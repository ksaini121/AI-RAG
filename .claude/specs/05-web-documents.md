# Spec: Web Documents

## Overview
Build the `/documents` page of the `web/` frontend so a signed-in user can upload documents, watch
them move through ingestion with live status, and delete them. It wires the existing, unchanged
`/api/v1/documents` backend (Phase 2 of `IMPLEMENTATION_UI_FINAL.md`) into the placeholder route in
`web/src/routes.tsx`. It sits after auth (01) and the chat API (03) because it reuses the
authenticated client and layout, and it precedes the chat UI (06), which needs ingested documents.

## Depends on
- 01 login / JWT / refresh (web `AuthProvider`, `authFetch`/`request` in `web/src/api/client.ts`)
- 03 chat API + web shell (`Layout`, `RequireAuth`, `/documents` placeholder route)
- Backend document ingestion (Temporal workflow, `DocumentService`) — already merged

## Routes
No new routes. Existing backend routes consumed (all authenticated, bearer token):
- `POST /api/v1/documents` — multipart `file` → `DocumentRead` — 202 (422 on bad type/size/name)
- `GET /api/v1/documents` — → `list[DocumentRead]` — 200
- `DELETE /api/v1/documents/{document_id}` — → no body — 204 (404 if not owned/missing)

Not used by the UI: `GET /documents/{id}` and `GET /documents/{id}/status` (list polling covers it).
Note: the backend returns **422** for both unsupported content type and oversize files (no 413/415);
the UI must render the 422 message from `ApiError`.

## Schemas
No backend schema changes. Frontend types to add in `web/src/api/types.ts` (hand-written, mirroring
`app/schema/document.py`):
- `DocumentStatus = 'pending' | 'parsing' | 'chunking' | 'embedding' | 'ready' | 'failed'`
- `Document { id, filename, content_type, size_bytes, status, error: string | null, chunk_count,
  created_at, updated_at }`

## Database changes
No database changes.

## Services
Frontend only — a thin API module, no backend services:
- `listDocuments(): Promise<Document[]>` → `request('/documents')`
- `uploadDocument(file: File, onProgress: (pct: number) => void, signal?: AbortSignal):
  Promise<Document>` — uses `XMLHttpRequest` (fetch has no upload progress) with the same bearer
  token and one refresh-and-retry on 401 as `authFetch`; rejects with `ApiError` / `NetworkError`
- `deleteDocument(id: string): Promise<void>` → `request(..., { method: 'DELETE' })`

## Config
No config changes (backend). Frontend reads existing `VITE_API_BASE`. Client-side limits mirror
the server but the server stays authoritative:
- Allowed types: `.pdf .docx .txt .md .csv .xlsx`
- Max size: 25 MB (`MAX_UPLOAD_BYTES` default 26214400), as a constant in the documents feature

## Files to change
- `web/src/routes.tsx` — replace the `/documents` `Placeholder` with `DocumentsPage`
- `web/src/api/types.ts` — add `Document` and `DocumentStatus`
- `web/src/main.tsx` — only if no `QueryClientProvider` is mounted yet (React Query is already a dependency)

## Files to create
- `web/src/features/documents/api.ts` — `listDocuments`, `uploadDocument` (XHR + progress), `deleteDocument`
- `web/src/features/documents/useDocuments.ts` — React Query hooks: list with polling, upload and delete mutations
- `web/src/features/documents/DocumentsPage.tsx` — page: dropzone, upload queue, table, empty/error/loading states
- `web/src/features/documents/Dropzone.tsx` — drag-drop + file picker with client pre-checks (type, size, name length 4–100)
- `web/src/features/documents/DocumentRow.tsx` — filename, size, chunk count, created time, `StatusBadge`, delete button
- `web/src/features/documents/StatusBadge.tsx` — stepper `pending → parsing → chunking → embedding → ready`; `failed` shows `error`
- `web/src/features/documents/constants.ts` — allowed extensions/MIME map and max size

## New dependencies
No new dependencies (`@tanstack/react-query` is already in `web/package.json`).

## Tests
None requested for this spec — no new Vitest or pytest cases. Verification is manual (see Definition of done).

## Rules for implementation
- Backend is untouched; imports/layering rules from `CLAUDE.md` apply if that changes later
- All requests go through `request`/`authFetch` (or the XHR equivalent) so token refresh and `ApiError` parsing stay in one place
- Polling: a single `GET /documents` every 2 s **only while any document is non-terminal** (`status` not `ready`/`failed`); stop when all are terminal; back off on errors; no per-document polling
- Client validation is a convenience only: always render the server's 422 `ApiError` message, and never assume a client pre-check passed means the server accepts the file
- Delete asks for confirmation, removes the row optimistically, and rolls back with an error message on failure; deleting during ingestion must not crash polling
- Show readable states for: empty list, loading, list-fetch error, network error, upload error per file
- Do not store tokens or file contents in `localStorage`; abort in-flight uploads on unmount
- Match existing frontend style: Tailwind utility classes, function components, strict TypeScript, no `any`
- Must pass `npm run typecheck`, `npm run lint` and `npm run build` in `web/`

## Definition of done
- [ ] `cd web && npm run typecheck && npm run lint && npm run build` all pass
- [ ] `make db-up`, `make migrate`, Temporal + worker running, `make dev`, `cd web && npm run dev`; signed-in user opens `/documents` and sees an empty-state message
- [ ] Uploading a small `.pdf`/`.txt` shows progress, the row appears as `pending`, and its badge advances to `ready` with a non-zero chunk count without a page reload
- [ ] Uploading an unsupported type (e.g. `.png`) or a file over 25 MB shows a readable error and no row is added
- [ ] A failed ingestion shows the `failed` badge with its `error` text
- [ ] Deleting a document asks for confirmation, removes the row, and `GET /api/v1/documents` no longer returns it (204 then 404 on repeat delete)
- [ ] With every document `ready`/`failed`, the browser Network tab shows no further `GET /documents` polling
- [ ] Reloading the page keeps the user signed in and the document list intact
