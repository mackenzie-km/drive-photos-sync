// Mock all external dependencies so no real DB or Google API calls are made.
jest.mock("./auth", () => ({
  getAuthUrl: jest.fn().mockReturnValue("https://accounts.google.com/fake-auth"),
  handleCallback: jest.fn(),
}));

jest.mock("./sync", () => ({
  startSync: jest.fn(),
  getSyncState: jest
    .fn()
    .mockReturnValue({ status: "idle", currentFile: null, runId: null }),
  requestAbort: jest.fn(),
}));

jest.mock("./db", () => ({
  getLatestSyncRun: jest.fn().mockResolvedValue(null),
  getFileCounts: jest.fn().mockResolvedValue([]),
  getUploadedFiles: jest.fn().mockResolvedValue([]),
}));

import express from "express";
import session from "express-session";
import request from "supertest";
import routes from "./routes";
import { handleCallback } from "./auth";

const mockHandleCallback = handleCallback as jest.Mock;

// Creates a minimal Express app with session middleware.
// Pass a userId to simulate an already-authenticated session.
function createApp(userId?: string) {
  const app = express();
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

describe("GET /auth/callback — auth errors redirect to FRONTEND_URL with a banner", () => {
  const DEFAULT_FRONTEND = "http://localhost:5173";

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.FRONTEND_URL;
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
    const res = await request(createApp()).get("/auth/callback?code=valid-code");
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
