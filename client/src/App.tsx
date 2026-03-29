import { useEffect, useState } from "react";
import "./App.css";
import stackOfPhotos from "./assets/stack-of-photos.png";

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

interface UploadedFile {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  synced_at: number;
}

export default function App() {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [error, setError] = useState<string | null>(null);

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
        .catch(() =>
          setError(
            "Unable to reach the server. Please try refreshing the page.",
          ),
        );
    };
    poll();
    const interval = setInterval(poll, 2000);
    return () => clearInterval(interval);
  }, [loggedIn]);

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

  async function handleLogin() {
    try {
      const res = await fetch("/auth/url");
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      setError("Could not reach the server. Please try again shortly.");
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

  if (loggedIn === null) return <div className="container">Loading...</div>;

  if (!loggedIn) {
    return (
      <>
        <div className="container">
          <h1>📸 Drive → Photos Sync</h1>
          {error && (
            <div className="error-banner">
              ⚠️ {error}
              <button className="error-dismiss" onClick={() => setError(null)}>
                ✕
              </button>
            </div>
          )}
          <div className="card center">
            <PhotoStack />
            <span className="status-heading">
              Manage Your Photos
              <span className="status-heading-bar" />
            </span>
            <p className="tagline">
              Syncs your photos from Google Drive to Google Photos — ✨ using AI
              ✨ to add search-friendly labels along the way! Skips duplicates
              and resumes after crashes. You'll never have trouble finding your
              Google Photos again.
            </p>
            <button className="btn-google" onClick={handleLogin}>
              <GoogleLogo />
              Sign in with Google
            </button>
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
              mackenziekg.com
            </a>{" "}
            in 2026. All rights reserved.
          </p>
        </footer>
      </>
    );
  }

  return (
    <>
      <div className="container">
        <h1>📸 Drive → Photos Sync</h1>
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
            <Stat
              label="Pending"
              value={counts.uninitialized ?? 0}
              color="blue"
            />
            <Stat label="Failed" value={counts.failed ?? 0} color="red" />
            <Stat label="Skipped" value={counts.skipped ?? 0} color="gray" />
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

function PhotoStack() {
  return (
    <img
      src={stackOfPhotos}
      alt="stack of photos"
      className="photo-stack-img"
    />
  );
}

function GoogleLogo() {
  return (
    <svg
      className="google-logo"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      width="20"
      height="20"
    >
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
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
