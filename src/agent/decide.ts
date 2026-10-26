import type { ChatCompletionMessageParam } from 'groq-sdk/resources/chat/completions';
import { z } from 'zod';
import type { OwnerTopic } from '../knowledge/owner.js';
import { LlmUnavailable, type CompletionParams, type ModelPool } from './llm.js';
import { SYSTEM_PROMPT } from './prompt.js';

// One model call per buyer message (docs/ARCHITECTURE.md 5, the SKDL design): the model returns a
// small JSON decision, code validates it and acts. The model never sees or writes activation
// links, never confirms payments and cannot change prices: it only names an intent and a reply.

export const INTENTS = ['buy', 'price', 'history', 'show_order', 'proof', 'help', 'owner', 'shop', 'support', 'lead', 'chat'] as const;
export type Intent = (typeof INTENTS)[number];

/** What the model may ask about samkiel; 'shop' is its own intent. */
export const DECISION_TOPICS = ['identity', 'roles', 'projects', 'achievements', 'services', 'links'] as const satisfies readonly OwnerTopic[];
export type DecisionTopic = (typeof DECISION_TOPICS)[number];

export interface Decision {
  intent: Intent;
  quantity: number | null;
  orderNo: string | null;
  topic: DecisionTopic | null;
  summary: string | null;
  /** Cleaned: lowercase casual text, no links, no dashes, at most 240 characters. */
  reply: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export type DecideResult =
  | { ok: true; decision: Decision; model: string; latencyMs: number }
  | { ok: false; failure: LlmUnavailable['reason'] | 'invalid' };

export const MAX_REPLY_CHARS = 240;
const TEMPERATURE = 0.3;
const MAX_TOKENS = 160;

/** Reasoning models spend completion tokens thinking before the JSON: give them room for both. */
function modelParams(model: string): Partial<CompletionParams> {
  if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'low', max_completion_tokens: MAX_TOKENS + 320 };
  if (model.startsWith('qwen/')) return { reasoning_format: 'hidden', max_completion_tokens: MAX_TOKENS + 480 };
  return { max_completion_tokens: MAX_TOKENS };
}

const nullableText = z
  .string()
  .nullish()
  .transform((s) => (s && s.trim() ? s.trim().slice(0, 200) : null));

const decisionSchema = z.object({
  intent: z.enum(INTENTS),
  quantity: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((q) => {
      const n = typeof q === 'string' ? Number.parseInt(q, 10) : q;
      return typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : null;
    }),
  order_no: nullableText,
  topic: z
    .string()
    .nullish()
    .transform((t) => (DECISION_TOPICS as readonly string[]).includes(t ?? '') ? (t as DecisionTopic) : null),
  summary: nullableText,
  reply: z.string(),
});

/**
 * Strips what must never reach a buyer from the model: URLs, dashes we do not use, and markdown
 * (replies are plain text, so asterisks would show).
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

/** The bot writes in lowercase whatever the model sends; only the SAMKIEL brand and order numbers keep their capitals. */
export function lowercase(text: string): string {
  return text
    .split(/(SAMKIEL|GP-\d+)/)
    .map((part, i) => (i % 2 === 1 ? part : part.toLowerCase()))
    .join('');
}

/** At most `max` characters, cut after a sentence if one ends late enough, else at a word. */
export function clip(text: string, max = MAX_REPLY_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (sentence >= max / 2) return head.slice(0, sentence + 1);
  return head.slice(0, head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : max).replace(/[,;:]$/, '');
}

/** The JSON object in a completion; models sometimes wrap it in a code fence or a sentence. */
export function parseDecision(raw: string | null | undefined): Decision | undefined {
  if (!raw) return undefined;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const parsed = decisionSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const { order_no: orderNo, reply, ...rest } = parsed.data;
  return { ...rest, orderNo, reply: clip(lowercase(cleanReply(reply))) };
}

/** Last `count` messages, each cut to 200 characters: enough for "yes" or "3 please" to make sense. */
export function trimHistory(history: ChatTurn[], count = 6): ChatTurn[] {
  return history.slice(-count).map((t) => ({ role: t.role, content: t.content.slice(0, 200) }));
}

export async function decide(pool: ModelPool, input: { context: string; history: ChatTurn[]; userText: string }): Promise<DecideResult> {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...trimHistory(input.history),
    { role: 'system', content: `context:\n${input.context}` },
    { role: 'user', content: input.userText },
  ];
  try {
    const { completion, model, latencyMs } = await pool.complete(
      { messages, temperature: TEMPERATURE, response_format: { type: 'json_object' } },
      modelParams,
    );
    const decision = parseDecision(completion.choices[0]?.message?.content);
    if (!decision || (decision.intent === 'chat' && !decision.reply)) return { ok: false, failure: 'invalid' };
    return { ok: true, decision, model, latencyMs };
  } catch (err) {
    if (err instanceof LlmUnavailable) return { ok: false, failure: err.reason };
    throw err;
  }
}
