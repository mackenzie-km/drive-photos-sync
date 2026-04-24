import { Router, Request, Response } from "express";
import { getAuthUrl, handleCallback, getAuthClient } from "./auth";
import { startSync, getSyncState, requestAbort } from "./sync";
import { getLatestSyncRun, getFileCounts, getUploadedFiles, query } from "./db";

const router = Router();

// ── Health ────────────────────────────────────────────────────────────────────

router.get("/health", async (_req: Request, res: Response) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    console.error("[health] DB check failed:", err);
    res.status(503).json({ ok: false, error: "DB unavailable" });
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────

// Step 1: visit this URL in your browser to kick off OAuth
router.get("/auth/url", (_req: Request, res: Response) => {
  res.json({ url: getAuthUrl() });
});

// Step 2: Google redirects here with ?code=... after the user approves.
// We exchange the code for tokens, fetch the user's stable Google userId, and store it in the session
router.get("/auth/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:5173";
  if (!code) {
    res.redirect(`${frontendUrl}/?auth_error=access_denied`);
    return;
  }
  try {
    const userId = await handleCallback(code);
    (req.session as any).userId = userId;
    req.session.save((err) => {
      if (err) console.error("[auth] session save error:", err);
      res.redirect(frontendUrl);
    });
  } catch (err: any) {
    console.error("[auth] callback error:", err);
    res.redirect(`${frontendUrl}/?auth_error=1`);
  }
});

router.get("/auth/me", (req: Request, res: Response) => {
  const userId = (req.session as any).userId;
  if (!userId) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }
  res.json({ userId });
});

// ── Auth middleware — all /sync routes require a session ──────────────────────
function requireAuth(req: Request, res: Response, next: Function) {
  const userId = (req.session as any).userId;
  if (!userId) {
    res.status(401).json({
      error: "Not authenticated. Complete the OAuth flow at /auth/url first.",
    });
    return;
  }
  (req as any).userId = userId;
  next();
}

// ── Sync ──────────────────────────────────────────────────────────────────────
const SYNC_TIMEOUT_SECS = 3 * 60 * 60; // 3 hours

router.post("/sync/start", requireAuth, async (req: Request, res: Response) => {
  try {
    const useAI = req.body?.useAI !== false; // default true
    const folderId = req.body?.folderId as string;
    const driveAccessToken = req.body?.driveAccessToken as string | undefined;
    if (!folderId) {
      res.status(400).json({ error: "folderId is required" });
      return;
    }
    const runId = await startSync((req as any).userId, useAI, folderId, driveAccessToken);
    res.json({ runId, message: "Sync started" });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/sync/abort", requireAuth, (req: Request, res: Response) => {
  requestAbort((req as any).userId);
  res.json({
    message: "Abort signal sent — current file will finish then sync will stop",
  });
});

router.get("/sync/status", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const state = getSyncState(userId);
  const latestRun = await getLatestSyncRun(userId);
  const countsRaw = await getFileCounts(userId);
  const fileCounts = Object.fromEntries(
    countsRaw.map((r) => [r.status, r.count]),
  );

  // - No active in-memory sync (e.g. server restart) → show error
  // - Active sync but exceeded 3-hour timeout → request abort, show error
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

  res.json({ ...state, latestRun: latestRun ?? null, fileCounts });
});

router.get("/sync/files", requireAuth, async (req: Request, res: Response) => {
  const files = await getUploadedFiles((req as any).userId);
  res.json({ files });
});

router.get("/picker/config", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const auth = await getAuthClient(userId);
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
});

export default router;
