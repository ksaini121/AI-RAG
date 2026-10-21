import json
import logging
import uuid
from collections.abc import AsyncIterator
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Response
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    ToolMessage,
)
from langchain_core.runnables import RunnableConfig
from langgraph.errors import GraphRecursionError
from sse_starlette.sse import EventSourceResponse

from app.agent.context import AgentContext
from app.agent.graph import get_graph
from app.api.deps import CurrentUser
from app.core.config import config
from app.db.deps import DbSession
from app.db.models import ChatThread
from app.schema.chat import ChatRequest, MessageRead, ThreadCreate, ThreadDetail, ThreadRead
from app.services.chat_service import ChatService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["chat"])

TOOL_PREVIEW_CHARS = 200
GENERIC_ERROR = "Something went wrong while generating a response."
RECURSION_ERROR = "The assistant used too many steps on this request. Try a simpler question."


# dependency injection
def get_chat_service(db: DbSession) -> ChatService:
    return ChatService(db)


ChatServiceDep = Annotated[ChatService, Depends(get_chat_service)]


def _thread_config(thread_id: uuid.UUID) -> RunnableConfig:
    return {
        "configurable": {"thread_id": str(thread_id)},
        "recursion_limit": 2 * config.agent_max_tool_iterations + 1,
    }


def _text(content: Any) -> str:
    """Message content is a str for plain replies but can be a list of parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part if isinstance(part, str) else str(part.get("text", ""))
            for part in content
            if isinstance(part, str | dict)
        )
    return str(content)


def _event(name: str, payload: dict[str, Any]) -> dict[str, str]:
    return {"event": name, "data": json.dumps(payload)}


def _to_message_read(message: BaseMessage) -> MessageRead | None:
    if isinstance(message, HumanMessage):
        return MessageRead(role="user", content=_text(message.content))
    if isinstance(message, AIMessage):
        return MessageRead(
            role="assistant",
            content=_text(message.content),
            tool_calls=[dict(call) for call in message.tool_calls] or None,
        )
    if isinstance(message, ToolMessage):
        return MessageRead(role="tool", content=_text(message.content))
    return None  # system messages are never shown


def _require_thread(service: ChatService, thread_id: uuid.UUID, user_id: uuid.UUID) -> ChatThread:
    thread = service.get_for_user(thread_id, user_id)
    if thread is None:
        raise HTTPException(status_code=404, detail="thread not found!")
    return thread


async def _stream_turn(
    thread: ChatThread, message: str, user_id: uuid.UUID, db: DbSession
) -> AsyncIterator[dict[str, str]]:
    # Everything that can be rejected was rejected before this generator
    # started: past the first yield the status is already 200, so failures
    # can only be reported as a terminal `error` event.
    yield _event("thread", {"thread_id": str(thread.id)})
    try:
        stream: AsyncIterator[Any] = get_graph().astream(
            {"messages": [HumanMessage(content=message)]},
            config=_thread_config(thread.id),
            context=AgentContext(user_id=user_id, db=db),
            stream_mode=["messages", "updates"],
        )
        async for mode, chunk in stream:
            if mode == "messages":
                msg, meta = chunk
                if (
                    meta.get("langgraph_node") == "agent"
                    and isinstance(msg, AIMessageChunk)
                    and (text := _text(msg.content))
                ):
                    yield _event("token", {"text": text})
            elif mode == "updates":
                for node, update in chunk.items():
                    for msg in (update or {}).get("messages", []):
                        if node == "agent" and isinstance(msg, AIMessage):
                            for call in msg.tool_calls:
                                yield _event(
                                    "tool_start",
                                    {"id": call["id"], "name": call["name"], "args": call["args"]},
                                )
                        elif node == "tools" and isinstance(msg, ToolMessage):
                            yield _event(
                                "tool_end",
                                {
                                    "id": msg.tool_call_id,
                                    "name": msg.name or "",
                                    "preview": _text(msg.content)[:TOOL_PREVIEW_CHARS],
                                },
                            )
    except GraphRecursionError:
        logger.warning("Agent hit the recursion limit on thread %s", thread.id)
        yield _event("error", {"message": RECURSION_ERROR})
        return
    except Exception:
        # Never leak exception text to the client.
        logger.exception("Agent run failed on thread %s", thread.id)
        yield _event("error", {"message": GENERIC_ERROR})
        return
    yield _event("done", {"thread_id": str(thread.id)})


# routes
@router.post("")
async def chat(
    body: ChatRequest, user: CurrentUser, service: ChatServiceDep, db: DbSession
) -> EventSourceResponse:
    if body.thread_id is None:
        thread = service.create_thread(user.id, None)
    else:
        thread = _require_thread(service, body.thread_id, user.id)
    # Commits, so the Session is not left idle in a transaction for the
    # duration of the LLM call.
    service.touch(thread, body.message)
    return EventSourceResponse(_stream_turn(thread, body.message, user.id, db))


@router.post("/threads", status_code=201, response_model=ThreadRead)
def create_thread(body: ThreadCreate, user: CurrentUser, service: ChatServiceDep):
    return service.create_thread(user.id, body.title)


@router.get("/threads", response_model=list[ThreadRead])
def list_threads(user: CurrentUser, service: ChatServiceDep):
    return service.list_threads(user.id)


@router.get("/threads/{thread_id}", response_model=ThreadDetail)
async def get_thread(thread_id: uuid.UUID, user: CurrentUser, service: ChatServiceDep):
    thread = _require_thread(service, thread_id, user.id)
    state = await get_graph().aget_state(_thread_config(thread.id))
    messages = [
        read
        for message in (state.values or {}).get("messages", [])
        if (read := _to_message_read(message)) is not None
    ]
    return ThreadDetail.model_validate(
        {**ThreadRead.model_validate(thread).model_dump(), "messages": messages}
    )


@router.delete("/threads/{thread_id}", status_code=204, response_class=Response)
async def delete_thread(thread_id: uuid.UUID, user: CurrentUser, service: ChatServiceDep) -> None:
    thread = _require_thread(service, thread_id, user.id)
    # Checkpoint data first: if the row went first and this failed, the
    # orphaned history would resurface in a recreated thread.
    await get_graph().checkpointer.adelete_thread(str(thread.id))  # type: ignore[union-attr]
    service.delete_for_user(thread_id, user.id)
