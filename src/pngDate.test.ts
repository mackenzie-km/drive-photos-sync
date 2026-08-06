import { crc32 } from "zlib";
import { resolvePngDate, applyFallbackDate } from "./pngDate";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Test-local chunk builder/reader — deliberately independent of pngDate.ts's
// internals (mirrors the prototype's "independent reader" approach), so these
// tests verify actual on-disk bytes rather than just round-tripping through
// the same code being tested.

function serializeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function buildPng(chunks: { type: string; data: Buffer }[]): Buffer {
  const ihdr = Buffer.alloc(13); // minimal, values don't matter for these tests
  const all = [
    { type: "IHDR", data: ihdr },
    ...chunks,
    { type: "IEND", data: Buffer.alloc(0) },
  ];
  return Buffer.concat([PNG_SIGNATURE, ...all.map((c) => serializeChunk(c.type, c.data))]);
}

function buildITXtChunk(keyword: string, text: string): Buffer {
  return Buffer.concat([
    Buffer.from(keyword, "ascii"),
    Buffer.from([0, 0, 0]), // null, compression flag=0, compression method=0
    Buffer.from([0]), // empty language tag + null
    Buffer.from([0]), // empty translated keyword + null
    Buffer.from(text, "utf8"),
  ]);
}

function xmpWithDateCreated(dateCreated: string): string {
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"><photoshop:DateCreated>${dateCreated}</photoshop:DateCreated></rdf:Description></rdf:RDF></x:xmpmeta>`;
}

// A chunk with a declared length far exceeding what actually follows it —
// simulating bit-level corruption of a length field, as opposed to a
// completely non-PNG buffer (already covered by the "not a png at all"
// tests below). Buffer.subarray clamps out-of-range reads instead of
// throwing, so a naive parser can silently swallow the real IEND chunk into
// this one's data and never notice.
function buildPngWithCorruptedChunkLength(): Buffer {
  const ihdr = serializeChunk("IHDR", Buffer.alloc(13));
  const badLength = Buffer.alloc(4);
  badLength.writeUInt32BE(500_000, 0); // claims 500KB; nowhere near that much data follows
  const typeBuf = Buffer.from("iTXt", "ascii");
  const itxtData = Buffer.from("XML:com.adobe.xmp\0\0\0\0\0<xmp>whatever</xmp>", "utf8");
  const crcVal = Buffer.alloc(4);
  crcVal.writeUInt32BE(crc32(Buffer.concat([typeBuf, itxtData])) >>> 0, 0);
  const corruptChunk = Buffer.concat([badLength, typeBuf, itxtData, crcVal]);
  const iend = serializeChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([PNG_SIGNATURE, ihdr, corruptChunk, iend]);
}

function readExifDateTimeOriginal(png: Buffer): string | undefined {
  let pos = 8;
  let exifData: Buffer | undefined;
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString("ascii");
    if (type === "eXIf") exifData = png.subarray(pos + 8, pos + 8 + length);
    pos += 8 + length + 4;
    if (type === "IEND") break;
  }
  if (!exifData) return undefined;

  const ifd0Offset = exifData.readUInt32BE(4);
  const numEntries = exifData.readUInt16BE(ifd0Offset);
  let exifIfdOffset: number | undefined;
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = ifd0Offset + 2 + i * 12;
    const tag = exifData.readUInt16BE(entryOffset);
    if (tag === 0x8769) exifIfdOffset = exifData.readUInt32BE(entryOffset + 8);
  }
  if (exifIfdOffset === undefined) return undefined;

  const subEntries = exifData.readUInt16BE(exifIfdOffset);
  for (let i = 0; i < subEntries; i++) {
    const entryOffset = exifIfdOffset + 2 + i * 12;
    const tag = exifData.readUInt16BE(entryOffset);
    if (tag === 0x9003) {
      const count = exifData.readUInt32BE(entryOffset + 4);
      const offset = exifData.readUInt32BE(entryOffset + 8);
      return exifData
        .subarray(offset, offset + count)
        .toString("ascii")
        .replace(/\0+$/, "");
    }
  }
  return undefined;
}

