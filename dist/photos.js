"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadPhoto = uploadPhoto;
const axios_1 = __importDefault(require("axios"));
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
async function getAccessToken(auth) {
    const { token } = await auth.getAccessToken();
    if (!token)
        throw new Error("Could not retrieve access token");
    return token;
}
async function uploadPhoto(auth, stream, filename, mimeType, description) {
    if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
        throw new Error(`Unsupported mime type: ${mimeType}`);
    }
    const token = await getAccessToken(auth);
    // Step 1: upload bytes to get a token
    const uploadRes = await axios_1.default.post(`${PHOTOS_BASE}/uploads`, stream, {
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
    const createRes = await axios_1.default.post(`${PHOTOS_BASE}/mediaItems:batchCreate`, {
        newMediaItems: [
            {
                ...(description && { description }),
                simpleMediaItem: { uploadToken, fileName: filename },
            },
        ],
    }, { headers: { Authorization: `Bearer ${token}` } });
    const result = createRes.data?.newMediaItemResults?.[0];
    const status = result?.status?.message;
    if (status !== "Success" && status !== "OK") {
        throw new Error(`Photos API: ${status ?? "unknown error"}`);
    }
    return result.mediaItem.id;
}
