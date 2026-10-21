# React UI — Implementation Plan

A web frontend for everything built so far: **auth, document upload/ingestion status, and the
streaming RAG chat agent**. It is deliberately built *before* `IMPLEMENTATION_AGENT_HARDENING.md`,
so the hardening work (approval prompts, memories, new tool events) lands in a UI that already
exists and can be seen working.

This is a plan, not a scaffold. You implement each phase; each ends with a "Verify".

**Goal:** register/login → upload documents and watch them ingest → chat with the agent, seeing
tokens and tool calls stream in → resume old conversations.

---

## What the backend gives us (read from the code, not assumed)

Base path `/api/v1`. All routes except register/login/refresh need `Authorization: Bearer <access>`.

| Area | Endpoint | Notes |
|---|---|---|
| Auth | `POST /users/` | register → `UserRead` (201) |
| | `POST /users/login` `{email,password}` | → `{access_token, refresh_token, token_type, expires_in, user}` |
| | `POST /users/refresh` `{refresh_token}` | → `TokenPair` (no `user`) |
| | `POST /users/logout` `{refresh_token}` | 204; revokes the refresh token |
| | `GET /users/me` | current user |
| Documents | `POST /documents` multipart `file` | **202**, returns `DocumentRead` with `status: pending` |
| | `GET /documents` | list |
| | `GET /documents/{id}` , `/{id}/status` | status endpoint is the lean poll target: `{id,status,error,chunk_count}` |
| | `DELETE /documents/{id}` | 204 |
| Chat | `POST /chat` `{message, thread_id?}` | **SSE stream** |
| | `GET/POST /chat/threads` | list / create (`{title?}`) |
| | `GET /chat/threads/{id}` | `ThreadRead` + `messages[{role,content,tool_calls?}]` |
| | `DELETE /chat/threads/{id}` | 204 |

