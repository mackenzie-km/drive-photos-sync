import { crc32, inflateSync } from "zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngChunk {
  type: string;
  data: Buffer;
}

export type PngDateResolution =
  | { action: "none" }
  | { action: "fixed"; buffer: Buffer }
  | { action: "needs-fallback" };

function parseChunks(png: Buffer): PngChunk[] {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Not a valid PNG (bad signature)");
  }
  const chunks: PngChunk[] = [];
  let pos = 8;
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString("ascii");
    const data = png.subarray(pos + 8, pos + 8 + length);
    chunks.push({ type, data });
    pos += 8 + length + 4; // length + type + data + crc
    if (type === "IEND") break;
  }
  // Buffer.subarray clamps instead of throwing, so a corrupted length field
  // could silently swallow IEND without an exception — require it explicitly.
  if (chunks.length === 0 || chunks[chunks.length - 1].type !== "IEND") {
    throw new Error("PNG chunk stream did not terminate in a valid IEND chunk");
  }
  return chunks;
}

function serializeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function formatExifDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}:${pad(date.getUTCMonth() + 1)}:${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

// Sets both IFD0's DateTime and the Exif sub-IFD's DateTimeOriginal, since
// it's undocumented which one Google Photos actually reads.
function buildExifBlob(date: Date): Buffer {
  const dateStr = formatExifDate(date) + "\0"; // 20 bytes incl. null terminator
  if (dateStr.length !== 20) throw new Error("unexpected date string length");

  const TIFF_HEADER_SIZE = 8;
  const IFD0_ENTRY_COUNT = 2;
  const IFD0_SIZE = 2 + IFD0_ENTRY_COUNT * 12 + 4;
  const EXIF_IFD_ENTRY_COUNT = 2;
  const EXIF_IFD_SIZE = 2 + EXIF_IFD_ENTRY_COUNT * 12 + 4;

  const ifd0Offset = TIFF_HEADER_SIZE;
  const dateTimeDataOffset = ifd0Offset + IFD0_SIZE;
  const exifIfdOffset = dateTimeDataOffset + 20;
  const dateTimeOriginalDataOffset = exifIfdOffset + EXIF_IFD_SIZE;
  const dateTimeDigitizedDataOffset = dateTimeOriginalDataOffset + 20;
  const totalSize = dateTimeDigitizedDataOffset + 20;

  const buf = Buffer.alloc(totalSize);

  buf.write("MM", 0, "ascii");
  buf.writeUInt16BE(42, 2);
  buf.writeUInt32BE(ifd0Offset, 4);

  let pos = ifd0Offset;
  buf.writeUInt16BE(IFD0_ENTRY_COUNT, pos);
  pos += 2;
  buf.writeUInt16BE(0x0132, pos);
  buf.writeUInt16BE(2, pos + 2); // type = ASCII
  buf.writeUInt32BE(20, pos + 4); // count
  buf.writeUInt32BE(dateTimeDataOffset, pos + 8);
  pos += 12;
  buf.writeUInt16BE(0x8769, pos);
  buf.writeUInt16BE(4, pos + 2); // type = LONG
  buf.writeUInt32BE(1, pos + 4); // count
  buf.writeUInt32BE(exifIfdOffset, pos + 8);
  pos += 12;
  buf.writeUInt32BE(0, pos); // next IFD offset (none)
  pos += 4;

  buf.write(dateStr, dateTimeDataOffset, "ascii");

  pos = exifIfdOffset;
  buf.writeUInt16BE(EXIF_IFD_ENTRY_COUNT, pos);
  pos += 2;
  buf.writeUInt16BE(0x9003, pos);
  buf.writeUInt16BE(2, pos + 2);
  buf.writeUInt32BE(20, pos + 4);
  buf.writeUInt32BE(dateTimeOriginalDataOffset, pos + 8);
  pos += 12;
  buf.writeUInt16BE(0x9004, pos);
  buf.writeUInt16BE(2, pos + 2);
  buf.writeUInt32BE(20, pos + 4);
  buf.writeUInt32BE(dateTimeDigitizedDataOffset, pos + 8);
  pos += 12;
  buf.writeUInt32BE(0, pos);

  buf.write(dateStr, dateTimeOriginalDataOffset, "ascii");
  buf.write(dateStr, dateTimeDigitizedDataOffset, "ascii");

  return buf;
}

// Replaces (or inserts) the eXIf chunk; nothing else in the file is touched.
function writePngDate(png: Buffer, date: Date): Buffer {
  const chunks = parseChunks(png);
  const exifBlob = buildExifBlob(date);
  const newExifChunk: PngChunk = { type: "eXIf", data: exifBlob };

  const withoutOldExif = chunks.filter((c) => c.type !== "eXIf");
  const ihdrIndex = withoutOldExif.findIndex((c) => c.type === "IHDR");
  if (ihdrIndex === -1) throw new Error("PNG has no IHDR chunk");

  const newChunks = [
    ...withoutOldExif.slice(0, ihdrIndex + 1),
    newExifChunk,
    ...withoutOldExif.slice(ihdrIndex + 1),
  ];

  const parts = [PNG_SIGNATURE, ...newChunks.map((c) => serializeChunk(c.type, c.data))];
  return Buffer.concat(parts);
}

function decodeITXt(chunkData: Buffer): string | null {
  const idx = chunkData.indexOf(0);
  if (idx === -1) return null;
  const compFlag = chunkData[idx + 1];
  let rest = chunkData.subarray(idx + 3);
  const idx2 = rest.indexOf(0);
  if (idx2 === -1) return null;
  rest = rest.subarray(idx2 + 1);
  const idx3 = rest.indexOf(0);
  if (idx3 === -1) return null;
  let text = rest.subarray(idx3 + 1);
  if (compFlag === 1) text = inflateSync(text);
  return text.toString("utf8");
}

// Some backlog PNGs' XMP photoshop:DateCreated has a corrupted month: the
// real month ends up split across the month/day fields as two decimal
// digits (real month = XMP_day - 10*XMP_month, verified against 18 real
// files). Day-of-month isn't recoverable from this field at all.
function readXmpRecoveredDate(chunks: PngChunk[]): Date | null {
  for (const chunk of chunks) {
    if (chunk.type !== "iTXt") continue;
    const text = decodeITXt(chunk.data);
    if (!text) continue;

    // Offset is only used to validate the field's shape, then discarded —
    // EXIF has no timezone concept, so the local wall-clock digits are
    // preserved verbatim rather than converted through the offset.
    const match = text.match(
      /photoshop:DateCreated>(\d{4})-(-?\d{1,2})-(-?\d{1,2})T(\d{2}):(\d{2}):(\d{2})[+-]\d{2}:\d{2}</,
    );
    if (!match) continue;

    const [, yearStr, monthFieldStr, dayFieldStr, hh, mm, ss] = match;
    const monthField = parseInt(monthFieldStr, 10);
    const dayField = parseInt(dayFieldStr, 10);
    const realMonth = dayField - 10 * monthField;
    if (realMonth < 1 || realMonth > 12) continue;

    const year = parseInt(yearStr, 10);
    const hour = parseInt(hh, 10);
    const minute = parseInt(mm, 10);
    const second = parseInt(ss, 10);
    const date = new Date(Date.UTC(year, realMonth - 1, 1, hour, minute, second));
    if (isNaN(date.getTime())) continue;
    return date;
  }
  return null;
}

// Priority: existing eXIf (untouched, even without a date — rewriting would
// destroy other tags like Orientation) -> XMP recovery -> caller-supplied
// fallback via applyFallbackDate. Never throws; a parse failure is treated
// as needs-fallback.
export function resolvePngDate(buffer: Buffer): PngDateResolution {
  try {
    const chunks = parseChunks(buffer);

    if (chunks.some((c) => c.type === "eXIf")) {
      return { action: "none" };
    }

    const recoveredDate = readXmpRecoveredDate(chunks);
    if (recoveredDate) {
      return { action: "fixed", buffer: writePngDate(buffer, recoveredDate) };
    }

    return { action: "needs-fallback" };
  } catch {
    return { action: "needs-fallback" };
  }
}

export function applyFallbackDate(buffer: Buffer, date: Date): Buffer {
  try {
    return writePngDate(buffer, date);
  } catch {
    return buffer;
  }
}
