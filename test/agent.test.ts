import type { ChatCompletion } from 'groq-sdk/resources/chat/completions';
import { describe, expect, it } from 'vitest';
import { cleanReply, nudgeTemplate, runAgent, writeNudge } from '../src/agent/agent.js';
import { ModelPool, type CompletionParams, type LlmTransport } from '../src/agent/llm.js';
import { systemPrompt } from '../src/agent/prompt.js';
import { createTools, type AgentActions, type ToolContext } from '../src/agent/tools.js';
import { OWNER, OWNER_BLURB } from '../src/knowledge/owner.js';
import { createLogger } from '../src/util/logger.js';

const logger = createLogger({ level: 'silent' });

function completion(message: Record<string, unknown>): ChatCompletion {
  return {
    id: 'c',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content: '', ...message } }],
  } as unknown as ChatCompletion;
}
const answer = (content: string) => completion({ content });
const toolCall = (name: string, args: unknown, id = 'call_1') =>
  completion({ content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

function scriptedPool(steps: (ChatCompletion | Error)[], models = ['openai/gpt-oss-120b']) {
  const requests: CompletionParams[] = [];
  const transport: LlmTransport = {
    async create(params) {
      requests.push(structuredClone(params));
      const step = steps.shift();
      if (!step) throw new Error('script ran out');
      if (step instanceof Error) throw step;
      return { completion: step, headers: new Headers() };
    },
  };
  return { pool: new ModelPool(transport, models, { logger }), requests };
}

function fakeActions() {
  const calls: { name: string; args: unknown[] }[] = [];
  const record = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const actions: AgentActions = {
    getPrice: (quantity) => ({ quantity, baseNgn: 3500 * quantity, feeNgn: 0, totalNgn: 3500 * quantity, feeNote: 'fee at checkout' }),
    checkAvailability: async () => ({ canSell: true, maxQuantity: 10 }),
    buy: async (telegramId, quantity) => {
      record('buy', telegramId, quantity);
      return { ok: true, orderNo: 'GP-1001', quantity, totalNgn: 3500 * quantity, maxQuantity: 10 };
    },
    showHistory: async (telegramId) => void record('showHistory', telegramId),
    showOrder: async (telegramId, orderNo) => (record('showOrder', telegramId, orderNo), orderNo === 'GP-1001'),
    cancelPending: async (telegramId) => (record('cancelPending', telegramId), true),
    escalate: async (telegramId, username, reason) => void record('escalate', telegramId, username, reason),
    saveLead: async (telegramId, username, summary) => (record('saveLead', telegramId, username, summary), 'saved'),
    supportLocal: '08087357158',
    supportUrl: 'https://wa.me/2348087357158?text=hi',
  };
  return { actions, calls };
}

const ctx = (): ToolContext => ({ telegramId: 42, username: 'sam', attachments: [] });

async function run(steps: (ChatCompletion | Error)[], options: { models?: string[]; userText?: string; toolCtx?: ToolContext } = {}) {
  const { actions, calls } = fakeActions();
  const { pool, requests } = scriptedPool(steps, options.models);
  const toolCtx = options.toolCtx ?? ctx();
  const reply = await runAgent(
    { pool, tools: createTools(actions, { maxQtyPerOrder: 10 }), logger },
    { systemPrompt: 'system', history: [], userText: options.userText ?? 'hi', ctx: toolCtx },
  );
  return { reply, calls, requests, toolCtx };
}

describe('runAgent', () => {
  it('runs a tool, feeds the result back and returns the cleaned answer', async () => {
    const { reply, requests } = await run([toolCall('get_price', { quantity: 3 }), answer('3 links come to ₦10,500 — nice **deal** https://evil.example')]);
    expect(reply).toMatchObject({ failed: false, text: '3 links come to ₦10,500, nice deal', model: 'openai/gpt-oss-120b' });
    expect(JSON.parse(String((requests[1]?.messages.at(-1) as { content: string }).content))).toMatchObject({ totalNgn: 10_500 });
  });

  it('sends the tools with temperature 0.4, 300 tokens and low reasoning effort', async () => {
    const { requests } = await run([answer('hi')]);
    expect(requests[0]).toMatchObject({ temperature: 0.4, max_tokens: 300, tool_choice: 'auto', reasoning_effort: 'low' });
    expect(requests[0]?.tools?.map((t) => t.function?.name).sort()).toEqual([
      'cancel_pending_order',
      'check_availability',
      'create_payment_link',
      'escalate_to_support',
      'get_owner_info',
      'get_price',
      'save_lead',
      'show_history',
      'show_order',
    ]);
    expect(JSON.stringify(requests[0]?.tools)).not.toMatch(/telegram/i);
  });

  it('create_payment_link shows the card for the user in the update, once per turn, and returns no url', async () => {
    const { reply, calls, requests, toolCtx } = await run([
      toolCall('create_payment_link', { quantity: 2, telegram_id: 999 }),
      toolCall('create_payment_link', { quantity: 2 }, 'call_2'),
      answer('done, tap pay on the card above.'),
    ]);
    expect(calls).toEqual([{ name: 'buy', args: [42, 2] }]);
    expect(toolCtx.cardShown).toMatchObject({ ok: true, orderNo: 'GP-1001' });
    expect(reply.toolCalls[0]?.result).toEqual({ shown: true, orderNo: 'GP-1001', quantity: 2, totalNgn: 7000, feeNote: 'fee at checkout' });
    expect(reply.toolCalls[1]?.result).toMatchObject({ shown: true, note: 'the order card is already in the chat' });
    expect(JSON.stringify(requests)).not.toMatch(/https?:\/\//);
  });

  it('history and order tools render in code and return only whether they showed', async () => {
    const { reply, calls } = await run([
      toolCall('show_history', {}),
      toolCall('show_order', { orderNo: 'GP-1001' }, 'c2'),
      toolCall('show_order', { orderNo: 'GP-9' }, 'c3'),
      answer('here you go'),
    ]);
    expect(reply.toolCalls.map((c) => c.result)).toEqual([{ shown: true }, { shown: true }, { shown: false, error: 'order_not_found' }]);
    expect(calls.map((c) => c.name)).toEqual(['showHistory', 'showOrder', 'showOrder']);
  });

  it('owner info and support attach url buttons; leads are saved', async () => {
    const { reply, toolCtx, calls } = await run([
      toolCall('get_owner_info', { topic: 'identity' }),
      toolCall('escalate_to_support', { reason: 'dead link' }, 'c2'),
      toolCall('save_lead', { summary: 'wants a website for a bakery' }, 'c3'),
      answer('i was built by samkiel. tap below.'),
    ]);
    expect((reply.toolCalls[0]?.result as { text: string }).text).toBe(OWNER.identity.join('\n'));
    expect(toolCtx.attachments.flat().map((b) => b.text)).toEqual(['portfolio', 'github', 'linkedin', 'whatsapp support']);
    expect(calls.map((c) => c.name)).toEqual(['escalate', 'saveLead']);
  });

  it('returns invalid tool arguments to the model instead of acting on them', async () => {
    const { reply, calls } = await run([toolCall('create_payment_link', { quantity: 'lots' }), answer('how many?')]);
    expect(calls).toEqual([]);
    expect(reply.toolCalls[0]?.result).toMatchObject({ error: 'invalid_arguments' });
  });

  it('a rate limited model hands over to the next one', async () => {
    const limited = Object.assign(new Error('429'), { status: 429, headers: { 'retry-after': '30' } });
    const { reply, requests } = await run([limited, answer('hi from the fallback')], { models: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'] });
    expect(reply).toMatchObject({ failed: false, model: 'qwen/qwen3.8-27b' });
    expect(requests.map((r) => r.model)).toEqual(['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
    expect(requests[1]).toMatchObject({ reasoning_format: 'hidden' });
  });

  it('fails fast with the reason when every model is rate limited', async () => {
    const limited = () => Object.assign(new Error('429'), { status: 429, headers: { 'retry-after': '30' } });
    const { reply } = await run([limited(), limited()], { models: ['a', 'b'] });
    expect(reply).toMatchObject({ failed: true, failure: 'rate_limited', text: '' });
  });

  it('stops after 5 tool rounds and asks for a final answer without tools', async () => {
    const rounds = Array.from({ length: 5 }, (_, i) => toolCall('check_availability', {}, `call_${i}`));
    const { reply, requests } = await run([...rounds, answer('we have stock.')]);
    expect(reply.text).toBe('we have stock.');
    expect(requests).toHaveLength(6);
    expect(requests[5]?.tool_choice).toBe('none');
  });
});

describe('cleanReply', () => {
  it('replaces dashes, removes urls and markdown', () => {
    expect(cleanReply('sure — here: https://x.y/z and www.example.com ok')).toBe('sure, here: and ok');
    expect(cleanReply('1–2 days, **tap** `pay`')).toBe('1-2 days, tap pay');
  });
});

describe('writeNudge', () => {
  const order = { quantity: 2, totalNgn: 7000, minutesLeft: 4 };

  it('uses the model text, cleaned', async () => {
    const { pool } = scriptedPool([answer('your 2 links are still waiting — tap pay when ready')]);
    expect(await writeNudge(pool, order)).toBe('your 2 links are still waiting, tap pay when ready');
  });

  it('falls back to the template when the model fails or no model is free', async () => {
    const { pool } = scriptedPool([new Error('down')]);
    expect(await writeNudge(pool, order)).toBe(nudgeTemplate(order));
    expect(nudgeTemplate(order)).toBe(
      'quick reminder, the payment for your 2 gemini pro links (₦7,000) is still open for about 4 minutes. tap pay below, or ask me anything.',
    );
  });
});

describe('system prompt', () => {
  const facts = { unitPriceNgn: 3500, grossUp: false, supportLocal: '08087357158', maxQtyPerOrder: 10 };

  it('carries the offer text, the owner blurb and the buyer, and never a date', () => {
    const prompt = systemPrompt(facts, { offerText: 'offer ending very soon', buyer: 'buyer: tunde, returning, 2 paid orders. writes pidgin.' });
    expect(prompt).toContain('offer: offer ending very soon.');
    expect(prompt).toContain(OWNER_BLURB);
    expect(prompt).toContain('buyer: tunde, returning');
    expect(prompt).toMatch(/if the buyer writes pidgin \(.*\), reply in light pidgin/);
    expect(prompt).toContain('always under 300 characters');
    expect(prompt).toContain('replaced where possible, as soon as reported, but a replacement is not guaranteed');
    expect(prompt).not.toMatch(/\b20\d\d\b|29 oct|vpn/i);
    expect(prompt).not.toMatch(/[–—]/);
  });

  it('the owner blurb stays under 80 words', () => {
    expect(OWNER_BLURB.split(/\s+/).length).toBeLessThanOrEqual(80);
  });
});
