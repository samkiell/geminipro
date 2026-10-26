import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { TelegramPort } from '../bot/telegram.js';
import { payLabel, type UiFacts } from '../bot/views.js';
import type { Db } from '../db/client.js';
import { orders } from '../db/schema.js';
import type { Logger } from '../util/logger.js';
import { naira } from './prompt.js';
import { saveTurn } from './history.js';

// Abandoned payment nudge (docs/ARCHITECTURE.md 5.3): one short follow up about 10 minutes after a
// payment link was issued and not paid, then never again for that order. Run by the reconciler.
// A fixed template, not the model: the model's quota is kept for buyers' messages.

export const NUDGE_AFTER_MINUTES = 5;

export interface NudgeDeps {
  db: Db;
  port: TelegramPort;
  facts: UiFacts;
  /** Default: nudgeTemplate. */
  write?: (order: { quantity: number; totalNgn: number; minutesLeft: number }) => Promise<string>;
  logger: Logger;
}

export async function sendPaymentNudges(deps: NudgeDeps): Promise<number> {
  const { db } = deps;
  const due = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.status, 'awaiting_payment'),
        eq(orders.nudgeSent, false),
        isNotNull(orders.checkoutUrl),
        sql`${orders.createdAt} < now() - make_interval(mins => ${NUDGE_AFTER_MINUTES})`,
        // Not worth a nudge in the last minute: the link would expire as they open it.
        sql`${orders.expiresAt} > now() + interval '1 minute'`,
      ),
    );

  let sent = 0;
  for (const order of due) {
    // Claim first, so two reconciler runs never nudge the same order twice.
    const [claimed] = await db
      .update(orders)
      .set({ nudgeSent: true })
      .where(and(eq(orders.id, order.id), eq(orders.nudgeSent, false), eq(orders.status, 'awaiting_payment')))
      .returning();
    if (!claimed?.checkoutUrl || !claimed.expiresAt) continue;

    const minutesLeft = Math.max(1, Math.floor((claimed.expiresAt.getTime() - Date.now()) / 60_000));
    const details = { quantity: claimed.quantity, totalNgn: claimed.amountNgn, minutesLeft };
    const text = deps.write ? await deps.write(details) : nudgeTemplate(details);
    try {
      // A plain link button: its job ends with the payment window, so nothing to retire later.
      await deps.port.send(claimed.telegramId, {
        text,
        keyboard: [[{ text: `pay ${payLabel(claimed, deps.facts)}`, url: claimed.checkoutUrl }]],
      });
      await saveTurn(db, claimed.telegramId, 'assistant', text);
      sent++;
    } catch (err) {
      deps.logger.warn({ orderId: claimed.id, err: (err as Error).message }, 'payment nudge not sent');
    }
  }
  return sent;
}

export function nudgeTemplate({ quantity, totalNgn, minutesLeft }: { quantity: number; totalNgn: number; minutesLeft: number }): string {
  const what = quantity === 1 ? 'your gemini pro link' : `your ${quantity} gemini pro links`;
  return `quick reminder, the payment for ${what} (${naira(totalNgn)}) is still open for about ${minutesLeft} minutes. tap pay below, or ask me anything.`;
}
