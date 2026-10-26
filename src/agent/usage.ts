import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';
import type { Notify } from '../services/notifier.js';
import { getSetting } from '../services/settings.js';
import { watDateKey } from '../services/stats.js';
import type { Logger } from '../util/logger.js';
import type { CallRecord } from './llm.js';

// Model usage per WAT day, for the daily summary, and an alert when buyers keep getting scripted
// replies (more than 5 in 5 minutes). Counters live in settings so a restart does not lose them.

export interface LlmUsage {
  /** Model attempts, successful or not. */
  calls: number;
  rateLimited: number;
  /** Messages answered with a scripted reply because the model was not available. */
  fallbacks: number;
  /** Messages answered from the fast path or the cache, with no model call. */
  free: number;
}

const key = (now: Date) => `llm_usage:${watDateKey(now)}`;

export async function readUsage(db: Db, now = new Date()): Promise<LlmUsage> {
  const stored = await getSetting<Partial<LlmUsage>>(db, key(now));
  return { calls: 0, rateLimited: 0, fallbacks: 0, free: 0, ...stored };
}

export function createUsage(deps: { db: Db; notify: Notify; logger: Logger; now?: () => Date; burst?: { max: number; windowMs: number } }) {
  const now = deps.now ?? (() => new Date());
  const burst = deps.burst ?? { max: 5, windowMs: 5 * 60_000 };
  let recent: number[] = [];
  const pending = new Set<Promise<unknown>>();

  function bump(field: keyof LlmUsage): void {
    const k = key(now());
    const write = deps.db
      .insert(settings)
      .values({ key: k, value: { [field]: 1 } })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: sql`coalesce(${settings.value}, '{}'::jsonb) || jsonb_build_object(${field}::text, coalesce((${settings.value}->>${field}::text)::int, 0) + 1)` },
      })
      .catch((err: unknown) => deps.logger.warn({ err }, 'llm usage not recorded'));
    pending.add(write);
    void write.finally(() => pending.delete(write));
  }

  return {
    /** Resolves when every counter written so far is stored (tests, shutdown). */
    settled: async () => {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    call(record: CallRecord): void {
      bump('calls');
      if (record.status === 429) bump('rateLimited');
    },
    free(): void {
      bump('free');
    },
    fallback(reason: string): void {
      bump('fallbacks');
      const t = now().getTime();
      recent = [...recent.filter((at) => t - at < burst.windowMs), t];
      if (recent.length > burst.max) {
        deps.notify({
          level: 'warning',
          title: 'buyers are getting scripted replies',
          body: `${recent.length} scripted replies in the last ${Math.round(burst.windowMs / 60_000)} minutes (last reason: ${reason}). Sales still work through the buttons. If it keeps happening, upgrade the Groq plan or check its limits page.`,
          cooldownKey: 'llm_fallbacks',
        });
      }
    },
  };
}

export type Usage = ReturnType<typeof createUsage>;
