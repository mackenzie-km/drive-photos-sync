# PRD: Tag & Sync (drive-photos-sync)

## 1. Problem statement

Photos accumulate in Google Drive over the years with no reliable way to
search them by content, and no easy path into Google Photos (which _does_
have content search).

This is both a genuine personal problem (a disorganized Drive full of
unsearchable photos) and a deliberate vehicle for hands-on practice with
AI-assisted/agentic development.

## 2. Goals

- Move photos from Google Drive into Google Photos without duplicating files
  already synced.
- Make photos searchable by content by generating AI captions before upload.
- Make sync resumable across interruptions — no re-picking a folder, no
  re-processing already-handled files.
- Give real-time visibility into sync progress rather than an opaque
  long-running job.
- Use this build as a concrete reference point for AI-orchestrated
  engineering practice (relevant to job search framing, not just the tool
  itself).

## 3. Non-goals

- **Not a general backup tool.** No support for non-photo files, no folder
  structure preservation in Photos, no two-way sync back to Drive.
- **Not built for scale beyond a single active user yet.** Real-time
  progress is reliable for one sync at a time; supporting many concurrent
  users across multiple servers is a future concern, not a v1 requirement.
- **Requests the minimum Drive access needed**, not full Drive read access —
  a deliberate tradeoff of some flexibility for a faster, lower-friction
  permission grant.
- **Supports common photo formats only.** A couple of image formats are
  intentionally excluded because Google Photos can't reliably import them.
- **AI captioning requires processing the whole photo at once**, not as a
  stream — which is why there's a size limit on files eligible for
  captioning.

## 4. Target users

- **Primary (v1):** Mackenzie, solving her own Drive/Photos disorganization.
- **Secondary (aspirational, not committed):** friends/family may use it —
  the app isn't gated to a single account — but there's no committed plan,
  onboarding flow, or specific person waiting on it yet. Not designed for
  multi-user use (no per-user quotas or isolation guarantees beyond basic
  per-account separation).

## 5. Core user flow

1. Sign in with Google.
2. Pick a Drive folder to sync.
3. The app finds all photos in that folder and queues them.
4. Each photo is optionally captioned by AI, then uploaded to Google Photos.
5. Progress updates live in the browser while the sync runs.
6. Duplicates are skipped automatically; photos that fail are retried
   automatically on the next sync.
7. Coming back later — even after closing the browser or the app
   restarting — resumes the sync where it left off, without needing to
   re-pick the folder.

## 6. Functional requirements

- User can authenticate with Google.
- User can choose a Drive folder.
- User can enable/disable AI descriptions for search.
- User can resume interrupted syncs.
- User sees live progress.
- Duplicate photos are skipped.
- Failed uploads retry automatically (up to a limit).
- User can clear a pending backlog if desired.

## 7. Success metrics

No baseline was captured before starting. Metrics below are
reconstructed from actual usage, not instrumented at build time:

- **Scale tested:** ~5,000 photos run through the sync so far, against
  Mackenzie's real backlog (not synthetic/sample data) — still in progress.
- **Reliability, raw:** ~10% of files (~500) ended in failed status.
- **Reliability, corrected:** all ~500 failures traced to pre-existing 0kb/
  corrupted files already present in the source Drive folder — not sync
  bugs. Effective failure rate on valid, non-corrupted source files is
  ~0%. Both numbers are worth keeping side by side: the raw rate
  understates reliability, the corrected rate could look like
  cherry-picking if the raw number isn't shown alongside it.
- **Headline claim:** migrated ~4,500 of ~5,000 tested photos (90%) from
  Drive to searchable Google Photos with no manual intervention beyond the
  initial folder pick; the only failures were pre-existing corrupted files
  in the source library, which the sync correctly flagged rather than
  silently dropping or succeeding on.
- **Portfolio metric:** ability to walk through real product/architectural
  tradeoffs with concrete rationale, not just "it works."

## 8. Known Constraints

- If the server restarts mid-sync, in-progress state is lost, but completed
  work isn't — the next sync picks up where the backlog says it should.
- The Drive access granted for a sync session expires after about an hour;
  there is an inherent need to re-select your Google profile.
- Reporting across past syncs isn't broken down file-by-file — only
  aggregate counts persist per run.
- The narrower, free Drive permission picker scope means the app can
  only see folders a user explicitly picks, not browse their whole Drive.
- In a rare crash-timing scenario (right between a photo landing in Google
  Photos and that being recorded), a photo could be uploaded twice on
  retry.

## 9. Out of scope / future work

- Reliable support for many simultaneous users across multiple servers
  (SQS, Redis Pub/Sub).
- A way to manually clear failed (not just pending) photos from the
  backlog.

---

_Timeline: build started March 2026, actively ongoing (not a finished/shelved
project as of this PRD)._
