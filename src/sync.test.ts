jest.mock("./auth", () => ({
  getAuthClient: jest.fn().mockResolvedValue({}),
}));

jest.mock("./drive", () => ({
  listDrivePhotos: jest.fn(),
  downloadDriveFile: jest.fn().mockResolvedValue(Buffer.from("fake-image-data")),
}));

jest.mock("./gemini", () => ({
  generatePhotoDescription: jest.fn(),
}));

jest.mock("./photos", () => ({
  uploadPhoto: jest.fn().mockResolvedValue("media-id-123"),
}));

jest.mock("./db", () => ({
  upsertDriveFile: jest.fn().mockResolvedValue(undefined),
  getUninitializedFiles: jest.fn(),
  markFileInProgress: jest.fn().mockResolvedValue(undefined),
  updateFileStatus: jest.fn().mockResolvedValue(undefined),
  resetStuckFiles: jest.fn().mockResolvedValue(undefined),
  clearFailedFiles: jest.fn().mockResolvedValue(undefined),
  createSyncRun: jest.fn().mockResolvedValue(1),
  updateSyncRun: jest.fn().mockResolvedValue(undefined),
  getFileCounts: jest.fn().mockResolvedValue([]),
  getMd5Uploaded: jest.fn().mockResolvedValue(null),
  getLatestSyncRun: jest.fn().mockResolvedValue(null),
}));

import {
  startSync,
  requestAbort,
  getSyncState,
  getSyncSnapshot,
  addSyncClient,
} from "./sync";
import { generatePhotoDescription } from "./gemini";
import {
  updateSyncRun,
  updateFileStatus,
  getMd5Uploaded,
  getUninitializedFiles,
  createSyncRun,
  upsertDriveFile,
  clearFailedFiles,
  getLatestSyncRun,
  getFileCounts,
} from "./db";
import { listDrivePhotos, downloadDriveFile } from "./drive";
import { uploadPhoto } from "./photos";

const mockGeneratePhotoDescription = generatePhotoDescription as jest.Mock;
const mockListDrivePhotos = listDrivePhotos as jest.Mock;
const mockGetUninitializedFiles = getUninitializedFiles as jest.Mock;
const mockUpdateSyncRun = updateSyncRun as jest.Mock;
const mockUpdateFileStatus = updateFileStatus as jest.Mock;
const mockGetMd5Uploaded = getMd5Uploaded as jest.Mock;
const mockCreateSyncRun = createSyncRun as jest.Mock;
const mockUpsertDriveFile = upsertDriveFile as jest.Mock;
const mockClearFailedFiles = clearFailedFiles as jest.Mock;
const mockDownloadDriveFile = downloadDriveFile as jest.Mock;
const mockUploadPhoto = uploadPhoto as jest.Mock;
const mockGetFileCounts = getFileCounts as jest.Mock;

