import "dotenv/config";
import { google } from "googleapis";
import { createClientFromToken } from "../src/auth";

// Investigation script (not part of the date-fix mechanism itself): downloads
// a handful of real backlog PNGs and checks their iTXt/XMP block for
// photoshop:DateCreated, to see whether the "month=00" pattern found in
// IMG_2324.png (a likely zero-indexed-month bug in whatever tool wrote the
// XMP) is systematic across the backlog or a one-off.
//
// Usage:
//   DRIVE_ACCESS_TOKEN=ya29.... npx tsx prototype/xmpDateSurvey.ts <fileId> [fileId...]

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

// Inlined from pngExif.ts's readPngDate (that file lives on the unmerged
// prototype/png-exif-date-writer branch, not here) — generic IFD walk, does
// not share buildExifBlob's offset assumptions.
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

function decodeITXt(chunkData: Buffer): { keyword: string; text: string } | null {
  const idx = chunkData.indexOf(0);
  if (idx === -1) return null;
  const keyword = chunkData.subarray(0, idx).toString("ascii");
  const compFlag = chunkData[idx + 1];
  let rest = chunkData.subarray(idx + 3);
  const idx2 = rest.indexOf(0);
  rest = rest.subarray(idx2 + 1);
  const idx3 = rest.indexOf(0);
  let text = rest.subarray(idx3 + 1);
  if (compFlag === 1) {
    const zlib = require("zlib");
    text = zlib.inflateSync(text);
  }
  return { keyword, text: text.toString("utf8") };
}

type Category = "exif" | "xmp-recoverable" | "xmp-no-date" | "no-metadata" | "error";

async function main() {
  const token = process.env.DRIVE_ACCESS_TOKEN;
  if (!token) throw new Error("Set DRIVE_ACCESS_TOKEN (see file header).");

  const fileIds = process.argv.slice(2);
  if (fileIds.length === 0) throw new Error("Pass one or more Drive file IDs as args.");

  const auth = createClientFromToken(token);
  const drive = google.drive({ version: "v3", auth });

  const tally: Record<Category, number> = {
    exif: 0,
    "xmp-recoverable": 0,
    "xmp-no-date": 0,
    "no-metadata": 0,
    error: 0,
  };

  for (const fileId of fileIds) {
    let category: Category = "no-metadata";
    let name = fileId;
    try {
      const meta = await drive.files.get({ fileId, fields: "name" });
      name = meta.data.name ?? fileId;

      const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" },
      );
      const buf = Buffer.from(res.data as ArrayBuffer);
      const chunks = parseChunks(buf);

      const exifChunk = chunks.find((c) => c.type === "eXIf");
      const exifDate = exifChunk ? readExifDate(exifChunk.data) : {};
      const hasExifDate = !!(exifDate.dateTimeOriginal || exifDate.dateTime);

      if (hasExifDate) {
        category = "exif";
      } else {
        const itxtChunks = chunks.filter((c) => c.type === "iTXt");
        let foundXmpDate = false;
        let foundItxt = false;
        for (const chunk of itxtChunks) {
          const decoded = decodeITXt(chunk.data);
          if (!decoded) continue;
          foundItxt = true;
          if (decoded.text.match(/photoshop:DateCreated>([^<]+)</)) foundXmpDate = true;
        }
        category = foundXmpDate ? "xmp-recoverable" : foundItxt ? "xmp-no-date" : "no-metadata";
      }
    } catch (err: any) {
      category = "error";
      console.log(`${fileId} (${name}): ERROR ${err.message}`);
      tally[category]++;
      continue;
    }
    console.log(`${fileId} (${name}): ${category}`);
    tally[category]++;
  }

  console.log("\n=== TALLY ===");
  const total = fileIds.length;
  for (const [cat, count] of Object.entries(tally)) {
    console.log(`${cat}: ${count}/${total} (${((count / total) * 100).toFixed(0)}%)`);
  }
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
