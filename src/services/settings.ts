import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';

const PAUSED = 'paused';

/** Sales are paused by the owner (/pause) or automatically when the reseller rejects our API key. */
export async function isPaused(db: Db): Promise<boolean> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, PAUSED));
  return row?.value === true;
}

export async function setPaused(db: Db, paused: boolean): Promise<void> {
  await db
    .insert(settings)
    .values({ key: PAUSED, value: paused })
    .onConflictDoUpdate({ target: settings.key, set: { value: paused } });
}
