import type { ChatCompletion } from 'groq-sdk/resources/chat/completions';
import { describe, expect, it } from 'vitest';
import { LlmUnavailable, ModelPool, parseDuration, type LlmTransport } from '../src/agent/llm.js';
import { createLogger } from '../src/util/logger.js';

const logger = createLogger({ level: 'silent' });
const ok = { choices: [{ message: { role: 'assistant', content: 'hi' } }] } as unknown as ChatCompletion;
const rateLimit = (retryAfter: string) => Object.assign(new Error('429'), { status: 429, headers: { 'retry-after': retryAfter } });

function script(steps: Record<string, (Error | Record<string, string>)[]>) {
  const calls: string[] = [];
  const transport: LlmTransport = {
    async create(params) {
      calls.push(params.model);
      const next = steps[params.model]?.shift() ?? {};
      if (next instanceof Error) throw next;
      return { completion: ok, headers: new Headers(next) };
    },
  };
  return { transport, calls };
}

describe('parseDuration', () => {
  it('reads Groq reset times and retry-after seconds', () => {
    expect(parseDuration('34.875s')).toBe(34_875);
    expect(parseDuration('1m2.5s')).toBe(62_500);
    expect(parseDuration('48m57.6s')).toBe(2_937_600);
    expect(parseDuration('2h3m')).toBe(7_380_000);
    expect(parseDuration('120ms')).toBe(120);
    expect(parseDuration('7')).toBe(7_000);
    expect(parseDuration('soon')).toBeUndefined();
    expect(parseDuration(undefined)).toBeUndefined();
  });
});

describe('ModelPool', () => {
  it('uses the first model while it has budget', async () => {
    const { transport, calls } = script({});
    const pool = new ModelPool(transport, ['a', 'b'], { logger });
    expect((await pool.complete({ messages: [] })).model).toBe('a');
    expect(calls).toEqual(['a']);
  });

  it('after a 429 rests that model for the retry-after time and uses the next', async () => {
    let now = 1_000_000;
    const { transport, calls } = script({ a: [rateLimit('30')] });
    const pool = new ModelPool(transport, ['a', 'b'], { logger, now: () => now });
    expect((await pool.complete({ messages: [] })).model).toBe('b');
    expect(pool.usable()).toEqual(['b']);
    expect((await pool.complete({ messages: [] })).model).toBe('b');
    expect(calls).toEqual(['a', 'b', 'b']);
    now += 31_000;
    expect(pool.usable()).toEqual(['a', 'b']);
  });

  it('skips a model whose remaining tokens are too low until its reset', async () => {
    let now = 0;
    const { transport, calls } = script({
      a: [{ 'x-ratelimit-remaining-tokens': '1200', 'x-ratelimit-reset-tokens': '20s' }],
    });
    const pool = new ModelPool(transport, ['a', 'b'], { logger, minTokens: 2500, now: () => now });
    await pool.complete({ messages: [] });
    expect(pool.usable()).toEqual(['b']);
    await pool.complete({ messages: [] });
    expect(calls).toEqual(['a', 'b']);
    now += 21_000;
    expect(pool.usable()).toEqual(['a', 'b']);
  });

  it('skips a model whose daily requests are used up', async () => {
    const { transport } = script({ a: [{ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '2h' }] });
    const pool = new ModelPool(transport, ['a', 'b'], { logger });
    await pool.complete({ messages: [] });
    expect(pool.usable()).toEqual(['b']);
  });

  it('throws rate_limited at once, without a network call, when every model is resting', async () => {
    const { transport, calls } = script({ a: [rateLimit('60')], b: [rateLimit('60')] });
    const pool = new ModelPool(transport, ['a', 'b'], { logger });
    await expect(pool.complete({ messages: [] })).rejects.toMatchObject({ reason: 'rate_limited' });
    expect(calls).toEqual(['a', 'b']);
    expect(pool.available).toBe(false);

    const started = Date.now();
    await expect(pool.complete({ messages: [] })).rejects.toBeInstanceOf(LlmUnavailable);
    expect(Date.now() - started).toBeLessThan(20);
    expect(calls).toEqual(['a', 'b']);
  });

  it('a server error rests a model briefly; a bad request does not rest it', async () => {
    const { transport } = script({
      a: [Object.assign(new Error('boom'), { status: 503 })],
      b: [Object.assign(new Error('bad'), { status: 400 }), {}],
    });
    const pool = new ModelPool(transport, ['a', 'b'], { logger });
    await expect(pool.complete({ messages: [] })).rejects.toMatchObject({ reason: 'failed' });
    expect(pool.usable()).toEqual(['b']);
  });

  it('tries at most two models for one call', async () => {
    const down = () => Object.assign(new Error('boom'), { status: 503 });
    const { transport, calls } = script({ a: [down()], b: [down()], c: [{}] });
    const pool = new ModelPool(transport, ['a', 'b', 'c'], { logger });
    await expect(pool.complete({ messages: [] })).rejects.toMatchObject({ reason: 'failed' });
    expect(calls).toEqual(['a', 'b']);
  });

  it('beyond the in-flight limit a call waits briefly in the queue, then is refused as busy', async () => {
    const releases: (() => void)[] = [];
    const transport: LlmTransport = {
      create: () => new Promise((resolve) => releases.push(() => resolve({ completion: ok, headers: new Headers() }))),
    };
    const pool = new ModelPool(transport, ['a'], { logger, maxInFlight: 1, maxQueue: 1, queueWaitMs: 50 });
    const first = pool.complete({ messages: [] });
    const queued = pool.complete({ messages: [] });
    // the queue is full: refused at once
    await expect(pool.complete({ messages: [] })).rejects.toMatchObject({ reason: 'busy' });
    expect(pool.available).toBe(false);
    releases.shift()?.();
    await first;
    // the queued call got the slot as soon as it was free
    await new Promise((resolve) => setTimeout(resolve, 5));
    releases.shift()?.();
    expect((await queued).model).toBe('a');
    expect(pool.available).toBe(true);

    // a call that waits longer than queueWaitMs gives up
    const slow = pool.complete({ messages: [] });
    await expect(pool.complete({ messages: [] })).rejects.toMatchObject({ reason: 'busy' });
    releases.shift()?.();
    await slow;
  });

  it('reports every call with its latency and tokens, never the content', async () => {
    const records: unknown[] = [];
    const withUsage = { ...ok, usage: { prompt_tokens: 700, completion_tokens: 50, total_tokens: 750 } } as unknown as ChatCompletion;
    const transport: LlmTransport = { create: async () => ({ completion: withUsage, headers: new Headers() }) };
    let now = 0;
    const pool = new ModelPool(transport, ['a'], {
      logger,
      onCall: (c) => records.push(c),
      now: () => (now += 400),
    });
    await pool.complete({ messages: [] });
    expect(records).toEqual([{ model: 'a', ok: true, latencyMs: 400, promptTokens: 700, completionTokens: 50 }]);
  });
});
