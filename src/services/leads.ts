import { and, count, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { leads } from '../db/schema.js';
import type { Notify } from './notifier.js';

export const MAX_LEADS_PER_DAY = 3;

/** Saves a business inquiry ("can you build me a website") and tells the owner. */
export async function saveLead(
  db: Db,
  notify: Notify,
  lead: { telegramId: number; username: string | undefined; summary: string },
): Promise<'saved' | 'limited'> {
  const [today] = await db
    .select({ n: count() })
    .from(leads)
    .where(and(eq(leads.telegramId, lead.telegramId), sql`${leads.createdAt} > now() - interval '1 day'`));
  if ((today?.n ?? 0) >= MAX_LEADS_PER_DAY) return 'limited';

  const summary = lead.summary.trim().slice(0, 500);
  await db.insert(leads).values({ telegramId: lead.telegramId, username: lead.username ?? null, summary });
  notify({
    level: 'info',
    title: 'new lead',
    body: `${lead.username ? `@${lead.username}` : `Telegram user ${lead.telegramId}`}: ${summary}`,
  });
  return 'saved';
}

export async function latestLeads(db: Db, limit = 10) {
  return db.select().from(leads).orderBy(desc(leads.createdAt)).limit(limit);
}
