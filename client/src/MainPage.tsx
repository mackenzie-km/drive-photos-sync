import { useEffect, useState } from "react";

interface SyncStatus {
  status:
    | "idle"
    | "discovering"
    | "uploading"
    | "done"
    | "failed"
    | "aborted"
    | "limit_reached";
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
  const [useAI, setUseAI] = useState(true);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);

  useEffect(() => {
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
      const res = await fetch("/sync/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useAI, folderId }),
      });
      if (res.ok) {
        setSyncStatus((prev) =>
          prev
            ? {
                ...prev,
                latestRun: prev.latestRun
                  ? { ...prev.latestRun, error: undefined, failed: 0 }
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

  async function openPicker() {
    try {
      const res = await fetch("/picker/config");
      if (!res.ok) throw new Error("Not authenticated");
      const { access_token, api_key } = await res.json();

      (window as any).gapi.load("picker", () => {
        const gp = (window as any).google.picker;
        const folderView = new gp.DocsView()
          .setIncludeFolders(true)
          .setSelectFolderEnabled(true)
          .setMimeTypes("application/vnd.google-apps.folder");
        const picker = new gp.PickerBuilder()
          .addView(folderView)
          .setOAuthToken(access_token)
          .setDeveloperKey(api_key)
          .setCallback((data: any) => {
            if (data.action === gp.Action.PICKED) {
              setFolderId(data.docs[0].id);
              setFolderName(data.docs[0].name);
            }
          })
          .build();
        picker.setVisible(true);
      });
    } catch (e: any) {
      setError("Could not open picker: " + e.message);
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
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            {IS_RUNNING(status) ? (
              <button className="btn-secondary" onClick={handleAbort}>
                ⏸ Abort
              </button>
            ) : (
              <>
                <button className="btn-green" onClick={openPicker}>
                  {folderName
                    ? `Selected: ${folderName.length > 10 ? folderName.slice(0, 15) + "…" : folderName}`
                    : "Select a Folder"}
                </button>
                <button disabled={!folderId} onClick={handleStartSync}>
                  ▶ Start Sync
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
            Use AI descriptions (slower, up to 1,000 photos)
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
