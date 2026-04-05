import { useEffect, useState } from "react";

interface SyncStatus {
  status: "idle" | "discovering" | "uploading" | "done" | "failed" | "aborted" | "limit_reached";
  currentFile: string | null;
  runId: number | null;
  latestRun: {
    id: number;
    uploaded: number;
    failed: number;
    total: number;
    started_at: number;
    finished_at: number | null;
    error?: string;
  } | null;
  fileCounts: {
    uninitialized?: number;
    in_progress?: number;
    uploaded?: number;
    failed?: number;
    skipped?: number;
  };
}

interface UploadedFile {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  synced_at: number;
}

const STATUS_LABEL: Record<string, string> = {
  idle: "💤 Idle",
  discovering: "🔍 Discovering files...",
  uploading: "⬆️ Uploading...",
  done: "✅ Done",
  failed: "❌ Failed",
  aborted: "🛑 Aborted",
  limit_reached: "⚠️ Upload limit reached",
};

const IS_RUNNING = (status: string) =>
  status === "discovering" || status === "uploading";

export default function MainPage() {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const poll = () => {
      fetch("/sync/status")
        .then((r) => r.json())
        .then(setSyncStatus)
        .catch(() =>
          setError("Unable to reach the server. Please try refreshing the page."),
        );
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, []);

  async function handleToggleFiles() {
    if (showFiles) {
      setShowFiles(false);
      return;
    }
    try {
      const res = await fetch("/sync/files");
      if (!res.ok) throw new Error("Failed to load uploaded files.");
      const { files } = await res.json();
      setUploadedFiles(files);
      setShowFiles(true);
    } catch {
      setError("Could not load uploaded files. Please try again.");
    }
  }

  async function handleStartSync() {
    try {
      const res = await fetch("/sync/start", { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        if (body.error) {
          setError(
            "There was an issue completing this sync. Please try again shortly.",
          );
        }
      }
    } catch {
      setError(
        "There was an issue completing this sync. Please try again shortly.",
      );
    }
  }

  async function handleAbort() {
    try {
      await fetch("/sync/abort", { method: "POST" });
    } catch {
      setError("Could not stop sync. Please try again shortly.");
    }
  }

  const counts = syncStatus?.fileCounts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + Number(b), 0);
  const uploaded = Number(counts.uploaded ?? 0);
  const progress = total > 0 ? Math.round((uploaded / total) * 100) : 0;
  const status = syncStatus?.status ?? "idle";
  const currentFile = syncStatus?.currentFile ?? null;

  return (
    <>
      <div className="container">
        <h1>📸 Drive → Photos Sync</h1>
        {syncStatus?.latestRun?.error && (
          <div className="error-banner">
            ⚠️ {syncStatus.latestRun.error}
          </div>
        )}
        {error && (
          <div className="error-banner">
            ⚠️ {error}
            <button className="error-dismiss" onClick={() => setError(null)}>
              ✕
            </button>
          </div>
        )}
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
            <Stat label="Pending" value={counts.uninitialized ?? 0} color="blue" />
            <Stat label="Failed" value={counts.failed ?? 0} color="red" />
            <Stat label="Duplicates" value={counts.skipped ?? 0} color="gray" />
          </div>

          <button
            className="btn-secondary btn-files"
            onClick={handleToggleFiles}
          >
            Show uploaded files{" "}
            <span className={`chevron ${showFiles ? "chevron-up" : ""}`}>
              ›
            </span>
          </button>

          {showFiles && (
            <ul className="file-list">
              {uploadedFiles.length === 0 && (
                <li className="file-list-empty">No files uploaded yet.</li>
              )}
              {uploadedFiles.map((f) => (
                <li key={f.id} className="file-list-item">
                  <span className="file-name">{f.name}</span>
                  <span className="file-meta">
                    {(f.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <footer className="footer">
        <p>
          Made with care by{" "}
          <a href="https://www.mackenziekg.dev" target="_blank" rel="noreferrer">
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
