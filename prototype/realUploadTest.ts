import "dotenv/config";
import { readFileSync } from "fs";
import { Readable } from "stream";
import { getAuthClient } from "../src/auth";
import { uploadPhoto } from "../src/photos";
import { writePngDate, readPngDate } from "./pngExif";

const USER_ID = "102316373971929260712";
const LOCAL_PATH = "/Users/Mackenzie/Downloads/IMG_2324.png";

// Live re-fetch of this file's Drive metadata via `getAuthClient`'s stored backend
// token isn't possible here — `drive.file` scope only grants access to files
// authorized through an active picker session with a fresh GIS token (see
// CLAUDE.md's "Drive file authorization uses GIS tokens" note); the backend
// token has no standing access to arbitrary Drive files. That live-fetch wiring
// is in scope for the full plan (routes.ts already receives a fresh GIS token
// per sync request), not tonight's narrower PNG-mechanism proof. Using the date
// already visually confirmed from Drive's own UI for this exact file instead.
const RESOLVED_DATE = new Date(Date.UTC(2024, 0, 15, 12, 0, 0));

async function main() {
  const auth = await getAuthClient(USER_ID);
  console.log(`Resolved fallback date (from Drive's UI, confirmed earlier): ${RESOLVED_DATE.toISOString()}`);

  const originalBuffer = readFileSync(LOCAL_PATH);
  const before = readPngDate(originalBuffer);
  console.log("Existing EXIF date in local file (expect none):", before);

  const rewritten = writePngDate(originalBuffer, RESOLVED_DATE);
  const after = readPngDate(rewritten);
  console.log("EXIF date after write (independent re-parse):", after);

  console.log("\nUploading test copy to Google Photos...");
  const filename = "PROTOTYPE-datefix-test-IMG_2324.png";
  const mediaId = await uploadPhoto(
    auth,
    Readable.from(rewritten),
    filename,
    "image/png",
    `Prototype test upload — date-fix demo. Resolved date: ${RESOLVED_DATE.toISOString()}. Safe to delete.`,
  );

  console.log(`\nUploaded. Media item ID: ${mediaId}`);
  console.log(`View it at: https://photos.google.com/photo/${mediaId}`);

  // Independent confirmation via the Photos API itself, not just our own parser.
  const token = await auth.getAccessToken();
  const res = await fetch(
    `https://photoslibrary.googleapis.com/v1/mediaItems/${mediaId}`,
    { headers: { Authorization: `Bearer ${token.token}` } },
  );
  const mediaItem = await res.json();
  console.log("\nGoogle Photos' own reported creationTime for this upload:");
  console.log(mediaItem.mediaMetadata?.creationTime);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
