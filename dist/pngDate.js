"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolvePngDate = resolvePngDate;
exports.applyFallbackDate = applyFallbackDate;
const zlib_1 = require("zlib");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function parseChunks(png) {
    if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error("Not a valid PNG (bad signature)");
    }
    const chunks = [];
    let pos = 8;
    while (pos < png.length) {
        const length = png.readUInt32BE(pos);
        const type = png.subarray(pos + 4, pos + 8).toString("ascii");
        const data = png.subarray(pos + 8, pos + 8 + length);
        chunks.push({ type, data });
        pos += 8 + length + 4; // length + type + data + crc
        if (type === "IEND")
            break;
    }
    // Buffer.subarray clamps instead of throwing, so a corrupted length field
    // could silently swallow IEND without an exception — require it explicitly.
    if (chunks.length === 0 || chunks[chunks.length - 1].type !== "IEND") {
        throw new Error("PNG chunk stream did not terminate in a valid IEND chunk");
    }
    return chunks;
}
function serializeChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, "ascii");
    const crcInput = Buffer.concat([typeBuf, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE((0, zlib_1.crc32)(crcInput) >>> 0, 0);
    return Buffer.concat([length, typeBuf, data, crc]);
}
function formatExifDate(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return (`${date.getUTCFullYear()}:${pad(date.getUTCMonth() + 1)}:${pad(date.getUTCDate())} ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`);
}
// Sets both IFD0's DateTime and the Exif sub-IFD's DateTimeOriginal, since
// it's undocumented which one Google Photos actually reads.
function buildExifBlob(date) {
    const dateStr = formatExifDate(date) + "\0"; // 20 bytes incl. null terminator
    if (dateStr.length !== 20)
        throw new Error("unexpected date string length");
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
function writePngDate(png, date) {
    const chunks = parseChunks(png);
    const exifBlob = buildExifBlob(date);
    const newExifChunk = { type: "eXIf", data: exifBlob };
    const withoutOldExif = chunks.filter((c) => c.type !== "eXIf");
    const ihdrIndex = withoutOldExif.findIndex((c) => c.type === "IHDR");
    if (ihdrIndex === -1)
        throw new Error("PNG has no IHDR chunk");
    const newChunks = [
        ...withoutOldExif.slice(0, ihdrIndex + 1),
        newExifChunk,
        ...withoutOldExif.slice(ihdrIndex + 1),
    ];
    const parts = [PNG_SIGNATURE, ...newChunks.map((c) => serializeChunk(c.type, c.data))];
    return Buffer.concat(parts);
}
// Tags we're comfortable discarding when rewriting the eXIf chunk — all
// auto-derived from the image itself (dimensions, colorspace, resolution),
// nothing a person would notice missing. Anything else (Orientation, GPS,
// Make/Model, ...) is treated as worth protecting.
const SAFE_TO_DISCARD_EXIF_TAGS = new Set([
    0x011a, // XResolution
    0x011b, // YResolution
    0x0128, // ResolutionUnit
    0x8769, // ExifIFDPointer (structural, not real content)
    0xa001, // ColorSpace
    0xa002, // PixelXDimension
    0xa003, // PixelYDimension
]);
const DATE_EXIF_TAGS = new Set([0x0132, 0x9003, 0x9004]);
function readExifTagSet(data) {
    const byteOrder = data.subarray(0, 2).toString("ascii");
    const endian = byteOrder === "II" ? "LE" : "BE";
    const read16 = (o) => (endian === "LE" ? data.readUInt16LE(o) : data.readUInt16BE(o));
    const read32 = (o) => (endian === "LE" ? data.readUInt32LE(o) : data.readUInt32BE(o));
    const tags = new Set();
    const subIfdOffsets = [];
    function readIfd(offset) {
        const numEntries = read16(offset);
        for (let i = 0; i < numEntries; i++) {
            const entryOffset = offset + 2 + i * 12;
            const tag = read16(entryOffset);
            tags.add(tag);
            if (tag === 0x8769) {
                const valueRaw = data.subarray(entryOffset + 8, entryOffset + 12);
                subIfdOffsets.push(endian === "LE" ? valueRaw.readUInt32LE(0) : valueRaw.readUInt32BE(0));
            }
        }
    }
    readIfd(read32(4));
    for (const offset of subIfdOffsets)
        readIfd(offset);
    return tags;
}
// True if this eXIf chunk already has a real date, or carries any tag worth
// protecting from writePngDate's wholesale chunk replacement.
function exifChunkBlocksRewrite(exifData) {
    const tags = readExifTagSet(exifData);
    for (const tag of tags) {
        if (DATE_EXIF_TAGS.has(tag))
            return true;
        if (!SAFE_TO_DISCARD_EXIF_TAGS.has(tag))
            return true;
    }
    return false;
}
function decodeITXt(chunkData) {
    const idx = chunkData.indexOf(0);
    if (idx === -1)
        return null;
    const compFlag = chunkData[idx + 1];
    let rest = chunkData.subarray(idx + 3);
    const idx2 = rest.indexOf(0);
    if (idx2 === -1)
        return null;
    rest = rest.subarray(idx2 + 1);
    const idx3 = rest.indexOf(0);
    if (idx3 === -1)
        return null;
    let text = rest.subarray(idx3 + 1);
    if (compFlag === 1)
        text = (0, zlib_1.inflateSync)(text);
    return text.toString("utf8");
}
// Some backlog PNGs' XMP photoshop:DateCreated has a corrupted month: the
// real month ends up split across the month/day fields as two decimal
// digits (real month = XMP_day - 10*XMP_month, verified against 18 real
// files). Day-of-month isn't recoverable from this field at all.
function readXmpRecoveredDate(chunks) {
    for (const chunk of chunks) {
        if (chunk.type !== "iTXt")
            continue;
        const text = decodeITXt(chunk.data);
        if (!text)
            continue;
        // Offset is only used to validate the field's shape, then discarded —
        // EXIF has no timezone concept, so the local wall-clock digits are
        // preserved verbatim rather than converted through the offset.
        const match = text.match(/photoshop:DateCreated>(\d{4})-(-?\d{1,2})-(-?\d{1,2})T(\d{2}):(\d{2}):(\d{2})[+-]\d{2}:\d{2}</);
        if (!match)
            continue;
        const [, yearStr, monthFieldStr, dayFieldStr, hh, mm, ss] = match;
        const monthField = parseInt(monthFieldStr, 10);
        const dayField = parseInt(dayFieldStr, 10);
        const realMonth = dayField - 10 * monthField;
        if (realMonth < 1 || realMonth > 12)
            continue;
        const year = parseInt(yearStr, 10);
        const hour = parseInt(hh, 10);
        const minute = parseInt(mm, 10);
        const second = parseInt(ss, 10);
        const date = new Date(Date.UTC(year, realMonth - 1, 1, hour, minute, second));
        if (isNaN(date.getTime()))
            continue;
        return date;
    }
    return null;
}
// Priority: existing eXIf with a date, or with any tag worth protecting
// (Orientation, GPS, ...) -> left untouched. Otherwise (no eXIf, or one
// containing only auto-derived tags like dimensions/colorspace) -> XMP
// recovery -> caller-supplied fallback via applyFallbackDate. Never throws;
// a parse failure is treated as needs-fallback.
function resolvePngDate(buffer) {
    try {
        const chunks = parseChunks(buffer);
        const exifChunk = chunks.find((c) => c.type === "eXIf");
        if (exifChunk && exifChunkBlocksRewrite(exifChunk.data)) {
            return { action: "none" };
        }
        const recoveredDate = readXmpRecoveredDate(chunks);
        if (recoveredDate) {
            return { action: "fixed", buffer: writePngDate(buffer, recoveredDate) };
        }
        return { action: "needs-fallback" };
    }
    catch {
        return { action: "needs-fallback" };
    }
}
function applyFallbackDate(buffer, date) {
    try {
        return writePngDate(buffer, date);
    }
    catch {
        return buffer;
    }
}
