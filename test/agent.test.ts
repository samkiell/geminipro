import Groq from 'groq-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanReply, clip, decide, parseDecision, trimHistory, type ChatTurn } from '../src/agent/decide.js';
import { groqTransport, ModelPool, type CallRecord } from '../src/agent/llm.js';
import { contextBlock, SYSTEM_PROMPT } from '../src/agent/prompt.js';
import { OWNER_BLURB } from '../src/knowledge/owner.js';
import { createLogger } from '../src/util/logger.js';
import { decisionJson, startMockGroq, type MockGroq } from './mocks/groq-server.js';

// The single call decision contract (Prompt C), through the real groq-sdk against a mock server.

const logger = createLogger({ level: 'silent' });
const facts = { unitPriceNgn: 3500, grossUp: false, supportLocal: '08087357158', maxQtyPerOrder: 10 };
const context = contextBlock(facts, {
  offerText: 'offer ending very soon',
  availability: { canSell: true, maxQuantity: 10 },
  buyer: 'buyer: tunde, new, no orders yet. writes english.',
});

let groq: MockGroq;
let calls: CallRecord[];

beforeEach(async () => {
  groq = await startMockGroq();
  calls = [];
});
afterEach(async () => {
  await groq.close();
});

function pool(models = ['fast', 'smart', 'spare'], timeoutMs = 6_000) {
  const client = new Groq({ apiKey: 'test-key', baseURL: groq.url, maxRetries: 0 });
  return new ModelPool(groqTransport(client), models, { logger, timeoutMs, onCall: (c) => calls.push(c) });
}

const ask = (p: ModelPool, userText: string, history: ChatTurn[] = []) => decide(p, { context, history, userText });

