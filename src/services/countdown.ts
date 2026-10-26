import { and, eq, isNotNull } from 'drizzle-orm';
import type { TelegramPort } from '../bot/telegram.js';
import { EXPIRED_TEXT, paymentCard, type UiFacts } from '../bot/views.js';
import type { Db } from '../db/client.js';
import { orders } from '../db/schema.js';
import type { Logger } from '../util/logger.js';
import { expireUnpaidOrders, setOrderMessages } from './orders.js';

// Section 4: Live payment countdown synced with Bachs.
// One scheduler loop (every 5 seconds) edits awaiting_payment cards every 30 seconds,
// and every 10 seconds in the final minute. The card shows WAT deadline and mm:ss left.
// Global edit rate limit (20 edits/sec), jitter, backoff on Telegram 429, ignores "message is not modified".

export interface CountdownDeps {
  db: Db;
  port: TelegramPort;
  facts: UiFacts;
  logger: Logger;
  onChange?: (orderId: string) => void;
  /** Loop interval in milliseconds. Default 5_000 (5s). */
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface CountdownRunner {
  start: () => void;
  stop: () => void;
  tick: () => Promise<number>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createCountdownRunner(deps: CountdownDeps): CountdownRunner {
  const { db, port, facts, logger } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const intervalMs = deps.intervalMs ?? 5_000;

  const lastEdited = new Map<string, number>();
  let backoffUntil = 0;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function tick(): Promise<number> {
    if (running) return 0;
    running = true;
    try {
      const currentNow = now();
      if (currentNow < backoffUntil) return 0;

      // Rebuild state from database on every tick: safe after restarts
      const active = await db
        .select()
        .from(orders)
        .where(and(eq(orders.status, 'awaiting_payment'), isNotNull(orders.summaryMessageId)));

      let updatedCount = 0;

      for (const order of active) {
        if (!order.summaryMessageId) continue;

        const expiresAt = order.expiresAt ?? new Date(currentNow + 15 * 60 * 1000);
        const remainingMs = expiresAt.getTime() - now();

        // Expired: edit card to expired copy and retire buttons
        if (remainingMs <= 0) {
          try {
            await port.edit(order.telegramId, order.summaryMessageId, {
              text: EXPIRED_TEXT,
              keyboard: undefined,
            });
            await setOrderMessages(db, order.id, { summaryMessageId: null, payMessageId: null });
            await expireUnpaidOrders(db, order.telegramId);
            deps.onChange?.(order.id);
            lastEdited.delete(order.id);
            updatedCount++;
          } catch (err: unknown) {
            logger.warn({ orderId: order.id, err: (err as Error).message }, 'failed to mark card expired');
          }
          continue;
        }

        const remainingSec = Math.floor(remainingMs / 1000);
        // Every 30s, or every 10s in the final minute
        const interval = remainingSec <= 60 ? 10_000 : 30_000;
        const last = lastEdited.get(order.id);
        if (last && now() - last < interval) {
          continue;
        }

        // Global edit rate limit: jitter / 50ms pause between edits (~20 edits/sec max)
        await sleep(50);

        const card = paymentCard({ order, facts, now: new Date(now()) });
        try {
          const result = await port.edit(order.telegramId, order.summaryMessageId, card);
          if (result === 'gone') {
            await setOrderMessages(db, order.id, { summaryMessageId: null, payMessageId: null });
            lastEdited.delete(order.id);
          } else if (result === 'ok') {
            lastEdited.set(order.id, now());
            updatedCount++;
          }
        } catch (err: unknown) {
          const status = (err as { status?: number })?.status;
          const retryAfter = (err as { parameters?: { retry_after?: number } })?.parameters?.retry_after;
          if (status === 429 && retryAfter) {
            backoffUntil = now() + retryAfter * 1000;
            logger.warn({ retryAfter }, 'telegram 429 during countdown tick, backing off');
            break;
          }
          const msg = (err as Error)?.message ?? '';
          if (msg.includes('message is not modified')) {
            lastEdited.set(order.id, now());
          } else {
            logger.warn({ orderId: order.id, err: msg }, 'failed to update countdown on payment card');
          }
        }
      }

      return updatedCount;
    } finally {
      running = false;
    }
  }

  return {
    start: () => {
      if (timer) return;
      void tick();
      timer = setInterval(() => {
        void tick().catch((err: unknown) => logger.error({ err }, 'countdown loop error'));
      }, intervalMs);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    tick,
  };
}
