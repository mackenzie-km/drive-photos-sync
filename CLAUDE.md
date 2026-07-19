# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Backend
npm run db:start   # start local Postgres (Homebrew pg@16)
npm run db:stop
npm run dev        # backend with hot reload (port 3000)
npm run build      # tsc compile → dist/
npm test           # jest (all backend tests)
npx jest src/sync.test.ts              # single test file
npx jest -t "concurrent guard"         # single test by name

# Frontend (cd client/)
npm run dev        # Vite dev server (port 5173, proxied to 3000)
npm run build      # tsc + Vite build
npm run lint       # eslint
npm test           # vitest run (one-shot)
npm run test:watch # vitest watch
```

The pre-commit hook runs `npm run build` and stages `dist/`. Render serves the compiled output. Do not skip the hook.

The pre-commit hook also best-effort auto-logs one line to `DECISIONS.md` per commit (via the `decision-log` skill's `log-decision.js` helper) when the staged diff looks like a real design/behavior decision — trivial commits (wording, formatting, docs) are skipped. The hook itself lives only in `.git/hooks/pre-commit`, not tracked by git, matching how the build-stage hook was already set up before this existed. Neither the skill (`~/.claude/skills/decision-log/SKILL.md`) nor its helper script live in this repo — both are global, since the skill needs to travel across clones/machines independent of this repo's gitignore rules. For backfilling history or manually reviewing/logging a decision, use that skill.

## Architecture

- **Backend**: Node/Express (`src/`) — OAuth, Drive discovery, Gemini, Photos upload
- **Frontend**: React/Vite (`client/`) — single page, subscribes to `/sync/events` (SSE) for live progress instead of polling; `/sync/status` remains as a one-shot snapshot endpoint
- **Database**: Postgres — tokens, file sync state, session data (`connect-pg-simple`)
- **Deployment**: Render (backend) + Vercel (frontend)

All backend routes are in `src/routes.ts`. Sync logic lives entirely in `src/sync.ts`. DB queries are collected in `src/db.ts` — no ORM, raw `pg` queries.

## Key design decisions

### Drive file authorization uses GIS tokens, not backend tokens

The Google Drive Picker must use a GIS token (`google.accounts.oauth2.initTokenClient`) — not the stored backend token — because `drive.file` scope authorization is tracked per-token-family. Using the backend token for the picker causes `files.list` to return zero results, even for previously-authorized folders. The GIS token is passed as `driveAccessToken` to both the picker and the backend `/sync/start` call. The backend uses this token for all Drive API calls via `createClientFromToken(driveAccessToken)`.

Minting the token and showing the folder-browser dialog are separate GIS calls: `requestAccessToken({ prompt: "" })` alone mints silently with no popup; wrapping it in `gapi.load("picker", ...)` shows the dialog. `drive.file` grants persist per Google account regardless of which pick minted the token, so a silent token still retains access to every previously-granted folder. `MainPage.tsx`'s `getDriveToken()` (silent) resumes a pending backlog; `openPicker()` (full) is used when a new folder must be picked.

### Two-phase sync

`runSync` in `sync.ts` has two explicit phases:

1. **Discovery**: pages through Drive and upserts all matching files into `drive_files` as `uninitialized`
2. **Upload**: processes `uninitialized` files in batches — downloads from Drive, optionally sends to Gemini, uploads to Photos

Phase 1 is conditionally skipped, and the signal for that is **`folderId === null`** — nothing else. The route (`routes.ts`) is the only place that decides whether discovery is needed (via `getResumableCount`, see below) and passes `folderId: null` when it isn't; `runSync` just honors whatever it's given and never re-derives that decision itself. Concretely: a real `folderId` always means "discover this folder," full stop, even if the user has a backlog sitting in some other folder — the two are unrelated. `folderId === null` means "resume the global backlog," and only happens because the route already confirmed one exists.

**Do not reintroduce a second "is there a backlog" check inside `runSync`** — the route's decision, expressed as `folderId` being null or not, is the only signal it should ever act on.
`resetStuckFiles` still runs unconditionally at the start of every sync regardless of this branch (crash recovery). Failed files are intentionally left in place for retry (see below).

### Real-time progress via SSE, not polling

`GET /sync/events` (`routes.ts`) opens a Server-Sent Events stream. Connections are tracked in `sync.ts` via an in-memory `Map<userId, Set<Response>>` (`userSyncClients`) — single-process only; a sync running on one Node instance won't push to a browser connected to another instance if this is ever scaled horizontally. `/sync/status` still exists as a one-shot REST snapshot (used by scripts, or a manual check) but the frontend no longer polls it.

Two push functions exist, both DB-backed:

- **`pushSnapshot`** — full snapshot via `getSyncSnapshot`, called once per new/reconnected connection and unthrottled at phase transitions (`discovering`/`uploading`) and in `finishRun`.
- **`pushProgress`** — the per-file hot-path push, throttled to ~1/sec via a `lastProgressPushAt` timestamp map, to bound DB load regardless of how fast files process.

**Both query `getFileCounts` fresh rather than using `runSync`'s local closure counters (`uploaded`/`skipped`/`failed`).** This was a real bug during development: those counters mean "uploaded this run" and start at 0, but `fileCounts` has always meant "all-time totals across all folders for this user" everywhere else in the app (`getFileCounts` is not scoped to a run or folder). Building the per-file push from local counters overwrote the real cumulative "uploaded" count with 0 the instant a new sync's discovery phase began, because the frontend replaces its whole state object on each SSE message rather than merging. Do not reintroduce local-counter-based `fileCounts` in the hot path — always re-query.

`finishRun`'s terminal push also queries `getFileCounts` directly rather than trusting its own `total`/`uploaded`/`skipped`/`failed` parameters, because `startSync`'s fire-and-forget `.catch()` calls `finishRun(userId, runId, "failed", 0, 0, 0, 0)` when `runSync` throws mid-sync (e.g. an expired `driveAccessToken` partway through discovery) — those args are hardcoded zeros with no relation to what was actually discovered/uploaded before the failure.

A heartbeat comment (`:\n\n`) is written every 15s to keep the connection alive through proxies that kill idle connections; `req.on("close")` removes the client from `userSyncClients` and clears its heartbeat timer to avoid leaking dead connections and their intervals.

### Folder-scoped sync state (discovery only)

`drive_files` has a `folder_id` column, and `upsertDriveFile` still tags every discovered file with the folder it came from. Discovery (Phase 1) is scoped to whichever `folderId` was passed in. `resetStuckFiles` is intentionally unscoped — it resets all `in_progress` rows regardless of folder as a crash-recovery safety net.

### Pending resume is folder-agnostic (upload/retry phase)

`getUninitializedFiles(userId)` — Phase 2's batch query — is **not** scoped to a folder. It pulls every `uninitialized` row and every retryable `failed` row (`retry_count < 3`) for the user, across all folders, as one global work queue. This is deliberate: a page refresh wipes the frontend's `folderId` state, and requiring the exact original folder to be re-picked to resume was real friction. Combined with the Phase 1 skip above, resuming after a refresh needs nothing more than a silently-minted token (see the GIS token note above) — no folder re-selection at all.

`getResumableCount(userId)` (`db.ts`) mirrors this exact query as a `COUNT(*)` — it's the one place that decides "is there a backlog to resume," and every other check that needs that fact calls it (or, for the SSE/status payload, reads the `resumableCount` field that `getCountsPayload` computes from it) rather than re-deriving it from `fileCounts.uninitialized`. That distinction matters: `fileCounts.uninitialized` (the "Pending" stat tile, and what `clearPendingFiles` acts on) is narrower than `getResumableCount` (which also includes retryable `failed` rows). **Keep these two counts conceptually separate** — a user whose entire backlog is retryable `failed` rows has `fileCounts.uninitialized === 0` but `resumableCount > 0`, and the frontend's Resume/Start button logic must key off `resumableCount`, not `fileCounts.uninitialized`, or a failed-only backlog silently can't be resumed without an unnecessary folder re-pick.

### Failed file retry across runs

Failed files with `retry_count < 3` are not cleared at sync start — they persist and are picked up by `getUninitializedFiles` globally on the next run, same as true pending files. `clearFailedFiles(userId, folderId)` exists in `db.ts` and is folder-scoped, but is not called during sync; it's available for a future "clear failed" UI action.

### Clearing the pending backlog

`clearPendingFiles(userId)` is its global (not folder-scoped) counterpart for pending files — wired up to `POST /sync/pending/clear`, letting a user deliberately drop the backlog instead of processing it. It only ever deletes `status = 'uninitialized'` rows (never retryable `failed` ones), which is why its UI visibility is tied to `fileCounts.uninitialized`, not `resumableCount` — showing it whenever there's a "resumable" backlog would let a user click Clear and see nothing happen if that backlog was all retryable failures. The route checks `getSyncState(userId).status` (cheap, in-memory) rather than `getSyncSnapshot` — no need for the latter's DB round trips just to read a status that's already held in memory — and rejects with 400 while a sync is running, to avoid deleting rows out from under an in-flight upload batch.

### Streaming is not possible when AI is on

Gemini requires the full file buffer (`inlineData`). Files are downloaded entirely into memory before anything is sent. There is a 200MB size check before download to prevent OOM.

### Sync state is in-memory

`userSyncState` (a Map in `sync.ts`) tracks per-user sync progress. It is lost on server restart. `getSyncSnapshot` (used by both `/sync/status` and the first SSE message on connect) detects a `running` DB row with no matching in-memory state and marks it `failed`, prompting the user to re-run. `userSyncClients` (the SSE connection registry) is likewise in-memory and lost on restart, but this is self-healing: `EventSource` auto-reconnects on its own, and every new connection gets a fresh `getSyncSnapshot` immediately.

### md5 deduplication

Before uploading, we check if another file with the same `md5` is already `uploaded` for this user. If so, we skip it. `md5` comes from Drive's `md5Checksum` field — it's null for Google-native files (Docs, Sheets, etc.), which are excluded by the mime type filter anyway.

### Token refresh is automatic

`getAuthClient` sets up a `"tokens"` event listener on the OAuth2 client. When the googleapis library auto-refreshes an expired access token, the listener persists the new token back to the DB.

## Important gotchas

- **`upsertDriveFile` has a conditional update**: `ON CONFLICT DO UPDATE ... WHERE status = 'uninitialized'` — re-discovering an already-uploaded file is a no-op. Correct behavior.
- **`withRetry` is selective**: only retries on 429 and transient network errors (`ENOTFOUND`, `ECONNRESET`, `ETIMEDOUT`). All other errors fail immediately. Do not make it retry everything.
- **`drive.readonly` scope is a restricted scope** and requires Google's CASA security assessment (expensive). Do not add it. The app stays within `drive.file`.
- **Session lives in Postgres** via `connect-pg-simple`. The `session` table is created automatically. Old sessions are not purged automatically.
- **`driveAccessToken` can expire** (access tokens last ~1 hour). `createClientFromToken` has no refresh mechanism. If Drive calls start failing mid-sync, the token has likely expired. The frontend needs a fresh one — via `getDriveToken()` (silent, no dialog) if there's a pending backlog, or `openPicker()` (shows the folder browser) otherwise. `MainPage.tsx` tracks `tokenMintedAt` and treats a token older than `TOKEN_MAX_AGE_MS` (50 min, a buffer under the ~1hr real expiry) as stale, re-minting silently before reuse rather than risking a whole batch fail with a confusing generic error.
- **`folderId`/`driveAccessToken` are optional together on `/sync/start`** — but only when `folderId` is omitted entirely (checked server-side via `getResumableCount`, not `getSyncSnapshot` — the latter has a stale-run-correction side effect via `requestAbort` that has no business firing on every single `/sync/start` call). Don't reintroduce a hard `folderId` requirement without checking `getResumableCount` first; discovery genuinely doesn't need one when there's a backlog to resume instead. Conversely, a real `folderId` is never blocked by an existing backlog elsewhere — see the "Two-phase sync" note above.
- **File size limit**: 200MB. Files above this are skipped with status `skipped` and reason `"file too large"`.
- **`sync_runs` and `drive_files` are not linked by foreign key**. `sync_runs` tracks aggregate counts per run; individual file attribution across runs is not tracked.
- **Crash window between upload and DB write**: if the server crashes after `uploadPhoto` returns but before `updateFileStatus("uploaded")` completes, the photo is already in Google Photos but the DB row will be reset to `uninitialized` on the next sync and re-uploaded. md5 dedup won't catch this because it only matches `status = 'uploaded'` rows.
- **`MAX_PER_SYNC` in `sync.ts` and the AI checkbox label in `client/src/MainPage.tsx` must stay in sync**: they drifted once already (label said "up to 1,000 photos" for three months after the code was raised to 10,000). No shared constant enforces this — check both when changing either.

## Supported mime types

Defined in `drive.ts` and mirrored in `photos.ts`. Must stay in sync:

```
image/jpeg, image/png, image/gif, image/heic, image/heif, image/webp, image/tiff, image/bmp
```

`image/raw` and `image/svg+xml` are intentionally excluded — Photos can't reliably import them.

## Environment variables

Backend (`.env`):

```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
OAUTH_REDIRECT_URI
DATABASE_URL
SESSION_SECRET
GEMINI_API_KEY
GOOGLE_API_KEY      # optional — used for picker quota tracking only
PORT
FRONTEND_URL
```

Frontend (`client/.env`): none required. `client_id` and `api_key` are fetched from `/picker/config` at runtime.
