jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn().mockResolvedValue({
        response: {
          text: () =>
            "sunset, beach, ocean, couple, silhouette, golden hour, romantic, waves, sand, travel",
        },
      }),
    }),
  })),
}));

import { generatePhotoDescription } from "./gemini";

describe("generatePhotoDescription", () => {
  it("returns exactly 10 comma-separated keywords", async () => {
    const buffer = Buffer.from("fake-image-data");
    const result = await generatePhotoDescription(buffer, "image/jpeg");
    const keywords = result.split(",").map((k) => k.trim());

    expect(keywords).toHaveLength(10);
    keywords.forEach((keyword) => expect(keyword.length).toBeGreaterThan(0));
  });
});
