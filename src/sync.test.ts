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
  clearUninitializedFiles: jest.fn().mockResolvedValue(undefined),
  createSyncRun: jest.fn().mockResolvedValue(1),
  updateSyncRun: jest.fn().mockResolvedValue(undefined),
  getFileCounts: jest.fn().mockResolvedValue([]),
  getMd5Uploaded: jest.fn().mockResolvedValue(null),
}));

import { startSync, requestAbort, getSyncState } from "./sync";
import { generatePhotoDescription } from "./gemini";
import {
  updateSyncRun,
  updateFileStatus,
  getMd5Uploaded,
  getUninitializedFiles,
  createSyncRun,
  clearUninitializedFiles,
  upsertDriveFile,
  clearFailedFiles,
} from "./db";
import { listDrivePhotos } from "./drive";

const mockGeneratePhotoDescription = generatePhotoDescription as jest.Mock;
const mockListDrivePhotos = listDrivePhotos as jest.Mock;
const mockGetUninitializedFiles = getUninitializedFiles as jest.Mock;
const mockUpdateSyncRun = updateSyncRun as jest.Mock;
const mockUpdateFileStatus = updateFileStatus as jest.Mock;
const mockGetMd5Uploaded = getMd5Uploaded as jest.Mock;
const mockCreateSyncRun = createSyncRun as jest.Mock;
const mockClearUninitializedFiles = clearUninitializedFiles as jest.Mock;
const mockUpsertDriveFile = upsertDriveFile as jest.Mock;
const mockClearFailedFiles = clearFailedFiles as jest.Mock;

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

  it("passes folderId to clearUninitializedFiles at sync start", async () => {
    await startSync("user-folder", true, "folder-xyz");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockClearUninitializedFiles).toHaveBeenCalledWith("user-folder", "folder-xyz");
  });

  it("passes folderId to upsertDriveFile during discovery", async () => {
    await startSync("user-folder", true, "folder-xyz");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockUpsertDriveFile).toHaveBeenCalledWith(
      "file-1", "user-folder", "folder-xyz", "photo.jpg", "abc", "image/jpeg", 1024,
    );
  });

  it("passes folderId to getUninitializedFiles during upload", async () => {
    await startSync("user-folder", true, "folder-xyz");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockGetUninitializedFiles).toHaveBeenCalledWith("user-folder", "folder-xyz");
  });

  it("does not call clearFailedFiles", async () => {
    await startSync("user-folder", true, "folder-xyz");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockClearFailedFiles).not.toHaveBeenCalled();
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
