import axios from "axios";
import { OAuth2Client } from "google-auth-library";

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
  "image/raw",
]);

async function getAccessToken(auth: OAuth2Client): Promise<string> {
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error("Could not retrieve access token");
  return token;
}

export async function uploadPhoto(
  auth: OAuth2Client,
  stream: NodeJS.ReadableStream,
  filename: string,
  mimeType: string,
  description?: string,
): Promise<string> {
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported mime type: ${mimeType}`);
  }

  const token = await getAccessToken(auth);

  // Step 1: upload bytes to get a token
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

  // Step 2: create media item from token
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

  return result.mediaItem.id as string;
}
