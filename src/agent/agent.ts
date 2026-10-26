import type Groq from 'groq-sdk';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'groq-sdk/resources/chat/completions';
import type { Logger } from '../util/logger.js';
import { naira } from './prompt.js';
import type { PayButton, ToolContext, ToolSet } from './tools.js';

// Tool calling loop (docs/ARCHITECTURE.md 5.1) on Groq's OpenAI-compatible chat API.

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CompletionClient {
  create(params: ChatCompletionCreateParamsNonStreaming, options: { timeout: number }): Promise<ChatCompletion>;
}

export function groqClient(groq: Groq): CompletionClient {
  return { create: (params, { timeout }) => groq.chat.completions.create(params, { timeout, maxRetries: 0 }) };
}

export interface AgentOptions {
  client: CompletionClient;
  /** GROQ_MODEL first, then GROQ_FALLBACK_MODELS, tried in order on any error or rate limit. */
  models: string[];
  tools: ToolSet;
  systemPrompt: string;
  logger: Logger;
  maxIterations?: number;
  timeoutMs?: number;
}

export interface AgentReply {
  /** Empty when every model failed: the caller sends a scripted fallback instead. */
  text: string;
  failed: boolean;
  payButton?: PayButton;
  toolCalls: { name: string; args: string; result: unknown }[];
  model?: string;
}

const TEMPERATURE = 0.4;
const MAX_TOKENS = 300;

/** Reasoning models spend completion tokens on thinking; keep it small so the reply fits. */
function modelParams(model: string): Partial<ChatCompletionCreateParamsNonStreaming> {
  if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'low' };
  if (model.startsWith('qwen/')) return { reasoning_format: 'hidden' };
  return {};
}

class AllModelsFailed extends Error {
  override name = 'AllModelsFailed';
}

async function complete(
  opts: AgentOptions,
  messages: ChatCompletionMessageParam[],
  toolChoice: 'auto' | 'none' | undefined,
): Promise<{ completion: ChatCompletion; model: string }> {
  for (const model of opts.models) {
    try {
      const completion = await opts.client.create(
        {
          model,
          messages,
          temperature: TEMPERATURE,
          max_tokens: MAX_TOKENS,
          ...(toolChoice && { tools: opts.tools.definitions, tool_choice: toolChoice }),
          ...modelParams(model),
        },
        { timeout: opts.timeoutMs ?? 20_000 },
      );
      return { completion, model };
    } catch (err) {
      const status = (err as { status?: number }).status;
      opts.logger.warn({ model, status, err: (err as Error).message }, 'groq call failed, trying the next model');
    }
  }
  throw new AllModelsFailed('every model failed');
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
  input: { history: ChatTurn[]; userText: string; ctx: ToolContext },
): Promise<AgentReply> {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: opts.systemPrompt },
    ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: input.userText },
  ];
  const toolCalls: AgentReply['toolCalls'] = [];
  const maxIterations = opts.maxIterations ?? 5;
  let text: string | undefined;
  let model: string | undefined;

  try {
    for (let i = 0; i < maxIterations && text === undefined; i++) {
      const step = await complete(opts, messages, 'auto');
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
      const step = await complete(opts, messages, 'none');
      model = step.model;
      text = step.completion.choices[0]?.message?.content ?? '';
    }
  } catch (err) {
    if (!(err instanceof AllModelsFailed)) throw err;
    opts.logger.error('all groq models failed; using the scripted fallback');
    return { text: '', failed: true, toolCalls, ...(input.ctx.payButton && { payButton: input.ctx.payButton }) };
  }

  const cleaned = cleanReply(text);
  if (cleaned !== text.trim()) opts.logger.info({ model }, 'cleaned dashes, urls or markdown out of an agent reply');
  if (!input.ctx.payButton && /pay now/i.test(cleaned)) {
    opts.logger.warn({ model }, 'agent mentioned pay now without creating a payment link');
  }
  return {
    text: cleaned,
    failed: cleaned === '',
    toolCalls,
    ...(model && { model }),
    ...(input.ctx.payButton && { payButton: input.ctx.payButton }),
  };
}

/** One short reminder for an unpaid order (docs/ARCHITECTURE.md 5.3). Template if the model fails. */
export async function writeNudge(
  opts: Pick<AgentOptions, 'client' | 'models' | 'logger' | 'timeoutMs'>,
  order: { quantity: number; totalNgn: number; minutesLeft: number },
): Promise<string> {
  const template = nudgeTemplate(order);
  const brief =
    `write one short, friendly, lowercase message (max 25 words) reminding a buyer that their payment link for ` +
    `${order.quantity} gemini pro link${order.quantity === 1 ? '' : 's'} (total ${naira(order.totalNgn)}) is still open ` +
    `for about ${order.minutesLeft} minutes, and that they can tap pay now below or ask a question. ` +
    `no em dashes, no urls, no pressure, no emojis.`;
  try {
    const { completion } = await complete(
      { ...opts, tools: { definitions: [], execute: async () => ({}) }, systemPrompt: '' },
      [{ role: 'user', content: brief }],
      undefined,
    );
    const text = cleanReply(completion.choices[0]?.message?.content ?? '');
    return text.length > 0 && text.length <= 200 ? text : template;
  } catch {
    return template;
  }
}

export function nudgeTemplate({ quantity, totalNgn, minutesLeft }: { quantity: number; totalNgn: number; minutesLeft: number }): string {
  const what = quantity === 1 ? 'your gemini pro link' : `your ${quantity} gemini pro links`;
  return `quick reminder, the payment for ${what} (${naira(totalNgn)}) is still open for about ${minutesLeft} minutes. tap pay now below, or ask me anything.`;
}
