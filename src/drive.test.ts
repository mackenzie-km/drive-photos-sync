const mockFilesList = jest.fn();

jest.mock("googleapis", () => ({
  google: {
    drive: jest.fn().mockReturnValue({
      files: { list: mockFilesList },
    }),
  },
}));

import { listDrivePhotos } from "./drive";
import { OAuth2Client } from "google-auth-library";

const mockAuth = {} as OAuth2Client;

// Helper: collect all yielded values from the async generator into an array
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of gen) results.push(item);
  return results;
}

describe("listDrivePhotos", () => {
  beforeEach(() => {
    mockFilesList.mockClear();
  });

  it("yields files with the correct shape from a single page", async () => {
    mockFilesList.mockResolvedValueOnce({
      data: {
        files: [
          { id: "file-1", name: "photo.jpg", md5Checksum: "abc123", mimeType: "image/jpeg", size: "1024" },
          { id: "file-2", name: "photo.png", md5Checksum: null,     mimeType: "image/png",  size: null   },
        ],
        nextPageToken: undefined,
      },
    });

    const files = await collect(listDrivePhotos(mockAuth));

    expect(files).toEqual([
      { id: "file-1", name: "photo.jpg", md5: "abc123", mime_type: "image/jpeg", size: 1024, thumbnailLink: null },
      { id: "file-2", name: "photo.png", md5: null,     mime_type: "image/png",  size: null, thumbnailLink: null },
    ]);
  });

  it("follows pagination and yields files from all pages", async () => {
    mockFilesList
      .mockResolvedValueOnce({
        data: {
          files: [{ id: "file-1", name: "a.jpg", md5Checksum: "aaa", mimeType: "image/jpeg", size: "100" }],
          nextPageToken: "page-2-token",
        },
      })
      .mockResolvedValueOnce({
        data: {
          files: [{ id: "file-2", name: "b.jpg", md5Checksum: "bbb", mimeType: "image/jpeg", size: "200" }],
          nextPageToken: undefined,
        },
      });

    const files = await collect(listDrivePhotos(mockAuth));

    expect(files).toHaveLength(2);
    expect(files[0].id).toBe("file-1");
    expect(files[1].id).toBe("file-2");
    expect(mockFilesList).toHaveBeenCalledTimes(2);
  });
});
