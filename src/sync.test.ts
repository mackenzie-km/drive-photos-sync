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
}));

import { startSync } from "./sync";
import { generatePhotoDescription } from "./gemini";
import { updateSyncRun } from "./db";
import { listDrivePhotos, streamDriveFile } from "./drive";
import { getUninitializedFiles } from "./db";

const mockGeneratePhotoDescription = generatePhotoDescription as jest.Mock;
const mockListDrivePhotos = listDrivePhotos as jest.Mock;
const mockGetUninitializedFiles = getUninitializedFiles as jest.Mock;
const mockUpdateSyncRun = updateSyncRun as jest.Mock;

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
