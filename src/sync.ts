import { withRetry } from "./retry";
import { getAuthClient, createClientFromToken } from "./auth";
import { Readable } from "stream";
import { listDrivePhotos, downloadDriveFile } from "./drive";
import { generatePhotoDescription } from "./gemini";
import { uploadPhoto } from "./photos";
import {
  upsertDriveFile,
  getUninitializedFiles,
  markFileInProgress,
  updateFileStatus,
  resetStuckFiles,
  clearFailedFiles,
  clearUninitializedFiles,
  createSyncRun,
  updateSyncRun,
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

export async function startSync(
  userId: string,
  useAI: boolean,
  folderId: string,
  driveAccessToken?: string,
): Promise<number> {
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
  runSync(userId, runId, useAI, folderId, driveAccessToken).catch((err) => {
    console.error("[sync] fatal error:", err.message);
    finishRun(userId, runId, "failed", 0, 0, 0, 0);
  });

  return runId;
}

async function runSync(
  userId: string,
  runId: number,
  useAI: boolean,
  folderId: string,
  driveAccessToken?: string,
) {
  const driveAuth = driveAccessToken
    ? createClientFromToken(driveAccessToken)
    : await getAuthClient(userId);
  const photosAuth = await getAuthClient(userId);
  const state = userSyncState.get(userId)!;

  await resetStuckFiles(userId);
  await clearFailedFiles(userId);
  await clearUninitializedFiles(userId);

  // Cap per sync run — only applies when AI is on (Gemini adds time per file)
  const MAX_PER_SYNC = useAI ? 10_000 : 20_000;

  // ── Phase 1: discover ──────────────────────────────────────────────────────
  let discovered = 0;
  let limitReached = false;
  state.status = "discovering";
  console.log(
    `[sync:${userId}] Phase 1: discovering Drive photos in folder ${folderId}...`,
  );

  for await (const file of listDrivePhotos(driveAuth, folderId)) {
    if (state.shouldAbort) break;
    if (discovered >= MAX_PER_SYNC) {
      limitReached = true;
      break;
    }
    await upsertDriveFile(
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
    `[sync:${userId}] Discovery complete: ${discovered} photos found.`,
  );

  if (state.shouldAbort) {
    return finishRun(userId, runId, "aborted", discovered, 0, 0, 0);
  }

  // ── Phase 2: upload ────────────────────────────────────────────────────────
  state.status = "uploading";
  console.log(`[sync:${userId}] Phase 2: Preparing to upload photos.`);
  let uploaded = 0,
    skipped = 0,
    failed = 0;

  while (!state.shouldAbort && !limitReached) {
    const batch = await getUninitializedFiles(userId);
    if (batch.length === 0) {
      console.log(`[sync:${userId}] 0 uninitialized files remaining.`);
      break;
    }

    for (const file of batch) {
      if (state.shouldAbort) break;
      if (uploaded >= MAX_PER_SYNC) {
        limitReached = true;
        break;
      }
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
        const fileBuffer = await downloadDriveFile(driveAuth, file.id);
        const description = useAI
          ? await withRetry(() =>
              generatePhotoDescription(fileBuffer, file.mime_type),
            ).catch(() => undefined)
          : undefined;
        const mediaId = await withRetry(() =>
          uploadPhoto(
            photosAuth,
            Readable.from(fileBuffer),
            file.name,
            file.mime_type,
            description,
          ),
        );
        await updateFileStatus("uploaded", mediaId, null, 0, file.id, userId);
        uploaded++;
        console.log(`[sync:${userId}]   ✓ ${file.name} (${uploaded} uploaded)`);
      } catch (err: any) {
        const reason = err.response?.data?.error?.errors?.[0]?.reason;
        const detail = reason
          ? `${err.message} (reason: ${reason})`
          : (err.message ?? "unknown error");
        if (err.response?.data) {
          console.log(
            `[sync:${userId}]   ✗ ${file.name}: ${detail} | response body: ${JSON.stringify(err.response.data)}`,
          );
        } else {
          console.log(`[sync:${userId}]   ✗ ${file.name}: ${detail}`);
        }
        await updateFileStatus("failed", null, detail, 1, file.id, userId);
        failed++;
      }
    }
  }

  state.currentFile = null;
  finishRun(
    userId,
    runId,
    state.shouldAbort ? "aborted" : limitReached ? "limit_reached" : "done",
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
