// Mock all external dependencies so no real DB or Google API calls are made.
jest.mock("./auth", () => ({
  getAuthUrl: jest
    .fn()
    .mockReturnValue("https://accounts.google.com/fake-auth"),
  handleCallback: jest.fn(),
  getAuthClient: jest.fn(),
}));

jest.mock("./sync", () => ({
  startSync: jest.fn(),
  requestAbort: jest.fn(),
  getSyncSnapshot: jest.fn(),
  getSyncState: jest.fn(),
  addSyncClient: jest.fn(),
  removeSyncClient: jest.fn(),
  pushSnapshot: jest.fn(),
}));

jest.mock("./db", () => ({
  getUploadedFiles: jest.fn().mockResolvedValue([]),
  clearPendingFiles: jest.fn().mockResolvedValue(undefined),
  getResumableCount: jest.fn().mockResolvedValue(0),
}));

import express from "express";
import session from "express-session";
import request from "supertest";
import routes from "./routes";
import { handleCallback, getAuthClient } from "./auth";
import {
  startSync,
  requestAbort,
  getSyncSnapshot,
  getSyncState,
  pushSnapshot,
} from "./sync";
import { clearPendingFiles, getResumableCount, getUploadedFiles } from "./db";

const mockHandleCallback = handleCallback as jest.Mock;
const mockGetAuthClient = getAuthClient as jest.Mock;
const mockStartSync = startSync as jest.Mock;
const mockGetSyncSnapshot = getSyncSnapshot as jest.Mock;
const mockGetSyncState = getSyncState as jest.Mock;
const mockPushSnapshot = pushSnapshot as jest.Mock;
const mockClearPendingFiles = clearPendingFiles as jest.Mock;
const mockGetResumableCount = getResumableCount as jest.Mock;
const mockGetUploadedFiles = getUploadedFiles as jest.Mock;

// Polls until condition is true.
async function waitFor(condition: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
  app.use(
    (
      err: any,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: "Internal server error" });
    },
  );
  return app;
}

describe("POST /sync/start", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no pending backlog. getResumableCount is only queried at all
    // when folderId is omitted, so this only matters for those tests.
    mockGetResumableCount.mockResolvedValue(0);
  });

  it("returns 400 with an error message when a sync is already running", async () => {
    mockStartSync.mockRejectedValue(new Error("A sync is already running"));
    const res = await request(createApp("user-123"))
      .post("/sync/start")
      .send({ folderId: "test-folder-id" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("A sync is already running");
    // A real folderId means getResumableCount never needs to be checked.
    expect(mockGetResumableCount).not.toHaveBeenCalled();
  });

  it("returns 400 when there is no pending backlog and folderId is missing", async () => {
    mockGetResumableCount.mockResolvedValue(0);
    const res = await request(createApp("user-123"))
      .post("/sync/start")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("folderId is required");
    expect(mockStartSync).not.toHaveBeenCalled();
  });

  it("starts a sync with folderId omitted when there is a pending backlog", async () => {
    mockGetResumableCount.mockResolvedValue(5);
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
    mockGetSyncState.mockReturnValue({
      status: "idle",
      runId: null,
      currentFile: null,
    });
    const res = await request(createApp("user-123")).post(
      "/sync/pending/clear",
    );
    expect(res.status).toBe(200);
    expect(mockClearPendingFiles).toHaveBeenCalledWith("user-123");
    expect(mockPushSnapshot).toHaveBeenCalledWith("user-123");
  });

  it("rejects with 400 while a sync is running, without clearing anything", async () => {
    mockGetSyncState.mockReturnValue({
      status: "uploading",
      runId: 1,
      currentFile: "photo.jpg",
    });
    const res = await request(createApp("user-123")).post(
      "/sync/pending/clear",
    );
    expect(res.status).toBe(400);
    expect(mockClearPendingFiles).not.toHaveBeenCalled();
  });

  it("returns 500 instead of crashing when clearPendingFiles rejects (e.g. a dropped DB connection)", async () => {
    mockGetSyncState.mockReturnValue({
      status: "idle",
      runId: null,
      currentFile: null,
    });
    mockClearPendingFiles.mockRejectedValue(
      new Error("Connection terminated unexpectedly"),
    );
    const res = await request(createApp("user-123")).post(
      "/sync/pending/clear",
    );
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
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

  it("returns 500 instead of crashing when getSyncSnapshot rejects (e.g. a dropped DB connection)", async () => {
    mockGetSyncSnapshot.mockRejectedValue(
      new Error("Connection terminated unexpectedly"),
    );
    const res = await request(createApp("user-123")).get("/sync/status");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});

describe("GET /sync/files", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns whatever getUploadedFiles resolves for the authenticated user", async () => {
    mockGetUploadedFiles.mockResolvedValue([{ id: "1", name: "photo.jpg" }]);
    const res = await request(createApp("user-123")).get("/sync/files");
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([{ id: "1", name: "photo.jpg" }]);
    expect(mockGetUploadedFiles).toHaveBeenCalledWith("user-123");
  });

  it("returns 500 instead of crashing when getUploadedFiles rejects", async () => {
    mockGetUploadedFiles.mockRejectedValue(
      new Error("Connection terminated unexpectedly"),
    );
    const res = await request(createApp("user-123")).get("/sync/files");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});

describe("GET /picker/config", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns 500 instead of crashing when getAuthClient rejects", async () => {
    mockGetAuthClient.mockRejectedValue(
      new Error("Connection terminated unexpectedly"),
    );
    const res = await request(createApp("user-123")).get("/picker/config");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});

describe("GET /sync/events — resilience", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not crash the process when the initial pushSnapshot rejects", async () => {
    mockPushSnapshot.mockRejectedValue(
      new Error("Connection terminated unexpectedly"),
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const server = createApp("user-123").listen(0);
    const port = (server.address() as any).port;
    const controller = new AbortController();

    try {
      const res = await fetch(`http://localhost:${port}/sync/events`, {
        signal: controller.signal,
      });
      expect(res.status).toBe(200);

      await waitFor(() => errorSpy.mock.calls.length > 0);
      expect(errorSpy.mock.calls[0][0]).toContain(
        "failed to push initial snapshot",
      );
    } finally {
      controller.abort();
      errorSpy.mockRestore();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
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
