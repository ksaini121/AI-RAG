# Spec: Chat API SSE

## Overview
Expose the LangGraph agent built in step 6 over HTTP. A streaming `POST /api/v1/chat` endpoint
sends Server-Sent Events (`thread`, `token`, `tool_start`, `tool_end`, `done`, `error`) while the
agent runs. Thread CRUD endpoints create, list, read and delete conversations. Ownership is
enforced against `chat_threads.user_id`, because the checkpointer has no concept of users.
The spec also fixes four step 6 gaps that would break this feature: the checkpointer tables are
never created, the pool is never closed, parallel tool calls share one non-thread-safe
`Session`, and `get_graph()` is typed `object`. This is Phase 7 of `IMPLEMENTATION.md`.

## Depends on
JWT auth (spec 01), document ingestion + Temporal, pgvector retrieval, and the LangGraph agent
(`app/agent/`, merged in PR #6). `chat_threads` already exists (migration
`1fde42132819`). `alembic/env.py` already has `include_object` excluding the checkpointer tables.

## Routes
All under the `/api/v1` prefix, router prefix `/chat`, all authenticated (`CurrentUser`, 401 otherwise).
- `POST /api/v1/chat` — run one agent turn and stream events — `ChatRequest` → `text/event-stream` — 200 — authenticated. 404 if `thread_id` is given but not owned; 422 on invalid body. Both are raised before the first yield.
- `POST /api/v1/chat/threads` — create an empty thread — `ThreadCreate` → `ThreadRead` — 201 — authenticated
- `GET /api/v1/chat/threads` — list caller's threads, newest activity first — → `list[ThreadRead]` — 200 — authenticated
- `GET /api/v1/chat/threads/{thread_id}` — thread plus message history from the checkpointer — → `ThreadDetail` — 200 — authenticated; 404 if missing or not owned
- `DELETE /api/v1/chat/threads/{thread_id}` — delete checkpoint data, then the row — 204 — authenticated; 404 if missing or not owned

SSE events (each `event: <name>` with a JSON `data:` payload):
- `thread` — `{"thread_id": str}`, always first
- `token` — `{"text": str}`, from the `agent` node only
- `tool_start` — `{"id": str, "name": str, "args": object}`
- `tool_end` — `{"id": str, "name": str, "preview": str}`, preview truncated
- `done` — `{"thread_id": str}`, terminal on success
- `error` — `{"message": str}`, terminal on failure, generic text with no internals

The path for the streaming route is `""` (no trailing slash), matching `document_routes.py`.

## Schemas
New `src/app/schema/chat.py`:
- `ChatRequest` — `message: str` (`min_length=1`, `max_length=4000`), `thread_id: uuid.UUID | None = None`
- `ThreadCreate` — `title: str | None = Field(default=None, max_length=255)`
- `ThreadRead` — `from_attributes=True`; `id`, `title`, `last_message_at`, `created_at`, `updated_at`
- `MessageRead` — `role: Literal["user", "assistant", "tool"]`, `content: str`, `tool_calls: list[dict[str, Any]] | None`
- `ThreadDetail(ThreadRead)` — adds `messages: list[MessageRead]`

Validators: `ChatRequest.message` is rejected if it is whitespace-only (`field_validator`, strip then check non-empty).

## Database changes
No database changes. `chat_threads` (`id`, `user_id` FK CASCADE indexed, `title`, `last_message_at`,
plus `TimestampMixin`) already exists in `src/app/db/models.py` and the migration. Checkpointer tables
are library-owned and created by `AsyncPostgresSaver.setup()`, not Alembic.

## Services
New `src/app/services/chat_service.py`, `ChatService(db: Session)`, all sync:
- `create_thread(self, user_id: uuid.UUID, title: str | None) -> ChatThread`
- `list_threads(self, user_id: uuid.UUID) -> list[ChatThread]` — ordered `last_message_at DESC NULLS LAST`, then `created_at DESC`
- `get_for_user(self, thread_id: uuid.UUID, user_id: uuid.UUID) -> ChatThread | None` — the ownership gate, filters on both ids
- `touch(self, thread: ChatThread, first_message: str) -> None` — set `last_message_at` to now (UTC); if `title` is empty, set it to the first 60 chars of the message; commit
- `delete_for_user(self, thread_id: uuid.UUID, user_id: uuid.UUID) -> bool` — deletes the row only

Async checkpoint work (`aget_state`, `adelete_thread`) lives in the route/stream layer, not in the service.

Step 6 changes:
- `app/agent/graph.py`: `bind_tools(TOOLS, parallel_tool_calls=False)` in `agent_node`; annotate `build_graph`/`get_graph` as returning `CompiledStateGraph`; add `async def disconnect_graph() -> None` that closes the pool and clears `_graph`
- `app/agent/checkpointer.py`: add a `get_pool()` accessor if needed by `disconnect_graph`
- `app/agent/setup.py` (new): one-shot script that opens the pool, awaits `AsyncPostgresSaver(pool).setup()`, closes the pool

## Config
No new settings. Reuses `agent_max_tool_iterations`; `recursion_limit = 2 * agent_max_tool_iterations + 1`.
No `.env.example` changes.

## Files to change
- `src/app/main.py` — include `chat_routes.router`; call `disconnect_graph()` after `yield` in `lifespan`
- `src/app/agent/graph.py` — `parallel_tool_calls=False`, return typing, `disconnect_graph`
- `src/app/agent/checkpointer.py` — pool accessor for shutdown, if needed
- `Makefile` — add `checkpointer-setup` target (`PYTHONPATH=$(APP_DIR) uv run python -m app.agent.setup`) and list it in `.PHONY`
- `CLAUDE.md` — document `make checkpointer-setup` and the new `chat_routes`/`chat_service` under Architecture

