import { withRetry } from "./retry";

// Use initialDelay=0 throughout so tests don't actually sleep.
beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

const make429 = (shape: "axios" | "gemini") =>
  shape === "axios"
    ? { response: { status: 429 } }
    : { status: 429 };

describe("withRetry", () => {
  it("returns the result immediately on success", async () => {
    const fn = jest.fn().mockResolvedValue("ok");
    await expect(withRetry(fn, 3, 0)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on an axios-style 429 and succeeds on the second attempt", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(make429("axios"))
      .mockResolvedValue("ok");
    await expect(withRetry(fn, 3, 0)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries on a Gemini-style 429 and succeeds on the second attempt", async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(make429("gemini"))
      .mockResolvedValue("ok");
    await expect(withRetry(fn, 3, 0)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting all retries", async () => {
    const fn = jest.fn().mockRejectedValue(make429("axios"));
    await expect(withRetry(fn, 3, 0)).rejects.toMatchObject({
      response: { status: 429 },
    });
    expect(fn).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it("does not retry non-retryable errors", async () => {
    const fn = jest.fn().mockRejectedValue(new Error("bad request"));
    await expect(withRetry(fn, 3, 0)).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each(["ENOTFOUND", "ECONNRESET", "ETIMEDOUT"])(
    "retries on %s and succeeds on the second attempt",
    async (code) => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce({ code })
        .mockResolvedValue("ok");
      await expect(withRetry(fn, 3, 0)).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    },
  );
});
