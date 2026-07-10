import { Router, Request, Response } from "express";
import { getAuthUrl, handleCallback, getAuthClient } from "./auth";
import {
  startSync,
  requestAbort,
  getSyncSnapshot,
  addSyncClient,
  removeSyncClient,
  pushSnapshot,
} from "./sync";
import { getUploadedFiles } from "./db";

const router = Router();

// ── Health ────────────────────────────────────────────────────────────────────

router.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
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
  res.json(await getSyncSnapshot(userId));
});

// SSE stream — replaces polling /sync/status every 2s. Sends a full snapshot
// immediately on connect (including reconnects), then incremental pushes as
// runSync progresses. Same-origin in both dev (Vite proxy) and prod (Vercel
// rewrite), so no CORS/withCredentials changes are needed for EventSource.
router.get("/sync/events", requireAuth, (req: Request, res: Response) => {
  const userId = (req as any).userId;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  addSyncClient(userId, res);
  pushSnapshot(userId, [res]);

  const heartbeat = setInterval(() => res.write(":\n\n"), 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    removeSyncClient(userId, res);
  });
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
