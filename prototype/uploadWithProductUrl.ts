import axios from "axios";
import { OAuth2Client } from "google-auth-library";
import { Readable } from "stream";

const PHOTOS_BASE = "https://photoslibrary.googleapis.com/v1";
const SUPPORTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/webp",
  "image/tiff",
  "image/bmp",
]);

// Prototype-local variant of src/photos.ts's uploadPhoto — identical upload
// logic, but also captures `productUrl` from the batchCreate response, which
// the real app's uploadPhoto discards (it only returns the media item ID).
// productUrl is what actually works as a web-viewable link; the ID alone is
// in a different namespace/format than what photos.google.com/photo/{id}
// expects, which is why the hand-constructed URL from the ID 404'd.
export async function uploadPhotoWithUrl(
  auth: OAuth2Client,
  stream: Readable,
  filename: string,
  mimeType: string,
  description?: string,
): Promise<{ mediaId: string; productUrl: string }> {
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported mime type: ${mimeType}`);
  }

  const { token } = await auth.getAccessToken();
  if (!token) throw new Error("Could not retrieve access token");

  const uploadRes = await axios.post<string>(`${PHOTOS_BASE}/uploads`, stream, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      "X-Goog-Upload-File-Name": encodeURIComponent(filename),
      "X-Goog-Upload-Protocol": "raw",
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });

  const uploadToken = uploadRes.data;

  const createRes = await axios.post(
    `${PHOTOS_BASE}/mediaItems:batchCreate`,
    {
      newMediaItems: [
        {
          ...(description && { description }),
          simpleMediaItem: { uploadToken, fileName: filename },
        },
      ],
    },
    { headers: { Authorization: `Bearer ${token}` } },
  );

  const result = createRes.data?.newMediaItemResults?.[0];
  const status = result?.status?.message;
  if (status !== "Success" && status !== "OK") {
    throw new Error(`Photos API: ${status ?? "unknown error"}`);
  }

  return {
    mediaId: result.mediaItem.id as string,
    productUrl: result.mediaItem.productUrl as string,
  };
}