Document `status` is one of `pending | parsing | chunking | embedding | ready | failed`.
Accepted types: PDF, DOCX, TXT/MD, CSV, XLSX; max `max_upload_bytes` (25 MB default).
Access token lifetime is 15 min (`expires_in` is returned so the client needn't decode the JWT);
refresh token 30 days.

### SSE events from `POST /chat`

`event:` name → JSON `data:` payload, emitted in this order:

| Event | Payload | Meaning |
|---|---|---|
| `thread` | `{thread_id}` | always first; the id to use for follow-ups |
| `token` | `{text}` | one chunk of assistant text |
| `tool_start` | `{id, name, args}` | model asked for a tool |
| `tool_end` | `{id, name, preview}` | tool result (first 200 chars) |
| `done` | `{thread_id}` | terminal, success |
| `error` | `{message}` | terminal, failure (HTTP status is already 200) |

A turn can contain several `tool_start`/`tool_end` pairs interleaved with `token` runs.

---

## Backend gaps found while planning

Fix or accept these *before* they surprise you in the browser.

| Gap | Impact | Plan |
|---|---|---|
| **No CORS middleware** (`main.py` has none) | A browser on `localhost:5173` calling `:8000` is blocked | Dev: Vite proxy makes it same-origin, so no backend change. Prod: serve UI and API from one origin, or add `CORSMiddleware` with an explicit origin list |
| **POST + SSE** | `EventSource` is GET-only | Use `fetch` + a stream reader (Phase 4) |
| **Tokens are returned in the JSON body**, no cookie | Client must store the refresh token | See "Token handling" below |
| `POST /chat` can't be cancelled by the UI today | "Stop" only closes the client connection | Verify the server stops generating on disconnect; note the result |
| No `pending_approval`, memories, or `approval_required` yet | Not needed now | Leave extension points (see end) |

---

## Stack and why

| Choice | Why |
|---|---|
| **Vite + React 19 + TypeScript** | Fast dev server, built-in proxy, no framework to learn around the real subject (streaming) |
| **React Router** | Four routes; nothing more needed |
| **TanStack Query** | Server state (documents, threads) with caching, polling and invalidation, so no hand-rolled `useEffect` fetching |
| **Plain `fetch` wrapper** | One place for auth headers and refresh-on-401; axios adds nothing here |
| **`openapi-typescript`** | Generate request/response types from FastAPI's `/openapi.json`. SSE payloads are *not* in OpenAPI, so type those by hand |
| **Tailwind CSS** | Fast, consistent styling without a component-library detour |
| **`react-markdown`** | Assistant output is markdown; see the security note in Phase 4 |
| **Vitest + Testing Library + MSW** | Unit/component tests with a mocked API, including a mocked SSE stream |
| **Playwright** (one smoke test) | Proves the real stack works end-to-end |

Deliberately **not** included: Redux (Query covers server state, `useReducer` covers the stream),
a UI kit (extra surface to learn), Next.js (no SSR/SEO need), and `EventSource` polyfills.

### Layout

```
web/                         # sits at the repo root next to src/
  src/
    api/        client.ts  auth.ts  documents.ts  chat.ts  sse.ts  types.gen.ts
    auth/       AuthProvider.tsx  RequireAuth.tsx  tokens.ts
    features/
      documents/  DocumentsPage.tsx  UploadDropzone.tsx  StatusBadge.tsx
      chat/       ChatPage.tsx  ThreadList.tsx  MessageList.tsx  Composer.tsx
                  ToolCallChip.tsx  useChatStream.ts  streamReducer.ts
    components/ Layout.tsx  ErrorBanner.tsx
    main.tsx  routes.tsx
  vite.config.ts  package.json
```

Add Makefile targets so it fits how this repo already works:
`web-install`, `web-dev`, `web-build`, `web-test`, `web-typecheck`, and add them to `make check`.

---

## Token handling (decide this deliberately)

The API returns both tokens in the response body. Options:

| Option | Trade-off |
|---|---|
| Access token in **memory**, refresh token in `localStorage` *(recommended for now)* | Survives reload. The refresh token is readable by any XSS, which is the main cost |
| Both in memory | Safest against XSS, but the user is logged out on every reload |
| httpOnly cookie for the refresh token | Best, but needs a **backend change** (set-cookie on login/refresh, CSRF thinking) |

Take the first option and write the XSS trade-off in a comment. Reducing XSS surface is another
reason to keep markdown rendering strict (Phase 4).

Refresh rules:
- On a 401, call `/users/refresh` **once**, retry the original request, and if that fails clear
  state and go to `/login`.
- **Single-flight the refresh.** If three requests 401 at once, they must share one refresh call.
  If the backend rotates refresh tokens, parallel refreshes would race and log the user out.
  Check `AuthService.refresh` to see whether it rotates, and record the answer in the code.
- Refresh *proactively* using `expires_in` shortly before expiry. A long stream can outlive the
  15-minute token only if it was started with an almost-expired one, so refresh before starting a
  chat request, not during it.

---

## Phase 0 — Scaffold and dev wiring

1. `npm create vite@latest web -- --template react-ts`, then add the dependencies above.
2. `vite.config.ts` dev proxy so the browser only ever talks to its own origin:
   ```ts
   server: { proxy: { "/api": "http://localhost:8000" } }
   ```
3. A `generate:types` script: `openapi-typescript http://localhost:8000/openapi.json -o src/api/types.gen.ts`.
4. Add `web/node_modules`, `web/dist` to `.gitignore`.

**Verify:** `make db-up && make dev` plus `make web-dev`; the UI at `localhost:5173` can
`fetch("/health")`... note `/health` isn't under `/api`, so either proxy it too or hit
`/api/v1/users/me` and expect a **401** (proof the proxy works and the guard is on).

---

## Phase 1 — API client and auth

Build in this order, each testable alone:

1. `api/client.ts` — `request<T>(path, init)`: base path, JSON handling, attaches the bearer
   token, throws a typed `ApiError {status, detail}` (FastAPI errors are `{detail: ...}`;
   validation errors have a `detail` *array*, so handle both shapes).
2. `auth/tokens.ts` — get/set/clear, the single-flight refresh.
3. `AuthProvider` — holds `user`, `login`, `register`, `logout`; hydrates from a stored refresh
   token on load by refreshing then calling `/users/me`.
4. Pages: `/login`, `/register`; `RequireAuth` route wrapper.

Show field-level validation errors (password rules come from the backend validator; surface its
message, don't re-implement the rules).

**Verify:** register → login → reload the page (still signed in) → logout (refresh token
revoked: replaying it against `/users/refresh` returns 401). Expire the access token manually and
confirm one transparent refresh.

---

## Phase 2 — Documents

- `DocumentsPage`: list via `useQuery`, upload via a drag-and-drop zone (`FormData`, field name
  `file`), delete with confirm.
- Client-side pre-checks (type, size) for fast feedback, but **the server is the authority**:
  render the 413/415/422 it returns.
- `StatusBadge` per status, with `failed` showing `error`.
- **Polling:** for any document not `ready`/`failed`, poll `GET /documents/{id}/status` every
  ~2 s, stopping when terminal. Use Query's `refetchInterval` as a function of the data so it
  turns itself off. Invalidate the list when a status changes.

Show the pipeline as steps (`parsing → chunking → embedding → ready`); this is the visible payoff
of the Temporal work. Optionally link to the Temporal UI (`localhost:8080`) in dev.

**Verify:** upload a PDF → 202 → badge walks through the stages to `ready` and shows a chunk
count. Kill the worker mid-embed, restart it: the badge pauses, then continues, not restarts.
Upload an unsupported file → readable error.

---

## Phase 3 — Chat shell (read-only)

Before streaming, get the structure right:

- Layout: thread sidebar (list, new, delete) + conversation pane. Routes `/chat` and
  `/chat/:threadId`.
- `GET /chat/threads/{id}` renders history by `role`: user bubbles, assistant bubbles, and
  `tool` messages as collapsed "tool result" blocks. An assistant message with `tool_calls`
  renders as tool chips.
- Thread list ordered by `last_message_at`, with an empty state.
- Deleting the active thread navigates away.

**Verify:** create a thread through curl, send a message through the existing endpoint, reload the
UI: history renders with tool calls visible.

---

## Phase 4 — Streaming (the core of the project)

### 4a. The SSE reader (`api/sse.ts`)

`fetch` the POST, read `response.body.getReader()`, decode with `TextDecoder`
(`{stream: true}`), and parse the SSE wire format by hand:

- Events are separated by a blank line; fields are `event:`, `data:`, optional `id:`/`retry:`;
  lines starting with `:` are comments (the server's keep-alive pings).
- **A chunk boundary can fall mid-event or mid-line.** Buffer, split on `\n\n`, keep the tail.
  This is the classic bug; write the unit test for it first.
- Multiple `data:` lines in one event join with `\n`.
- Expose an async iterator of `{event, data}` and accept an `AbortSignal`.

Writing this parser is the most instructive part of the UI, and ~50 lines.

### 4b. The reducer (`streamReducer.ts`)

Model the turn as state, not as scattered `useState`:

```ts
type Turn = {
  threadId?: string;
  parts: Array<
    | { kind: "text"; text: string }
    | { kind: "tool"; id: string; name: string; args: unknown; preview?: string; status: "running" | "done" }
  >;
  status: "streaming" | "done" | "error";
  error?: string;
};
```

A discriminated union of events in, new state out. `token` appends to the last `text` part (or
starts one); `tool_start` pushes a running tool part; `tool_end` finds it **by `id`** and
completes it. **Ignore unknown event names**, so new backend events don't break the client.

### 4c. The hook and composer

`useChatStream`: on send, optimistically append the user message, open the stream, dispatch
events, handle `thread` by updating the URL (`/chat/:id`) when it was a new conversation, and on
`done` invalidate the thread list and the thread detail query.

- **Stop** button → `AbortController.abort()`.
- Disable the composer while streaming; keep `Enter` to send, `Shift+Enter` for a newline;
  enforce the 4000-char limit client-side.
- Auto-scroll only if the user is already at the bottom.
- A stream that ends **without** `done` or `error` is a dropped connection: show "connection
  lost" and offer a retry that reloads history (the checkpoint may have partial progress).

### 4d. Rendering assistant text safely

- `react-markdown` with **no raw HTML**.
- **Do not render remote images**, and open links with `rel="noopener noreferrer"`. This closes
  the markdown-image exfiltration channel described in the hardening guide (Phase C2); doing it
  now means the UI is already safe when `fetch_url` arrives.
- Tool `args` and `preview` are untrusted text: render as text, never as HTML.

**Verify:** ask a document question → tokens appear incrementally (not all at once), a
"searching documents…" chip runs then completes with a preview, the final answer follows. Reload:
the same conversation appears from history. Stop mid-answer. Continue the same thread after
restarting the API. Force an `error` event (e.g. bad `OPENAI_API_KEY`) → error banner, composer
usable again.

---

## Phase 5 — Quality

| Layer | What | Tooling |
|---|---|---|
| Unit | SSE parser incl. split chunks, reducer, token single-flight | Vitest |
| Component | Login flow, upload + polling, chat turn with a mocked stream | Testing Library + MSW |
| E2E | Register → upload → ready → ask → answer with a tool chip | Playwright against the real stack |

Also: error boundaries per route, loading skeletons, a visible "API unreachable" state, keyboard
accessibility for the composer and dialogs, and responsive layout (sidebar collapses on narrow
screens).

---

## Extension points for the hardening work

Design these in now so `IMPLEMENTATION_AGENT_HARDENING.md` doesn't force a rewrite:

| Hardening feature | UI hook |
|---|---|
| **Human-in-the-loop** (`approval_required` event, `POST /chat/threads/{id}/resume`) | The reducer already treats a stream as ending in `done` \| `error`; add a third terminal state `awaiting_approval` and an `ApprovalDialog`. Disable the composer until resolved. Handle **409** on send |
| `pending_approval` on `GET /threads/{id}` | On load, if present, reopen the dialog so a refresh doesn't lose it |
| **Long-term memory** (`/memories`) | A `/memories` page: list + delete. Reuse the Query + list-page pattern from documents |
| New tools (`fetch_url`, status) | Already generic: `ToolCallChip` renders any `name`/`args`/`preview`. Show a distinct style for approval-gated tools |
| Untrusted-content envelope | Strip or collapse `<untrusted>` wrappers in the tool preview |

---

## Build order and specs

1. Phase 0 + 1 — scaffold, API client, auth
2. Phase 2 — documents
3. Phase 3 — chat shell
4. Phase 4 — streaming
5. Phase 5 — tests and polish

Suggested specs (`/create-spec`): `04-web-scaffold-auth`, `05-web-documents`, `06-web-chat`.
Rename the hardening specs after these, since the numbering is yours to keep consistent.

---

## Risks

| Risk | Mitigation |
|---|---|
| CORS blocks the browser | Vite proxy in dev; single origin or explicit `CORSMiddleware` origins in prod |
| SSE chunks split mid-event | Buffered parser plus a test that feeds one byte at a time |
| Proxy buffering kills streaming in prod | Disable buffering for `/api/v1/chat` (e.g. nginx `proxy_buffering off`) and verify with `curl -N` |
| Refresh race logs the user out | Single-flight refresh; check whether the backend rotates tokens |
| Refresh token in `localStorage` is XSS-readable | Strict markdown, no raw HTML, no remote images; consider httpOnly cookie later |
| Token expires mid-conversation | Refresh before starting a stream |
| Stale UI state after a dropped stream | Re-fetch thread history on error/disconnect; don't trust local state |
| Server keeps generating after "Stop" | Verify disconnect behaviour; cost implication if it doesn't |
| Types drift from the API | Regenerate `types.gen.ts` in CI; hand-typed SSE events live in one file |
| Event names change | Reducer ignores unknown events; payloads validated at the boundary |
