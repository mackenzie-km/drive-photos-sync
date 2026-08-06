import "dotenv/config";
import { google } from "googleapis";
import { Readable } from "stream";
import { getAuthClient } from "../src/auth";
import { createClientFromToken } from "../src/auth";
import { uploadPhotoWithUrl } from "./uploadWithProductUrl";

// Gut-check for the "does Photos already honor existing EXIF" hypothesis:
// downloads real backlog files that our xmpDateSurvey.ts already confirmed
// have a valid eXIf DateTimeOriginal, uploads them completely UNMODIFIED
// (no date rewriting at all — that's the point), and returns productUrl
// links so dates can be visually compared against the known EXIF value.
//
// This creates real, visible entries in Google Photos (prefixed
// PROTOTYPE-gutcheck-, marked safe to delete in the description).
//
// Usage:
//   DRIVE_ACCESS_TOKEN=ya29.... npx tsx prototype/gutCheckUpload.ts <fileId> [fileId...]

const USER_ID = "102316373971929260712";

interface PngChunk {
  type: string;
  data: Buffer;
}

function parseChunks(png: Buffer): PngChunk[] {
  const chunks: PngChunk[] = [];
  let pos = 8;
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString("ascii");
    const data = png.subarray(pos + 8, pos + 8 + length);
    chunks.push({ type, data });
    pos += 8 + length + 4;
    if (type === "IEND") break;
  }
  return chunks;
}

function readExifDate(data: Buffer): { dateTime?: string; dateTimeOriginal?: string } {
  const byteOrder = data.subarray(0, 2).toString("ascii");
  const endian = byteOrder === "II" ? "LE" : "BE";
  const read16 = (o: number) => (endian === "LE" ? data.readUInt16LE(o) : data.readUInt16BE(o));
  const read32 = (o: number) => (endian === "LE" ? data.readUInt32LE(o) : data.readUInt32BE(o));
  const ifd0Offset = read32(4);

  function readIfd(offset: number) {
    const numEntries = read16(offset);
    const map = new Map<number, { type: number; count: number; valueRaw: Buffer }>();
    for (let i = 0; i < numEntries; i++) {
      const entryOffset = offset + 2 + i * 12;
      const tag = read16(entryOffset);
      const type = read16(entryOffset + 2);
      const count = read32(entryOffset + 4);
      const valueRaw = data.subarray(entryOffset + 8, entryOffset + 12);
      map.set(tag, { type, count, valueRaw });
    }
    return map;
  }

  function decodeAscii(entry: { type: number; count: number; valueRaw: Buffer }): string {
    const size = entry.count;
    let raw: Buffer;
    if (size <= 4) {
      raw = entry.valueRaw.subarray(0, size);
    } else {
      const offset = endian === "LE" ? entry.valueRaw.readUInt32LE(0) : entry.valueRaw.readUInt32BE(0);
      raw = data.subarray(offset, offset + size);
    }
    return raw.toString("ascii").replace(/\0+$/, "");
  }

  const ifd0 = readIfd(ifd0Offset);
  const result: { dateTime?: string; dateTimeOriginal?: string } = {};
  if (ifd0.has(0x0132)) result.dateTime = decodeAscii(ifd0.get(0x0132)!);
  if (ifd0.has(0x8769)) {
    const ptrEntry = ifd0.get(0x8769)!;
    const exifIfdOffset =
      endian === "LE" ? ptrEntry.valueRaw.readUInt32LE(0) : ptrEntry.valueRaw.readUInt32BE(0);
    const exifIfd = readIfd(exifIfdOffset);
    if (exifIfd.has(0x9003)) result.dateTimeOriginal = decodeAscii(exifIfd.get(0x9003)!);
  }
  return result;
}

async function main() {
  const driveToken = process.env.DRIVE_ACCESS_TOKEN;
  if (!driveToken) throw new Error("Set DRIVE_ACCESS_TOKEN (see file header).");

  const fileIds = process.argv.slice(2);
  if (fileIds.length === 0) throw new Error("Pass one or more Drive file IDs as args.");

  const driveAuth = createClientFromToken(driveToken);
  const drive = google.drive({ version: "v3", auth: driveAuth });
  const photosAuth = await getAuthClient(USER_ID);

  const results: { name: string; exifDate: string; productUrl: string }[] = [];

  for (const fileId of fileIds) {
    try {
      const meta = await drive.files.get({ fileId, fields: "name" });
      const name = meta.data.name ?? fileId;

      const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" },
      );
      const buf = Buffer.from(res.data as ArrayBuffer);

      const chunks = parseChunks(buf);
      const exifChunk = chunks.find((c) => c.type === "eXIf");
      const exifDate = exifChunk ? readExifDate(exifChunk.data) : {};
      const dateStr = exifDate.dateTimeOriginal ?? exifDate.dateTime;
      if (!dateStr) {
        console.log(`SKIP ${name}: no eXIf date found (not actually in the "exif" category)`);
        continue;
      }

      const uploadFilename = `PROTOTYPE-gutcheck-${name}`;
      const { productUrl } = await uploadPhotoWithUrl(
        photosAuth,
        Readable.from(buf),
        uploadFilename,
        "image/png",
        `Gut-check upload — unmodified original, testing whether Photos honors existing EXIF (${dateStr}). Safe to delete.`,
      );

      console.log(`${name}: EXIF=${dateStr} -> ${productUrl}`);
      results.push({ name, exifDate: dateStr, productUrl });
    } catch (err: any) {
      console.log(`FAILED ${fileId}: ${err.message}`);
    }
  }

  console.log(`\nUploaded ${results.length}/${fileIds.length}`);
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
