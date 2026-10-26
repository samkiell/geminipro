import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { messages } from '../db/schema.js';
import type { ChatTurn } from './agent.js';

/** Longest message kept for the model; Telegram allows 4096 characters. */
const MAX_TURN_CHARS = 1_000;

/** The last `turns` exchanges (a user message and the reply), oldest first. */
export async function loadHistory(db: Db, telegramId: number, turns = 10): Promise<ChatTurn[]> {
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.telegramId, telegramId))
    .orderBy(desc(messages.id))
    .limit(turns * 2);
  return rows
    .reverse()
    .filter((row): row is ChatTurn => row.role === 'user' || row.role === 'assistant')
    .map((row) => ({ role: row.role, content: row.content.slice(0, MAX_TURN_CHARS) }));
}

export async function saveTurn(db: Db, telegramId: number, role: ChatTurn['role'], content: string): Promise<void> {
  await db.insert(messages).values({ telegramId, role, content });
}
