import { Pool } from "pg";

// A Pool manages multiple connections — rather than opening/closing a connection
// on every query, it keeps a set open and reuses them across requests.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 30000,
});

export { pool };

export const query = (text: string, params?: any[]) => pool.query(text, params);

// Called once at startup before the server begins accepting requests.
// CREATE TABLE IF NOT EXISTS is safe to run on every boot.
export async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS tokens (
      user_id       TEXT PRIMARY KEY,
      access_token  TEXT,
      refresh_token TEXT,
      expiry_date   BIGINT
    );

    CREATE TABLE IF NOT EXISTS drive_files (
      id                TEXT NOT NULL,
      user_id           TEXT NOT NULL,
      name              TEXT NOT NULL,
      md5               TEXT,
      mime_type         TEXT NOT NULL,
      size              BIGINT,
      status            TEXT NOT NULL DEFAULT 'uninitialized',
      photos_media_id   TEXT,
      error             TEXT,
      retry_count       INTEGER NOT NULL DEFAULT 0,
      discovered_at     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      last_attempted_at BIGINT,
      synced_at         BIGINT,
      PRIMARY KEY (id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_drive_files_status ON drive_files(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_drive_files_md5    ON drive_files(user_id, md5);

    CREATE TABLE IF NOT EXISTS sync_runs (
      id           SERIAL PRIMARY KEY,
      user_id      TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'running',
      total        INTEGER DEFAULT 0,
      uploaded     INTEGER DEFAULT 0,
      skipped      INTEGER DEFAULT 0,
      failed       INTEGER DEFAULT 0,
      started_at   BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      completed_at BIGINT
    );
  `);
}

export async function saveTokens(
  userId: string,
  accessToken: string | null,
  refreshToken: string | null,
  expiryDate: number | null,
) {
  await query(
    `INSERT INTO tokens (user_id, access_token, refresh_token, expiry_date)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET
       access_token  = $2,
       refresh_token = COALESCE($3, tokens.refresh_token),
       expiry_date   = $4`,
    [userId, accessToken, refreshToken, expiryDate],
  );
}

export async function getTokens(userId: string) {
  const result = await query(`SELECT * FROM tokens WHERE user_id = $1`, [
    userId,
  ]);
  return result.rows[0] ?? null;
}

// If the file (id + user_id) already exists in DB and it's still uninitialized,
// use the incoming metadata to update the existing row.
export async function upsertDriveFile(
  id: string,
  userId: string,
  name: string,
  md5: string | null,
  mimeType: string,
  size: number | null,
) {
  await query(
    `INSERT INTO drive_files (id, user_id, name, md5, mime_type, size)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id, user_id) DO UPDATE SET
       name      = $3,
       md5       = $4,
       mime_type = $5,
       size      = $6
     WHERE drive_files.status = 'uninitialized'`,
    [id, userId, name, md5, mimeType, size],
  );
}

// Returns the row if a file with the same md5 is already uploaded for this user, null otherwise
export async function getMd5Uploaded(userId: string, md5: string) {
  const result = await query(
    `SELECT id FROM drive_files WHERE user_id = $1 AND md5 = $2 AND status = 'uploaded' LIMIT 1`,
    [userId, md5],
  );
  return result.rows[0] ?? null;
}

// Mark a file as in_progress before touching the network — so a crash mid-upload
// leaves a clear signal rather than a file stuck in 'uninitialized' forever.
export async function markFileInProgress(id: string, userId: string) {
  await query(
    `UPDATE drive_files
     SET status = 'in_progress', last_attempted_at = EXTRACT(EPOCH FROM NOW())::BIGINT
     WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
}

// retryCountIncrement: pass 1 for failures, 0 for success/skipped
export async function updateFileStatus(
  status: string,
  photosMediaId: string | null,
  error: string | null,
  retryCountIncrement: number,
  id: string,
  userId: string,
) {
  await query(
    `UPDATE drive_files
     SET status = $1, photos_media_id = $2, error = $3,
         retry_count = retry_count + $4,
         synced_at = EXTRACT(EPOCH FROM NOW())::BIGINT
     WHERE id = $5 AND user_id = $6`,
    [status, photosMediaId, error, retryCountIncrement, id, userId],
  );
}

// On startup, reset any files stuck in_progress from a previous crash back to uninitialized
export async function resetStuckFiles(userId: string) {
  await query(
    `UPDATE drive_files SET status = 'uninitialized'
     WHERE user_id = $1 AND status = 'in_progress'`,
    [userId],
  );
}

// Clear failed files at the start of each sync so stale failures don't carry over
export async function clearFailedFiles(userId: string) {
  await query(
    `DELETE FROM drive_files WHERE user_id = $1 AND status = 'failed'`,
    [userId],
  );
}

// Clear uninitialized files before each sync so discovery re-populates them
// up to the current limit — prevents stale counts from prior runs skewing the UI.
export async function clearUninitializedFiles(userId: string) {
  await query(
    `DELETE FROM drive_files WHERE user_id = $1 AND status = 'uninitialized'`,
    [userId],
  );
}

// Pick up both fresh uninitialized files and failed files that haven't exceeded the retry limit
export async function getUninitializedFiles(userId: string) {
  const result = await query(
    `SELECT * FROM drive_files
     WHERE user_id = $1 AND (status = 'uninitialized' OR (status = 'failed' AND retry_count < 3))
     LIMIT 50`,
    [userId],
  );
  return result.rows;
}

export async function getFileCounts(userId: string) {
  const result = await query(
    `SELECT status, COUNT(*) as count FROM drive_files WHERE user_id = $1 GROUP BY status`,
    [userId],
  );
  return result.rows as { status: string; count: number }[];
}

// RETURNING id is how pg gives you back the auto-generated SERIAL id after an insert
export async function createSyncRun(userId: string): Promise<number> {
  const result = await query(
    `INSERT INTO sync_runs (user_id) VALUES ($1) RETURNING id`,
    [userId],
  );
  return result.rows[0].id;
}

export async function updateSyncRun(
  status: string,
  total: number,
  uploaded: number,
  skipped: number,
  failed: number,
  completedAt: number,
  id: number,
  userId: string,
) {
  await query(
    `UPDATE sync_runs
     SET status = $1, total = $2, uploaded = $3, skipped = $4, failed = $5, completed_at = $6
     WHERE id = $7 AND user_id = $8`,
    [status, total, uploaded, skipped, failed, completedAt, id, userId],
  );
}

export async function getUploadedFiles(userId: string) {
  const result = await query(
    `SELECT id, name, mime_type, size, synced_at FROM drive_files
     WHERE user_id = $1 AND status = 'uploaded'
     ORDER BY synced_at DESC`,
    [userId],
  );
  return result.rows;
}

export async function getLatestSyncRun(userId: string) {
  const result = await query(
    `SELECT * FROM sync_runs WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}
