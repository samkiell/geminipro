import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { settings } from '../db/schema.js';

const PAUSED = 'paused';
const OFFER_TEXT = 'offer_text';

/** Never a date: the offer end is announced with words the owner can change (/offertext). */
export const DEFAULT_OFFER_TEXT = 'offer ending very soon';

// offer_text is read on every agent turn, card and help page; a short cache keeps that off the DB.
const OFFER_CACHE_MS = 30_000;
const offerCache = new WeakMap<Db, { value: string; at: number }>();

/** Sales are paused by the owner (/pause) or automatically when the reseller rejects our API key. */
export async function isPaused(db: Db): Promise<boolean> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, PAUSED));
  return row?.value === true;
}

export async function setPaused(db: Db, paused: boolean): Promise<void> {
  await setSetting(db, PAUSED, paused);
}

export async function getOfferText(db: Db): Promise<string> {
  const hit = offerCache.get(db);
  if (hit && Date.now() - hit.at < OFFER_CACHE_MS) return hit.value;
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, OFFER_TEXT));
  const value = typeof row?.value === 'string' && row.value.trim() ? row.value : DEFAULT_OFFER_TEXT;
  offerCache.set(db, { value, at: Date.now() });
  return value;
}

export async function setOfferText(db: Db, text: string): Promise<void> {
  const value = text.trim().slice(0, 200);
  await setSetting(db, OFFER_TEXT, value);
  offerCache.set(db, { value, at: Date.now() });
}

export async function getSetting<T>(db: Db, key: string): Promise<T | undefined> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return (row?.value ?? undefined) as T | undefined;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
}
