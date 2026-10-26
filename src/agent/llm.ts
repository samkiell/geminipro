import type Groq from 'groq-sdk';
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'groq-sdk/resources/chat/completions';
import type { Logger } from '../util/logger.js';

// Groq's free tier allows about 8000 tokens a minute and 1000 requests a day per model. Under load
// the bot must not wait on a model that is out of budget: this pool learns each model's limits
// from the response headers, rests a model after a 429 until its reset time, tries at most two
// models per call, and throws LlmUnavailable at once (no network call) when nothing is usable, so
// the caller can answer with a scripted reply straight away.

export type CompletionParams = ChatCompletionCreateParamsNonStreaming;

export interface LlmTransport {
  create(params: CompletionParams, options: { timeout: number }): Promise<{ completion: ChatCompletion; headers: Headers }>;
}

export function groqTransport(groq: Groq): LlmTransport {
  return {
    async create(params, { timeout }) {
      const { data, response } = await groq.chat.completions.create(params, { timeout, maxRetries: 0 }).withResponse();
      return { completion: data, headers: response.headers };
    },
  };
}

export class LlmUnavailable extends Error {
  override name = 'LlmUnavailable';
  /** rate_limited: every model is resting. busy: too many calls in flight. failed: every model errored. */
  constructor(readonly reason: 'rate_limited' | 'busy' | 'failed') {
    super(`llm unavailable: ${reason}`);
  }
}

interface ModelState {
  restUntil: number;
  tokensLeft?: number;
  tokensResetAt?: number;
  requestsLeft?: number;
  requestsResetAt?: number;
}

/** One model call, for logs and counters. Never the prompt or the reply. */
export interface CallRecord {
  model: string;
  ok: boolean;
  latencyMs: number;
  status?: number;
  promptTokens?: number;
  completionTokens?: number;
}

export interface ModelPoolOptions {
  logger: Logger;
  /** Calls allowed at once across all users. Default 6. */
  maxInFlight?: number;
  /** Calls that may wait for a free slot; beyond that, or after queueWaitMs, the scripted reply. Default 12. */
  maxQueue?: number;
  /** Default 2.5s. */
  queueWaitMs?: number;
  /** Models tried for one call before giving up. Default 2. */
  maxAttempts?: number;
  /** A model with fewer tokens left in its minute is skipped until its reset. Default 1200. */
  minTokens?: number;
  /** Per model attempt. Default 6s: a slow model loses to the scripted reply. */
  timeoutMs?: number;
  onCall?: (call: CallRecord) => void;
  now?: () => number;
}

