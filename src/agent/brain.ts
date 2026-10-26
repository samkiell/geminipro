import type { Db } from '../db/client.js';
import { getOfferText } from '../services/settings.js';
import { buyerMemory } from './buyer.js';
import { decide, type DecideResult, type Decision } from './decide.js';
import { normalize } from './fastpath.js';
import { loadHistory } from './history.js';
import type { ModelPool } from './llm.js';
import { contextBlock, type PromptFacts, type TurnContext } from './prompt.js';

// Everything around the single model call: a 5 minute cache for repeated questions, a per buyer
// limit, then history, buyer memory and the context block (docs/ARCHITECTURE.md 5).

export type Availability = TurnContext['availability'];

export interface BrainDeps {
  db: Db;
  pool: ModelPool;
  facts: PromptFacts;
  /** Cached reseller state: what one buyer could order now. */
  availability: () => Promise<Availability>;
  /** Model messages per buyer per minute. Default 6. */
  perUserPerMinute?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

export type BrainResult = DecideResult | { ok: false; failure: 'limited' };

/** Intents whose answer does not depend on who asks: safe to reuse for the same words. */
const GENERIC = new Set<Decision['intent']>(['help', 'owner', 'shop', 'proof', 'support']);

/** Small LRU with a time limit: Map keeps insertion order, so the first key is the oldest. */
class TtlCache<V> {
  private readonly map = new Map<string, { value: V; at: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    if (this.now() - hit.at > this.ttlMs) return undefined;
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, at: this.now() });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}

export function createBrain(deps: BrainDeps) {
  const now = deps.now ?? Date.now;
  const cache = new TtlCache<Decision>(500, deps.cacheTtlMs ?? 5 * 60_000, now);
  const limit = deps.perUserPerMinute ?? 6;
  const recent = new Map<number, number[]>();

  /** Counts this message against the buyer's minute; false when they are over the limit. */
  function allow(telegramId: number): boolean {
    const t = now();
    const mine = (recent.get(telegramId) ?? []).filter((at) => t - at < 60_000);
    if (mine.length >= limit) return false;
    recent.set(telegramId, [...mine, t]);
    if (recent.size > 10_000) recent.clear();
    return true;
  }

  return {
    /** False when no model could take a call now: answer with a scripted reply straight away. */
    available: () => deps.pool.available,

    async decide(telegramId: number, userText: string): Promise<BrainResult & { cached?: boolean }> {
      // Self-contained questions only: "yes" or "3" mean something different in every chat.
      const key = normalize(userText);
      const cacheable = key.split(' ').length >= 3;
      const hit = cacheable ? cache.get(key) : undefined;
      if (hit) return { ok: true, decision: hit, model: 'cache', latencyMs: 0, cached: true };

      if (!allow(telegramId)) return { ok: false, failure: 'limited' };
      // Every model resting or the queue full: no point loading anything.
      if (!deps.pool.available) return { ok: false, failure: 'rate_limited' };
      const [history, offerText, memory, availability] = await Promise.all([
        loadHistory(deps.db, telegramId),
        getOfferText(deps.db),
        buyerMemory(deps.db, telegramId),
        deps.availability().catch((): Availability => ({ canSell: false, maxQuantity: 0, reason: 'stock unknown' })),
      ]);
      const result = await decide(deps.pool, {
        context: contextBlock(deps.facts, { offerText, availability, buyer: memory.line }),
        history,
        userText,
      });
      // Never cache a reply that names the buyer.
      const name = memory.firstName?.toLowerCase();
      if (result.ok && cacheable && GENERIC.has(result.decision.intent) && !(name && result.decision.reply.includes(name))) {
        cache.set(key, result.decision);
      }
      return result;
    },
  };
}

export type Brain = ReturnType<typeof createBrain>;
