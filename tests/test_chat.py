"""Chat API tests.

The real graph is replaced by a fake, so no OpenAI calls are made. Users and
threads are real committed rows, so these require Postgres (`make db-up`) and
the migrated schema (`make migrate`).
"""

import json
import uuid
from collections.abc import AsyncIterator, Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langgraph.errors import GraphRecursionError

from app.main import app
from app.services.chat_service import ChatService

PASSWORD = "Passw0rd!"

HAPPY_PATH: list[tuple[str, Any]] = [
    (
        "updates",
        {
            "agent": {
                "messages": [
                    AIMessage(
                        content="",
                        tool_calls=[{"id": "c1", "name": "list_my_documents", "args": {}}],
                    )
                ]
            }
        },
    ),
    (
        "updates",
        {
            "tools": {
                "messages": [
                    ToolMessage(content="a.pdf " * 100, tool_call_id="c1", name="list_my_documents")
                ]
            }
        },
    ),
    ("messages", (AIMessageChunk(content="Hel"), {"langgraph_node": "agent"})),
    ("messages", (AIMessageChunk(content="lo"), {"langgraph_node": "agent"})),
    # Tool output must never be streamed as tokens.
    ("messages", (AIMessageChunk(content="ignored"), {"langgraph_node": "tools"})),
]


class FakeCheckpointer:
    def __init__(self) -> None:
        self.deleted: list[str] = []

    async def adelete_thread(self, thread_id: str) -> None:
        self.deleted.append(thread_id)


class FakeGraph:
    def __init__(self, events: list[tuple[str, Any]], error: Exception | None = None) -> None:
        self.events = events
        self.error = error
        self.calls: list[dict[str, Any]] = []
        self.checkpointer = FakeCheckpointer()
        self.history: list[Any] = []

    async def astream(self, graph_input: Any, **kwargs: Any) -> AsyncIterator[tuple[str, Any]]:
        self.calls.append({"input": graph_input, **kwargs})
        for event in self.events:
            yield event
        if self.error is not None:
            raise self.error

    async def aget_state(self, config: Any) -> SimpleNamespace:
        return SimpleNamespace(values={"messages": self.history})


@pytest.fixture
def client() -> Iterator[TestClient]:
    # Context manager so the app lifespan runs.
    with TestClient(app) as c:
        yield c


@pytest.fixture
def fake_graph(monkeypatch: pytest.MonkeyPatch) -> FakeGraph:
    graph = FakeGraph(HAPPY_PATH)
    monkeypatch.setattr("app.api.routes.chat_routes.get_graph", lambda: graph)
    return graph


def _register_and_login(client: TestClient) -> dict[str, str]:
    email = f"chat-{uuid.uuid4()}@example.com"
    created = client.post(
        "/api/v1/users/", json={"name": "Ada", "email": email, "password": PASSWORD}
    )
    assert created.status_code == 201
    resp = client.post("/api/v1/users/login", json={"email": email, "password": PASSWORD})
    assert resp.status_code == 200
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


@pytest.fixture
def auth(client: TestClient) -> dict[str, str]:
    return _register_and_login(client)


@pytest.fixture
def other_auth(client: TestClient) -> dict[str, str]:
    return _register_and_login(client)


def _parse_sse(text: str) -> list[tuple[str, dict[str, Any]]]:
    events = []
    for block in text.replace("\r\n", "\n").split("\n\n"):
        name = data = None
        for line in block.split("\n"):
            if line.startswith("event:"):
                name = line.removeprefix("event:").strip()
            elif line.startswith("data:"):
                data = line.removeprefix("data:").strip()
        if name and data:
            events.append((name, json.loads(data)))
    return events


def _chat(client: TestClient, auth: dict[str, str], **body: Any):
    return client.post("/api/v1/chat", json=body, headers=auth)


# --- streaming ---------------------------------------------------------------


def test_stream_event_order(client: TestClient, auth: dict[str, str], fake_graph: FakeGraph):
    resp = _chat(client, auth, message="What documents do I have?")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    events = _parse_sse(resp.text)
    names = [name for name, _ in events]
    assert names == ["thread", "tool_start", "tool_end", "token", "token", "done"]
    assert events[1][1] == {"id": "c1", "name": "list_my_documents", "args": {}}
    assert len(events[2][1]["preview"]) <= 200
    assert [p["text"] for n, p in events if n == "token"] == ["Hel", "lo"]
    assert events[0][1]["thread_id"] == events[-1][1]["thread_id"]


def test_stream_creates_thread_and_sets_metadata(
    client: TestClient, auth: dict[str, str], fake_graph: FakeGraph
):
    resp = _chat(client, auth, message="What documents do I have?")
    thread_id = _parse_sse(resp.text)[0][1]["thread_id"]

    threads = client.get("/api/v1/chat/threads", headers=auth).json()
    assert [t["id"] for t in threads] == [thread_id]
    assert threads[0]["title"] == "What documents do I have?"
    assert threads[0]["last_message_at"] is not None

    call = fake_graph.calls[0]
    assert call["config"]["configurable"]["thread_id"] == thread_id
    assert call["context"].user_id is not None


def test_stream_reuses_existing_thread(
    client: TestClient, auth: dict[str, str], fake_graph: FakeGraph
):
    thread = client.post("/api/v1/chat/threads", json={"title": "Mine"}, headers=auth).json()
    resp = _chat(client, auth, message="hi", thread_id=thread["id"])

    assert _parse_sse(resp.text)[0][1]["thread_id"] == thread["id"]
    threads = client.get("/api/v1/chat/threads", headers=auth).json()
    assert len(threads) == 1
    assert threads[0]["title"] == "Mine"  # not overwritten by the first message


