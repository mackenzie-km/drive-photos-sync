# PNG EXIF date-write prototype

Scoped-down proof-of-concept for the PNG piece of the date-fix plan (see
`/Users/Mackenzie/.claude/plans/png-exif-prototype.md` and the full plan in
`cuddly-wibbling-spring.md`). Not wired into the real app — standalone scripts only.

## Files

- `pngExif.ts` — the actual mechanism. `writePngDate(buffer, date)` replaces a PNG's
  `eXIf` chunk with a freshly-built minimal one containing `DateTime` (IFD0) and
  `DateTimeOriginal`/`DateTimeDigitized` (Exif sub-IFD). `readPngDate(buffer)` is an
  independent parser (does not share code/assumptions with the writer) used to verify
  the result.
- `roundTripTest.ts` — proves the writer works in isolation: loads a real no-EXIF PNG
  from this user's actual backlog, writes a test date, re-parses independently, confirms
  the date matches, and confirms the PNG is still structurally valid.
- `realUploadTest.ts` — proves it end-to-end: same write, then uploads the result to the
  user's real Google Photos via `uploadWithProductUrl.ts`, so the displayed date can be
  visually confirmed.
- `uploadWithProductUrl.ts` — a prototype-local variant of `src/photos.ts`'s `uploadPhoto`.
  Identical upload logic, but also returns `productUrl` from the `batchCreate` response,
  which the real app's `uploadPhoto` discards (it only returns the media item ID). This
  matters: `productUrl` is what actually works as a web-viewable link — the bare ID is in a
  different namespace/format than `photos.google.com/photo/{id}` expects, so hand-building
  a URL from the ID alone 404s even though the upload succeeded.
- `checkMediaItem.ts` — attempted API-level confirmation of the uploaded item's date;
  fails with 403 `ACCESS_TOKEN_SCOPE_INSUFFICIENT` because this app only requests
  `photoslibrary.appendonly` (upload-only) scope, never a read scope. Expected, not a bug —
  visual confirmation via the Photos link is the real verification path.

## Results (2026-08-03 / 2026-08-04) — CONFIRMED WORKING

- `npx tsx prototype/roundTripTest.ts` — **PASSED**. `IMG_2324.png` (confirmed earlier in
  this investigation to have zero EXIF date tags) got a `2018-06-15` test date written in,
  independently re-read back correctly, and macOS's own `sips` tool (unrelated to this
  code) independently confirmed `creation: 2018:06:15 12:00:00` on the output file.
- `npx tsx prototype/realUploadTest.ts` — uploaded a real test copy of `IMG_2324.png` with
  a `2024-01-15` date written in (matching the year the user visually confirmed from
  Drive's own UI for this file).
- **User-confirmed end-to-end**: the user opened the uploaded photo directly in Google
  Photos (via a share link they generated themselves,
  `https://photos.app.goo.gl/PP8Cx8U5MSpiLv367`) and confirmed **the displayed date shows
  the corrected date, not today's date.** This is the actual goal for tonight, proven
  against the real product, not just via independent parsing.
- Separately: the first hand-constructed URL (`https://photos.google.com/photo/{id}`)
  404'd with "Photo not found" — this was a bug in the test script, not the mechanism. The
  Photos API returns a dedicated `productUrl` field for exactly this purpose (see
  `uploadWithProductUrl.ts`); the bare media item ID uses a different format than the
  web UI's own link scheme. Re-running with `productUrl` returned the **same media item
  ID** as the first upload despite a different filename — consistent with the same photo
  the user already confirmed, not a separate item.

## Known scope cuts vs. the full plan

- No live Drive API re-fetch of `createdTime`/`modifiedTime` for this test — the backend's
  stored OAuth token doesn't have standing `drive.file` access to arbitrary files outside an
  active picker session (see `CLAUDE.md`'s GIS token note). The full plan's `sync.ts`
  integration already receives a fresh GIS token per sync request, so this isn't a real
  blocker there — just out of scope for tonight's standalone script.
- JPEG, DB schema changes, and `sync.ts` wiring are explicitly out of scope for this
  prototype — see the full plan for those.
