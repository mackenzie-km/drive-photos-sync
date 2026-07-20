# Decision Log

One line per real design/behavior decision, grouped by branch. Trivial
changes (wording, formatting, docs-only edits) are intentionally skipped —
this is not a changelog of every commit.

## main
- Drive token-expiry errors during download now halt the sync run entirely (leaving in-flight files in_progress for reclaim) instead of failing every remaining queued file individually against a token that can't be refreshed mid-run.

## global-pending-resume
- Skip Phase 1 discovery whenever `folderId` is `null`, rather than re-deriving "is there a backlog" inside `runSync` from file counts — the route already decided that via `getResumableCount`, so sync just honors the signal it's given (`c5321eb`).
- Added `getResumableCount`/`getCountsPayload` as the one source of truth for "is there a resumable backlog," replacing separate call sites that queried file counts differently and could drift out of sync with each other (`1f19365`).
