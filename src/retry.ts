function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_CODES = new Set(["ENOTFOUND", "ECONNRESET", "ETIMEDOUT"]);

function isRetryable(err: any): boolean {
  return (
    err.response?.status === 429 ||
    err.status === 429 ||
    RETRYABLE_CODES.has(err.code)
  );
}

// Retries a function up to maxRetries times on 429s and transient network
// errors, with exponential backoff. All other errors are rethrown immediately.
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  initialDelay = 1000,
): Promise<T> {
  let delay = initialDelay;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (!isRetryable(err) || attempt === maxRetries) throw err;
      console.warn(
        `[retry] Transient error (${err.code ?? err.status ?? err.response?.status}) — retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
      );
      await sleep(delay);
      delay *= 2;
    }
  }
  throw new Error("unreachable");
}
