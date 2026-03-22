import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { saveTokens, getTokens } from "./db";

const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/photoslibrary.appendonly",
  "https://www.googleapis.com/auth/userinfo.profile",
];

function createClient(): OAuth2Client {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.OAUTH_REDIRECT_URI ?? "http://localhost:3000/auth/callback",
  );
}

export function getAuthUrl(): string {
  return createClient().generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // ensures we always get a refresh_token
  });
}

// Returns the stable Google user ID (the "sub" claim) after completing OAuth.
export async function handleCallback(code: string): Promise<string> {
  const client = createClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  // tokens.scope is a space-separated string of what the user actually granted.
  // We check every required scope is present before proceeding.
  const granted = new Set((tokens.scope ?? "").split(" "));
  const missing = SCOPES.filter((s) => !granted.has(s));
  if (missing.length > 0) {
    throw new Error(
      `You must grant all permissions to use this app. Missing: ${missing.join(", ")}`,
    );
  }

  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const { data } = await oauth2.userinfo.get();
  const userId = data.id!;

  await saveTokens(
    userId,
    tokens.access_token ?? null,
    tokens.refresh_token ?? null,
    tokens.expiry_date ?? null,
  );

  return userId;
}

export async function getAuthClient(userId: string): Promise<OAuth2Client> {
  const row = await getTokens(userId);
  if (!row?.refresh_token) {
    throw new Error(
      "Not authenticated. Call GET /auth/url and complete the OAuth flow first.",
    );
  }

  const client = createClient();
  client.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expiry_date: row.expiry_date,
  });

  // Persist any refreshed tokens automatically.
  client.on("tokens", (tokens) => {
    saveTokens(
      userId,
      tokens.access_token ?? row.access_token,
      tokens.refresh_token ?? row.refresh_token,
      tokens.expiry_date ?? null,
    ).catch((err) =>
      console.error("[auth] failed to persist refreshed tokens:", err),
    );
  });

  return client;
}
