const mockPost = jest.fn();

jest.mock("axios", () => ({
  post: mockPost,
}));

import { uploadPhoto } from "./photos";
import { OAuth2Client } from "google-auth-library";

const mockAuth = {
  getAccessToken: jest.fn().mockResolvedValue({ token: "test-token" }),
} as unknown as OAuth2Client;

const mockStream = {} as NodeJS.ReadableStream;

describe("uploadPhoto", () => {
  beforeEach(() => {
    mockPost.mockClear();
  });

  it("throws for unsupported MIME types without making any network calls", async () => {
    await expect(
      uploadPhoto(mockAuth, mockStream, "file.svg", "image/svg+xml"),
    ).rejects.toThrow("Unsupported mime type: image/svg+xml");

    expect(mockPost).not.toHaveBeenCalled();
  });

  it("returns the media item ID on success", async () => {
    mockPost
      .mockResolvedValueOnce({ data: "upload-token-abc" }) // Step 1: /uploads
      .mockResolvedValueOnce({                              // Step 2: batchCreate
        data: {
          newMediaItemResults: [
            { status: { message: "Success" }, mediaItem: { id: "media-123" } },
          ],
        },
      });

    const id = await uploadPhoto(mockAuth, mockStream, "photo.jpg", "image/jpeg");

    expect(id).toBe("media-123");
  });

  it("throws when batchCreate returns a non-success status", async () => {
    mockPost
      .mockResolvedValueOnce({ data: "upload-token-abc" })
      .mockResolvedValueOnce({
        data: {
          newMediaItemResults: [
            { status: { message: "PERMISSION_DENIED" } },
          ],
        },
      });

    await expect(
      uploadPhoto(mockAuth, mockStream, "photo.jpg", "image/jpeg"),
    ).rejects.toThrow("Photos API: PERMISSION_DENIED");
  });
});