describe('decide: one call, one JSON decision', () => {
  it('a valid decision comes back cleaned, from one call with the static prompt first and the context last', async () => {
    groq.respond(() => ({ content: decisionJson({ intent: 'buy', quantity: 3, reply: 'sure — 3 links coming up, see https://x.test' }) }));
    const history: ChatTurn[] = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}:${'x'.repeat(300)}` }));
    const result = await ask(pool(), 'i need 3 links', history);

    expect(result).toMatchObject({ ok: true, model: 'fast', decision: { intent: 'buy', quantity: 3, reply: 'sure, 3 links coming up, see' } });
    expect(groq.requests).toHaveLength(1);
    const [req] = groq.requests;
    expect(req?.messages[0]).toEqual({ role: 'system', content: SYSTEM_PROMPT });
    expect(req?.messages.at(-2)).toEqual({ role: 'system', content: `context:\n${context}` });
    expect(req?.messages.at(-1)).toEqual({ role: 'user', content: 'i need 3 links' });
    // last 6 messages of history, each cut to 200 characters
    const past = req?.messages.slice(1, -2) ?? [];
    expect(past).toHaveLength(6);
    expect(past.every((m) => m.content.length <= 200)).toBe(true);
    expect(req).toMatchObject({ temperature: 0.3, response_format: { type: 'json_object' } });
    expect(req?.tools).toBeUndefined();
    expect(calls).toEqual([{ model: 'fast', ok: true, latencyMs: expect.any(Number), promptTokens: 700, completionTokens: 60 }]);
  });

  it('invalid JSON, an unknown intent or an empty chat reply means the scripted fallback', async () => {
    const p = pool();
    groq.respond(() => ({ content: 'sure! how many links do you want?' }));
    expect(await ask(p, 'hi')).toEqual({ ok: false, failure: 'invalid' });
    groq.respond(() => ({ content: decisionJson({ intent: 'refund_everyone' }) }));
    expect(await ask(p, 'hi')).toEqual({ ok: false, failure: 'invalid' });
    groq.respond(() => ({ content: decisionJson({ intent: 'chat', reply: '   ' }) }));
    expect(await ask(p, 'hi')).toEqual({ ok: false, failure: 'invalid' });
  });

  it('a 429 rests that model for its retry-after and the next model answers at once', async () => {
    groq.respond((req) => (req.model === 'fast' ? { status: 429, headers: { 'retry-after': '30' } } : { content: decisionJson({}) }));
    const p = pool();
    expect(await ask(p, 'hello there friend')).toMatchObject({ ok: true, model: 'smart' });
    expect(p.usable()).toEqual(['smart', 'spare']);
    // cooling down: the next message does not touch the resting model at all
    expect(await ask(p, 'hello again friend')).toMatchObject({ ok: true, model: 'smart' });
    expect(groq.requests.map((r) => r.model)).toEqual(['fast', 'smart', 'smart']);
    expect(calls.filter((c) => c.status === 429)).toHaveLength(1);
  });

  it('a model slower than the timeout loses to the next one', async () => {
    groq.respond((req) => (req.model === 'fast' ? { delayMs: 400, then: { content: decisionJson({}) } } : { content: decisionJson({ reply: 'from smart' }) }));
    const result = await ask(pool(['fast', 'smart'], 150), 'hello there friend');
    expect(result).toMatchObject({ ok: true, model: 'smart', decision: { reply: 'from smart' } });
  });

  it('at most two models per message; then rate_limited, and no call at all while they rest', async () => {
    groq.respond(() => ({ status: 429, headers: { 'retry-after': '60' } }));
    const p = pool();
    expect(await ask(p, 'hello there friend')).toEqual({ ok: false, failure: 'rate_limited' });
    expect(groq.requests.map((r) => r.model)).toEqual(['fast', 'smart']);
    // 'spare' is still free, so a second message tries it
    expect(await ask(p, 'hello again')).toEqual({ ok: false, failure: 'rate_limited' });
    expect(groq.requests.map((r) => r.model)).toEqual(['fast', 'smart', 'spare']);
    // now all three rest: no request is made
    expect(await ask(p, 'and again')).toEqual({ ok: false, failure: 'rate_limited' });
    expect(groq.requests).toHaveLength(3);
  });
});

describe('parseDecision', () => {
  it('accepts a fenced object, numbers as strings, and drops unknown topics', () => {
    const raw = '```json\n{"intent":"owner","quantity":"2","order_no":" GP-1042 ","topic":"secrets","summary":"","reply":"he builds apps"}\n```';
    expect(parseDecision(raw)).toEqual({ intent: 'owner', quantity: 2, orderNo: 'GP-1042', topic: null, summary: null, reply: 'he builds apps' });
    expect(parseDecision('{"intent":"price"}')).toBeUndefined(); // no reply
    expect(parseDecision(null)).toBeUndefined();
  });

  it('replies are lowercase whatever the model sends, brand and order numbers aside', () => {
    expect(parseDecision(JSON.stringify(decisionJson({ reply: 'Samkiel is CEO of SAMKIEL in Nigeria, see GP-1042' })))?.reply).toBe(
      'samkiel is ceo of SAMKIEL in nigeria, see GP-1042',
    );
  });

  it('replies are cut to 240 characters, after a sentence when possible', () => {
    const long = `${'a'.repeat(150)}. ${'b'.repeat(200)}`;
    expect(clip(long)).toBe(`${'a'.repeat(150)}.`);
    expect(clip('word '.repeat(80)).length).toBeLessThanOrEqual(240);
    expect(cleanReply('sure — here: https://x.y/z and www.example.com ok')).toBe('sure, here: and ok');
    expect(cleanReply('1–2 days, **tap** `pay`')).toBe('1-2 days, tap pay');
  });

  it('history keeps the last 6 messages, 200 characters each', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: `${i}`.repeat(500) }));
    expect(trimHistory(history).map((t) => [t.content[0], t.content.length])).toEqual([
      ['4', 200],
      ['5', 200],
      ['6', 200],
      ['7', 200],
      ['8', 200],
      ['9', 200],
    ]);
  });
});

describe('prompt', () => {
  it('the static prompt is small, honest, has no prices or dates, and keeps the owner blurb', () => {
    expect(SYSTEM_PROMPT.length).toBeLessThan(2_400); // about 600 tokens
    expect(SYSTEM_PROMPT).toContain(OWNER_BLURB);
    expect(SYSTEM_PROMPT).toContain('never claim to be samkiel, google or jio, or that the shop is official or affiliated with them');
    expect(SYSTEM_PROMPT).toContain('replaced where possible, not guaranteed');
    expect(SYSTEM_PROMPT).toContain('in english unless they write pidgin, then light pidgin');
    expect(SYSTEM_PROMPT).not.toMatch(/₦|\b20\d\d\b|29 oct|vpn|card 2%|1\.5%/i);
    expect(SYSTEM_PROMPT).not.toMatch(/[–—]/);
    expect(OWNER_BLURB.split(/\s+/).length).toBeLessThanOrEqual(80);
  });

  it('the context block carries price, stock, offer and the buyer, last and short', () => {
    expect(context).toBe(
      [
        'price: ₦3,500 + fee per link, up to 10 per order.',
        'stock: can sell up to 10 now. offer: offer ending very soon.',
        'support: whatsapp 08087357158.',
        'buyer: tunde, new, no orders yet. writes english.',
      ].join('\n'),
    );
    const soldOut = contextBlock(facts, { offerText: 'x', availability: { canSell: false, maxQuantity: 0, reason: 'sales are paused' }, buyer: '' });
    expect(soldOut).toContain('cannot sell right now (sales are paused)');
  });
});
