export class TimeoutError extends Error {
  override name = 'TimeoutError';

  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
  }
}

/** Rejects with TimeoutError if `promise` has not settled within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
