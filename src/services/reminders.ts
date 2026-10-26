import { and, eq, isNull, sql } from 'drizzle-orm';
import type { TelegramPort } from '../bot/telegram.js';
import { reminderMessage } from '../bot/views.js';
import type { Db } from '../db/client.js';
import { orders } from '../db/schema.js';
import type { Logger } from '../util/logger.js';

// One "did you activate your link?" reminder per delivered order (Prompt A section 11), never in
// quiet hours (23:00 to 07:00 WAT): those wait for the first run after 07:00.

const WAT_HOUR = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hourCycle: 'h23' });

export function isQuietHour(now: Date): boolean {
  const hour = Number(WAT_HOUR.format(now));
  return hour >= 23 || hour < 7;
}

export async function sendActivationReminders(deps: {
  db: Db;
  port: TelegramPort;
  logger: Logger;
  delayMinutes: number;
  now?: Date;
}): Promise<number> {
  const { db } = deps;
  if (isQuietHour(deps.now ?? new Date())) return 0;

  const due = await db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.status, 'delivered'),
        isNull(orders.reminderSentAt),
        isNull(orders.activatedConfirmedAt),
        sql`${orders.deliveredAt} < now() - make_interval(mins => ${deps.delayMinutes})`,
      ),
    )
    .limit(50);

  let sent = 0;
  for (const order of due) {
    const [claimed] = await db
      .update(orders)
      .set({ reminderSentAt: sql`now()` })
      .where(and(eq(orders.id, order.id), isNull(orders.reminderSentAt)))
      .returning();
    if (!claimed) continue;
    try {
      await deps.port.send(claimed.telegramId, reminderMessage(claimed));
      sent++;
    } catch (err) {
      deps.logger.warn({ orderId: claimed.id, err: (err as Error).message }, 'activation reminder not sent');
    }
  }
  return sent;
}
