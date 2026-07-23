import { useEffect, useState } from "react";

interface SyncStatus {
  status:
    | "idle"
    | "discovering"
    | "uploading"
    | "done"
    | "failed"
    | "aborted"
    | "limit_reached"
    | "token_expired";
  currentFile: string | null;
  latestRun: {
    id: number;
    error?: string;
  } | null;
  fileCounts: {
    uninitialized?: number;
    in_progress?: number;
    uploaded?: number;
    failed?: number;
    skipped?: number;
  };
  resumableCount: number;
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
  token_expired: "🔑 Drive session expired — click Resume to continue",
};

const IS_RUNNING = (status: string) =>
  status === "discovering" || status === "uploading";

const TOKEN_MAX_AGE_MS = 50 * 60 * 1000;

function createTokenClient(
  clientId: string,
  callback: (response: any) => void,
) {
  return (window as any).google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: "https://www.googleapis.com/auth/drive.file",
    callback,
  });
}

async function getDriveToken(): Promise<string | null> {
  const res = await fetch("/picker/config");
  const { client_id } = await res.json();
  return new Promise((resolve) => {
    const tokenClient = createTokenClient(client_id, (response: any) =>
      resolve(response.access_token ?? null),
    );
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

export default function MainPage() {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [useAI, setUseAI] = useState(true);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [driveAccessToken, setDriveAccessToken] = useState<string | null>(null);
  const [tokenMintedAt, setTokenMintedAt] = useState<number | null>(null);
  const [aborting, setAborting] = useState(false);

  useEffect(() => {
    const source = new EventSource("/sync/events");
    source.onmessage = (e) => setSyncStatus(JSON.parse(e.data));
    // EventSource auto-reconnects on its own (default ~3s backoff); the
    // server sends a fresh snapshot on every new connection, so no manual
    // retry logic is needed here — just surface the transient state.
    source.onerror = () =>
      setError("Unable to reach the server. Please try refreshing the page.");
    source.onopen = () => setError(null);
    return () => source.close();
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
    const canResume = Number(syncStatus?.resumableCount ?? 0) > 0;

    if (!canResume && !folderId) {
      setError("Select a folder first.");
      return;
    }

    const tokenStale =
      tokenMintedAt !== null && Date.now() - tokenMintedAt > TOKEN_MAX_AGE_MS;
    let token = tokenStale ? null : driveAccessToken;
    if (!token) {
      try {
        token = await getDriveToken();
      } catch {
        token = null;
      }
      if (!token) {
        setError(
          'Could not reconnect to Drive automatically. Click "Select a Folder" to reconnect, then try again.',
        );
        return;
      }
      setDriveAccessToken(token);
      setTokenMintedAt(Date.now());
    }

    try {
      const res = await fetch("/sync/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useAI, folderId, driveAccessToken: token }),
      });
      if (res.ok) {
        // No manual refetch needed — the open SSE connection will receive a
        // push as soon as runSync flips state to "discovering". This just
        // optimistically clears stale error/failed info from the prior run.
        setSyncStatus((prev) =>
          prev
            ? {
                ...prev,
                latestRun: prev.latestRun
                  ? { ...prev.latestRun, error: undefined }
                  : null,
              }
            : null,
        );
      } else {
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

  async function handleClearPending() {
    try {
      const res = await fetch("/sync/pending/clear", { method: "POST" });
      if (!res.ok) {
        const body = await res.json();
        setError(
          body.error ??
            "Could not clear pending files. Please try again shortly.",
        );
      }
      // No manual state update on success — pushSnapshot on the backend
      // broadcasts fresh counts over the already-open EventSource.
    } catch {
      setError("Could not clear pending files. Please try again shortly.");
    }
  }

  async function openPicker() {
    const res = await fetch("/picker/config");
    const { client_id, api_key } = await res.json();

    const tokenClient = createTokenClient(client_id, (response: any) => {
      const access_token = response.access_token;
      if (!access_token) return;

      (window as any).gapi.load("picker", () => {
        const gp = (window as any).google.picker;
        const folderView = new gp.DocsView()
          .setIncludeFolders(true)
          .setSelectFolderEnabled(true)
          .setMimeTypes("application/vnd.google-apps.folder");
        let builder = new gp.PickerBuilder()
          .addView(folderView)
          .setOAuthToken(access_token)
          .setCallback((data: any) => {
            if (data.action === gp.Action.PICKED) {
              setFolderId(data.docs[0].id);
              setFolderName(data.docs[0].name);
              setDriveAccessToken(access_token);
              setTokenMintedAt(Date.now());
            }
          });
        if (api_key) builder = builder.setDeveloperKey(api_key);
        builder.build().setVisible(true);
      });
    });
    tokenClient.requestAccessToken({ prompt: "" });
  }

  async function handleAbort() {
    setAborting(true);
    try {
      await fetch("/sync/abort", { method: "POST" });
    } catch {
      setAborting(false);
      setError("Could not stop sync. Please try again shortly.");
    }
  }

  const counts = syncStatus?.fileCounts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + Number(b), 0);
  const uploaded = Number(counts.uploaded ?? 0);
  const progress = total > 0 ? Math.round((uploaded / total) * 100) : 0;
  const status = syncStatus?.status ?? "idle";
  const currentFile = syncStatus?.currentFile ?? null;
  const canResume = Number(syncStatus?.resumableCount ?? 0) > 0;

  useEffect(() => {
    // Abort takes a moment (the in-flight file finishes first) — once the
    // run actually leaves a running status, drop back to the plain button.
    if (!IS_RUNNING(status)) setAborting(false);
  }, [status]);

  return (
    <>
      {syncStatus?.latestRun?.error && (
        <div className="error-banner">⚠️ {syncStatus.latestRun.error}</div>
      )}
      {!syncStatus?.latestRun?.error &&
        syncStatus?.status === "done" &&
        (syncStatus?.fileCounts?.failed ?? 0) > 0 && (
          <div className="error-banner">
            ⚠️ {syncStatus.fileCounts!.failed} file
            {syncStatus.fileCounts!.failed === 1 ? "" : "s"} failed to upload.
            Start a new sync to retry.
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
          <div className="action-buttons">
            {IS_RUNNING(status) ? (
              <button
                className="btn-secondary"
                onClick={handleAbort}
                disabled={aborting}
              >
                {aborting ? <span className="spinner-sm" /> : "⏸"} Abort
              </button>
            ) : (
              <>
                <button className="btn-green" onClick={openPicker}>
                  {folderName
                    ? `📁 ${folderName.length > 10 ? folderName.slice(0, 15) + "…" : folderName}`
                    : "Choose Folder"}
                </button>
                {(counts.uninitialized ?? 0) > 0 && (
                  <button
                    className="btn-secondary"
                    onClick={handleClearPending}
                  >
                    Clear
                  </button>
                )}
                <button
                  disabled={!folderId && !canResume}
                  onClick={handleStartSync}
                >
                  {!folderId && canResume ? "▶ Resume" : "▶ Start"}
                </button>
              </>
            )}
          </div>
        </div>
        {
          <label className="ai-toggle">
            <input
              type="checkbox"
              checked={useAI}
              disabled={IS_RUNNING(status)}
              onChange={(e) => setUseAI(e.target.checked)}
            />{" "}
            Use AI descriptions (slower, up to 10,000 photos)
          </label>
        }
        <p className="tagline">
          Syncs your photos from Google Drive to Google Photos ✨ using AI ✨ to
          add search-friendly labels along the way! Skips duplicates and resumes
          after crashes. You'll never have trouble finding your Google Photos
          again.
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
          <Stat label="Duplicates" value={counts.skipped ?? 0} color="gray" />
        </div>

        <button className="btn-secondary btn-files" onClick={handleToggleFiles}>
          Show uploaded files{" "}
          <span className={`chevron ${showFiles ? "chevron-up" : ""}`}>›</span>
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
