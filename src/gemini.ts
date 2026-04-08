import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const PROMPT =
  "Generate exactly 10 descriptive, search-friendly keywords for this photo. Return them as a single comma-separated list with no numbering, no extra punctuation, and no explanation. Example format: sunset, beach, ocean, couple, silhouette, golden hour, romantic, waves, sand, travel";

export async function generatePhotoDescription(
  thumbnailLink: string,
): Promise<string> {
  const res = await axios.get(thumbnailLink, { responseType: "arraybuffer" });
  const base64 = Buffer.from(res.data).toString("base64");
  const mimeType = (res.headers["content-type"] as string) ?? "image/jpeg";

  const result = await model.generateContent([
    { inlineData: { mimeType, data: base64 } },
    PROMPT,
  ]);

  return result.response.text().trim();
}
