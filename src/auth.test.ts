// Mock the entire 'googleapis' module so no real HTTP calls are made.
jest.mock("googleapis", () => ({
  google: {
    auth: {
      // createClient() calls new google.auth.OAuth2(...) — we replace it
      // with a class whose methods we can control per test.
      OAuth2: jest.fn().mockImplementation(() => ({
        getToken: jest.fn(),
        setCredentials: jest.fn(),
        generateAuthUrl: jest.fn(),
        on: jest.fn(),
      })),
    },
    oauth2: jest.fn(),
  },
}));

// Mock our db module so the test never touches a real database.
jest.mock("./db", () => ({
  saveTokens: jest.fn().mockResolvedValue(undefined),
  getTokens: jest.fn(),
}));

import { google } from "googleapis";
import { handleCallback } from "./auth";

// Grab the mocked OAuth2 constructor so we can configure instances per test
const MockOAuth2 = google.auth.OAuth2 as unknown as jest.Mock;

describe("handleCallback", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("throws if the user did not grant all required scopes", async () => {
    // Simulate Google returning tokens that are missing the photoslibrary scope
    MockOAuth2.mockImplementation(() => ({
      getToken: jest.fn().mockResolvedValue({
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          expiry_date: 9999999999,
          // Only two of the three required scopes granted:
          scope:
            "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.profile",
        },
      }),
      setCredentials: jest.fn(),
      on: jest.fn(),
    }));

    await expect(handleCallback("some-code")).rejects.toThrow(
      "You must grant all permissions to use this app. Missing: https://www.googleapis.com/auth/photoslibrary",
    );
  });

  it("throws if the user granted no scopes at all", async () => {
    MockOAuth2.mockImplementation(() => ({
      getToken: jest.fn().mockResolvedValue({
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          expiry_date: 9999999999,
          scope: "", // nothing granted
        },
      }),
      setCredentials: jest.fn(),
      on: jest.fn(),
    }));

    await expect(handleCallback("some-code")).rejects.toThrow(
      "You must grant all permissions to use this app.",
    );
  });

  it("succeeds and returns userId when all scopes are granted", async () => {
    MockOAuth2.mockImplementation(() => ({
      getToken: jest.fn().mockResolvedValue({
        tokens: {
          access_token: "access-token",
          refresh_token: "refresh-token",
          expiry_date: 9999999999,
          scope: [
            "https://www.googleapis.com/auth/drive.readonly",
            "https://www.googleapis.com/auth/photoslibrary",
            "https://www.googleapis.com/auth/userinfo.profile",
          ].join(" "),
        },
      }),
      setCredentials: jest.fn(),
      on: jest.fn(),
    }));

    // Mock the userinfo.get() call that fetches the stable Google user ID
    (google.oauth2 as jest.Mock).mockReturnValue({
      userinfo: {
        get: jest.fn().mockResolvedValue({ data: { id: "google-user-123" } }),
      },
    });

    const userId = await handleCallback("some-code");
    expect(userId).toBe("google-user-123");
  });
});
