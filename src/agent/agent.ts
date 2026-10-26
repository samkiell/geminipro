import type { ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions';
import type { Logger } from '../util/logger.js';
import { LlmUnavailable, type CompletionParams, type ModelPool } from './llm.js';
import { naira } from './prompt.js';
import type { ToolContext, ToolSet } from './tools.js';

// Tool calling loop (docs/ARCHITECTURE.md 5.1) on Groq's OpenAI-compatible chat API. Any model
// trouble (rate limit, busy, errors, too slow) ends the turn with failed: true, and the bot
// answers with a scripted reply instead, so buyers are never left waiting.

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentOptions {
  pool: ModelPool;
  tools: ToolSet;
  logger: Logger;
  maxIterations?: number;
  /** Whole turn, all model calls. Default 20s. */
  deadlineMs?: number;
}

export interface AgentReply {
  /** Empty when the turn failed: the caller sends a scripted reply instead. */
  text: string;
  failed: boolean;
  failure?: LlmUnavailable['reason'] | 'deadline' | 'empty';
  toolCalls: { name: string; args: string; result: unknown }[];
  model?: string;
}

const TEMPERATURE = 0.4;
const MAX_TOKENS = 300;

/** Reasoning models spend completion tokens on thinking; keep it small so the reply fits. */
function modelParams(model: string): Partial<CompletionParams> {
  if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'low' };
  if (model.startsWith('qwen/')) return { reasoning_format: 'hidden' };
  return {};
}

/**
 * Strips what must never reach a buyer from the model: URLs, dashes we do not use, and markdown
 * emphasis (replies are sent as plain text, so asterisks would show).
 */
export function cleanReply(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s*—\s*/g, ', ')
    .replace(/–/g, '-')
    .replace(/\bhttps?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?])/g, '$1')
    .trim();
}

export async function runAgent(
  opts: AgentOptions,
  input: { systemPrompt: string; history: ChatTurn[]; userText: string; ctx: ToolContext },
): Promise<AgentReply> {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: input.systemPrompt },
    ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: input.userText },
  ];
  const toolCalls: AgentReply['toolCalls'] = [];
  const deadline = Date.now() + (opts.deadlineMs ?? 20_000);
  const base = { temperature: TEMPERATURE, max_tokens: MAX_TOKENS, messages };
  let text: string | undefined;
  let model: string | undefined;

  try {
    for (let i = 0; i < (opts.maxIterations ?? 5) && text === undefined; i++) {
      if (Date.now() > deadline) return { text: '', failed: true, failure: 'deadline', toolCalls, ...(model && { model }) };
      const step = await opts.pool.complete({ ...base, tools: opts.tools.definitions, tool_choice: 'auto' }, modelParams);
      model = step.model;
      const message = step.completion.choices[0]?.message;
      const calls = message?.tool_calls ?? [];
      if (calls.length === 0) {
        text = message?.content ?? '';
        break;
      }
      // Only role, content and tool_calls go back: reasoning stays out of the transcript.
      messages.push({ role: 'assistant', content: message?.content ?? '', tool_calls: calls });
      for (const call of calls) {
        const result = await opts.tools.execute(call.function.name, call.function.arguments, input.ctx);
        toolCalls.push({ name: call.function.name, args: call.function.arguments, result });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    if (text === undefined) {
      // Out of tool rounds: ask for the answer with what it has.
      const step = await opts.pool.complete({ ...base, tools: opts.tools.definitions, tool_choice: 'none' }, modelParams);
      model = step.model;
      text = step.completion.choices[0]?.message?.content ?? '';
    }
  } catch (err) {
    if (!(err instanceof LlmUnavailable)) throw err;
    opts.logger.warn({ reason: err.reason, toolCalls: toolCalls.length }, 'agent turn falls back to a scripted reply');
    return { text: '', failed: true, failure: err.reason, toolCalls, ...(model && { model }) };
  }

  const cleaned = cleanReply(text);
  if (cleaned !== text.trim()) opts.logger.info({ model }, 'cleaned dashes, urls or markdown out of an agent reply');
  return { text: cleaned, failed: cleaned === '', ...(cleaned === '' && { failure: 'empty' }), toolCalls, ...(model && { model }) };
}

/** One short reminder for an unpaid order (docs/ARCHITECTURE.md 5.3). Template if no model is free. */
export async function writeNudge(
  pool: ModelPool,
  order: { quantity: number; totalNgn: number; minutesLeft: number },
): Promise<string> {
  const template = nudgeTemplate(order);
  if (!pool.available) return template;
  const brief =
    `write one short, friendly, lowercase message (max 25 words) reminding a buyer that their payment for ` +
    `${order.quantity} gemini pro link${order.quantity === 1 ? '' : 's'} (${naira(order.totalNgn)}) is still open ` +
    `for about ${order.minutesLeft} minutes, and that they can tap pay below or ask a question. ` +
    `no em dashes, no urls, no pressure, no emojis.`;
  try {
    const { completion } = await pool.complete(
      { temperature: TEMPERATURE, max_tokens: 120, messages: [{ role: 'user', content: brief }] },
      modelParams,
    );
    const text = cleanReply(completion.choices[0]?.message?.content ?? '');
    return text.length > 0 && text.length <= 200 ? text : template;
  } catch {
    return template;
  }
}

export function nudgeTemplate({ quantity, totalNgn, minutesLeft }: { quantity: number; totalNgn: number; minutesLeft: number }): string {
  const what = quantity === 1 ? 'your gemini pro link' : `your ${quantity} gemini pro links`;
  return `quick reminder, the payment for ${what} (${naira(totalNgn)}) is still open for about ${minutesLeft} minutes. tap pay below, or ask me anything.`;
}
