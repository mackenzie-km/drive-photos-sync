import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

const PROMPT =
  "Generate exactly 10 descriptive, search-friendly keywords for this photo. Return them as a single comma-separated list with no numbering, no extra punctuation, and no explanation. Example format: sunset, beach, ocean, couple, silhouette, golden hour, romantic, waves, sand, travel";

export async function generatePhotoDescription(
  imageBuffer: Buffer,
  mimeType: string,
): Promise<string> {
  const base64 = imageBuffer.toString("base64");

  const result = await model.generateContent([
    { inlineData: { mimeType, data: base64 } },
    PROMPT,
  ]);

  return result.response.text().trim();
}
