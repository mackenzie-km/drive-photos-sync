"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("./auth");
const sync_1 = require("./sync");
const db_1 = require("./db");
const router = (0, express_1.Router)();
// ── Health ────────────────────────────────────────────────────────────────────
router.get("/health", async (_req, res) => {
    try {
        await (0, db_1.query)("SELECT 1");
        res.json({ ok: true });
    }
    catch (err) {
        console.error("[health] DB check failed:", err);
        res.status(503).json({ ok: false, error: "DB unavailable" });
    }
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
const SYNC_TIMEOUT_SECS = 3 * 60 * 60; // 3 hours
router.post("/sync/start", requireAuth, async (req, res) => {
    try {
        const useAI = req.body?.useAI !== false; // default true
        const folderId = req.body?.folderId;
        if (!folderId) {
            res.status(400).json({ error: "folderId is required" });
            return;
        }
        const runId = await (0, sync_1.startSync)(req.userId, useAI, folderId);
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
router.get("/sync/status", requireAuth, async (req, res) => {
    const userId = req.userId;
    const state = (0, sync_1.getSyncState)(userId);
    const latestRun = await (0, db_1.getLatestSyncRun)(userId);
    const countsRaw = await (0, db_1.getFileCounts)(userId);
    const fileCounts = Object.fromEntries(countsRaw.map((r) => [r.status, r.count]));
    // - No active in-memory sync (e.g. server restart) → show error
    // - Active sync but exceeded 3-hour timeout → request abort, show error
    if (latestRun?.status === "running") {
        const noActiveSync = state.status === "idle";
        const isStale = Math.floor(Date.now() / 1000) - latestRun.started_at > SYNC_TIMEOUT_SECS;
        if (noActiveSync || isStale) {
            if (isStale && !noActiveSync)
                (0, sync_1.requestAbort)(userId);
            latestRun.status = "failed";
            latestRun.error = "Sync was interrupted. Start a new sync to resume.";
        }
    }
    res.json({ ...state, latestRun: latestRun ?? null, fileCounts });
});
router.get("/sync/files", requireAuth, async (req, res) => {
    const files = await (0, db_1.getUploadedFiles)(req.userId);
    res.json({ files });
});
router.get("/picker/config", requireAuth, async (req, res) => {
    const userId = req.userId;
    const row = await (0, db_1.getTokens)(userId);
    res.json({
        access_token: row?.access_token,
        client_id: process.env.GOOGLE_CLIENT_ID,
        api_key: process.env.GOOGLE_API_KEY,
    });
});
exports.default = router;
