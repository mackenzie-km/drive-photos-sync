# drive-photos-sync

Why search through drive, hunting around for your old photos? This web app

- Uses AI (Google Gemini) to add labels to your Drive Photos to improve searching
- Then syncs photos from Google Drive to Google Photos, skipping duplicates

## Tech stack

- **Backend:** Node.js, TypeScript, Express
- **Database:** PostgreSQL
- **Auth:** Google OAuth 2.0
- **AI:** Google Gemini (generates photo descriptions from photo content)
- **Deployment:** Render (backend) · Vercel (frontend)

## Architecture

![Architecture diagram](./Architecture.png)

## How it works

1. You authenticate with Google via OAuth
2. You use the Google Drive Picker to select a specific folder to sync — this mints a separate, short-lived Google Identity Services (GIS) token in the browser just for the picker/Drive calls, distinct from the backend's stored OAuth token
3. The app discovers all image files in that folder (up to 10,000 with AI, up to 20,000 without) — skipped if you already have pending files from a previous sync (see [Sync lifecycle](#sync-lifecycle))
4. Each file is downloaded and optionally sent to Gemini to generate a descriptive caption
5. The file is uploaded to Google Photos with the caption attached
6. Progress streams to the browser in real time over Server-Sent Events (SSE) — no polling
7. Progress is tracked in Postgres — syncs are resumable and idempotent

### Authorization tokens

The Drive Picker and Drive API calls use a browser-minted GIS token (`google.accounts.oauth2.initTokenClient`), not the backend's stored OAuth token — `drive.file` scope authorization is tracked per-token-family, and using the backend token would make `files.list` return zero results even for folders you've already authorized. Minting a token and showing the folder-browser dialog are two separate steps: requesting a token silently (no popup) is enough to resume an existing sync, but picking a *new* folder requires the full picker dialog. `drive.file` grants persist per Google account, so a silently-minted token still has access to every folder you've previously picked.

## Local setup

### Prerequisites

- Node.js 20+
- PostgreSQL 16

```bash
# Install and start Postgres (macOS)
brew install postgresql@16
npm run db:start

# Create the local database
createdb drive_photos_sync
```

### Google Cloud Initial Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project and enable:
   - Google Drive API
   - Google Photos Library API
   - Gemini API
3. Create an OAuth 2.0 Client ID under **Credentials**
4. Add `http://localhost:3000/auth/callback` as an authorized redirect URI
5. Copy your Client ID and Client Secret
6. Add test/localdev users to OAuth Consent Screen Audience
7. Make sure Google Drive API, Google Photos Library API, and Google Picker API are enabled for this project.
8. Add Drive & Photos to your OAuth Scopes:

- https://www.googleapis.com/auth/drive.file
- https://www.googleapis.com/auth/photoslibrary.appendonly

### Environment

```bash
cp .env.example .env
```

Fill in `.env` in your main project root:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
OAUTH_REDIRECT_URI=http://localhost:3000/auth/callback
DATABASE_URL=postgres://localhost/drive_photos_sync
SESSION_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
GEMINI_API_KEY=...
PORT=3000
```

And also add one in your client folder:

```
VITE_GOOGLE_API_KEY=...
VITE_GOOGLE_API_KEY=...
```

### Run Backend

```bash
npm install
npm run db:start
npm run dev
```

> **Deploying backend changes:** The backend compiles TypeScript to `dist/` which is what Render runs. A pre-commit hook runs `npm run build` automatically and stages `dist/` for you — just commit and push as normal. The frontend (Vercel) deploys directly from source and does not need a build step.

## API

### Auth

| Method | Route            | Description                                                      |
| ------ | ---------------- | ---------------------------------------------------------------- |
| `GET`  | `/auth/me`       | Tells you if you're logged in or not                             |
| `GET`  | `/auth/url`      | Used to kick off the Google Auth workflow                        |
| `GET`  | `/auth/callback` | Exchanges auth code for tokens, saves to DB, sets session cookie |

### Sync (🔒 requires Google auth via `requireAuth` middleware)

| Method | Route          | Description                                                                                                                                                                                                                                                                                                                |
| ------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/sync/events` | Opens a Server-Sent Events stream. Sends a full snapshot immediately on connect (and on every reconnect), then pushes live updates as discovery/upload progresses. This is what the frontend uses in place of polling.                                                                                                    |
| `GET`  | `/sync/status` | One-shot snapshot of sync progress (status, current file, file counts). Superseded by `/sync/events` for the live UI; still useful for scripts or a manual check.                                                                                                                                                          |
| `GET`  | `/sync/files`  | Returns list of already uploaded files                                                                                                                                                                                                                                                                                     |
| `POST` | `/sync/start`  | Kicks off the sync process. Requires `folderId` (from the Picker) and accepts `useAI` (default `true`). Discovers photos in the selected folder, saves records to DB, optionally sends photos to Gemini for descriptions, then uploads to Google Photos one at a time. Capped at 10,000 files per sync with AI, 20,000 without. |
| `POST` | `/sync/abort`  | Gracefully stops sync: immediately clears local memory and sets a flag so the loop stops after the current file finishes                                                                                                                                                                                                   |
| `POST` | `/sync/pending/clear` | Drops the user's global pending backlog instead of processing it. Rejected with 400 while a sync is running, to avoid deleting rows out from under an in-flight upload batch.                                                                                                                                       |

### Health

| Method | Route     | Description                                      |
| ------ | --------- | ------------------------------------------------ |
| `GET`  | `/health` | Confirms database and backend are up and running |

## Database schema

### tokens

| Column          | Type     | Notes                                       |
| --------------- | -------- | ------------------------------------------- |
| `user_id`       | `TEXT`   | Primary key                                 |
| `access_token`  | `TEXT`   | Nullable                                    |
| `refresh_token` | `TEXT`   | Nullable; preserved on refresh via COALESCE |
| `expiry_date`   | `BIGINT` | Unix timestamp; nullable                    |

### drive_files

| Column              | Type      | Notes                                                                   |
| ------------------- | --------- | ----------------------------------------------------------------------- |
| `id`                | `TEXT`    | Composite primary key with `user_id` (Google Drive file ID)             |
| `user_id`           | `TEXT`    | Composite primary key with `id`                                         |
| `name`              | `TEXT`    |                                                                         |
| `md5`               | `TEXT`    | Nullable; used for dedup                                                |
| `mime_type`         | `TEXT`    |                                                                         |
| `size`              | `BIGINT`  | Nullable                                                                |
| `status`            | `TEXT`    | `uninitialized` \| `in_progress` \| `uploaded` \| `failed` \| `skipped` |
| `photos_media_id`   | `TEXT`    | Nullable; set after successful upload                                   |
| `error`             | `TEXT`    | Nullable; last error message                                            |
| `retry_count`       | `INTEGER` | Files with `retry_count >= 3` are not retried                           |
| `discovered_at`     | `BIGINT`  | Unix timestamp                                                          |
| `last_attempted_at` | `BIGINT`  | Unix timestamp; nullable                                                |
| `synced_at`         | `BIGINT`  | Unix timestamp; nullable                                                |

### sync_runs

| Column         | Type      | Notes                                                           |
| -------------- | --------- | --------------------------------------------------------------- |
| `id`           | `SERIAL`  | Primary key                                                     |
| `user_id`      | `TEXT`    |                                                                 |
| `status`       | `TEXT`    | `running` \| `done` \| `failed` \| `aborted` \| `limit_reached` |
| `total`        | `INTEGER` |                                                                 |
| `uploaded`     | `INTEGER` |                                                                 |
| `skipped`      | `INTEGER` |                                                                 |
| `failed`       | `INTEGER` |                                                                 |
| `started_at`   | `BIGINT`  | Unix timestamp                                                  |
| `completed_at` | `BIGINT`  | Unix timestamp; nullable                                        |

> **Note:** `sync_runs`'s `total`/`uploaded`/`skipped`/`failed` are counts for *that one run* only. They're unrelated to the `fileCounts` object returned by `/sync/status` and `/sync/events`, which is always a fresh, live query of `drive_files` and represents all-time totals across every folder and run for that user — the two are not meant to match.

## Sync lifecycle

Each file in `drive_files` moves through these states:

```
uninitialized → in_progress → uploaded
                            → failed (retried up to 3 times)
                            → skipped (duplicate md5)
```

At the start of each sync run:

- Files stuck in `in_progress` (e.g. from a crash) are reset to `uninitialized` (across all folders, as a crash-recovery safety net)
- **Discovery is conditional:** if you already have `uninitialized` (pending) files from a previous sync — in *any* folder, not just the one just picked — discovery is skipped entirely and the sync goes straight to uploading that backlog. Discovery (and picking a folder) only happens once the backlog is empty.
- `failed` files are left in place and retried automatically (up to 3 attempts) on the next sync — they are not cleared, and are picked up from any folder the same way pending files are
- This combination is what makes resuming after a page refresh work without ever needing to re-pick the original folder — the app doesn't need to remember which folder you were syncing, only that a backlog exists

## Real-time updates (SSE)

The frontend gets live sync progress over a Server-Sent Events stream (`GET /sync/events`) instead of polling. One long-lived connection stays open per browser tab:

- On connect (including automatic reconnects), the server immediately sends a full snapshot — current phase, current file, and file counts — so the UI is never blank or stale.
- As discovery/upload progresses, the server pushes updates: unthrottled at phase transitions (`discovering` → `uploading` → done), and throttled to roughly once per second during the per-file hot loop, to keep database load bounded no matter how fast files process.
- A heartbeat comment is sent every 15 seconds to keep the connection alive through proxies that time out idle connections.
- File counts are always read fresh from the database rather than tracked locally in memory — they represent totals across all of a user's folders and past syncs, not just the current run, so they can't be reconstructed from a single run's local counters.

## npm scripts

| Script             | Description                  |
| ------------------ | ---------------------------- |
| `npm run dev`      | Start server with hot reload |
| `npm run build`    | Compile TypeScript           |
| `npm start`        | Run compiled output          |
| `npm test`         | Run Jest tests               |
| `npm run db:start` | Start local Postgres         |
| `npm run db:stop`  | Stop local Postgres          |

## Deployment

### Render (backend)

Set these environment variables in the Render dashboard:

```
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
OAUTH_REDIRECT_URI=https://your-domain.com/auth/callback  # must match Google Cloud Console
DATABASE_URL        # provided automatically by Render Postgres addon
SESSION_SECRET
GEMINI_API_KEY
FRONTEND_URL=https://your-domain.com
NODE_ENV=production
```

Also register `https://your-domain.com/auth/callback` as an authorized redirect URI in Google Cloud Console.
And register `https://your-domain.com` as an authorized JavaScript Origin in Google Cloud Console.

### Vercel (frontend)

Set these environment variables in the Vercel project dashboard:

```
BACKEND_URL=https://your-backend.onrender.com
VITE_GOOGLE_CLIENT_ID
VITE_GOOGLE_API_KEY
```

This is used by the `/api/auth/callback` serverless function, which proxies the OAuth callback from Google to the Render backend and forwards the `Set-Cookie` header back to the browser. Vercel's rewrite proxy strips `Set-Cookie` headers, so `/auth/callback` uses a serverless function instead — all other routes use rewrites in `vercel.json`.
