function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries a function up to maxRetries times on 429 rate-limit errors,
// with exponential backoff. All other errors are rethrown immediately.
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
      const is429 = err.response?.status === 429 || err.status === 429;
      if (!is429 || attempt === maxRetries) throw err;
      console.warn(
        `[retry] Rate limited — retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
      );
      await sleep(delay);
      delay *= 2;
    }
  }
  throw new Error("unreachable");
}
