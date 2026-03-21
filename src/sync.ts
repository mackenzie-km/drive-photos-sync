import { getAuthClient } from "./auth";
import { listDrivePhotos, streamDriveFile } from "./drive";
import { uploadPhoto } from "./photos";
import {
  upsertDriveFile,
  getUninitializedFiles,
  getMd5Uploaded,
  markFileInProgress,
  updateFileStatus,
  resetStuckFiles,
  createSyncRun,
  updateSyncRun,
} from "./db";

type SyncStatus =
  | "idle"
  | "discovering"
  | "uploading"
  | "done"
  | "failed"
  | "aborted";

// Per-user sync state — keyed by userId so concurrent users don't interfere
const userSyncState = new Map<
  string,
  { runId: number; status: SyncStatus; shouldAbort: boolean }
>();

export function getSyncState(userId: string) {
  const state = userSyncState.get(userId);
  return {
    runId: state?.runId ?? null,
    status: state?.status ?? "idle",
  };
}

export function requestAbort(userId: string) {
  const state = userSyncState.get(userId);
  if (state) state.shouldAbort = true;
}

export async function startSync(userId: string): Promise<number> {
  const existing = userSyncState.get(userId);
  if (existing?.status === "discovering" || existing?.status === "uploading") {
    throw new Error("A sync is already running");
  }

  const { lastInsertRowid } = createSyncRun.run(userId);
  const runId = lastInsertRowid as number;

  userSyncState.set(userId, {
    runId,
    status: "discovering",
    shouldAbort: false,
  });

  // Fire and forget — progress is tracked in the DB and queryable via /sync/status
  runSync(userId, runId).catch((err) => {
    console.error("[sync] fatal error:", err);
    finishRun(userId, runId, "failed", 0, 0, 0, 0);
  });

  return runId;
}

async function runSync(userId: string, runId: number) {
  const auth = await getAuthClient(userId);
  const state = userSyncState.get(userId)!;

  // Reset any files stuck in_progress from a previous crash back to uninitialized
  resetStuckFiles.run(userId);

  // ── Phase 1: discover ──────────────────────────────────────────────────────
  state.status = "discovering";
  console.log(`[sync:${userId}] Phase 1: discovering Drive photos...`);
  let discovered = 0;

  for await (const file of listDrivePhotos(auth)) {
    if (state.shouldAbort) break;
    upsertDriveFile.run(
      file.id,
      userId,
      file.name,
      file.md5,
      file.mime_type,
      file.size,
    );
    discovered++;
    if (discovered % 500 === 0)
      console.log(`[sync:${userId}]   ${discovered} files found so far...`);
  }

  console.log(
    `[sync:${userId}] Discovery complete: ${discovered} photos in Drive.`,
  );

  if (state.shouldAbort) {
    return finishRun(userId, runId, "aborted", discovered, 0, 0, 0);
  }

  // ── Phase 2: upload ────────────────────────────────────────────────────────
  state.status = "uploading";
  console.log(`[sync:${userId}] Phase 2: uploading to Google Photos...`);
  let uploaded = 0,
    skipped = 0,
    failed = 0;

  while (!state.shouldAbort) {
    const batch = getUninitializedFiles.all(userId) as any[];
    if (batch.length === 0) break;

    for (const file of batch) {
      if (state.shouldAbort) break;

      try {
        // Dedup: if another file with the same md5 was already uploaded, skip
        if (file.md5 && getMd5Uploaded.get(userId, file.md5)) {
          updateFileStatus.run("skipped", null, "duplicate md5", 0, file.id, userId);
          skipped++;
          continue;
        }

        markFileInProgress.run(file.id, userId);
        const stream = await streamDriveFile(auth, file.id);
        const mediaId = await uploadPhoto(auth, stream, file.name, file.mime_type);
        updateFileStatus.run("uploaded", mediaId, null, 0, file.id, userId);
        uploaded++;
        console.log(`[sync:${userId}]   ✓ ${file.name} (${uploaded} uploaded)`);

        // Polite delay to stay within Google's rate limits
        await sleep(250);
      } catch (err: any) {
        updateFileStatus.run("failed", null, err.message ?? "unknown error", 1, file.id, userId);
        failed++;
        console.error(`[sync:${userId}]   ✗ ${file.name}: ${err.message}`);
      }
    }
  }

  finishRun(
    userId,
    runId,
    state.shouldAbort ? "aborted" : "done",
    discovered,
    uploaded,
    skipped,
    failed,
  );
  console.log(
    `[sync:${userId}] Finished. uploaded=${uploaded} skipped=${skipped} failed=${failed}`,
  );
}

function finishRun(
  userId: string,
  runId: number,
  status: SyncStatus,
  total: number,
  uploaded: number,
  skipped: number,
  failed: number,
) {
  const state = userSyncState.get(userId);
  if (state) state.status = status;
  updateSyncRun.run(
    status,
    total,
    uploaded,
    skipped,
    failed,
    Math.floor(Date.now() / 1000),
    runId,
    userId,
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