/** "34.875s", "1m2.3s", "48m57.6s", "2h3m", "120ms" -> milliseconds. */
export function parseDuration(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Number(value) * 1000; // retry-after: plain seconds
  let total = 0;
  let matched = false;
  for (const [, amount, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(amount);
    total += unit === 'h' ? n * 3_600_000 : unit === 'm' ? n * 60_000 : unit === 's' ? n * 1000 : n;
  }
  return matched ? total : undefined;
}

function headerOf(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

export class ModelPool {
  private readonly state = new Map<string, ModelState>();
  private inFlight = 0;
  private readonly waiting: { start: () => void }[] = [];
  private readonly maxInFlight: number;
  private readonly maxQueue: number;
  private readonly queueWaitMs: number;
  private readonly maxAttempts: number;
  private readonly minTokens: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly transport: LlmTransport,
    readonly models: string[],
    private readonly opts: ModelPoolOptions,
  ) {
    this.maxInFlight = opts.maxInFlight ?? 6;
    this.maxQueue = opts.maxQueue ?? 12;
    this.queueWaitMs = opts.queueWaitMs ?? 2_500;
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.minTokens = opts.minTokens ?? 1_200;
    this.timeoutMs = opts.timeoutMs ?? 6_000;
    this.now = opts.now ?? Date.now;
  }

  /** A slot to call in: now, after a short wait in the queue, or LlmUnavailable('busy'). */
  private acquire(): Promise<void> {
    if (this.inFlight < this.maxInFlight) {
      this.inFlight++;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxQueue) return Promise.reject(new LlmUnavailable('busy'));
    return new Promise((resolve, reject) => {
      const entry = {
        start: () => {
          clearTimeout(timer);
          resolve();
        },
      };
      const timer = setTimeout(() => {
        this.waiting.splice(this.waiting.indexOf(entry), 1);
        reject(new LlmUnavailable('busy'));
      }, this.queueWaitMs);
      this.waiting.push(entry);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next.start(); // the slot passes straight to the next call
    else this.inFlight--;
  }

  /** Models that can take a call right now, in preference order. */
  usable(): string[] {
    const now = this.now();
    return this.models.filter((model) => {
      const s = this.state.get(model);
      if (!s) return true;
      if (s.restUntil > now) return false;
      if (s.tokensLeft !== undefined && s.tokensLeft < this.minTokens && (s.tokensResetAt ?? 0) > now) return false;
      if (s.requestsLeft === 0 && (s.requestsResetAt ?? 0) > now) return false;
      return true;
    });
  }

  /** True when a call could get a model (now or after a short wait); else go straight to the scripted reply. */
  get available(): boolean {
    return (this.inFlight < this.maxInFlight || this.waiting.length < this.maxQueue) && this.usable().length > 0;
  }

  async complete(
    params: Omit<CompletionParams, 'model'>,
    paramsFor: (model: string) => Partial<CompletionParams> = () => ({}),
  ): Promise<{ completion: ChatCompletion; model: string; latencyMs: number }> {
    if (this.usable().length === 0) throw new LlmUnavailable('rate_limited');
    await this.acquire();
    try {
      // Re-read after any wait: a model may have been rate limited meanwhile.
      const candidates = this.usable().slice(0, this.maxAttempts);
      if (candidates.length === 0) throw new LlmUnavailable('rate_limited');
      let rateLimited = 0;
      for (const model of candidates) {
        const started = this.now();
        try {
          const { completion, headers } = await this.transport.create(
            { ...params, model, ...paramsFor(model) } as CompletionParams,
            { timeout: this.timeoutMs },
          );
          const latencyMs = this.now() - started;
          this.learn(model, headers);
          this.record({
            model,
            ok: true,
            latencyMs,
            ...(completion.usage && { promptTokens: completion.usage.prompt_tokens, completionTokens: completion.usage.completion_tokens }),
          });
          return { completion, model, latencyMs };
        } catch (err) {
          const status = (err as { status?: number }).status;
          const headers = (err as { headers?: unknown }).headers;
          if (status === 429) {
            rateLimited++;
            const wait =
              parseDuration(headerOf(headers, 'retry-after')) ??
              parseDuration(headerOf(headers, 'x-ratelimit-reset-tokens')) ??
              parseDuration(headerOf(headers, 'x-ratelimit-reset-requests')) ??
              20_000;
            this.rest(model, Math.min(Math.max(wait, 1_000), 10 * 60_000));
          } else if (status === 401 || status === 403) {
            this.rest(model, 5 * 60_000);
          } else if (status === undefined || status >= 500) {
            this.rest(model, 5_000); // timeout, network or server trouble
          }
          // Other 4xx are about this request, not the model: no rest, just try the next one.
          this.record({ model, ok: false, latencyMs: this.now() - started, ...(status !== undefined && { status }) }, err);
        }
      }
      throw new LlmUnavailable(rateLimited === candidates.length ? 'rate_limited' : 'failed');
    } finally {
      this.release();
    }
  }

  private record(call: CallRecord, err?: unknown): void {
    if (call.ok) this.opts.logger.info(call, 'groq call');
    else this.opts.logger.warn({ ...call, err: (err as Error)?.message?.slice(0, 200) }, 'groq call failed');
    this.opts.onCall?.(call);
  }

  private rest(model: string, ms: number): void {
    const s = this.state.get(model) ?? { restUntil: 0 };
    s.restUntil = this.now() + ms;
    this.state.set(model, s);
  }

  private learn(model: string, headers: unknown): void {
    const now = this.now();
    const s = this.state.get(model) ?? { restUntil: 0 };
    const tokens = headerOf(headers, 'x-ratelimit-remaining-tokens');
    const tokensReset = parseDuration(headerOf(headers, 'x-ratelimit-reset-tokens'));
    const requests = headerOf(headers, 'x-ratelimit-remaining-requests');
    const requestsReset = parseDuration(headerOf(headers, 'x-ratelimit-reset-requests'));
    if (tokens !== undefined) s.tokensLeft = Number(tokens);
    if (tokensReset !== undefined) s.tokensResetAt = now + tokensReset;
    if (requests !== undefined) s.requestsLeft = Number(requests);
    if (requestsReset !== undefined) s.requestsResetAt = now + requestsReset;
    this.state.set(model, s);
  }
}
