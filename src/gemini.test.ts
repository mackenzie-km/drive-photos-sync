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

jest.mock("axios", () => ({
  get: jest.fn().mockResolvedValue({
    data: Buffer.from("fake-image-data"),
    headers: { "content-type": "image/jpeg" },
  }),
}));

import axios from "axios";
import { generatePhotoDescription } from "./gemini";

const mockAxiosGet = axios.get as jest.Mock;

describe("generatePhotoDescription", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns exactly 10 comma-separated keywords", async () => {
    const result = await generatePhotoDescription(
      "https://example.com/thumbnail.jpg",
    );
    const keywords = result.split(",").map((k) => k.trim());

    expect(keywords).toHaveLength(10);
    keywords.forEach((keyword) => expect(keyword.length).toBeGreaterThan(0));
  });

  it("fetches the thumbnail link before sending to Gemini", async () => {
    const url = "https://example.com/thumbnail.jpg";
    await generatePhotoDescription(url);

    expect(mockAxiosGet).toHaveBeenCalledWith(url, {
      responseType: "arraybuffer",
    });
  });
});
