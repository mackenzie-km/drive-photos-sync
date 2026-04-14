"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listDrivePhotos = listDrivePhotos;
exports.downloadDriveFile = downloadDriveFile;
const googleapis_1 = require("googleapis");
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
// Async generator — yields one file at a time, handles pagination internally.
async function* listDrivePhotos(auth) {
    const drive = googleapis_1.google.drive({ version: "v3", auth });
    let pageToken;
    do {
        const res = await drive.files.list({
            q: `(${MIME_QUERY}) and trashed = false`,
            fields: "nextPageToken, files(id, name, md5Checksum, mimeType, size)",
            pageSize: 1000,
            pageToken,
        });
        for (const file of res.data.files ?? []) {
            yield {
                id: file.id,
                name: file.name,
                md5: file.md5Checksum ?? null,
                mime_type: file.mimeType,
                size: file.size ? parseInt(file.size) : null,
            };
        }
        pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
}
// Downloads a file's bytes into a Buffer. Used when the file is needed for
// both Gemini analysis and Photos upload in the same sync step.
async function downloadDriveFile(auth, fileId) {
    const drive = googleapis_1.google.drive({ version: "v3", auth });
    const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    return Buffer.from(res.data);
}
