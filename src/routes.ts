import { Router, Request, Response } from "express";
import { getAuthUrl, handleCallback } from "./auth";
import { startSync, getSyncState, requestAbort } from "./sync";
import { getLatestSyncRun, getFileCounts } from "./db";

const router = Router();

// ── Auth ──────────────────────────────────────────────────────────────────────

// Step 1: visit this URL in your browser to kick off OAuth
router.get("/auth/url", (_req: Request, res: Response) => {
  res.json({ url: getAuthUrl() });
});

// Step 2: Google redirects here with ?code=... after the user approves.
// We exchange the code for tokens, fetch the user's stable Google userId, and store it in the session
router.get("/auth/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).json({ error: "Missing code parameter" });
    return;
  }
  try {
    const userId = await handleCallback(code);
    console.log(userId);
    (req.session as any).userId = userId;
    res.send(
      "<p>Authentication successful. You can close this tab and return to the terminal.</p>",
    );
  } catch (err: any) {
    console.error("[auth] callback error:", err);
    // Send the user back to try again with a human-readable message in the page
    res
      .status(403)
      .send(`<p>${err.message}</p><p><a href="/auth/url">Try again</a></p>`);
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
router.post("/sync/start", requireAuth, async (req: Request, res: Response) => {
  try {
    const runId = await startSync((req as any).userId);
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
  res.json({ ...state, latestRun: latestRun ?? null, fileCounts });
});

export default router;
