# React UI — Final Implementation Plan

Supersedes `IMPLEMENTATION_UI.md`. Same goal and stack; this version folds in the gaps found by
checking the plan against the backend code (`auth_service.py`, `chat_routes.py`, `schema/chat.py`,
`main.py`). Sections marked **(new)** or **(changed)** differ from the first draft.

**Goal:** register/login → upload documents and watch them ingest → chat with the agent, seeing
tokens, tool calls and sources stream in → resume old conversations.

---

## 0. Decisions made up front (new)

| Decision | Choice | Why |
|---|---|---|
| Prod serving | FastAPI serves `web/dist` via `StaticFiles` with SPA fallback; one origin | No CORS, no second deploy, no cross-site cookie questions. Dev uses the Vite proxy |
| Token storage | Access token in memory, refresh token in `localStorage` | Survives reload; XSS trade-off documented in code |
| Small backend changes in scope | Yes, the ones in section 2 | Without them the UI cannot do history or citations properly |
| Cross-tab auth | Web Locks API around refresh + `storage` event for logout | Refresh rotates (see 1.1), so two tabs would otherwise log each other out |

---

## 1. Shortcomings found in the first draft

### 1.1 Refresh is single-use and the plan under-weighted it
`AuthService.refresh` revokes the presented token and issues a new pair. The draft said "check
whether it rotates"; it does. Consequences:
- **Multi-tab race (missed).** Tab A and tab B both hold the same refresh token in `localStorage`.
  Both refresh near expiry; the second call presents a spent token → 401 → that tab logs out.
  Fix: wrap refresh in `navigator.locks.request("auth-refresh", …)`, and inside the lock re-read
  `localStorage` first (another tab may have just rotated it) before calling the API. Write the new
  pair to `localStorage` before releasing the lock.
- **React StrictMode (missed).** In dev, effects run twice; a hydrate-on-mount that refreshes will
  burn the token on the first call and fail the second. The single-flight promise must live at
  module level, not in a component or hook.
- **Network failure after the server rotated.** If the response is lost, the old token is dead and
  the user is logged out. Accept and document; do not retry a refresh with the same token.
- Distinguish "refresh rejected" (401 → log out) from "network error" (keep session, show offline).

### 1.2 SSE parsing details the draft got wrong
- `sse_starlette` emits **`\r\n`** line endings, so splitting on `\n\n` never matches. The parser
  must accept `\r\n`, `\n` and `\r` and split on a blank line of any of those. Unit-test with
  `\r\n\r\n` fixtures, one-byte-at-a-time feeds, and a multi-byte UTF-8 character split across
  chunks (`TextDecoder` with `{stream: true}` handles it; test proves it).
- Keep-alive is a `: ping` comment roughly every 15 s; ignore comment lines but treat any bytes
  received as liveness.

### 1.3 Errors that arrive *before* the stream
The draft only handled the in-stream `error` event. `POST /chat` can fail with a normal HTTP
status first: **401** (expired token), **404** (unknown/foreign thread), **422** (empty or >4000
char message). The stream reader must check `response.ok` and route non-2xx through the same
`ApiError` path as `client.ts`, including one refresh-and-retry on 401. Only after a 200 does the
event protocol apply.

### 1.4 New-thread navigation remounts the chat (the classic bug)
On the `thread` event for a new conversation the draft says "update the URL to `/chat/:id`".
Navigating from `/chat` to `/chat/:id` changes the route element's params; if `ChatPage` keys off
`threadId` it remounts and **drops the in-flight stream state**. Fix:
- Hold stream state in a provider/store above the route (`ChatStreamProvider`) keyed by a client
  `localTurnId`, or make `/chat` and `/chat/:threadId` the same route element
  (`/chat/:threadId?`) and use `navigate(..., {replace: true})`.
- On `done`, do **not** immediately replace local turn state with the refetched history; keep the
  streamed turn on screen until the thread query has returned, then swap, to avoid a flash/jump.
  Do not refetch history *during* a stream.

