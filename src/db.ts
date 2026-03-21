import Database from "better-sqlite3";
import path from "path";

const db = new Database(path.join(process.cwd(), "sync.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    user_id       TEXT PRIMARY KEY,
    access_token  TEXT,
    refresh_token TEXT,
    expiry_date   INTEGER
  );

  CREATE TABLE IF NOT EXISTS drive_files (
    id              TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    name            TEXT NOT NULL,
    md5             TEXT,
    mime_type       TEXT NOT NULL,
    size            INTEGER,
    status          TEXT NOT NULL DEFAULT 'uninitialized',
    photos_media_id TEXT,
    error           TEXT,
    retry_count     INTEGER NOT NULL DEFAULT 0,
    discovered_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    last_attempted_at INTEGER,
    synced_at       INTEGER,
    PRIMARY KEY (id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_drive_files_status ON drive_files(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_drive_files_md5    ON drive_files(user_id, md5);

  CREATE TABLE IF NOT EXISTS sync_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'running',
    total        INTEGER DEFAULT 0,
    uploaded     INTEGER DEFAULT 0,
    skipped      INTEGER DEFAULT 0,
    failed       INTEGER DEFAULT 0,
    started_at   INTEGER NOT NULL DEFAULT (unixepoch()),
    completed_at INTEGER
  );
`);

export const saveTokens = db.prepare(
  `INSERT OR REPLACE INTO tokens (user_id, access_token, refresh_token, expiry_date)
   VALUES (?, ?, ?, ?)`,
);

export const getTokens = db.prepare(`SELECT * FROM tokens WHERE user_id = ?`);

// If the file (id + user_id) already exists in DB and it's still unInitialized
// Use the incoming metadata to update the existing line item
export const upsertDriveFile = db.prepare(
  `INSERT INTO drive_files (id, user_id, name, md5, mime_type, size)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(id, user_id) DO UPDATE SET
     name      = excluded.name,
     md5       = excluded.md5,
     mime_type = excluded.mime_type,
     size      = excluded.size
   WHERE status = 'uninitialized'`,
);

// Returns truthy if a *different* file with the same md5 is already uploaded for this user
export const getMd5Uploaded = db.prepare(
  `SELECT id FROM drive_files WHERE user_id = ? AND md5 = ? AND status = 'uploaded' LIMIT 1`,
);

// Mark a file as in_progress before touching the network — so a crash mid-upload
// leaves a clear signal rather than a file stuck in 'uninitialized' forever.
export const markFileInProgress = db.prepare(
  `UPDATE drive_files
   SET status = 'in_progress', last_attempted_at = unixepoch()
   WHERE id = ? AND user_id = ?`,
);

// retryCountIncrement: pass 1 for failures, 0 for success/skipped
export const updateFileStatus = db.prepare(
  `UPDATE drive_files
   SET status = ?, photos_media_id = ?, error = ?,
       retry_count = retry_count + ?, synced_at = unixepoch()
   WHERE id = ? AND user_id = ?`,
);

// On startup, reset any files stuck in_progress from a previous crash back to uninitialized
export const resetStuckFiles = db.prepare(
  `UPDATE drive_files SET status = 'uninitialized' WHERE user_id = ? AND status = 'in_progress'`,
);

// Pick up both fresh uninitialized files and failed files that haven't exceeded the retry limit
export const getUninitializedFiles = db.prepare(
  `SELECT * FROM drive_files
   WHERE user_id = ? AND (status = 'uninitialized' OR (status = 'failed' AND retry_count < 3))
   LIMIT 50`,
);

export const getFileCounts = db.prepare(
  `SELECT status, COUNT(*) as count FROM drive_files WHERE user_id = ? GROUP BY status`,
);

export const createSyncRun = db.prepare(
  `INSERT INTO sync_runs (user_id) VALUES (?)`,
);

export const updateSyncRun = db.prepare(
  `UPDATE sync_runs
   SET status = ?, total = ?, uploaded = ?, skipped = ?, failed = ?, completed_at = ?
   WHERE id = ? AND user_id = ?`,
);

export const getLatestSyncRun = db.prepare(
  `SELECT * FROM sync_runs WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
);

export default db;
