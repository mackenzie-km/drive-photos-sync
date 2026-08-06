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

    // day defaults to the 1st; year/time/offset are preserved from the XMP
    expect(readExifDateTimeOriginal(result.buffer)).toBe("2019:12:01 22:30:00");
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
});
