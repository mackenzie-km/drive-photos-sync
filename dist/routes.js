"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("./auth");
const sync_1 = require("./sync");
const db_1 = require("./db");
const router = (0, express_1.Router)();
// Express 4 doesn't catch rejections from async handlers — this forwards them to next(err) instead.
function asyncHandler(fn) {
    return (req, res, next) => {
        fn(req, res, next).catch(next);
    };
}
// ── Health ────────────────────────────────────────────────────────────────────
router.get("/health", (_req, res) => {
    res.json({ ok: true });
});
// ── Auth ──────────────────────────────────────────────────────────────────────
// Step 1: visit this URL in your browser to kick off OAuth
router.get("/auth/url", (_req, res) => {
    res.json({ url: (0, auth_1.getAuthUrl)() });
});
// Step 2: Google redirects here with ?code=... after the user approves.
// We exchange the code for tokens, fetch the user's stable Google userId, and store it in the session
router.get("/auth/callback", async (req, res) => {
    const code = req.query.code;
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
    if (!code) {
        res.redirect(`${frontendUrl}/?auth_error=access_denied`);
        return;
    }
    try {
        const userId = await (0, auth_1.handleCallback)(code);
        req.session.userId = userId;
        req.session.save((err) => {
            if (err)
                console.error("[auth] session save error:", err);
            res.redirect(frontendUrl);
        });
    }
    catch (err) {
        console.error("[auth] callback error:", err);
        res.redirect(`${frontendUrl}/?auth_error=1`);
    }
});
router.get("/auth/me", (req, res) => {
    const userId = req.session.userId;
    if (!userId) {
        res.status(401).json({ error: "Not logged in" });
        return;
    }
    res.json({ userId });
});
// ── Auth middleware — all /sync routes require a session ──────────────────────
function requireAuth(req, res, next) {
    const userId = req.session.userId;
    if (!userId) {
        res.status(401).json({
            error: "Not authenticated. Complete the OAuth flow at /auth/url first.",
        });
        return;
    }
    req.userId = userId;
    next();
}
// ── Sync ──────────────────────────────────────────────────────────────────────
router.post("/sync/start", requireAuth, async (req, res) => {
    try {
        const userId = req.userId;
        const useAI = req.body?.useAI !== false; // default true
        const folderId = req.body?.folderId ?? null;
        const driveAccessToken = req.body?.driveAccessToken;
        // Only worth checking when folderId was actually omitted — a real
        // folderId always means "discover this specific folder," backlog or not.
        if (folderId === null) {
            const resumableCount = await (0, db_1.getResumableCount)(userId);
            if (resumableCount === 0) {
                res.status(400).json({ error: "folderId is required" });
                return;
            }
        }
        const runId = await (0, sync_1.startSync)(userId, useAI, folderId, driveAccessToken);
        res.json({ runId, message: "Sync started" });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
router.post("/sync/abort", requireAuth, (req, res) => {
    (0, sync_1.requestAbort)(req.userId);
    res.json({
        message: "Abort signal sent — current file will finish then sync will stop",
    });
});
router.post("/sync/pending/clear", requireAuth, asyncHandler(async (req, res) => {
    const userId = req.userId;
    const { status } = (0, sync_1.getSyncState)(userId);
    if (status === "discovering" || status === "uploading") {
        res.status(400).json({
            error: "Cannot clear pending files while a sync is running.",
        });
        return;
    }
    await (0, db_1.clearPendingFiles)(userId);
    await (0, sync_1.pushSnapshot)(userId);
    res.json({ message: "Pending files cleared" });
}));
router.get("/sync/status", requireAuth, asyncHandler(async (req, res) => {
    const userId = req.userId;
    res.json(await (0, sync_1.getSyncSnapshot)(userId));
}));
// SSE stream — replaces polling /sync/status every 2s. Sends a full snapshot
// immediately on connect (including reconnects), then incremental pushes as
// runSync progresses. Same-origin in both dev (Vite proxy) and prod (Vercel
// rewrite), so no CORS/withCredentials changes are needed for EventSource.
router.get("/sync/events", requireAuth, (req, res) => {
    const userId = req.userId;
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    (0, sync_1.addSyncClient)(userId, res);
    (0, sync_1.pushSnapshot)(userId, [res]).catch((err) => console.error("[sse] failed to push initial snapshot:", err));
    const heartbeat = setInterval(() => res.write(":\n\n"), 15000);
    req.on("close", () => {
        clearInterval(heartbeat);
        (0, sync_1.removeSyncClient)(userId, res);
    });
});
router.get("/sync/files", requireAuth, asyncHandler(async (req, res) => {
    const files = await (0, db_1.getUploadedFiles)(req.userId);
    res.json({ files });
}));
router.get("/picker/config", requireAuth, asyncHandler(async (req, res) => {
    const userId = req.userId;
    const auth = await (0, auth_1.getAuthClient)(userId);
    const { credentials } = await auth.refreshAccessToken();
    const token = credentials.access_token;
    if (!token) {
        res.status(401).json({ error: "token_expired" });
        return;
    }
    res.json({
        access_token: token,
        client_id: process.env.GOOGLE_CLIENT_ID,
        api_key: process.env.GOOGLE_API_KEY,
    });
}));
exports.default = router;
