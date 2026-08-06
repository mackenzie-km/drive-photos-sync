import "dotenv/config";
import { google } from "googleapis";
import { createClientFromToken } from "../src/auth";

// Proves the piece of the date-fix plan that prototype/png-exif-date-writer
// (PR #2) explicitly cut: a live re-fetch of a Drive file's createdTime via
// a GIS-minted access token, rather than a hardcoded date.
//
// The backend's stored OAuth token has no standing access to arbitrary Drive
// files under drive.file scope (see CLAUDE.md's "Drive file authorization
// uses GIS tokens" note) — this requires a token minted by the actual app's
// picker/resume flow, pasted in via env var. Never hardcode a real token here.
//
// Usage:
//   DRIVE_ACCESS_TOKEN=ya29.... npx tsx prototype/driveMetadataTest.ts

const FILE_ID = "1WHrupjO_3yZbRA9kPE2wnxjFObIWRgD3"; // IMG_2324.png, status=uploaded in drive_files

async function main() {
  const token = process.env.DRIVE_ACCESS_TOKEN;
  if (!token) {
    throw new Error("Set DRIVE_ACCESS_TOKEN to a fresh GIS-minted access token (see file header).");
  }

  const auth = createClientFromToken(token);
  const drive = google.drive({ version: "v3", auth });

  const res = await drive.files.get({
    fileId: FILE_ID,
    fields: "id, name, createdTime, modifiedTime",
  });

  console.log("Drive metadata for", FILE_ID);
  console.log(res.data);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
