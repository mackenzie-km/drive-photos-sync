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
// Builds a minimal, spec-compliant EXIF/TIFF blob (big-endian) containing:
//   IFD0: DateTime (0x0132) + ExifIFDPointer (0x8769)
//   Exif sub-IFD: DateTimeOriginal (0x9003) + DateTimeDigitized (0x9004)
// Both IFD0's DateTime and the sub-IFD's DateTimeOriginal are set, since it's
// undocumented which one Google Photos actually reads — covering both maximizes
// the chance this is honored.
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
    // TIFF header
    buf.write("MM", 0, "ascii");
    buf.writeUInt16BE(42, 2);
    buf.writeUInt32BE(ifd0Offset, 4);
    // IFD0
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
    // Exif sub-IFD
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
// Replaces (or inserts) the PNG's eXIf chunk with a freshly-built minimal one
// carrying DateTimeOriginal/DateTime = the given date. Nothing else in the
// file is touched.
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
// Backlog PNGs' XMP photoshop:DateCreated is systematically corrupted by
// whatever tool wrote it: the real month ends up split across the month/day
// slots as two decimal digits (real month = XMP_day - 10*XMP_month, verified
// against 18 real backlog files with zero exceptions). Day-of-month is not
// encoded anywhere in this field at all — year, time, and timezone offset are
// unaffected. Returns null if the field is absent or doesn't match the
// expected shape (fail safe rather than guess).
function readXmpRecoveredDate(chunks) {
    for (const chunk of chunks) {
        if (chunk.type !== "iTXt")
            continue;
        const text = decodeITXt(chunk.data);
        if (!text)
            continue;
        // The trailing offset group is only used to validate the field's shape
        // (a well-formed ISO 8601 offset) — its value is intentionally discarded
        // below. EXIF DateTimeOriginal has no timezone concept; it's the literal
        // local wall-clock time, verbatim. Converting through it (e.g. via
        // `new Date(isoString)` read back with UTC getters) would silently shift
        // the recovered time by the offset instead of preserving it.
        const match = text.match(/photoshop:DateCreated>(\d{4})-(-?\d{1,2})-(-?\d{1,2})T(\d{2}):(\d{2}):(\d{2})[+-]\d{2}:\d{2}</);
        if (!match)
            continue;
        const [, yearStr, monthFieldStr, dayFieldStr, hh, mm, ss] = match;
        const monthField = parseInt(monthFieldStr, 10);
        const dayField = parseInt(dayFieldStr, 10);
        const realMonth = dayField - 10 * monthField;
        if (realMonth < 1 || realMonth > 12)
            continue; // doesn't fit the known corruption shape — bail
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
// Decides how (if at all) to fix a PNG's embedded date, in priority order:
//   1. Any eXIf chunk already present -> leave untouched, whether or not it
//      has a date. (Confirmed via a real Google Photos upload test that a
//      valid date displays correctly as-is — no rewrite needed. A dateless
//      eXIf chunk is left alone too: writePngDate replaces the whole chunk
//      wholesale, so rewriting it would silently destroy any other tags it
//      carries, e.g. Orientation or GPS — safer to leave a narrow subset of
//      dateless-EXIF files unfixed than risk losing that data.)
//   2. Corrupted XMP photoshop:DateCreated recoverable via the known formula
//      -> write a corrected eXIf chunk (day defaults to the 1st, since it's
//      not recoverable from this field).
//   3. Neither -> caller must supply a fallback date (e.g. Drive createdTime)
//      via applyFallbackDate.
// Never throws — any parse failure is treated as needs-fallback, since this
// is a best-effort enhancement that must never be able to fail an upload
// that would otherwise succeed.
function resolvePngDate(buffer) {
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
    }
    catch {
        return { action: "needs-fallback" };
    }
}
// Same never-throws invariant as resolvePngDate — if the buffer somehow
// can't be rewritten, upload it unmodified rather than fail the file.
function applyFallbackDate(buffer, date) {
    try {
        return writePngDate(buffer, date);
    }
    catch {
        return buffer;
    }
}