// Polls until condition is true — used because runSync runs fire-and-forget.
async function waitFor(condition: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const FILE = {
  id: "file-1",
  name: "photo.jpg",
  mime_type: "image/jpeg",
  retry_count: 0,
};

describe("getSyncSnapshot — stale run correction", () => {
  const now = Math.floor(Date.now() / 1000);
  const mockGetLatestSyncRun = getLatestSyncRun as jest.Mock;

  beforeEach(() => {
    mockListDrivePhotos.mockImplementation(async function* () {});
    mockGetUninitializedFiles.mockResolvedValue([]);
  });

  it("marks a running run as failed when there is no active in-memory sync", async () => {
    mockGetLatestSyncRun.mockResolvedValue({ status: "running", started_at: now - 60 });

    const snapshot = await getSyncSnapshot("user-snapshot-idle");
    expect(snapshot.latestRun.status).toBe("failed");
  });

  it("marks a running run as failed and aborts when it has exceeded the 3-hour timeout", async () => {
    await startSync("user-snapshot-stale", true, "folder-x");
    mockGetLatestSyncRun.mockResolvedValue({
      status: "running",
      started_at: now - 4 * 60 * 60,
    });

    const snapshot = await getSyncSnapshot("user-snapshot-stale");
    expect(snapshot.latestRun.status).toBe("failed");
    // requestAbort deletes the in-memory state entry — confirms the timeout
    // branch actually fired, not just that latestRun.status got overwritten.
    expect(getSyncState("user-snapshot-stale").status).toBe("idle");
  });

  it("leaves a running run alone when a sync is active and within the timeout", async () => {
    await startSync("user-snapshot-active", true, "folder-x");
    mockGetLatestSyncRun.mockResolvedValue({ status: "running", started_at: now - 60 });

    const snapshot = await getSyncSnapshot("user-snapshot-active");
    expect(snapshot.latestRun.status).toBe("running");
  });
});

describe("requestAbort", () => {
  beforeEach(() => {
    mockListDrivePhotos.mockImplementation(async function* () {});
  });

  it("clears the sync state so status returns idle", async () => {
    await startSync("user-abort-1", true, "test-folder-id");
    expect(getSyncState("user-abort-1").status).not.toBe("idle");

    requestAbort("user-abort-1");
    expect(getSyncState("user-abort-1").status).toBe("idle");
  });
});

describe("startSync — MD5 dedup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDrivePhotos.mockImplementation(async function* () {});
  });

  it("marks a file as skipped when another file with the same md5 is already uploaded", async () => {
    const DUPE_MD5 = "406c42808df1d62ef77796cac292e827";

    mockGetUninitializedFiles
      .mockResolvedValueOnce([{ ...FILE, md5: DUPE_MD5 }])
      .mockResolvedValue([]);

    // Simulate an already-uploaded file with the same md5
    mockGetMd5Uploaded.mockResolvedValue({ id: "already-uploaded-file" });

    await startSync("user-dedup-1", true, "test-folder-id");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockUpdateFileStatus).toHaveBeenCalledWith(
      "skipped",
      null,
      "duplicate md5",
      0,
      FILE.id,
      "user-dedup-1",
    );
  });

  it("does not skip a file when no other file with the same md5 is uploaded", async () => {
    mockGetUninitializedFiles
      .mockResolvedValueOnce([FILE])
      .mockResolvedValue([]);

    mockGetMd5Uploaded.mockResolvedValue(null);

    await startSync("user-dedup-2", true, "test-folder-id");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockUpdateFileStatus).not.toHaveBeenCalledWith(
      "skipped",
      null,
      "duplicate md5",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("startSync — concurrent guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDrivePhotos.mockImplementation(async function* () {});
    mockGetUninitializedFiles.mockResolvedValue([]);
  });

  it("rejects a second startSync before the first has resolved", async () => {
    const p1 = startSync("user-concurrent", true, "folder-1");
    await expect(startSync("user-concurrent", true, "folder-1")).rejects.toThrow(
      "A sync is already running",
    );
    await p1;
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);
  });
});

describe("startSync — abort + restart", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDrivePhotos.mockImplementation(async function* () {});
    mockGetUninitializedFiles.mockResolvedValue([]);
  });

  it("does not overwrite new sync state when the aborted run finishes", async () => {
    mockCreateSyncRun.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    await startSync("user-abort-restart", true, "folder-1");
    requestAbort("user-abort-restart");
    await startSync("user-abort-restart", true, "folder-1");

    await waitFor(() => mockUpdateSyncRun.mock.calls.length >= 2);

    expect(getSyncState("user-abort-restart").status).toBe("done");
  });
});

describe("startSync — folderId plumbing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDrivePhotos.mockImplementation(async function* () {
      yield { id: "file-1", name: "photo.jpg", md5: "abc", mime_type: "image/jpeg", size: 1024 };
    });
    mockGetUninitializedFiles.mockResolvedValue([]);
  });

  it("passes folderId to upsertDriveFile during discovery", async () => {
    await startSync("user-folder", true, "folder-xyz");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockUpsertDriveFile).toHaveBeenCalledWith(
      "file-1", "user-folder", "folder-xyz", "photo.jpg", "abc", "image/jpeg", 1024,
    );
  });

  it("calls getUninitializedFiles with just userId — not scoped to a folder", async () => {
    await startSync("user-folder", true, "folder-xyz");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockGetUninitializedFiles).toHaveBeenCalledWith("user-folder");
  });

  it("does not call clearFailedFiles", async () => {
    await startSync("user-folder", true, "folder-xyz");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockClearFailedFiles).not.toHaveBeenCalled();
  });
});