### 1.5 History cannot be rendered faithfully with the current API
`MessageRead` is `{role, content, tool_calls?}`. A `tool` message has **no `tool_call_id` or
`name`**, so history cannot pair a result to its call chip, and a reload looks different from the
live stream. See backend change B1.

### 1.6 No citations, so the RAG UI shows no provenance
The `tool_end` preview is the first 200 characters of the tool output. For a RAG product the user
needs "which document and which passage". Needs backend change B2; UI renders source cards under
the answer.

### 1.7 Stop semantics and partial turns
- Aborting the fetch cancels the generator (sse_starlette cancels on disconnect) but the partial
  assistant text may not be in the checkpoint, so local state and history diverge. After Stop,
  show the partial text marked "stopped", then refetch history and reconcile (history wins).
- The user message is committed by `service.touch(...)` before the graph runs but may not be in the
  checkpoint if aborted early. History reload can therefore drop the last user message. Verify
  (Phase 4 verify list) and decide: accept and show an inline "message not saved" note, or fix
  server-side.
- **Concurrent sends on one thread** (two tabs, or double click) are not rejected by the server
  today. UI: disable composer while streaming and guard against double submit with a ref, not state.

### 1.8 Document UX gaps
- **Upload progress:** `fetch` has no upload progress; a 25 MB file shows nothing. Use XHR (or a
  small `uploadWithProgress` helper) for the upload only.
- **Polling N documents = N requests every 2 s.** Poll `GET /documents` once while any document is
  non-terminal instead of one status call per row; `refetchInterval` as a function of the list.
  Back off to 5 s after 30 s; stop on tab hidden (`refetchIntervalInBackground: false`).
- No pagination on `GET /documents` / threads. Fine for now; note it, and virtualize nothing yet.
- Duplicate-file uploads, delete-while-ingesting (what does the workflow do?) need an explicit
  check against the backend and a readable message.
- Chat searches *all* of the user's documents; there is no way to scope a question. Out of scope,
  list under "Later".

### 1.9 Streaming render performance and accessibility
- Re-rendering `react-markdown` per token is quadratic on long answers. Buffer tokens and flush at
  most once per animation frame; render only the in-progress last text part as markdown.
- Streamed text needs `aria-live="polite"` on the message container (but not the whole page),
  focus management after send, and a visible focus ring on Stop.
- JS `string.length` is UTF-16 units; the backend counts code points. Count with
  `[...s].length` for the 4000 limit so emoji do not cause a surprise 422.

### 1.10 Smaller items
- Phase 0 "Verify" is garbled ("`fetch("/health")`... note…"). Replace with: `GET /api/v1/users/me`
  returns 401 through the proxy.
- `API base` should come from `import.meta.env.VITE_API_BASE ?? "/api/v1"`.
- Logout must abort active streams, clear the Query cache, and broadcast to other tabs.
- Playwright E2E needs a model: use a deterministic fake chat model behind an env flag
  (`AGENT_FAKE_MODEL=1`) or record cassettes; do not call OpenAI in CI.
- No CI is mentioned. Add a `web` job: install, typecheck, lint, unit tests, build; regenerate
  types and fail on diff.
- Add ESLint + Prettier (repo already enforces ruff/mypy; the web side should match).
- Dev compression middleware can buffer SSE; verify with `curl -N` through the Vite proxy as well
  as the prod proxy.
- Unauthenticated deep link (`/chat/:id`) must return to it after login (`state.from`).
- Empty/loading/error states and an "API unreachable" banner (draft listed; keep).

---

## 2. Backend changes (small, do first on this branch or a sibling)

