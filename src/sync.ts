import type { Response } from "express";
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
  createSyncRun,
  updateSyncRun,
  getMd5Uploaded,
  getLatestSyncRun,
  getFileCounts,
} from "./db";

const SYNC_TIMEOUT_SECS = 3 * 60 * 60; // 3 hours — mirrors routes.ts's stale-run check

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

// Full snapshot — same shape /sync/status has always returned, including the
// crash-recovery correction (no in-memory state, or a run stuck past the
// timeout, gets reported as failed). Used for the one-shot REST endpoint and
// for the first message sent on every new/reconnected SSE connection.
export async function getSyncSnapshot(userId: string) {
  const state = getSyncState(userId);
  const latestRun = await getLatestSyncRun(userId);
  const countsRaw = await getFileCounts(userId);
  const fileCounts = Object.fromEntries(
    countsRaw.map((r) => [r.status, r.count]),
  );

  if (latestRun?.status === "running") {
    const noActiveSync = state.status === "idle";
    const isStale =
      Math.floor(Date.now() / 1000) - latestRun.started_at > SYNC_TIMEOUT_SECS;
    if (noActiveSync || isStale) {
      if (isStale && !noActiveSync) requestAbort(userId);
      latestRun.status = "failed";
      latestRun.error = "Sync was interrupted. Start a new sync to resume.";
    }
  }

  return { ...state, latestRun: latestRun ?? null, fileCounts };
}

// ── SSE ───────────────────────────────────────────────────────────────────────
// Per-user set of open SSE connections. In-memory, single-process — a sync
// running on one Node instance won't push to a browser connected to another
// instance if this is ever scaled horizontally. Not fixing that here.
const userSyncClients = new Map<string, Set<Response>>();

export function addSyncClient(userId: string, res: Response) {
  if (!userSyncClients.has(userId)) userSyncClients.set(userId, new Set());
  userSyncClients.get(userId)!.add(res);
}

export function removeSyncClient(userId: string, res: Response) {
  userSyncClients.get(userId)?.delete(res);
}

// DB-backed snapshot push — used once per new connection and at phase
// transitions/finish, never in the hot per-file loop (see pushProgress).
export async function pushSnapshot(userId: string, targets?: Response[]) {
  const clients = targets ?? [...(userSyncClients.get(userId) ?? [])];
  if (clients.length === 0) return;
  const payload = JSON.stringify(await getSyncSnapshot(userId));
  for (const res of clients) res.write(`data: ${payload}\n\n`);
}

const lastProgressPushAt = new Map<string, number>();

function pushProgress(userId: string) {
  const clients = userSyncClients.get(userId);
  if (!clients || clients.size === 0) return;
  const state = userSyncState.get(userId);
  if (!state) return;

  const now = Date.now();
  if (now - (lastProgressPushAt.get(userId) ?? 0) < 1000) return;
  lastProgressPushAt.set(userId, now);

  getFileCounts(userId)
    .then((countsRaw) => {
      const payload = JSON.stringify({
        runId: state.runId,
        status: state.status,
        currentFile: state.currentFile,
        fileCounts: Object.fromEntries(
          countsRaw.map((r) => [r.status, r.count]),
        ),
      });
      for (const res of clients) res.write(`data: ${payload}\n\n`);
    })
    .catch((err) => console.error("[sync] failed to push progress:", err));
}

export async function startSync(
  userId: string,
  useAI: boolean,
  folderId: string | null,
  driveAccessToken?: string,
): Promise<number> {
  const existing = userSyncState.get(userId);
  if (existing?.status === "discovering" || existing?.status === "uploading") {
    throw new Error("A sync is already running");
  }

  userSyncState.set(userId, {
    runId: -1,
    status: "discovering",
    shouldAbort: false,
    currentFile: null,
  });

  let runId: number;
  try {
    runId = await createSyncRun(userId);
  } catch (err) {
    userSyncState.delete(userId);
    throw err;
  }

  userSyncState.get(userId)!.runId = runId;

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
  folderId: string | null,
  driveAccessToken?: string,
) {
  const driveAuth = driveAccessToken
    ? createClientFromToken(driveAccessToken)
    : await getAuthClient(userId);
  const photosAuth = await getAuthClient(userId);
  const state = userSyncState.get(userId)!;

  await resetStuckFiles(userId);

  // Cap per sync run — only applies when AI is on (Gemini adds time per file)
  const MAX_PER_SYNC = useAI ? 10_000 : 20_000;

  // ── Phase 1: discover ──────────────────────────────────────────────────────
  // Skipped entirely when the user already has pending files anywhere
  const countsBeforeDiscovery = await getFileCounts(userId);
  const pendingCount = Number(
    countsBeforeDiscovery.find((r) => r.status === "uninitialized")?.count ?? 0,
  );

  let discovered = 0;
  let limitReached = false;

  if (pendingCount > 0) {
    console.log(
      `[sync:${userId}] Found ${pendingCount} pending files across all folders — skipping discovery.`,
    );
  } else {
    state.status = "discovering";
    pushSnapshot(userId);
    console.log(
      `[sync:${userId}] Phase 1: discovering Drive photos in folder ${folderId}...`,
    );

    for await (const file of listDrivePhotos(driveAuth, folderId!)) {
      if (state.shouldAbort) break;
      if (discovered >= MAX_PER_SYNC) {
        limitReached = true;
        break;
      }
      await upsertDriveFile(
        file.id,
        userId,
        folderId!,
        file.name,
        file.md5,
        file.mime_type,
        file.size,
      );
      discovered++;
      pushProgress(userId);
      if (discovered % 500 === 0)
        console.log(`[sync:${userId}]   ${discovered} files found so far...`);
    }

    console.log(
      `[sync:${userId}] Discovery complete: ${discovered} photos found.`,
    );

    if (state.shouldAbort) {
      return finishRun(userId, runId, "aborted", discovered, 0, 0, 0);
    }
  }

  // ── Phase 2: upload ────────────────────────────────────────────────────────
  state.status = "uploading";
  pushSnapshot(userId);
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
        // Skip files too large to safely buffer and upload
        const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB
        if (file.size && file.size > MAX_FILE_SIZE) {
          await updateFileStatus(
            "skipped",
            null,
            "file too large",
            0,
            file.id,
            userId,
          );
          skipped++;
          pushProgress(userId);
          continue;
        }

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
          pushProgress(userId);
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
        pushProgress(userId);
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
        pushProgress(userId);
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
  if (state && state.runId === runId) state.status = status;

  const clients = userSyncClients.get(userId);
  if (clients && clients.size > 0) {
    getFileCounts(userId)
      .then((countsRaw) => {
        const payload = JSON.stringify({
          runId,
          status,
          currentFile: null,
          fileCounts: Object.fromEntries(
            countsRaw.map((r) => [r.status, r.count]),
          ),
        });
        for (const res of clients) res.write(`data: ${payload}\n\n`);
      })
      .catch((err) =>
        console.error("[sync] failed to push terminal update:", err),
      );
  }

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
