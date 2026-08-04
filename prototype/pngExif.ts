import { crc32 } from "zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngChunk {
  type: string;
  data: Buffer;
}

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

// Builds a minimal, spec-compliant EXIF/TIFF blob (big-endian) containing:
//   IFD0: DateTime (0x0132) + ExifIFDPointer (0x8769)
//   Exif sub-IFD: DateTimeOriginal (0x9003) + DateTimeDigitized (0x9004)
// Both IFD0's DateTime and the sub-IFD's DateTimeOriginal are set, since it's
// undocumented which one Google Photos actually reads — covering both maximizes
// the chance this is honored.
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

  // TIFF header
  buf.write("MM", 0, "ascii");
  buf.writeUInt16BE(42, 2);
  buf.writeUInt32BE(ifd0Offset, 4);

  // IFD0
  let pos = ifd0Offset;
  buf.writeUInt16BE(IFD0_ENTRY_COUNT, pos);
  pos += 2;
  // Entry: DateTime (0x0132), ASCII, count 20, offset -> dateTimeDataOffset
  buf.writeUInt16BE(0x0132, pos);
  buf.writeUInt16BE(2, pos + 2); // type = ASCII
  buf.writeUInt32BE(20, pos + 4); // count
  buf.writeUInt32BE(dateTimeDataOffset, pos + 8);
  pos += 12;
  // Entry: ExifIFDPointer (0x8769), LONG, count 1, value -> exifIfdOffset
  buf.writeUInt16BE(0x8769, pos);
  buf.writeUInt16BE(4, pos + 2); // type = LONG
  buf.writeUInt32BE(1, pos + 4); // count
  buf.writeUInt32BE(exifIfdOffset, pos + 8);
  pos += 12;
  // Next IFD offset (none)
  buf.writeUInt32BE(0, pos);
  pos += 4;

  // DateTime string data
  buf.write(dateStr, dateTimeDataOffset, "ascii");

  // Exif sub-IFD
  pos = exifIfdOffset;
  buf.writeUInt16BE(EXIF_IFD_ENTRY_COUNT, pos);
  pos += 2;
  // Entry: DateTimeOriginal (0x9003), ASCII, count 20, offset -> dateTimeOriginalDataOffset
  buf.writeUInt16BE(0x9003, pos);
  buf.writeUInt16BE(2, pos + 2);
  buf.writeUInt32BE(20, pos + 4);
  buf.writeUInt32BE(dateTimeOriginalDataOffset, pos + 8);
  pos += 12;
  // Entry: DateTimeDigitized (0x9004), ASCII, count 20, offset -> dateTimeDigitizedDataOffset
  buf.writeUInt16BE(0x9004, pos);
  buf.writeUInt16BE(2, pos + 2);
  buf.writeUInt32BE(20, pos + 4);
  buf.writeUInt32BE(dateTimeDigitizedDataOffset, pos + 8);
  pos += 12;
  // Next IFD offset (none)
  buf.writeUInt32BE(0, pos);

  // DateTimeOriginal / DateTimeDigitized string data
  buf.write(dateStr, dateTimeOriginalDataOffset, "ascii");
  buf.write(dateStr, dateTimeDigitizedDataOffset, "ascii");

  return buf;
}

// Replaces (or inserts) the PNG's eXIf chunk with a freshly-built minimal one
// carrying DateTimeOriginal/DateTime = the given date. Nothing else in the
// file is touched.
export function writePngDate(png: Buffer, date: Date): Buffer {
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

// Independent read-back path — does NOT reuse buildExifBlob's internal offset
// assumptions. Walks the IFD structure generically, the way a real reader would.
export function readPngDate(png: Buffer): { dateTime?: string; dateTimeOriginal?: string } {
  const chunks = parseChunks(png);
  const exifChunk = chunks.find((c) => c.type === "eXIf");
  if (!exifChunk) return {};
  const data = exifChunk.data;

  const byteOrder = data.subarray(0, 2).toString("ascii");
  const endian = byteOrder === "II" ? "LE" : "BE";
  const read16 = (o: number) => (endian === "LE" ? data.readUInt16LE(o) : data.readUInt16BE(o));
  const read32 = (o: number) => (endian === "LE" ? data.readUInt32LE(o) : data.readUInt32BE(o));

  const ifd0Offset = read32(4);

  function readIfd(offset: number): Map<number, { type: number; count: number; valueRaw: Buffer }> {
    const numEntries = read16(offset);
    const map = new Map();
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
    const size = entry.count; // ASCII type size is 1 byte/unit
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

  if (ifd0.has(0x0132)) {
    result.dateTime = decodeAscii(ifd0.get(0x0132)!);
  }

  if (ifd0.has(0x8769)) {
    const ptrEntry = ifd0.get(0x8769)!;
    const exifIfdOffset =
      endian === "LE" ? ptrEntry.valueRaw.readUInt32LE(0) : ptrEntry.valueRaw.readUInt32BE(0);
    const exifIfd = readIfd(exifIfdOffset);
    if (exifIfd.has(0x9003)) {
      result.dateTimeOriginal = decodeAscii(exifIfd.get(0x9003)!);
    }
  }

  return result;
}