## Files to create
- `src/app/schema/chat.py` — chat request/response schemas
- `src/app/services/chat_service.py` — thread persistence and ownership lookups
- `src/app/api/routes/chat_routes.py` — thread CRUD and the SSE streaming endpoint
- `src/app/agent/setup.py` — one-shot `.setup()` script for the checkpointer tables
- `tests/test_chat.py` — chat API tests

## New dependencies
None. `sse-starlette`, `langgraph`, `langgraph-checkpoint-postgres`, `psycopg[pool]` are already installed.

## Tests
`tests/test_chat.py`. Use `with TestClient(app) as client:` (a bare `TestClient` does not run `lifespan`).
Replace the graph with a fake by patching `get_graph` in `app.api.routes.chat_routes` with a stub whose
async `astream` yields canned `(mode, chunk)` tuples and whose `aget_state`/`checkpointer.adelete_thread`
are async fakes. No OpenAI calls. All tests need live Postgres (`make db-up`, `make migrate`) because
users and threads are real rows.
- Success: stream yields `thread`, `tool_start`, `tool_end`, `token`..., `done` in that order
- Success: omitting `thread_id` creates a thread and the `thread` event carries its id; `last_message_at` and `title` are set afterwards
- Success: continuing an existing `thread_id` reuses it
- Success: thread create (201), list ordering, `GET` detail maps messages and skips system messages, `DELETE` returns 204 and calls `adelete_thread`
- Failure: no token returns 401 on all five routes
- Failure: another user's `thread_id` returns 404 on stream, `GET` and `DELETE`, and the fake graph is never called
- Failure: unknown `thread_id` returns 404
- Failure: empty or whitespace `message` returns 422
- Failure: graph raising mid-stream produces a terminal `error` event, no `done`, and the response status is still 200
- Failure: `GraphRecursionError` produces an `error` event with the friendly message
- `ChatService` unit tests using `test_user` / `other_user` from `tests/conftest.py`: `get_for_user` returns `None` for the wrong user; `touch` does not overwrite an existing title

## Rules for implementation
- Imports are `from app...`, never `from src.app...`
- Request flow is routes → service → db model; no DB queries in route handlers, no `HTTPException` raised from `db/` modules
- Services take a `Session` in `__init__` and never call `db.close()` — the request-scoped `get_db` dependency owns the session lifecycle
- Routers depend on a local `get_<x>_service` factory exposed as an `Annotated[..., Depends(...)]` alias, mirroring `user_routes.py`
- SQLAlchemy 2.0 style: `Mapped[...]` / `mapped_column(...)`, inheriting `Base` (+ `TimestampMixin` where timestamps apply)
- Schema changes go through Alembic autogenerate (`make migration m="..."`), and the generated file is reviewed before `make migrate`. None are expected here; `make migration m="noop"` must still produce an empty migration.
- Passwords are hashed with `app.core.security` (bcrypt) — never stored plaintext, never returned in a `*Read` schema
- New settings go in `Config` in `app/core/config.py`; never read `os.environ` directly. Secrets stay in `.env`, and `.env.example` documents every new key with a placeholder
- Ruff: line length 100, rules `E, F, I, N, UP, B, SIM`. Code must pass `make check` (lint + typecheck + test)
- Full type annotations on every new function and method — mypy runs over `src`
- Ownership is always checked against `chat_threads.user_id` (via `ChatService.get_for_user`) before touching the graph or checkpointer. A missing or foreign thread returns 404, never 403.
- Validate and authorise everything before the first yield; after headers are sent, failures become a terminal `event: error`. Never leak exception text to the client; log with `logger.exception`.
- `thread` is the first event, always. Call `db.commit()` before streaming begins so the `Session` does not sit idle in a transaction during the LLM call.
- `thread_id` goes in `config["configurable"]`; `AgentContext(user_id, db)` goes in `context=`. Never take `user_id` from the request body.
- `DELETE` removes checkpoint data first (`graph.checkpointer.adelete_thread`), then the `chat_threads` row.
- Do not catch `asyncio.CancelledError` in the stream generator; let client disconnects propagate.
- Truncate tool output in `tool_end` previews; never stream whole retrieved passages.
- Known limitations, documented and not fixed here: a client disconnect mid-tool-call can leave dangling `tool_calls` in the checkpoint, and concurrent posts to one thread can interleave.

## Definition of done
- [ ] `make checkpointer-setup` succeeds, and `make db-shell` then `\dt` lists `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, `checkpoint_migrations`
- [ ] `make migration m="noop"` generates an empty migration (delete it afterwards)
- [ ] `make check` passes (lint, mypy, pytest)
- [ ] `uv run pytest tests/test_chat.py` passes with Postgres running
- [ ] `curl -N -X POST localhost:8000/api/v1/chat -H "Authorization: Bearer $T" -H "Content-Type: application/json" -d '{"message":"What documents do I have?"}'` streams events incrementally, in order `thread`, `tool_start`, `tool_end`, `token`..., `done`
- [ ] After restarting uvicorn, posting a follow-up with the same `thread_id` shows the agent remembers the earlier turn
- [ ] A second user's token gets 404 from `POST /chat` (with the first user's `thread_id`), `GET /chat/threads/{id}` and `DELETE /chat/threads/{id}`
- [ ] `DELETE /api/v1/chat/threads/{id}` returns 204, a later `GET` returns 404, and `SELECT count(*) FROM checkpoints WHERE thread_id = '<id>'` returns 0
- [ ] `POST /api/v1/chat` with `{"message": ""}` returns 422 and with no `Authorization` header returns 401
- [ ] Stopping the app (Ctrl+C) closes the checkpointer pool without warnings