describe("startSync — pending resume (discovery skip)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDrivePhotos.mockImplementation(async function* () {
      yield {
        id: "should-not-be-discovered",
        name: "new-file.jpg",
        md5: "new",
        mime_type: "image/jpeg",
        size: 1024,
      };
    });
  });

  afterEach(() => {
    // Restore the module's default so this override never leaks into other
    // describe blocks that don't set their own getFileCounts expectation.
    mockGetFileCounts.mockResolvedValue([]);
  });

  it("skips discovery entirely and resumes across folders when pending files already exist", async () => {
    mockGetFileCounts.mockResolvedValue([{ status: "uninitialized", count: 3 }]);
    mockGetUninitializedFiles
      .mockResolvedValueOnce([FILE])
      .mockResolvedValue([]);

    await startSync("user-resume-1", true, null);
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockListDrivePhotos).not.toHaveBeenCalled();
    expect(mockUpsertDriveFile).not.toHaveBeenCalled();
    expect(mockGetUninitializedFiles).toHaveBeenCalledWith("user-resume-1");
    expect(mockUpdateFileStatus).toHaveBeenCalledWith(
      "uploaded",
      "media-id-123",
      null,
      0,
      FILE.id,
      "user-resume-1",
    );
  });

  it("runs discovery normally when there are no pending files", async () => {
    mockGetFileCounts.mockResolvedValue([]);
    mockGetUninitializedFiles.mockResolvedValue([]);

    await startSync("user-resume-2", true, "folder-xyz");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockListDrivePhotos).toHaveBeenCalledWith(expect.anything(), "folder-xyz");
    expect(mockUpsertDriveFile).toHaveBeenCalled();
  });
});

describe("startSync — Gemini integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockListDrivePhotos.mockImplementation(async function* () {
      yield {
        id: "file-1",
        name: "photo.jpg",
        md5: "abc",
        mime_type: "image/jpeg",
        size: 1024,
      };
    });
  });

  it("calls generatePhotoDescription with buffer and mimeType when useAI is true", async () => {
    mockGetUninitializedFiles
      .mockResolvedValueOnce([FILE])
      .mockResolvedValue([]);

    mockGeneratePhotoDescription.mockResolvedValue(
      "sunset, beach, ocean, couple, silhouette, golden hour, romantic, waves, sand, travel",
    );

    await startSync("user-gemini-1", true, "test-folder-id");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockGeneratePhotoDescription).toHaveBeenCalledWith(
      expect.any(Buffer),
      FILE.mime_type,
    );
  });

  it("skips generatePhotoDescription when useAI is false", async () => {
    mockGetUninitializedFiles
      .mockResolvedValueOnce([FILE])
      .mockResolvedValue([]);

    await startSync("user-gemini-2", false, "test-folder-id");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockGeneratePhotoDescription).not.toHaveBeenCalled();
  });
});

describe("startSync — file size limit", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDrivePhotos.mockImplementation(async function* () {});
  });

  it("marks a file as skipped when size exceeds 200MB", async () => {
    mockGetUninitializedFiles
      .mockResolvedValueOnce([{ ...FILE, size: 201 * 1024 * 1024 }])
      .mockResolvedValue([]);

    await startSync("user-size-1", false, "folder-id");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockUpdateFileStatus).toHaveBeenCalledWith(
      "skipped",
      null,
      "file too large",
      0,
      FILE.id,
      "user-size-1",
    );
  });

  it("does not skip a file just under 200MB", async () => {
    mockGetUninitializedFiles
      .mockResolvedValueOnce([{ ...FILE, size: 200 * 1024 * 1024 - 1 }])
      .mockResolvedValue([]);

    await startSync("user-size-2", false, "folder-id");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockUpdateFileStatus).not.toHaveBeenCalledWith(
      "skipped",
      null,
      "file too large",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not skip a file with null size", async () => {
    mockGetUninitializedFiles
      .mockResolvedValueOnce([{ ...FILE, size: null }])
      .mockResolvedValue([]);

    await startSync("user-size-3", false, "folder-id");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockUpdateFileStatus).not.toHaveBeenCalledWith(
      "skipped",
      null,
      "file too large",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("startSync — upload error paths", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockListDrivePhotos.mockImplementation(async function* () {});
  });

  it("marks a file as failed with extracted API reason when uploadPhoto throws a structured error", async () => {
    mockGetUninitializedFiles
      .mockResolvedValueOnce([FILE])
      .mockResolvedValue([]);

    // A 500 error (not retried by withRetry) with a structured response body
    const apiError = Object.assign(new Error("Request failed with status 500"), {
      response: {
        status: 500,
        data: { error: { errors: [{ reason: "backendError" }] } },
      },
    });
    mockUploadPhoto.mockRejectedValueOnce(apiError);

    await startSync("user-err-axios", false, "folder-id");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockUpdateFileStatus).toHaveBeenCalledWith(
      "failed",
      null,
      "Request failed with status 500 (reason: backendError)",
      1,
      FILE.id,
      "user-err-axios",
    );
  });

  it("marks a file as failed with the plain message when uploadPhoto throws without response data", async () => {
    mockGetUninitializedFiles
      .mockResolvedValueOnce([FILE])
      .mockResolvedValue([]);

    mockUploadPhoto.mockRejectedValueOnce(new Error("network error"));

    await startSync("user-err-plain", false, "folder-id");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockUpdateFileStatus).toHaveBeenCalledWith(
      "failed",
      null,
      "network error",
      1,
      FILE.id,
      "user-err-plain",
    );
  });

  it("marks a file as failed when downloadDriveFile throws", async () => {
    mockGetUninitializedFiles
      .mockResolvedValueOnce([FILE])
      .mockResolvedValue([]);

    mockDownloadDriveFile.mockRejectedValueOnce(new Error("download failed"));

    await startSync("user-err-download", false, "folder-id");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockUpdateFileStatus).toHaveBeenCalledWith(
      "failed",
      null,
      "download failed",
      1,
      FILE.id,
      "user-err-download",
    );
  });
});

