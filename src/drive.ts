import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

// All image types Drive can store
const MIME_QUERY = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/webp",
  "image/tiff",
  "image/bmp",
  // Exclude the following as we will not be able to import most into photos.
  // "image/svg+xml",
  // "image/raw",
]
  .map((m) => `mimeType = '${m}'`)
  .join(" or ");

export interface DrivePhoto {
  id: string;
  name: string;
  md5: string | null;
  mime_type: string;
  size: number | null;
}

// Async generator — yields one file at a time, handles pagination internally.
export async function* listDrivePhotos(
  auth: OAuth2Client,
): AsyncGenerator<DrivePhoto> {
  const drive = google.drive({ version: "v3", auth });
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `(${MIME_QUERY}) and trashed = false`,
      fields: "nextPageToken, files(id, name, md5Checksum, mimeType, size)",
      pageSize: 1000,
      pageToken,
    });

    for (const file of res.data.files ?? []) {
      yield {
        id: file.id!,
        name: file.name!,
        md5: file.md5Checksum ?? null,
        mime_type: file.mimeType!,
        size: file.size ? parseInt(file.size) : null,
      };
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
}

// Returns a readable stream of the file's bytes — streamed directly to Photos
// without buffering the whole file in memory.
export async function streamDriveFile(
  auth: OAuth2Client,
  fileId: string,
): Promise<NodeJS.ReadableStream> {
  const drive = google.drive({ version: "v3", auth });
  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" },
  );

  // "Unknown" needed due to imprecision of googleapi's streaming response types
  return res.data as unknown as NodeJS.ReadableStream;
}
