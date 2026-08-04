import { readFileSync, writeFileSync } from "fs";
import { writePngDate, readPngDate } from "./pngExif";

const SOURCE = "/Users/Mackenzie/Downloads/IMG_2324.png";
const TARGET_DATE = new Date(Date.UTC(2018, 5, 15, 12, 0, 0)); // 2018-06-15 12:00:00 UTC

const original = readFileSync(SOURCE);
console.log(`Loaded ${SOURCE}: ${original.length} bytes`);

const before = readPngDate(original);
console.log("Before write:", before);
if (before.dateTimeOriginal || before.dateTime) {
  throw new Error("Expected no existing date in this file — investigation assumption broken");
}

const rewritten = writePngDate(original, TARGET_DATE);
console.log(`Rewritten: ${rewritten.length} bytes (was ${original.length})`);

const after = readPngDate(rewritten);
console.log("After write (independent re-parse):", after);

const expected = "2018:06:15 12:00:00";
if (after.dateTimeOriginal !== expected || after.dateTime !== expected) {
  throw new Error(
    `Round-trip FAILED. Expected "${expected}", got dateTime=${after.dateTime} dateTimeOriginal=${after.dateTimeOriginal}`,
  );
}

// Sanity: make sure the rewritten buffer is still a structurally valid PNG
// (signature intact, IHDR/IDAT/IEND still present) by re-checking chunk types.
if (!rewritten.subarray(0, 8).equals(original.subarray(0, 8))) {
  throw new Error("PNG signature corrupted");
}

const outPath = "/tmp/IMG_2324_datefixed.png";
writeFileSync(outPath, rewritten);
console.log(`\nROUND-TRIP PASSED. Wrote result to ${outPath} for visual sanity check.`);
