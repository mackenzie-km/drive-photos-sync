# Decision Log

One line per real design/behavior decision, grouped by branch. Trivial
changes (wording, formatting, docs-only edits) are intentionally skipped —
this is not a changelog of every commit.

## progress-bar-colors
- Progress bar now renders four segments (uploaded/pending/failed/duplicates) instead of a single fill, driven off fileCounts rather than the removed total/progress calc, and the token_expired status message moved into a separate subheading.
- Deprioritized the "manually clear failed photos" backlog feature since observed failures (~500) all stem from permanently corrupted/0kb Drive source files, not transient errors that clearing would fix.
- Added Claude Code hooks (block --no-verify, redact live secret keys from Bash commands, auto-run eslint --fix on client TS files after edits, and surface a session file-touch summary after compaction) plus tracked .claude/settings.json, and narrowed .gitignore to only ignore .claude/settings.local.json and .claude/worktrees/ instead of the whole .claude directory so these hooks/settings can be committed.

## feature/png-exif-date-fix
- PNG date is resolved in priority order: existing EXIF date (used as-is) -> recovered from a corrupted XMP field via a known formula -> Drive's createdTime as a last resort.
- A dateless eXIf chunk only blocks rewriting if it carries Orientation or GPS — everything else (resolution, dimensions, colorspace, EXIF/FlashPix version markers, scene-capture-type, ...) is safe to discard. Deliberately a blocklist of the two tags actually worth protecting, not an allowlist of "safe" ones: real backlog files kept surfacing auto-generated tags an allowlist hadn't seen yet, falsely blocking fixable files — confirmed via production testing, where Google Photos permanently dedupes an unmodified re-upload to the existing (wrongly-dated) item, so a falsely-blocked file could never be fixed at all.

## worktree-agent-aa03ccc8306912487
- Removed the now-unused `/sync/status` REST endpoint (route, docs, and startup log message) since SSE fully replaced it and nothing still called it.

## worktree-agent-a7dfdd18755a0378c
- Added a migrations mechanism in db.ts and used it to drop sync_runs' unused total/uploaded/skipped/failed/completed_at columns, simplifying finishRun/updateSyncRun to take no count parameters since fileCounts (a live query of drive_files) was already the sole source of truth for progress display.

## main
- Drive token-expiry errors during download now halt the sync run entirely (leaving in-flight files in_progress for reclaim) instead of failing every remaining queued file individually against a token that can't be refreshed mid-run.
- Added an idle-pool error handler in db.ts and wrapped all async route handlers (plus the SSE initial pushSnapshot) in error-catching logic, since an unhandled rejection or idle-client "error" event would otherwise crash the whole Node process instead of just failing the one request.
- Removed the one-shot `GET /sync/status` REST endpoint (routes, docs, tests, and the `useSyncStatus`-era comments) since nothing in the repo actually called it anymore.
- A dateless eXIf chunk now blocks rewriting only if it carries Orientation or GPS, replacing the prior allowlist of "safe" auto-derived tags because the allowlist kept missing new backlog tags and falsely blocking otherwise-fixable files.

## global-pending-resume
- Skip Phase 1 discovery whenever `folderId` is `null`, rather than re-deriving "is there a backlog" inside `runSync` from file counts — the route already decided that via `getResumableCount`, so sync just honors the signal it's given (`c5321eb`).
- Added `getResumableCount`/`getCountsPayload` as the one source of truth for "is there a resumable backlog," replacing separate call sites that queried file counts differently and could drift out of sync with each other (`1f19365`).
