import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { messages } from '../db/schema.js';
import type { ChatTurn } from './decide.js';

/** Longest message kept for the model: short replies need only the gist of what came before. */
const MAX_TURN_CHARS = 200;

/** The last `count` messages (user and bot), oldest first. */
export async function loadHistory(db: Db, telegramId: number, count = 6): Promise<ChatTurn[]> {
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.telegramId, telegramId))
    .orderBy(desc(messages.id))
    .limit(count);
  return rows
    .reverse()
    .filter((row): row is ChatTurn => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({ role: row.role, content: row.content.slice(0, MAX_TURN_CHARS) }));
}

export async function saveTurn(db: Db, telegramId: number, role: ChatTurn['role'], content: string): Promise<void> {
  await db.insert(messages).values({ telegramId, role, content });
}