| # | Change | Why |
|---|---|---|
| B1 | `MessageRead` gains `id` (message id), `tool_call_id`, `name` for `tool` messages | Pair results to calls in history (1.5) |
| B2 | Emit citations: a `sources` SSE event `{items:[{document_id, filename, chunk_index, snippet, score}]}` after retrieval tool_end, and persist so history can rebuild (e.g. tool message artifact or content JSON) | Provenance (1.6) |
| B3 | Static file serving of `web/dist` with SPA fallback, mounted after the API routers, `/api` and `/health` untouched | Single origin (section 0) |
| B4 | Reject concurrent turns on one thread with **409** (advisory lock or `streaming_since` column) | Safe multi-tab (1.7); also what hardening's approval flow needs |
| B5 | Verify and record: does a client disconnect stop generation, and is the partial AI message checkpointed? | Stop semantics (1.7) |
| B6 | `CORSMiddleware` only if a separate origin is ever used; otherwise leave off | Avoid dead config |

B1, B2, B4 each get a test in `tests/test_chat.py`. Treat the SSE protocol as a versioned contract:
document the event table in the spec and keep "unknown events ignored" on the client.

---

## 3. Stack (unchanged, plus tooling)

Vite + React 19 + TypeScript, React Router, TanStack Query, plain `fetch` wrapper (XHR only for
upload progress), `openapi-typescript`, Tailwind, `react-markdown`, Vitest + Testing Library + MSW,
Playwright (one smoke test), plus **ESLint + Prettier**.

Layout as in the first draft, with these additions:
`api/upload.ts`, `auth/refreshLock.ts`, `features/chat/ChatStreamProvider.tsx`,
`features/chat/SourceCards.tsx`, `features/chat/MarkdownView.tsx`.

Makefile: `web-install`, `web-dev`, `web-build`, `web-lint`, `web-typecheck`, `web-test`,
`web-types`; add them to `make check`.

---

## 4. Phases

Each phase ends with a Verify and should be its own spec/PR.

### Phase 0 — Scaffold and wiring (spec `04-web-scaffold-auth`, part 1)
Vite app in `web/`, dev proxy `/api` → `:8000`, `generate:types` script, `.gitignore`, ESLint,
Prettier, Makefile targets, CI job.
**Verify:** `GET /api/v1/users/me` via `localhost:5173` returns 401.

### Phase 1 — API client and auth (spec `04`, part 2)
1. `client.ts`: base path, JSON, bearer, `ApiError` handling both `detail` shapes (string and
   validation array), one retry on 401.
2. `tokens.ts` + `refreshLock.ts`: module-level single-flight, Web Locks across tabs, re-read
   storage inside the lock, network error vs 401 distinction, proactive refresh from `expires_in`.
3. `AuthProvider`: hydrate via refresh then `/users/me`; `login`, `register`, `logout` (aborts
   streams, clears cache, broadcasts).
4. Pages `/login`, `/register`, `RequireAuth` with return-to-deep-link.
**Verify:** register → login → reload (still signed in, including under StrictMode) → open two tabs
and force both to refresh at once (both stay signed in) → logout in one tab logs out the other →
replaying the old refresh token returns 401.

### Phase 2 — Documents (spec `05-web-documents`)
Dropzone with client pre-checks (server is authoritative: render 413/415/422), upload with
progress, list with single-request polling and backoff, `StatusBadge` stepper
(`pending → parsing → chunking → embedding → ready`, `failed` shows `error`), delete with confirm,
empty/error states.
**Verify:** upload shows progress → 202 → badge walks to `ready` with chunk count; kill and restart
the Temporal worker mid-embed (badge pauses, then continues); unsupported/oversized file → readable
error; delete during ingestion behaves sanely.

### Phase 3 — Chat shell, read-only (spec `06-web-chat`, part 1)
Layout with thread sidebar (collapses on narrow screens), routes `/chat/:threadId?`, history
rendering by role using B1 (tool results paired to chips), sources from B2, thread list ordered by
`last_message_at`, delete active thread navigates away.
**Verify:** create a conversation via curl, reload the UI: history, tool chips and sources render
identically to what streaming will show.