function buildExifChunkWithOrientationOnly(): Buffer {
  // Minimal TIFF/EXIF blob carrying a single non-date tag (Orientation,
  // 0x0112, SHORT, value=1) — no DateTime/DateTimeOriginal anywhere.
  const buf = Buffer.alloc(8 + 2 + 12 + 4);
  buf.write("MM", 0, "ascii");
  buf.writeUInt16BE(42, 2);
  buf.writeUInt32BE(8, 4); // ifd0Offset
  buf.writeUInt16BE(1, 8); // numEntries
  buf.writeUInt16BE(0x0112, 10); // tag: Orientation
  buf.writeUInt16BE(3, 12); // type: SHORT
  buf.writeUInt32BE(1, 14); // count
  buf.writeUInt16BE(1, 18); // value (left-justified in the 4-byte field)
  buf.writeUInt32BE(0, 22); // next IFD offset
  return buf;
}

function buildExifChunkWithGpsPointerOnly(): Buffer {
  // Minimal TIFF/EXIF blob carrying only GPSInfoIFDPointer (0x8825) — no
  // DateTime/DateTimeOriginal anywhere. Only the presence of the pointer tag
  // in IFD0 matters for blocking; the GPS sub-IFD itself isn't walked.
  const buf = Buffer.alloc(8 + 2 + 12 + 4);
  buf.write("MM", 0, "ascii");
  buf.writeUInt16BE(42, 2);
  buf.writeUInt32BE(8, 4); // ifd0Offset
  buf.writeUInt16BE(1, 8); // numEntries
  buf.writeUInt16BE(0x8825, 10); // tag: GPSInfoIFDPointer
  buf.writeUInt16BE(4, 12); // type: LONG
  buf.writeUInt32BE(1, 14); // count
  buf.writeUInt32BE(999, 18); // bogus sub-IFD offset — never followed for GPS
  buf.writeUInt32BE(0, 22); // next IFD offset
  return buf;
}

const BASE_PNG = buildPng([]);

