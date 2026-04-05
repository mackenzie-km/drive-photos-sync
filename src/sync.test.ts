jest.mock("./auth", () => ({
  getAuthClient: jest.fn().mockResolvedValue({}),
}));

jest.mock("./drive", () => ({
  listDrivePhotos: jest.fn(),
  streamDriveFile: jest.fn().mockResolvedValue({}),
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
  createSyncRun: jest.fn().mockResolvedValue(1),
  updateSyncRun: jest.fn().mockResolvedValue(undefined),
  getFileCounts: jest.fn().mockResolvedValue([]),
  getMd5Uploaded: jest.fn().mockResolvedValue(null),
}));

import { startSync, requestAbort, getSyncState } from "./sync";
import { generatePhotoDescription } from "./gemini";
import { updateSyncRun, updateFileStatus, getMd5Uploaded } from "./db";
import { listDrivePhotos, streamDriveFile } from "./drive";
import { getUninitializedFiles } from "./db";

const mockGeneratePhotoDescription = generatePhotoDescription as jest.Mock;
const mockListDrivePhotos = listDrivePhotos as jest.Mock;
const mockGetUninitializedFiles = getUninitializedFiles as jest.Mock;
const mockUpdateSyncRun = updateSyncRun as jest.Mock;
const mockUpdateFileStatus = updateFileStatus as jest.Mock;
const mockGetMd5Uploaded = getMd5Uploaded as jest.Mock;

// Polls until condition is true — used because runSync runs fire-and-forget.
async function waitFor(condition: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// A file with a thumbnail_link
const FILE_WITH_THUMB = {
  id: "file-1",
  name: "photo.jpg",
  mime_type: "image/jpeg",
  thumbnail_link: "https://example.com/thumb.jpg",
  retry_count: 0,
};

// A file without a thumbnail_link
const FILE_WITHOUT_THUMB = {
  id: "file-2",
  name: "photo.jpg",
  mime_type: "image/jpeg",
  thumbnail_link: null,
  retry_count: 0,
};

describe("requestAbort", () => {
  it("clears the sync state so status returns idle", async () => {
    await startSync("user-abort-1");
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
      .mockResolvedValueOnce([{ ...FILE_WITH_THUMB, md5: DUPE_MD5 }])
      .mockResolvedValue([]);

    // Simulate an already-uploaded file with the same md5
    mockGetMd5Uploaded.mockResolvedValue({ id: "already-uploaded-file" });

    await startSync("user-dedup-1");
    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockUpdateFileStatus).toHaveBeenCalledWith(
      "skipped",
      null,
      "duplicate md5",
      0,
      FILE_WITH_THUMB.id,
      "user-dedup-1",
    );
  });

  it("does not skip a file when no other file with the same md5 is uploaded", async () => {
    mockGetUninitializedFiles
      .mockResolvedValueOnce([FILE_WITH_THUMB])
      .mockResolvedValue([]);

    mockGetMd5Uploaded.mockResolvedValue(null);

    await startSync("user-dedup-2");
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

describe("startSync — Gemini integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default: discovery yields one file then stops (matches the TODO break in sync.ts)
    mockListDrivePhotos.mockImplementation(async function* () {
      yield {
        id: "file-1",
        name: "photo.jpg",
        md5: "abc",
        mime_type: "image/jpeg",
        size: 1024,
        thumbnailLink: "https://example.com/thumb.jpg",
      };
    });
  });

  it("calls generatePhotoDescription when the file has a thumbnail_link", async () => {
    mockGetUninitializedFiles
      .mockResolvedValueOnce([FILE_WITH_THUMB])
      .mockResolvedValue([]); // empty batch ends the upload loop

    mockGeneratePhotoDescription.mockResolvedValue(
      "sunset, beach, ocean, couple, silhouette, golden hour, romantic, waves, sand, travel",
    );

    await startSync("user-gemini-1");

    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockGeneratePhotoDescription).toHaveBeenCalledWith(
      "https://example.com/thumb.jpg",
    );
  });

  it("skips generatePhotoDescription when the file has no thumbnail_link", async () => {
    mockListDrivePhotos.mockImplementation(async function* () {
      yield {
        id: "file-2",
        name: "photo.jpg",
        md5: "abc",
        mime_type: "image/jpeg",
        size: 1024,
        thumbnailLink: null,
      };
    });

    mockGetUninitializedFiles
      .mockResolvedValueOnce([FILE_WITHOUT_THUMB])
      .mockResolvedValue([]);

    await startSync("user-gemini-2");

    await waitFor(() => mockUpdateSyncRun.mock.calls.length > 0);

    expect(mockGeneratePhotoDescription).not.toHaveBeenCalled();
  });
});
