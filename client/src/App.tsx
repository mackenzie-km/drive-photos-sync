import { useEffect, useState } from "react";
import "./App.css";

interface SyncStatus {
  status: "idle" | "discovering" | "uploading" | "done" | "failed" | "aborted";
  currentFile: string | null;
  runId: number | null;
  latestRun: {
    id: number;
    uploaded: number;
    failed: number;
    total: number;
    started_at: number;
    finished_at: number | null;
  } | null;
  fileCounts: {
    uninitialized?: number;
    in_progress?: number;
    uploaded?: number;
    failed?: number;
    skipped?: number;
  };
}

const STATUS_LABEL: Record<string, string> = {
  idle: "💤 Idle",
  discovering: "🔍 Discovering files...",
  uploading: "⬆️ Uploading...",
  done: "✅ Done",
  failed: "❌ Failed",
  aborted: "🛑 Aborted",
};

const IS_RUNNING = (status: string) =>
  status === "discovering" || status === "uploading";

export default function App() {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/auth/me")
      .then((r) => setLoggedIn(r.ok))
      .catch(() => setLoggedIn(false));
  }, []);

  useEffect(() => {
    if (!loggedIn) return;
    const poll = () => {
      fetch("/sync/status")
        .then((r) => r.json())
        .then(setSyncStatus)
        .catch(console.error);
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [loggedIn]);

  async function handleLogin() {
    const res = await fetch("/auth/url");
    const { url } = await res.json();
    window.location.href = url;
  }

  async function handleStartSync() {
    await fetch("/sync/start", { method: "POST" });
  }

  async function handleAbort() {
    await fetch("/sync/abort", { method: "POST" });
  }

  const counts = syncStatus?.fileCounts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + Number(b), 0);
  const uploaded = Number(counts.uploaded ?? 0);
  const progress = total > 0 ? Math.round((uploaded / total) * 100) : 0;
  const status = syncStatus?.status ?? "idle";
  const currentFile = syncStatus?.currentFile ?? null;

  if (loggedIn === null) return <div className="container">Loading...</div>;

  if (!loggedIn) {
    return (
      <div className="container center">
        <h1>Drive → Photos Sync</h1>
        <p>Connect your Google account to get started.</p>
        <button onClick={handleLogin}>Sign in with Google</button>
      </div>
    );
  }

  return (
    <>
      <div className="container">
        <h1>Drive → Photos Sync</h1>

        <div className="card">
          <div className="status-row">
            <div className="status-label-group">
              <span className="status-heading">
                {STATUS_LABEL[status] ?? status}
                <span className="status-heading-bar" />
              </span>
            </div>
            {IS_RUNNING(status) ? (
              <button className="btn-secondary" onClick={handleAbort}>
                ⏸ Abort
              </button>
            ) : (
              <button onClick={handleStartSync}>▶ Start Sync</button>
            )}
          </div>
          <p className="tagline">
            Syncs your photos from Google Drive to Google Photos ✨ using AI ✨
            to add search-friendly labels along the way! Skips duplicates and
            resumes after crashes. You'll never have trouble finding your Google
            Photos again.
          </p>
          <div className="progress-bar-track">
            <div
              className="progress-bar-fill"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="progress-label">
            {uploaded} / {total} uploaded
            {currentFile && (
              <span className="current-file"> · {currentFile}</span>
            )}
          </p>

          <div className="counts">
            <Stat label="Uploaded" value={counts.uploaded ?? 0} color="green" />
            <Stat
              label="Pending"
              value={counts.uninitialized ?? 0}
              color="blue"
            />
            <Stat label="Failed" value={counts.failed ?? 0} color="red" />
            <Stat label="Skipped" value={counts.skipped ?? 0} color="gray" />
          </div>
        </div>
      </div>
      <footer className="footer">
        <p>
          Made with care by{" "}
          <a
            href="https://www.mackenziekg.dev"
            target="_blank"
            rel="noreferrer"
          >
            mackenziekg.dev
          </a>{" "}
          in 2026. All rights reserved.
        </p>
      </footer>
    </>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <div className={`stat stat-${color}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}
