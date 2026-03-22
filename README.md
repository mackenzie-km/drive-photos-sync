# drive-photos-sync

Why search through drive, hunting around for your old photos? This web app

- Uses AI to add labels to your Drive Photos to improve searching
- Then syncs photos from Google Drive to Google Photos, skipping duplicates

## Tech stack

- **Backend:** Node.js, TypeScript, Express
- **Database:** PostgreSQL
- **Auth:** Google OAuth 2.0
- **Deployment:** Render (backend) · Vercel (frontend)

## How it works

1. You authenticate with Google via OAuth
2. The app discovers all image files in your Drive
3. Each file is streamed directly from Drive to Google Photos (no disk buffering)
4. Progress is tracked in Postgres — syncs are resumable and idempotent

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

### Google Cloud setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project and enable:
   - Google Drive API
   - Google Photos Library API
3. Create an OAuth 2.0 Client ID under **Credentials**
4. Add `http://localhost:3000/auth/callback` as an authorized redirect URI
5. Copy your Client ID and Client Secret
6. Make sure Google Drive & Google Photos are set up as enabled APIs for this project.
7. Add Drive & Photos to your OAuth Scopes:

- https://www.googleapis.com/auth/drive.readonly
- https://www.googleapis.com/auth/photoslibrary.appendonly

### Environment

```bash
cp .env.example .env
```

Fill in `.env`:

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
OAUTH_REDIRECT_URI=http://localhost:3000/auth/callback
DATABASE_URL=postgres://localhost/drive_photos_sync
SESSION_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
PORT=3000
```

### Run Backend

```bash
npm install
npm run db:start
npm run dev
```

## API

| Method | Route            | Description                               |
| ------ | ---------------- | ----------------------------------------- |
| `GET`  | `/auth/url`      | Get the Google OAuth login URL            |
| `GET`  | `/auth/callback` | OAuth redirect handler (called by Google) |
| `GET`  | `/auth/me`       | Returns the logged-in user's ID           |
| `POST` | `/sync/start`    | Start a sync run                          |
| `POST` | `/sync/abort`    | Gracefully stop a running sync            |
| `GET`  | `/sync/status`   | Get current sync state and file counts    |

## Sync lifecycle

Each file in `drive_files` moves through these states:

```
uninitialized → in_progress → uploaded
                            → failed (retried up to 3 times)
                            → skipped (duplicate md5)
```

Files stuck in `in_progress` (e.g. from a crash) are reset to `uninitialized` at the start of each sync run.

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
OAUTH_REDIRECT_URI=https://your-backend.onrender.com/auth/callback
DATABASE_URL        # provided automatically by Render Postgres addon
SESSION_SECRET
FRONTEND_URL=https://your-frontend.vercel.app
NODE_ENV=production
```

Also register `https://your-backend.onrender.com/auth/callback` as an authorized redirect URI in Google Cloud Console.
