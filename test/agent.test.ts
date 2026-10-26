import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'groq-sdk/resources/chat/completions';
import { describe, expect, it } from 'vitest';
import { cleanReply, nudgeTemplate, runAgent, writeNudge, type AgentOptions, type CompletionClient } from '../src/agent/agent.js';
import { fallbackReply, whatsappUrl } from '../src/agent/fallback.js';
import { spokenDate, systemPrompt } from '../src/agent/prompt.js';
import { createTools, type BuyerServices, type ToolContext } from '../src/agent/tools.js';
import { createLogger } from '../src/util/logger.js';

const logger = createLogger({ level: 'silent' });
const CHECKOUT_URL = 'https://sandbox-checkout.bachs.io/c/secret-checkout';

type Step = ChatCompletion | Error;

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

function scripted(steps: Step[]) {
  const requests: ChatCompletionCreateParamsNonStreaming[] = [];
  const client: CompletionClient = {
    create: async (params) => {
      requests.push(structuredClone(params));
      const step = steps.shift();
      if (!step) throw new Error('script ran out');
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return { client, requests };
}

function fakeServices() {
  const calls: { name: string; args: unknown[] }[] = [];
  const record = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const services: BuyerServices = {
    getPrice: (quantity) => (record('getPrice', quantity), { quantity, baseNgn: 3500 * quantity, feeNgn: 0, totalNgn: 3500 * quantity }),
    checkAvailability: async () => (record('checkAvailability'), { canSell: true, maxQuantity: 10 }),
    createPaymentLink: async (telegramId, quantity) => (
      record('createPaymentLink', telegramId, quantity),
      { ok: true, orderId: 'order-1', quantity, totalNgn: 3500 * quantity, expiresInMinutes: 15, checkoutUrl: CHECKOUT_URL }
    ),
    getMyOrders: async (telegramId) => (record('getMyOrders', telegramId), []),
    resendMyLinks: async (telegramId, orderId) => (record('resendMyLinks', telegramId, orderId), { sent: 1 }),
    cancelPendingOrder: async (telegramId) => (record('cancelPendingOrder', telegramId), { cancelled: true }),
    escalate: async (telegramId, reason) => (record('escalate', telegramId, reason), { supportWhatsapp: '08087357158' }),
  };
  return { services, calls };
}

function options(client: CompletionClient, services: BuyerServices, models = ['openai/gpt-oss-120b']): AgentOptions {
  return {
    client,
    models,
    tools: createTools(services, { maxQtyPerOrder: 10 }),
    systemPrompt: 'system',
    logger,
  };
}

const ctx = (): ToolContext => ({ telegramId: 42 });

describe('runAgent', () => {
  it('runs a tool, feeds the result back and returns the cleaned answer', async () => {
    const { services, calls } = fakeServices();
    const { client, requests } = scripted([
      toolCall('get_price', { quantity: 3 }),
      answer('3 links come to ₦10,500 — tap below https://evil.example/pay'),
    ]);
    const reply = await runAgent(options(client, services), { history: [], userText: 'how much for 3', ctx: ctx() });

    expect(reply).toMatchObject({ failed: false, text: '3 links come to ₦10,500, tap below', model: 'openai/gpt-oss-120b' });
    expect(reply.toolCalls.map((c) => c.name)).toEqual(['get_price']);
    expect(calls).toEqual([{ name: 'getPrice', args: [3] }]);
    const toolMessage = requests[1]?.messages.at(-1);
    expect(toolMessage).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(JSON.parse(String((toolMessage as { content: string }).content))).toEqual({
      quantity: 3,
      baseNgn: 10_500,
      feeNgn: 0,
      totalNgn: 10_500,
    });
  });

  it('sends history and the system prompt, with tools, temperature 0.4 and 300 tokens', async () => {
    const { services } = fakeServices();
    const { client, requests } = scripted([answer('hi')]);
    await runAgent(options(client, services), {
      history: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi, how can i help?' },
      ],
      userText: 'price?',
      ctx: ctx(),
    });
    const [request] = requests;
    expect(request?.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(request).toMatchObject({ temperature: 0.4, max_tokens: 300, tool_choice: 'auto', reasoning_effort: 'low' });
    expect(request?.tools?.map((t) => t.function?.name).sort()).toEqual([
      'cancel_pending_order',
      'check_availability',
      'create_payment_link',
      'escalate_to_support',
      'get_my_orders',
      'get_price',
      'resend_my_links',
    ]);
    expect(JSON.stringify(request?.tools)).not.toMatch(/telegram/i);
  });

  it('create_payment_link acts for the user in the update and keeps the checkout URL away from the model', async () => {
    const { services, calls } = fakeServices();
    const { client, requests } = scripted([
      toolCall('create_payment_link', { quantity: 2, telegram_id: 999 }),
      answer('done, 2 links for ₦7,000. tap pay now below.'),
    ]);
    const reply = await runAgent(options(client, services), { history: [], userText: 'i need 2', ctx: ctx() });

    expect(calls).toEqual([{ name: 'createPaymentLink', args: [42, 2] }]);
    expect(reply.payButton).toEqual({ orderId: 'order-1', url: CHECKOUT_URL, quantity: 2, totalNgn: 7000 });
    const toolContent = String((requests[1]?.messages.at(-1) as { content: string }).content);
    expect(JSON.parse(toolContent)).toEqual({ orderId: 'order-1', totalNgn: 7000, expiresInMinutes: 15 });
    expect(JSON.stringify(requests)).not.toContain(CHECKOUT_URL);
  });

  it('returns invalid tool arguments to the model instead of acting on them', async () => {
    const { services, calls } = fakeServices();
    const { client, requests } = scripted([toolCall('create_payment_link', { quantity: 'lots' }), answer('how many do you need?')]);
    await runAgent(options(client, services), { history: [], userText: 'buy lots', ctx: ctx() });
    expect(calls).toEqual([]);
    expect(JSON.parse(String((requests[1]?.messages.at(-1) as { content: string }).content))).toMatchObject({
      error: 'invalid_arguments',
    });
  });

  it('falls back to the next model when one errors or is rate limited', async () => {
    const { services } = fakeServices();
    const rateLimited = Object.assign(new Error('rate limited'), { status: 429 });
    const { client, requests } = scripted([rateLimited, answer('hi from the fallback')]);
    const reply = await runAgent(options(client, services, ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']), {
      history: [],
      userText: 'hi',
      ctx: ctx(),
    });
    expect(reply).toMatchObject({ failed: false, text: 'hi from the fallback', model: 'qwen/qwen3.8-27b' });
    expect(requests.map((r) => r.model)).toEqual(['openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
    expect(requests[1]).toMatchObject({ reasoning_format: 'hidden' });
  });

  it('reports failure when every model fails, keeping a pay button already created', async () => {
    const { services } = fakeServices();
    const down = new Error('down');
    const { client } = scripted([toolCall('create_payment_link', { quantity: 1 }), down, down]);
    const reply = await runAgent(options(client, services, ['a', 'b']), { history: [], userText: 'buy 1', ctx: ctx() });
    expect(reply.failed).toBe(true);
    expect(reply.text).toBe('');
    expect(reply.payButton?.url).toBe(CHECKOUT_URL);
  });

  it('stops after 5 tool rounds and asks for a final answer without tools', async () => {
    const { services } = fakeServices();
    const rounds = Array.from({ length: 5 }, (_, i) => toolCall('check_availability', {}, `call_${i}`));
    const { client, requests } = scripted([...rounds, answer('we have stock.')]);
    const reply = await runAgent(options(client, services), { history: [], userText: 'stock?', ctx: ctx() });
    expect(reply.text).toBe('we have stock.');
    expect(requests).toHaveLength(6);
    expect(requests[5]?.tool_choice).toBe('none');
  });
});

describe('cleanReply', () => {
  it('replaces em dashes and removes urls', () => {
    expect(cleanReply('sure — here: https://x.y/z and www.example.com ok')).toBe('sure, here: and ok');
    expect(cleanReply('1–2 days')).toBe('1-2 days');
  });
});

describe('writeNudge', () => {
  const order = { quantity: 2, totalNgn: 7000, minutesLeft: 4 };

  it('uses the model text, cleaned', async () => {
    const { client, requests } = scripted([answer('your 2 links are still waiting — tap pay now when ready')]);
    expect(await writeNudge({ client, models: ['m'], logger }, order)).toBe('your 2 links are still waiting, tap pay now when ready');
    expect(requests[0]?.tools).toBeUndefined();
  });

  it('falls back to the template when the model fails', async () => {
    const { client } = scripted([new Error('down')]);
    expect(await writeNudge({ client, models: ['m'], logger }, order)).toBe(nudgeTemplate(order));
    expect(nudgeTemplate(order)).toBe(
      'quick reminder, the payment for your 2 gemini pro links (₦7,000) is still open for about 4 minutes. tap pay now below, or ask me anything.',
    );
  });
});

describe('prompt and fallback', () => {
  const facts = { unitPriceNgn: 3500, grossUp: false, supportWhatsapp: '08087357158', offerDeadline: '2026-10-29', maxQtyPerOrder: 10 };

  it('the system prompt carries the facts from config and no em dashes', () => {
    const prompt = systemPrompt(facts);
    expect(prompt).toContain('3500 naira per link, plus a small payment fee');
    expect(prompt).toContain('whatsapp 08087357158');
    expect(prompt).toContain('closes 29 october 2026');
    expect(prompt).toContain('up to 10 links');
    expect(prompt).not.toMatch(/[–—]/);
    expect(spokenDate('2026-11-01')).toBe('1 november 2026');
  });

  it('scripted replies route by keyword and always offer buttons', () => {
    expect(fallbackReply('how much is it', facts).text).toContain('₦3,500 per link');
    expect(fallbackReply('where is my link', facts).text).toContain('/status');
    expect(fallbackReply('i want 2', facts).text).toContain('/buy 3');
    expect(fallbackReply('hello', facts).text).toContain('tap below');
    expect(fallbackReply('hello', facts).buttons.flat().map((b) => b.text)).toEqual(['buy 1 link', 'price', 'whatsapp support']);
    expect(whatsappUrl('08087357158')).toBe('https://wa.me/2348087357158');
  });
});
