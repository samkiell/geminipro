import type Groq from 'groq-sdk';
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'groq-sdk/resources/chat/completions';
import type { Logger } from '../util/logger.js';

// Groq's free tier allows about 8000 tokens a minute and 1000 requests a day per model. Under load
// the bot must not wait on a model that is out of budget: this pool learns each model's limits
// from the response headers, rests a model after a 429 until its reset time, and throws
// LlmUnavailable at once (no network call) when nothing is usable, so the caller can answer
// with a scripted reply straight away.

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

export interface ModelPoolOptions {
  logger: Logger;
  /** Calls allowed at once across all users. Extra turns get the scripted reply. Default 4. */
  maxInFlight?: number;
  /** A model with fewer tokens left in its minute is skipped until its reset. Default 2500. */
  minTokens?: number;
  /** Per call. Default 8s: a slow model loses to the scripted reply. */
  timeoutMs?: number;
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
  private readonly maxInFlight: number;
  private readonly minTokens: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly transport: LlmTransport,
    readonly models: string[],
    private readonly opts: ModelPoolOptions,
  ) {
    this.maxInFlight = opts.maxInFlight ?? 4;
    this.minTokens = opts.minTokens ?? 2_500;
    this.timeoutMs = opts.timeoutMs ?? 8_000;
    this.now = opts.now ?? Date.now;
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

  /** True when a turn would get a model; lets callers skip straight to the scripted reply. */
  get available(): boolean {
    return this.inFlight < this.maxInFlight && this.usable().length > 0;
  }

  async complete(
    params: Omit<CompletionParams, 'model'>,
    paramsFor: (model: string) => Partial<CompletionParams> = () => ({}),
  ): Promise<{ completion: ChatCompletion; model: string }> {
    if (this.inFlight >= this.maxInFlight) throw new LlmUnavailable('busy');
    const candidates = this.usable();
    if (candidates.length === 0) throw new LlmUnavailable('rate_limited');

    this.inFlight++;
    try {
      let rateLimited = 0;
      for (const model of candidates) {
        try {
          const { completion, headers } = await this.transport.create(
            { ...params, model, ...paramsFor(model) } as CompletionParams,
            { timeout: this.timeoutMs },
          );
          this.learn(model, headers);
          return { completion, model };
        } catch (err) {
          const status = (err as { status?: number }).status;
          const headers = (err as { headers?: unknown }).headers;
          if (status === 429) {
            rateLimited++;
            const wait =
              parseDuration(headerOf(headers, 'retry-after')) ??
              parseDuration(headerOf(headers, 'x-ratelimit-reset-tokens')) ??
              20_000;
            this.rest(model, Math.min(Math.max(wait, 1_000), 10 * 60_000));
          } else if (status === 401 || status === 403) {
            this.rest(model, 5 * 60_000);
          } else if (status === undefined || status >= 500) {
            this.rest(model, 5_000); // timeout, network or server trouble
          }
          // Other 4xx are about this request, not the model: no rest, just try the next one.
          this.opts.logger.warn({ model, status, err: (err as Error).message?.slice(0, 200) }, 'groq call failed');
        }
      }
      throw new LlmUnavailable(rateLimited === candidates.length ? 'rate_limited' : 'failed');
    } finally {
      this.inFlight--;
    }
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
