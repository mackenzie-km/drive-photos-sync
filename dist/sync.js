"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSyncState = getSyncState;
exports.requestAbort = requestAbort;
exports.getSyncSnapshot = getSyncSnapshot;
exports.addSyncClient = addSyncClient;
exports.removeSyncClient = removeSyncClient;
exports.pushSnapshot = pushSnapshot;
exports.startSync = startSync;
const retry_1 = require("./retry");
const auth_1 = require("./auth");
const stream_1 = require("stream");
const drive_1 = require("./drive");
const gemini_1 = require("./gemini");
const photos_1 = require("./photos");
const db_1 = require("./db");
const SYNC_TIMEOUT_SECS = 3 * 60 * 60; // 3 hours — mirrors routes.ts's stale-run check
// The Drive-side driveAuth client is built once per run from a token that
// can't be refreshed mid-flight (see createClientFromToken in auth.ts). Once
// it expires, every remaining drive.files.get call fails the same way — so
// treat the first one as a signal to stop the whole run rather than burning
// through the rest of the queue as one-by-one permanent failures.
function isDriveAuthError(err) {
    const status = err?.code ?? err?.response?.status;
    const reason = err?.response?.data?.error?.errors?.[0]?.reason;
    return status === 401 || reason === "authError";
}
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
async function getCountsPayload(userId) {
    const [countsRaw, resumableCount] = await Promise.all([
        (0, db_1.getFileCounts)(userId),
        (0, db_1.getResumableCount)(userId),
    ]);
    return {
        fileCounts: Object.fromEntries(countsRaw.map((r) => [r.status, r.count])),
        resumableCount,
    };
}
// Full snapshot — same shape /sync/status has always returned, including the
// crash-recovery correction (no in-memory state, or a run stuck past the
// timeout, gets reported as failed). Used for the one-shot REST endpoint and
// for the first message sent on every new/reconnected SSE connection.
async function getSyncSnapshot(userId) {
    const state = getSyncState(userId);
    const latestRun = await (0, db_1.getLatestSyncRun)(userId);
    const { fileCounts, resumableCount } = await getCountsPayload(userId);
    if (latestRun?.status === "running") {
        const noActiveSync = state.status === "idle";
        const isStale = Math.floor(Date.now() / 1000) - latestRun.started_at > SYNC_TIMEOUT_SECS;
        if (noActiveSync || isStale) {
            if (isStale && !noActiveSync)
                requestAbort(userId);
            latestRun.status = "failed";
            latestRun.error = "Sync was interrupted. Start a new sync to resume.";
        }
    }
    return { ...state, latestRun: latestRun ?? null, fileCounts, resumableCount };
}
// ── SSE ───────────────────────────────────────────────────────────────────────
// Per-user set of open SSE connections. In-memory, single-process — a sync
// running on one Node instance won't push to a browser connected to another
// instance if this is ever scaled horizontally. Not fixing that here.
const userSyncClients = new Map();
function addSyncClient(userId, res) {
    if (!userSyncClients.has(userId))
        userSyncClients.set(userId, new Set());
    userSyncClients.get(userId).add(res);
}
function removeSyncClient(userId, res) {
    userSyncClients.get(userId)?.delete(res);
}
// DB-backed snapshot push — used once per new connection and at phase
// transitions/finish, never in the hot per-file loop (see pushProgress).
async function pushSnapshot(userId, targets) {
    const clients = targets ?? [...(userSyncClients.get(userId) ?? [])];
    if (clients.length === 0)
        return;
    const payload = JSON.stringify(await getSyncSnapshot(userId));
    for (const res of clients)
        res.write(`data: ${payload}\n\n`);
}
const lastProgressPushAt = new Map();
function pushProgress(userId) {
    const clients = userSyncClients.get(userId);
    if (!clients || clients.size === 0)
        return;
    const state = userSyncState.get(userId);
    if (!state)
        return;
    const now = Date.now();
    if (now - (lastProgressPushAt.get(userId) ?? 0) < 1000)
        return;
    lastProgressPushAt.set(userId, now);
    getCountsPayload(userId)
        .then(({ fileCounts, resumableCount }) => {
        const payload = JSON.stringify({
            runId: state.runId,
            status: state.status,
            currentFile: state.currentFile,
            fileCounts,
            resumableCount,
        });
        for (const res of clients)
            res.write(`data: ${payload}\n\n`);
    })
        .catch((err) => console.error("[sync] failed to push progress:", err));
}
async function startSync(userId, useAI, folderId, driveAccessToken) {
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
    let runId;
    try {
        runId = await (0, db_1.createSyncRun)(userId);
    }
    catch (err) {
        userSyncState.delete(userId);
        throw err;
    }
    userSyncState.get(userId).runId = runId;
    // Fire and forget — progress is tracked in the DB and queryable via /sync/status
    runSync(userId, runId, useAI, folderId, driveAccessToken).catch((err) => {
        console.error("[sync] fatal error:", err.message);
        finishRun(userId, runId, "failed");
    });
    return runId;
}
async function runSync(userId, runId, useAI, folderId, driveAccessToken) {
    const driveAuth = driveAccessToken
        ? (0, auth_1.createClientFromToken)(driveAccessToken)
        : await (0, auth_1.getAuthClient)(userId);
    const photosAuth = await (0, auth_1.getAuthClient)(userId);
    const state = userSyncState.get(userId);
    await (0, db_1.resetStuckFiles)(userId);
    // Cap per sync run — only applies when AI is on (Gemini adds time per file)
    const MAX_PER_SYNC = useAI ? 10_000 : 20_000;
    // ── Phase 1: discover ──────────────────────────────────────────────────────
    // Skipped entirely when the caller passed no folderId
    let discovered = 0;
    let limitReached = false;
    if (folderId === null) {
        console.log(`[sync:${userId}] No folder specified — resuming existing backlog across all folders.`);
    }
    else {
        state.status = "discovering";
        pushSnapshot(userId);
        console.log(`[sync:${userId}] Phase 1: discovering Drive photos in folder ${folderId}...`);
        for await (const file of (0, drive_1.listDrivePhotos)(driveAuth, folderId)) {
            if (state.shouldAbort)
                break;
            if (discovered >= MAX_PER_SYNC) {
                limitReached = true;
                break;
            }
            await (0, db_1.upsertDriveFile)(file.id, userId, folderId, file.name, file.md5, file.mime_type, file.size);
            discovered++;
            pushProgress(userId);
            if (discovered % 500 === 0)
                console.log(`[sync:${userId}]   ${discovered} files found so far...`);
        }
        console.log(`[sync:${userId}] Discovery complete: ${discovered} photos found.`);
        if (state.shouldAbort) {
            return finishRun(userId, runId, "aborted");
        }
    }
    // ── Phase 2: upload ────────────────────────────────────────────────────────
    state.status = "uploading";
    pushSnapshot(userId);
    console.log(`[sync:${userId}] Phase 2: Preparing to upload photos.`);
    let uploaded = 0, skipped = 0, failed = 0;
    let driveTokenExpired = false;
    while (!state.shouldAbort && !limitReached && !driveTokenExpired) {
        const batch = await (0, db_1.getUninitializedFiles)(userId);
        if (batch.length === 0) {
            console.log(`[sync:${userId}] 0 uninitialized files remaining.`);
            break;
        }
        for (const file of batch) {
            if (state.shouldAbort || driveTokenExpired)
                break;
            if (uploaded >= MAX_PER_SYNC) {
                limitReached = true;
                break;
            }
            try {
                // Skip files too large to safely buffer and upload
                const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB
                if (file.size && file.size > MAX_FILE_SIZE) {
                    await (0, db_1.updateFileStatus)("skipped", null, "file too large", 0, file.id, userId);
                    skipped++;
                    pushProgress(userId);
                    continue;
                }
                // Dedup: if another file with the same md5 was already uploaded, skip
                if (file.md5 && (await (0, db_1.getMd5Uploaded)(userId, file.md5))) {
                    await (0, db_1.updateFileStatus)("skipped", null, "duplicate md5", 0, file.id, userId);
                    skipped++;
                    pushProgress(userId);
                    continue;
                }
                state.currentFile = file.name;
                await (0, db_1.markFileInProgress)(file.id, userId);
                let fileBuffer;
                try {
                    fileBuffer = await (0, drive_1.downloadDriveFile)(driveAuth, file.id);
                }
                catch (downloadErr) {
                    if (isDriveAuthError(downloadErr)) {
                        // Not this file's fault — leave it in_progress (resetStuckFiles
                        // reclaims it as uninitialized on the next run, no retry spent)
                        // and stop the whole run rather than failing every file left in
                        // the queue one at a time on a token that is never coming back.
                        console.log(`[sync:${userId}]   Drive token expired — halting run instead of failing the rest of the queue.`);
                        driveTokenExpired = true;
                        break;
                    }
                    throw downloadErr;
                }
                const description = useAI
                    ? await (0, retry_1.withRetry)(() => (0, gemini_1.generatePhotoDescription)(fileBuffer, file.mime_type)).catch(() => undefined)
                    : undefined;
                const mediaId = await (0, retry_1.withRetry)(() => (0, photos_1.uploadPhoto)(photosAuth, stream_1.Readable.from(fileBuffer), file.name, file.mime_type, description));
                await (0, db_1.updateFileStatus)("uploaded", mediaId, null, 0, file.id, userId);
                uploaded++;
                pushProgress(userId);
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
                pushProgress(userId);
            }
        }
    }
    state.currentFile = null;
    finishRun(userId, runId, state.shouldAbort
        ? "aborted"
        : driveTokenExpired
            ? "token_expired"
            : limitReached
                ? "limit_reached"
                : "done");
    console.log(`[sync:${userId}] Finished. uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
}
function finishRun(userId, runId, status) {
    const state = userSyncState.get(userId);
    if (state && state.runId === runId)
        state.status = status;
    const clients = userSyncClients.get(userId);
    if (clients && clients.size > 0) {
        getCountsPayload(userId)
            .then(({ fileCounts, resumableCount }) => {
            const payload = JSON.stringify({
                runId,
                status,
                currentFile: null,
                fileCounts,
                resumableCount,
            });
            for (const res of clients)
                res.write(`data: ${payload}\n\n`);
        })
            .catch((err) => console.error("[sync] failed to push terminal update:", err));
    }
    (0, db_1.updateSyncRun)(status, runId, userId).catch((err) => console.error("[sync] failed to update sync run:", err));
}