def test_stream_graph_error_is_terminal_error_event(
    client: TestClient, auth: dict[str, str], monkeypatch: pytest.MonkeyPatch
):
    graph = FakeGraph(HAPPY_PATH[:1], error=RuntimeError("secret internals"))
    monkeypatch.setattr("app.api.routes.chat_routes.get_graph", lambda: graph)

    resp = _chat(client, auth, message="hi")
    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    names = [name for name, _ in events]
    assert names[-1] == "error"
    assert "done" not in names
    assert "secret internals" not in resp.text


def test_stream_recursion_error_has_friendly_message(
    client: TestClient, auth: dict[str, str], monkeypatch: pytest.MonkeyPatch
):
    graph = FakeGraph([], error=GraphRecursionError("limit"))
    monkeypatch.setattr("app.api.routes.chat_routes.get_graph", lambda: graph)

    events = _parse_sse(_chat(client, auth, message="hi").text)
    assert events[-1][0] == "error"
    assert "too many steps" in events[-1][1]["message"]


@pytest.mark.parametrize("message", ["", "   \n\t"])
def test_stream_rejects_blank_message(
    client: TestClient, auth: dict[str, str], fake_graph: FakeGraph, message: str
):
    assert _chat(client, auth, message=message).status_code == 422
    assert fake_graph.calls == []


# --- thread CRUD -------------------------------------------------------------


def test_create_and_list_threads_ordering(client: TestClient, auth: dict[str, str]):
    first = client.post("/api/v1/chat/threads", json={}, headers=auth)
    assert first.status_code == 201
    second = client.post("/api/v1/chat/threads", json={"title": "Second"}, headers=auth).json()

    ids = [t["id"] for t in client.get("/api/v1/chat/threads", headers=auth).json()]
    # Neither has messages: newest created first.
    assert ids == [second["id"], first.json()["id"]]


def test_list_orders_by_last_activity(
    client: TestClient, auth: dict[str, str], fake_graph: FakeGraph
):
    older = client.post("/api/v1/chat/threads", json={}, headers=auth).json()
    newer = client.post("/api/v1/chat/threads", json={}, headers=auth).json()
    _chat(client, auth, message="hi", thread_id=older["id"])

    ids = [t["id"] for t in client.get("/api/v1/chat/threads", headers=auth).json()]
    assert ids == [older["id"], newer["id"]]  # active thread first, empty one last


def test_get_thread_maps_messages_and_skips_system(
    client: TestClient, auth: dict[str, str], fake_graph: FakeGraph
):
    thread = client.post("/api/v1/chat/threads", json={}, headers=auth).json()
    fake_graph.history = [
        SystemMessage(content="secret prompt"),
        HumanMessage(content="hi"),
        AIMessage(content="", tool_calls=[{"id": "c1", "name": "t", "args": {}}]),
        ToolMessage(content="result", tool_call_id="c1", name="t"),
        AIMessage(content="done"),
    ]

    resp = client.get(f"/api/v1/chat/threads/{thread['id']}", headers=auth)
    assert resp.status_code == 200
    messages = resp.json()["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant", "tool", "assistant"]
    assert messages[1]["tool_calls"][0]["name"] == "t"
    assert "secret prompt" not in resp.text


def test_delete_thread(client: TestClient, auth: dict[str, str], fake_graph: FakeGraph):
    thread = client.post("/api/v1/chat/threads", json={}, headers=auth).json()

    assert client.delete(f"/api/v1/chat/threads/{thread['id']}", headers=auth).status_code == 204
    assert fake_graph.checkpointer.deleted == [thread["id"]]
    assert client.get(f"/api/v1/chat/threads/{thread['id']}", headers=auth).status_code == 404


# --- auth / ownership --------------------------------------------------------


def test_all_routes_require_auth(client: TestClient):
    tid = uuid.uuid4()
    responses = [
        client.post("/api/v1/chat", json={"message": "hi"}),
        client.post("/api/v1/chat/threads", json={}),
        client.get("/api/v1/chat/threads"),
        client.get(f"/api/v1/chat/threads/{tid}"),
        client.delete(f"/api/v1/chat/threads/{tid}"),
    ]
    assert [r.status_code for r in responses] == [401] * 5


def test_other_users_thread_returns_404(
    client: TestClient,
    auth: dict[str, str],
    other_auth: dict[str, str],
    fake_graph: FakeGraph,
):
    thread = client.post("/api/v1/chat/threads", json={}, headers=auth).json()
    url = f"/api/v1/chat/threads/{thread['id']}"

    assert _chat(client, other_auth, message="hi", thread_id=thread["id"]).status_code == 404
    assert client.get(url, headers=other_auth).status_code == 404
    assert client.delete(url, headers=other_auth).status_code == 404
    assert fake_graph.calls == []
    assert fake_graph.checkpointer.deleted == []
    # Still intact for the owner.
    assert client.get(url, headers=auth).status_code == 200


def test_unknown_thread_returns_404(
    client: TestClient, auth: dict[str, str], fake_graph: FakeGraph
):
    resp = _chat(client, auth, message="hi", thread_id=str(uuid.uuid4()))
    assert resp.status_code == 404
    assert fake_graph.calls == []


# --- ChatService -------------------------------------------------------------


def test_get_for_user_returns_none_for_wrong_user(db_session, test_user, other_user):
    service = ChatService(db_session)
    thread = service.create_thread(test_user.id, None)

    assert service.get_for_user(thread.id, test_user.id) is not None
    assert service.get_for_user(thread.id, other_user.id) is None


def test_touch_does_not_overwrite_existing_title(db_session, test_user):
    service = ChatService(db_session)
    thread = service.create_thread(test_user.id, "Keep me")

    service.touch(thread, "a different first message")

    assert thread.title == "Keep me"
    assert thread.last_message_at is not None
