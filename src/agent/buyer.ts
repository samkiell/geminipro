import { desc, eq, isNotNull, and } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { orders, users } from '../db/schema.js';
import { watDate } from '../bot/views.js';

// Light buyer memory (Prompt B section 5): who this is, in about 40 tokens, for every agent turn.

export type Lang = 'en' | 'pcm';

// Words that are distinctly Nigerian Pidgin (not just informal English).
const PIDGIN = [
  'abeg', 'wetin', 'una', 'dey', 'wan', 'oya', 'sabi', 'wahala', 'comot', 'sef', 'wey', 'shey', 'nawa',
  'abi', 'gats', 'pikin', 'waka', 'jare', 'ehn', 'dem', 'make i', 'i go', 'how far', 'no be', 'na im',
  'e don', 'i fit', 'e fit', 'no vex', 'carry go', 'chop',
];
const PIDGIN_RE = new RegExp(`(^|[^a-z])(${PIDGIN.join('|')})(?=$|[^a-z])`, 'i');

/** pcm when the message uses pidgin words; en for a plain english sentence; otherwise no signal. */
export function detectLang(text: string): Lang | undefined {
  if (PIDGIN_RE.test(text)) return 'pcm';
  return text.trim().split(/\s+/).length >= 4 ? 'en' : undefined;
}

/** Remembers the language the buyer writes in, when this message says something about it. */
export async function noteLanguage(db: Db, telegramId: number, text: string): Promise<void> {
  const lang = detectLang(text);
  if (lang) await db.update(users).set({ lang }).where(eq(users.telegramId, telegramId));
}

/** e.g. "buyer: tunde, returning, 2 paid orders, last GP-1042 delivered 26 oct. writes pidgin." */
export async function buyerContext(db: Db, telegramId: number): Promise<string> {
  return (await buyerMemory(db, telegramId)).line;
}

/** The buyer line, and their first name (so a reply that names them is never cached). */
export async function buyerMemory(db: Db, telegramId: number): Promise<{ line: string; firstName: string | null }> {
  const [user] = await db
    .select({ firstName: users.firstName, lang: users.lang })
    .from(users)
    .where(eq(users.telegramId, telegramId));
  const paid = await db
    .select({ orderNo: orders.orderNo, status: orders.status, createdAt: orders.createdAt })
    .from(orders)
    .where(and(eq(orders.telegramId, telegramId), isNotNull(orders.paidAt)))
    .orderBy(desc(orders.createdAt))
    .limit(20);

  const name = user?.firstName ? user.firstName.toLowerCase().slice(0, 20) : 'unknown name';
  const last = paid[0];
  const history =
    paid.length === 0
      ? 'new, no orders yet'
      : `returning, ${paid.length} paid order${paid.length === 1 ? '' : 's'}, last ${last?.orderNo} ${last?.status.replace('_', ' ')} ${last ? watDate(last.createdAt) : ''}`;
  return {
    line: `buyer: ${name}, ${history}. writes ${user?.lang === 'pcm' ? 'pidgin' : 'english'}.`,
    firstName: user?.firstName ?? null,
  };
}