### Phase 4 — Streaming (spec `06`, part 2)
- **4a `sse.ts`:** fetch POST, check `response.ok` first (1.3), `TextDecoder({stream:true})`, parser
  accepting `\r\n`/`\n`/`\r`, comment lines ignored, multi-line `data:` joined, async iterator,
  `AbortSignal`. Tests first: split chunks, 1-byte feed, `\r\n`, split UTF-8, unknown event.
- **4b `streamReducer.ts`:** parts = `text | tool | sources`; `token` appends; `tool_start` pushes;
  `tool_end` completes **by id**; `sources` attaches; terminal states `done | error | stopped |
  dropped`; unknown events ignored; payloads validated at the boundary (small hand-rolled guards or
  zod).
- **4c `ChatStreamProvider` + `useChatStream`:** state above the router (1.4), optimistic user
  message, refresh token before starting the request, rAF-batched token flushing (1.9), Stop via
  `AbortController`, `done` → invalidate list and detail then swap to history once loaded,
  stream-ended-without-terminal → "connection lost" + reload history, double-submit guard, handle
  409 (B4).
- **4d Composer:** Enter / Shift+Enter, 4000 code-point limit, disabled while streaming, focus
  returns after turn.
- **4e Safe rendering:** `react-markdown` with no raw HTML, `img` component overridden to render
  nothing, links `rel="noopener noreferrer" target="_blank"`, dangerous URL schemes rejected, tool
  `args`/`preview` rendered as text only. `aria-live` on the active turn.
**Verify:** tokens arrive incrementally; chip runs then completes; sources appear; reload matches;
Stop mid-answer then reload (check B5 outcome); continue the thread after restarting the API;
bad `OPENAI_API_KEY` → error banner and usable composer; expired token before send → transparent
refresh; second tab sending to the same thread gets a clear 409 message; a 5000-token answer stays
smooth.

### Phase 5 — Quality (spec `07-web-quality`)
- Unit: SSE parser, reducer, refresh single-flight and lock logic, code-point counter.
- Component (MSW, including a mocked SSE stream and a mocked mid-stream drop): login, upload +
  polling, chat turn, 401-before-stream retry.
- E2E (Playwright, fake model): register → upload → ready → ask → answer with tool chip and source.
- Error boundary per route, skeletons, "API unreachable" banner, keyboard and screen-reader pass,
  responsive pass.
- CI: typecheck, lint, tests, build, types-regeneration diff check.
**Verify:** `make check` green with web targets; E2E passes locally and in CI.

---

## 5. Extension points for agent hardening (unchanged in intent)

| Hardening feature | UI hook |
|---|---|
| Human-in-the-loop (`approval_required`, resume endpoint) | Reducer already has terminal states; add `awaiting_approval` and `ApprovalDialog`; composer disabled until resolved; 409 already handled via B4 |
| `pending_approval` on thread detail | Reopen dialog on load |
| Long-term memory | `/memories` page, same list pattern as documents |
| New tools | `ToolCallChip` is generic; distinct style for approval-gated tools |
| Untrusted-content envelope | Collapse `<untrusted>` wrappers in previews |

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Rotating refresh token races (tabs, StrictMode) | Module-level single-flight + Web Locks + re-read storage |
| `\r\n` SSE framing breaks parser | Tolerant line splitting + fixtures |
| Stream state lost on new-thread navigation | State above the router, `replace` navigation |
| UI history differs from live stream | B1/B2 so both come from the same shapes; reconcile on done/stop |
| Server keeps generating after Stop | B5 verification; cost note if it does |
| Concurrent turns corrupt a thread | B4 409 + client guard |
| Proxy buffering kills streaming | Disable buffering for `/api/v1/chat`; verify with `curl -N` in dev and prod |
| XSS reads refresh token | Strict markdown, no HTML, no remote images, CSP header on static serving, httpOnly cookie later |
| Types drift | Regenerate in CI, fail on diff; SSE types in one file |
| CI cost/flakiness from real LLM | Fake model for E2E |

## Later (explicitly out of scope)
Document-scoped chat, pagination/virtualization, httpOnly refresh cookie, message edit/regenerate,
dark mode, i18n.