describe("startSync — limit_reached", () => {
  // These tests drive 10 001 mock iterations (useAI=true → MAX_PER_SYNC=10 000).
  // Mocks resolve synchronously so this completes in well under 1 s in practice,
  // but we give Jest extra headroom in case of CI slowness.
  beforeAll(() => jest.setTimeout(15000));
  afterAll(() => jest.setTimeout(5000));

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("sets final status to limit_reached when discovery exceeds MAX_PER_SYNC", async () => {
    const MAX = 10_000; // useAI=true → MAX_PER_SYNC = 10_000
    mockListDrivePhotos.mockImplementation(async function* () {
      for (let i = 0; i <= MAX; i++) {
        yield { id: `file-${i}`, name: `photo${i}.jpg`, md5: `md5-${i}`, mime_type: "image/jpeg", size: 1024 };
      }
    });
    mockGetUninitializedFiles.mockResolvedValue([]);

    await startSync("user-limit-disc", true, "folder-id");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0, 14000);

    expect(mockUpdateSyncRun).toHaveBeenCalledWith(
      "limit_reached",
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      "user-limit-disc",
    );
  });

  it("sets final status to limit_reached when upload count exceeds MAX_PER_SYNC", async () => {
    const MAX = 10_000; // useAI=true → MAX_PER_SYNC = 10_000
    mockListDrivePhotos.mockImplementation(async function* () {});

    const batch = Array.from({ length: MAX + 1 }, (_, i) => ({
      id: `file-${i}`,
      name: `photo${i}.jpg`,
      md5: null,
      mime_type: "image/jpeg",
      size: 1024,
      retry_count: 0,
    }));
    mockGetUninitializedFiles
      .mockResolvedValueOnce(batch)
      .mockResolvedValue([]);

    await startSync("user-limit-upload", true, "folder-id");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0, 14000);

    expect(mockUpdateSyncRun).toHaveBeenCalledWith(
      "limit_reached",
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      "user-limit-upload",
    );
  });
});

describe("startSync — crash mid-sync (SSE terminal push)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFileCounts.mockResolvedValue([]);
  });

  it("pushes real drive_files counts over SSE, not the hardcoded-zero crash args", async () => {
    // Simulates an expired driveAccessToken partway through discovery:
    // listDrivePhotos throws after one file is found, rejecting runSync and
    // routing through startSync's fire-and-forget .catch(), which calls
    // finishRun(userId, runId, "failed", 0, 0, 0, 0) — args with no relation
    // to what was actually discovered.
    mockListDrivePhotos.mockImplementation(async function* () {
      yield {
        id: "file-1",
        name: "photo1.jpg",
        md5: "abc",
        mime_type: "image/jpeg",
        size: 1024,
      };
      throw new Error("token expired");
    });

    // The first call is runSync's pre-discovery pending check (must be empty
    // so discovery actually runs and hits the simulated crash below); every
    // call after that — including finishRun's terminal query — reflects what
    // a live query against drive_files would actually return post-crash,
    // independent of finishRun's zeroed-out args.
    mockGetFileCounts
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ status: "uninitialized", count: 1 }]);

    const fakeClient = { write: jest.fn() };
    addSyncClient("user-crash-1", fakeClient as any);

    await startSync("user-crash-1", true, "folder-id");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);
    await waitFor(() => fakeClient.write.mock.calls.length > 0);

    const lastFrame =
      fakeClient.write.mock.calls[fakeClient.write.mock.calls.length - 1][0];
    const payload = JSON.parse(lastFrame.replace(/^data: /, "").trim());

    expect(payload.status).toBe("failed");
    expect(payload.fileCounts).toEqual({ uninitialized: 1 });
  });
});
