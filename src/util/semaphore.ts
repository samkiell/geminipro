/** Limits how many async jobs run at once; the rest wait their turn (FIFO). */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  get busy(): number {
    return this.active;
  }

  /** Runs now if a slot is free, otherwise undefined: for callers that would rather not wait. */
  tryRun<T>(job: () => Promise<T>): Promise<T> | undefined {
    if (this.active >= this.max) return undefined;
    this.active++;
    return job().finally(() => this.release());
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await job();
    } finally {
      this.release();
    }
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); // the slot passes straight to the next job
    else this.active--;
  }
}
