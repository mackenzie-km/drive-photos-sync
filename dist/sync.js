"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSyncState = getSyncState;
exports.requestAbort = requestAbort;
exports.startSync = startSync;
const retry_1 = require("./retry");
const auth_1 = require("./auth");
const stream_1 = require("stream");
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
async function startSync(userId, useAI, folderId) {
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
    runSync(userId, runId, useAI, folderId).catch((err) => {
        console.error("[sync] fatal error:", err.message);
        finishRun(userId, runId, "failed", 0, 0, 0, 0);
    });
    return runId;
}
async function runSync(userId, runId, useAI, folderId) {
    const auth = await (0, auth_1.getAuthClient)(userId);
    const state = userSyncState.get(userId);
    await (0, db_1.resetStuckFiles)(userId);
    await (0, db_1.clearFailedFiles)(userId);
    await (0, db_1.clearUninitializedFiles)(userId);
    // Cap per sync run — only applies when AI is on (Gemini adds time per file)
    const MAX_PER_SYNC = useAI ? 5_000 : Infinity;
    // ── Phase 1: discover ──────────────────────────────────────────────────────
    let discovered = 0;
    state.status = "discovering";
    console.log(`[sync:${userId}] Phase 1: discovering Drive photos in folder ${folderId}...`);
    for await (const file of (0, drive_1.listDrivePhotos)(auth, folderId)) {
        if (state.shouldAbort)
            break;
        if (discovered >= MAX_PER_SYNC)
            break;
        await (0, db_1.upsertDriveFile)(file.id, userId, file.name, file.md5, file.mime_type, file.size);
        discovered++;
        if (discovered % 500 === 0)
            console.log(`[sync:${userId}]   ${discovered} files found so far...`);
    }
    console.log(`[sync:${userId}] Discovery complete: ${discovered} photos found.`);
    if (state.shouldAbort) {
        return finishRun(userId, runId, "aborted", discovered, 0, 0, 0);
    }
    // ── Phase 2: upload ────────────────────────────────────────────────────────
    state.status = "uploading";
    console.log(`[sync:${userId}] Phase 2: Preparing to upload photos.`);
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
            if (uploaded >= MAX_PER_SYNC)
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
                const fileBuffer = await (0, drive_1.downloadDriveFile)(auth, file.id);
                const description = useAI
                    ? await (0, retry_1.withRetry)(() => (0, gemini_1.generatePhotoDescription)(fileBuffer, file.mime_type)).catch(() => undefined)
                    : undefined;
                const mediaId = await (0, retry_1.withRetry)(() => (0, photos_1.uploadPhoto)(auth, stream_1.Readable.from(fileBuffer), file.name, file.mime_type, description));
                await (0, db_1.updateFileStatus)("uploaded", mediaId, null, 0, file.id, userId);
                uploaded++;
                console.log(`[sync:${userId}]   ✓ ${file.name} (${uploaded} uploaded)`);
            }
            catch (err) {
                const reason = err.response?.data?.error?.errors?.[0]?.reason;
                const detail = reason
                    ? `${err.message} (reason: ${reason})`
                    : (err.message ?? "unknown error");
                if (err.response?.data) {
                    console.log(`[sync:${userId}]   ✗ ${file.name}: ${detail} | response body: ${JSON.stringify(err.response.data)}`);
                }
                else {
                    console.log(`[sync:${userId}]   ✗ ${file.name}: ${detail}`);
                }
                await (0, db_1.updateFileStatus)("failed", null, detail, 1, file.id, userId);
                failed++;
            }
        }
    }
    state.currentFile = null;
    finishRun(userId, runId, state.shouldAbort ? "aborted" : "done", discovered, uploaded, skipped, failed);
    console.log(`[sync:${userId}] Finished. uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
}
function finishRun(userId, runId, status, total, uploaded, skipped, failed) {
    const state = userSyncState.get(userId);
    if (state)
        state.status = status;
    (0, db_1.updateSyncRun)(status, total, uploaded, skipped, failed, Math.floor(Date.now() / 1000), runId, userId).catch((err) => console.error("[sync] failed to update sync run:", err));
}
