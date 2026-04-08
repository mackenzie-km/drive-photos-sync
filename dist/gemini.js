"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generatePhotoDescription = generatePhotoDescription;
const generative_ai_1 = require("@google/generative-ai");
const axios_1 = __importDefault(require("axios"));
const genAI = new generative_ai_1.GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
const PROMPT = "Generate exactly 10 descriptive, search-friendly keywords for this photo. Return them as a single comma-separated list with no numbering, no extra punctuation, and no explanation. Example format: sunset, beach, ocean, couple, silhouette, golden hour, romantic, waves, sand, travel";
async function generatePhotoDescription(thumbnailLink) {
    const res = await axios_1.default.get(thumbnailLink, { responseType: "arraybuffer" });
    const base64 = Buffer.from(res.data).toString("base64");
    const mimeType = res.headers["content-type"] ?? "image/jpeg";
    const result = await model.generateContent([
        { inlineData: { mimeType, data: base64 } },
        PROMPT,
    ]);
    return result.response.text().trim();
}
