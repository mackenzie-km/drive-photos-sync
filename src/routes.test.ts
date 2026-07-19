// Mock all external dependencies so no real DB or Google API calls are made.
jest.mock("./auth", () => ({
  getAuthUrl: jest
    .fn()
    .mockReturnValue("https://accounts.google.com/fake-auth"),
  handleCallback: jest.fn(),
}));

jest.mock("./sync", () => ({
  startSync: jest.fn(),
  requestAbort: jest.fn(),
  getSyncSnapshot: jest.fn(),
  addSyncClient: jest.fn(),
  removeSyncClient: jest.fn(),
  pushSnapshot: jest.fn(),
}));

jest.mock("./db", () => ({
  getUploadedFiles: jest.fn().mockResolvedValue([]),
  clearPendingFiles: jest.fn().mockResolvedValue(undefined),
}));

import express from "express";
import session from "express-session";
import request from "supertest";
import routes from "./routes";
import { handleCallback } from "./auth";
import { startSync, requestAbort, getSyncSnapshot, pushSnapshot } from "./sync";
import { clearPendingFiles } from "./db";

const mockHandleCallback = handleCallback as jest.Mock;
const mockStartSync = startSync as jest.Mock;
const mockGetSyncSnapshot = getSyncSnapshot as jest.Mock;
const mockPushSnapshot = pushSnapshot as jest.Mock;
const mockClearPendingFiles = clearPendingFiles as jest.Mock;

// Creates a minimal Express app with session middleware.
// Pass a userId to simulate an already-authenticated session.
function createApp(userId?: string) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: "test", resave: false, saveUninitialized: false }));
  if (userId) {
    app.use((req, _res, next) => {
      (req.session as any).userId = userId;
      next();
    });
  }
  app.use(routes);
  return app;
}

describe("POST /sync/start", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no pending backlog — most tests here pass a folderId anyway,
    // so this only matters for satisfying the route's getSyncSnapshot call.
    mockGetSyncSnapshot.mockResolvedValue({ fileCounts: {} });
  });

  it("returns 400 with an error message when a sync is already running", async () => {
    mockStartSync.mockRejectedValue(new Error("A sync is already running"));
    const res = await request(createApp("user-123"))
      .post("/sync/start")
      .send({ folderId: "test-folder-id" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("A sync is already running");
  });

  it("returns 400 when there is no pending backlog and folderId is missing", async () => {
    mockGetSyncSnapshot.mockResolvedValue({ fileCounts: { uninitialized: 0 } });
    const res = await request(createApp("user-123"))
      .post("/sync/start")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("folderId is required");
    expect(mockStartSync).not.toHaveBeenCalled();
  });

  it("starts a sync with folderId omitted when there is a pending backlog", async () => {
    mockGetSyncSnapshot.mockResolvedValue({ fileCounts: { uninitialized: 5 } });
    mockStartSync.mockResolvedValue(42);
    const res = await request(createApp("user-123"))
      .post("/sync/start")
      .send({ driveAccessToken: "tok" });
    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(42);
    expect(mockStartSync).toHaveBeenCalledWith("user-123", true, null, "tok");
  });
});

describe("POST /sync/pending/clear", () => {
  beforeEach(() => jest.clearAllMocks());

  it("clears pending files and pushes a fresh snapshot when idle", async () => {
    mockGetSyncSnapshot.mockResolvedValue({
      status: "idle",
      fileCounts: { uninitialized: 5 },
    });
    const res = await request(createApp("user-123")).post(
      "/sync/pending/clear",
    );
    expect(res.status).toBe(200);
    expect(mockClearPendingFiles).toHaveBeenCalledWith("user-123");
    expect(mockPushSnapshot).toHaveBeenCalledWith("user-123");
  });

  it("rejects with 400 while a sync is running, without clearing anything", async () => {
    mockGetSyncSnapshot.mockResolvedValue({
      status: "uploading",
      fileCounts: { uninitialized: 5 },
    });
    const res = await request(createApp("user-123")).post(
      "/sync/pending/clear",
    );
    expect(res.status).toBe(400);
    expect(mockClearPendingFiles).not.toHaveBeenCalled();
  });
});

// The stale-run correction logic itself now lives in sync.ts's
// getSyncSnapshot (tested directly in sync.test.ts). This just confirms the
// route is a thin pass-through.
describe("GET /sync/status", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns whatever getSyncSnapshot resolves for the authenticated user", async () => {
    const snapshot = {
      status: "idle",
      currentFile: null,
      runId: null,
      latestRun: { status: "failed", error: "Sync was interrupted." },
      fileCounts: {},
    };
    mockGetSyncSnapshot.mockResolvedValue(snapshot);

    const res = await request(createApp("user-123")).get("/sync/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(snapshot);
    expect(mockGetSyncSnapshot).toHaveBeenCalledWith("user-123");
  });
});

describe("GET /auth/callback — auth errors redirect to FRONTEND_URL with a banner", () => {
  const DEFAULT_FRONTEND = "http://localhost:5173";

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FRONTEND_URL;
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("redirects with auth_error when Google omits the code (e.g. user denied access)", async () => {
    const res = await request(createApp()).get("/auth/callback");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      `${DEFAULT_FRONTEND}/?auth_error=access_denied`,
    );
  });

  it("redirects with auth_error when token exchange fails", async () => {
    mockHandleCallback.mockRejectedValue(new Error("Token exchange failed"));
    const res = await request(createApp()).get("/auth/callback?code=bad-code");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${DEFAULT_FRONTEND}/?auth_error=1`);
  });

  it("redirects with auth_error when scope validation fails", async () => {
    mockHandleCallback.mockRejectedValue(
      new Error("You must grant all permissions to use this app."),
    );
    const res = await request(createApp()).get(
      "/auth/callback?code=scope-denied-code",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${DEFAULT_FRONTEND}/?auth_error=1`);
  });

  it("redirects to FRONTEND_URL (no error) on success", async () => {
    mockHandleCallback.mockResolvedValue("user-123");
    const res = await request(createApp()).get(
      "/auth/callback?code=valid-code",
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(DEFAULT_FRONTEND);
  });

  it("uses the FRONTEND_URL env var for all redirects", async () => {
    process.env.FRONTEND_URL = "https://myapp.com";
    const res = await request(createApp()).get("/auth/callback");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(
      "https://myapp.com/?auth_error=access_denied",
    );
  });
});
