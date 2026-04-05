import { withRetry } from "./retry";
import { getAuthClient } from "./auth";
import { listDrivePhotos, streamDriveFile } from "./drive";
import { generatePhotoDescription } from "./gemini";
import { uploadPhoto } from "./photos";
import {
  upsertDriveFile,
  getUninitializedFiles,
  markFileInProgress,
  updateFileStatus,
  resetStuckFiles,
  createSyncRun,
  updateSyncRun,
  getFileCounts,
  getMd5Uploaded,
} from "./db";

type SyncStatus =
  | "idle"
  | "discovering"
  | "uploading"
  | "done"
  | "failed"
  | "aborted"
  | "limit_reached";

// Per-user sync state — keyed by userId so concurrent users don't interfere
const userSyncState = new Map<
  string,
  {
    runId: number;
    status: SyncStatus;
    shouldAbort: boolean;
    currentFile: string | null;
  }
>();

export function getSyncState(userId: string) {
  const state = userSyncState.get(userId);
  return {
    runId: state?.runId ?? null,
    status: state?.status ?? "idle",
    currentFile: state?.currentFile ?? null,
  };
}

export function requestAbort(userId: string) {
  const state = userSyncState.get(userId);
  if (state) {
    state.shouldAbort = true;
    // Resets state so user can re-run
    userSyncState.delete(userId);
  }
}

export async function startSync(userId: string): Promise<number> {
  const existing = userSyncState.get(userId);
  if (existing?.status === "discovering" || existing?.status === "uploading") {
    throw new Error("A sync is already running");
  }

  const runId = await createSyncRun(userId);

  userSyncState.set(userId, {
    runId,
    status: "discovering",
    shouldAbort: false,
    currentFile: null,
  });

  // Fire and forget — progress is tracked in the DB and queryable via /sync/status
  runSync(userId, runId).catch((err) => {
    console.error("[sync] fatal error:", err.message);
    finishRun(userId, runId, "failed", 0, 0, 0, 0);
  });

  return runId;
}

async function runSync(userId: string, runId: number) {
  const auth = await getAuthClient(userId);
  const state = userSyncState.get(userId)!;

  // Reset any files stuck in_progress from a previous crash back to uninitialized
  await resetStuckFiles(userId);

  const MAX_UPLOADS_PER_USER = 1000;

  // ── Phase 1: discover ──────────────────────────────────────────────────────
  state.status = "discovering";
  const preCounts = await getFileCounts(userId);
  const alreadyUploaded = Number(
    preCounts.find((r) => r.status === "uploaded")?.count ?? 0,
  );
  const discoverLimit = MAX_UPLOADS_PER_USER - alreadyUploaded;
  console.log(
    `[sync:${userId}] Phase 1: discovering Drive photos (limit: ${discoverLimit})...`,
  );
  let discovered = 0;

  for await (const file of listDrivePhotos(auth)) {
    if (state.shouldAbort) break;
    if (discovered >= discoverLimit) break;
    await upsertDriveFile(
      file.id,
      userId,
      file.name,
      file.md5,
      file.mime_type,
      file.size,
      file.thumbnailLink,
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
  const counts = await getFileCounts(userId);
  const byStatus = Object.fromEntries(
    counts.map((r) => [r.status, Number(r.count)]),
  );
  const alreadyDone = byStatus.uploaded ?? 0;
  const remaining = MAX_UPLOADS_PER_USER - alreadyDone;
  console.log(`[sync:${userId}] Phase 2: Preparing to upload photos.`);
  if (remaining <= 0) {
    console.log(
      `[sync:${userId}] Upload limit of ${MAX_UPLOADS_PER_USER} reached.`,
    );
    return finishRun(userId, runId, "limit_reached", discovered, 0, 0, 0);
  }
  let uploaded = 0,
    skipped = 0,
    failed = 0;

  while (!state.shouldAbort) {
    const batch = await getUninitializedFiles(userId);
    if (batch.length === 0) {
      console.log(`[sync:${userId}] 0 uninitialized files remaining.`);
      break;
    }

    for (const file of batch) {
      if (state.shouldAbort) break;
      if (uploaded >= remaining) break;
      try {
        // Dedup: if another file with the same md5 was already uploaded, skip
        if (file.md5 && (await getMd5Uploaded(userId, file.md5))) {
          await updateFileStatus(
            "skipped",
            null,
            "duplicate md5",
            0,
            file.id,
            userId,
          );
          skipped++;
          continue;
        }

        state.currentFile = file.name;
        await markFileInProgress(file.id, userId);
        const description = file.thumbnail_link
          ? await withRetry(() => {
              return generatePhotoDescription(file.thumbnail_link!);
            })
          : undefined;
        const stream = await streamDriveFile(auth, file.id);
        const mediaId = await withRetry(() =>
          uploadPhoto(auth, stream, file.name, file.mime_type, description),
        );
        await updateFileStatus("uploaded", mediaId, null, 0, file.id, userId);
        uploaded++;
        console.log(`[sync:${userId}]   ✓ ${file.name} (${uploaded} uploaded)`);
        await sleep(50);
      } catch (err: any) {
        await updateFileStatus(
          "failed",
          null,
          err.message ?? "unknown error",
          1,
          file.id,
          userId,
        );
        failed++;
        console.error(`[sync:${userId}]   ✗ ${file.name}: ${err.message}`);
      }
    }
  }

  state.currentFile = null;
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  updateSyncRun(
    status,
    total,
    uploaded,
    skipped,
    failed,
    Math.floor(Date.now() / 1000),
    runId,
    userId,
  ).catch((err) => console.error("[sync] failed to update sync run:", err));
}
