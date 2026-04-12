"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSyncState = getSyncState;
exports.requestAbort = requestAbort;
exports.startSync = startSync;
const retry_1 = require("./retry");
const auth_1 = require("./auth");
const drive_1 = require("./drive");
const gemini_1 = require("./gemini");
const photos_1 = require("./photos");
const db_1 = require("./db");
// Per-user sync state — keyed by userId so concurrent users don't interfere
const userSyncState = new Map();
function getSyncState(userId) {
    const state = userSyncState.get(userId);
    return {
        runId: state?.runId ?? null,
        status: state?.status ?? "idle",
        currentFile: state?.currentFile ?? null,
    };
}
function requestAbort(userId) {
    const state = userSyncState.get(userId);
    if (state) {
        state.shouldAbort = true;
        // Resets state so user can re-run
        userSyncState.delete(userId);
    }
}
async function startSync(userId, useAI) {
    const existing = userSyncState.get(userId);
    if (existing?.status === "discovering" || existing?.status === "uploading") {
        throw new Error("A sync is already running");
    }
    const runId = await (0, db_1.createSyncRun)(userId);
    userSyncState.set(userId, {
        runId,
        status: "discovering",
        shouldAbort: false,
        currentFile: null,
    });
    // Fire and forget — progress is tracked in the DB and queryable via /sync/status
    runSync(userId, runId, useAI).catch((err) => {
        console.error("[sync] fatal error:", err.message);
        finishRun(userId, runId, "failed", 0, 0, 0, 0);
    });
    return runId;
}
async function runSync(userId, runId, useAI) {
    const auth = await (0, auth_1.getAuthClient)(userId);
    const state = userSyncState.get(userId);
    // Reset any files stuck in_progress from a previous crash back to uninitialized
    await (0, db_1.resetStuckFiles)(userId);
    // Give previously failed files another chance on each manual sync
    await (0, db_1.resetFailedFiles)(userId);
    // Without AI, raise the limit since we're not incurring Gemini costs
    const MAX_UPLOADS_PER_USER = useAI ? 1_000 : 10_000;
    // ── Phase 1: discover ──────────────────────────────────────────────────────
    const preCounts = await (0, db_1.getFileCounts)(userId);
    const byPreStatus = Object.fromEntries(preCounts.map((r) => [r.status, Number(r.count)]));
    const alreadyUploaded = byPreStatus.uploaded ?? 0;
    const alreadyQueued = alreadyUploaded +
        (byPreStatus.uninitialized ?? 0) +
        (byPreStatus.in_progress ?? 0) +
        (byPreStatus.skipped ?? 0);
    const discoverLimit = MAX_UPLOADS_PER_USER - alreadyUploaded;
    let discovered = 0;
    if (alreadyQueued >= MAX_UPLOADS_PER_USER) {
        // DB already has enough files queued — skip rediscovery
        console.log(`[sync:${userId}] Phase 1: skipped (${alreadyQueued} files already queued).`);
    }
    else {
        // Clear uninitialized files so discovery re-populates up to the current limit
        await (0, db_1.clearUninitializedFiles)(userId);
        state.status = "discovering";
        console.log(`[sync:${userId}] Phase 1: discovering Drive photos (limit: ${discoverLimit})...`);
        for await (const file of (0, drive_1.listDrivePhotos)(auth)) {
            if (state.shouldAbort)
                break;
            if (discovered >= discoverLimit)
                break;
            await (0, db_1.upsertDriveFile)(file.id, userId, file.name, file.md5, file.mime_type, file.size, file.thumbnailLink);
            discovered++;
            if (discovered % 500 === 0)
                console.log(`[sync:${userId}]   ${discovered} files found so far...`);
        }
        console.log(`[sync:${userId}] Discovery complete: ${discovered} photos in Drive.`);
        if (state.shouldAbort) {
            return finishRun(userId, runId, "aborted", discovered, 0, 0, 0);
        }
    }
    // ── Phase 2: upload ────────────────────────────────────────────────────────
    state.status = "uploading";
    const counts = await (0, db_1.getFileCounts)(userId);
    const byStatus = Object.fromEntries(counts.map((r) => [r.status, Number(r.count)]));
    const alreadyDone = byStatus.uploaded ?? 0;
    const remaining = MAX_UPLOADS_PER_USER - alreadyDone;
    console.log(`[sync:${userId}] Phase 2: Preparing to upload photos.`);
    if (remaining <= 0) {
        console.log(`[sync:${userId}] Upload limit of ${MAX_UPLOADS_PER_USER} reached.`);
        return finishRun(userId, runId, "limit_reached", discovered, 0, 0, 0);
    }
    let uploaded = 0, skipped = 0, failed = 0;
    while (!state.shouldAbort) {
        const batch = await (0, db_1.getUninitializedFiles)(userId);
        if (batch.length === 0) {
            console.log(`[sync:${userId}] 0 uninitialized files remaining.`);
            break;
        }
        for (const file of batch) {
            if (state.shouldAbort)
                break;
            if (uploaded >= remaining)
                break;
            try {
                // Dedup: if another file with the same md5 was already uploaded, skip
                if (file.md5 && (await (0, db_1.getMd5Uploaded)(userId, file.md5))) {
                    await (0, db_1.updateFileStatus)("skipped", null, "duplicate md5", 0, file.id, userId);
                    skipped++;
                    continue;
                }
                state.currentFile = file.name;
                await (0, db_1.markFileInProgress)(file.id, userId);
                const description = useAI && file.thumbnail_link
                    ? await (0, retry_1.withRetry)(() => (0, gemini_1.generatePhotoDescription)(file.thumbnail_link))
                    : undefined;
                const stream = await (0, drive_1.streamDriveFile)(auth, file.id);
                const mediaId = await (0, retry_1.withRetry)(() => (0, photos_1.uploadPhoto)(auth, stream, file.name, file.mime_type, description));
                await (0, db_1.updateFileStatus)("uploaded", mediaId, null, 0, file.id, userId);
                uploaded++;
                console.log(`[sync:${userId}]   ✓ ${file.name} (${uploaded} uploaded)`);
            }
            catch (err) {
                await (0, db_1.updateFileStatus)("failed", null, err.message ?? "unknown error", 1, file.id, userId);
                failed++;
                console.error(`[sync:${userId}]   ✗ ${file.name}: ${err.message}`);
            }
        }
    }
    state.currentFile = null;
    finishRun(userId, runId, state.shouldAbort ? "aborted" : "done", discovered, uploaded, skipped, failed);
    console.log(`[sync:${userId}] Finished. uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function finishRun(userId, runId, status, total, uploaded, skipped, failed) {
    const state = userSyncState.get(userId);
    if (state)
        state.status = status;
    (0, db_1.updateSyncRun)(status, total, uploaded, skipped, failed, Math.floor(Date.now() / 1000), runId, userId).catch((err) => console.error("[sync] failed to update sync run:", err));
}