describe("resolvePngDate", () => {
  it("returns none when a valid eXIf DateTimeOriginal is already present", () => {
    const withExif = applyFallbackDate(BASE_PNG, new Date("2020-05-15T10:00:00Z"));
    expect(resolvePngDate(withExif)).toEqual({ action: "none" });
  });

  it("recovers year+month from a corrupted XMP DateCreated and writes a corrected eXIf chunk", () => {
    // monthField=-1, dayField=02 -> realMonth = 2 - 10*(-1) = 12 (December)
    const xmp = xmpWithDateCreated("2019--1-02T14:30:00-08:00");
    const png = buildPng([{ type: "iTXt", data: buildITXtChunk("XML:com.adobe.xmp", xmp) }]);

    const result = resolvePngDate(png);
    expect(result.action).toBe("fixed");
    if (result.action !== "fixed") throw new Error("unreachable");

    // day defaults to the 1st; year and local wall-clock time are preserved
    // verbatim from the XMP — the -08:00 offset is intentionally discarded
    // rather than applied as a UTC conversion (EXIF has no timezone concept).
    expect(readExifDateTimeOriginal(result.buffer)).toBe("2019:12:01 14:30:00");
  });

  it("returns none when a dateless eXIf chunk carries a tag worth protecting (Orientation)", () => {
    const xmp = xmpWithDateCreated("2019--1-02T14:30:00-08:00");
    const png = buildPng([
      { type: "eXIf", data: buildExifChunkWithOrientationOnly() },
      { type: "iTXt", data: buildITXtChunk("XML:com.adobe.xmp", xmp) },
    ]);

    expect(resolvePngDate(png)).toEqual({ action: "none" });
  });

  it("returns none when a dateless eXIf chunk carries a tag worth protecting (GPS)", () => {
    const xmp = xmpWithDateCreated("2019--1-02T14:30:00-08:00");
    const png = buildPng([
      { type: "eXIf", data: buildExifChunkWithGpsPointerOnly() },
      { type: "iTXt", data: buildITXtChunk("XML:com.adobe.xmp", xmp) },
    ]);

    expect(resolvePngDate(png)).toEqual({ action: "none" });
  });

  it("recovers from XMP when the dateless eXIf chunk only has auto-derived tags (dimensions/colorspace)", () => {
    // Real eXIf chunk bytes captured from an actual backlog file
    // (IMG_1259.png): IFD0 -> ExifIFDPointer only -> sub-IFD with
    // ColorSpace/PixelXDimension/PixelYDimension, nothing else. Confirms
    // this shape falls through to XMP recovery rather than being blocked.
    const realDimensionsOnlyExif = Buffer.from(
      "4d4d002a00000008000187690004000000010000001a000000000003a00100030000000100010000a00200040000000100000533a003000400000001000003e800000000",
      "hex",
    );
    // monthField=00, dayField=04 -> realMonth = 4 (April)
    const xmp = xmpWithDateCreated("2018-00-04T20:43:48-07:00");
    const png = buildPng([
      { type: "eXIf", data: realDimensionsOnlyExif },
      { type: "iTXt", data: buildITXtChunk("XML:com.adobe.xmp", xmp) },
    ]);

    const result = resolvePngDate(png);
    expect(result.action).toBe("fixed");
    if (result.action !== "fixed") throw new Error("unreachable");
    expect(readExifDateTimeOriginal(result.buffer)).toBe("2018:04:01 20:43:48");
  });

  it("recovers from XMP when the dateless eXIf chunk has EXIF/FlashPix version and scene-type markers (no location/orientation)", () => {
    // Real eXIf chunk bytes captured from an actual backlog file
    // (IMG_2532.png): carries ExifVersion, ComponentsConfiguration,
    // FlashpixVersion, and SceneCaptureType alongside the usual dimensions/
    // colorspace/resolution tags — none of which are location or
    // orientation, so this should fall through to XMP recovery.
    const realVersionMarkersExif = Buffer.from(
      "4d4d002a000000080004011a0005000000010000003e011b0005000000010000004601280003000000010002000087690004000000010000004e00000000000000480000000100000048000000010007900000070000000430323231910100070000000401020300a00000070000000430313030a00100030000000100010000a0020004000000010000023fa0030004000000010000023fa4060003000000010000000000000000",
      "hex",
    );
    // monthField=-1, dayField=00 -> realMonth = 0 - 10*(-1) = 10 (October)
    const xmp = xmpWithDateCreated("2018--1-00T15:26:12-07:00");
    const png = buildPng([
      { type: "eXIf", data: realVersionMarkersExif },
      { type: "iTXt", data: buildITXtChunk("XML:com.adobe.xmp", xmp) },
    ]);

    const result = resolvePngDate(png);
    expect(result.action).toBe("fixed");
    if (result.action !== "fixed") throw new Error("unreachable");
    expect(readExifDateTimeOriginal(result.buffer)).toBe("2018:10:01 15:26:12");
  });

  it("returns needs-fallback when there is no eXIf and no iTXt chunk at all", () => {
    expect(resolvePngDate(BASE_PNG)).toEqual({ action: "needs-fallback" });
  });

  it("returns needs-fallback when iTXt is present but has no photoshop:DateCreated", () => {
    const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:exif="http://ns.adobe.com/exif/1.0/"><exif:PixelXDimension>1280</exif:PixelXDimension></rdf:Description></rdf:RDF></x:xmpmeta>`;
    const png = buildPng([{ type: "iTXt", data: buildITXtChunk("XML:com.adobe.xmp", xmp) }]);
    expect(resolvePngDate(png)).toEqual({ action: "needs-fallback" });
  });

  it("falls back safely when the recovery formula produces an out-of-range month", () => {
    // monthField=0, dayField=15 -> realMonth = 15, out of [1,12]
    const xmp = xmpWithDateCreated("2018-00-15T10:00:00-07:00");
    const png = buildPng([{ type: "iTXt", data: buildITXtChunk("XML:com.adobe.xmp", xmp) }]);
    expect(resolvePngDate(png)).toEqual({ action: "needs-fallback" });
  });

  it("never throws on a malformed buffer — treats it as needs-fallback", () => {
    const garbage = Buffer.from("not a png at all");
    expect(resolvePngDate(garbage)).toEqual({ action: "needs-fallback" });
  });

  it("treats a corrupted chunk length (that would silently swallow IEND) as needs-fallback, not a parseable file", () => {
    const corrupted = buildPngWithCorruptedChunkLength();
    expect(resolvePngDate(corrupted)).toEqual({ action: "needs-fallback" });
  });
});

describe("applyFallbackDate", () => {
  it("writes the given date into a fresh eXIf chunk", () => {
    const result = applyFallbackDate(BASE_PNG, new Date("2021-03-04T09:15:30Z"));
    expect(readExifDateTimeOriginal(result)).toBe("2021:03:04 09:15:30");
  });

  it("returns the buffer unmodified rather than throwing on a malformed buffer", () => {
    const garbage = Buffer.from("not a png at all");
    expect(applyFallbackDate(garbage, new Date())).toBe(garbage);
  });

  it("returns the buffer unmodified rather than reconstructing a corrupted PNG missing IEND", () => {
    const corrupted = buildPngWithCorruptedChunkLength();
    expect(applyFallbackDate(corrupted, new Date())).toBe(corrupted);
  });
});
