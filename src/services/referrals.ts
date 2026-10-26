import { randomInt } from 'node:crypto';
import { and, count, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { TelegramPort } from '../bot/telegram.js';
import type { Db } from '../db/client.js';
import { orders, referrals, users, type Order } from '../db/schema.js';
import type { Logger } from '../util/logger.js';
import type { Notify } from './notifier.js';
import { isUniqueViolation, reservedUnits } from './orders.js';
import type { ResellerClient } from './reseller.js';
import { isPaused } from './settings.js';

// Referral program (Prompt D section 6). Every REFERRAL_THRESHOLD friends whose first paid order
// is delivered earn the referrer one free link, up to REFERRAL_MAX_REWARDS. A reward is a normal
// order (source 'referral_reward', amount 0) bought and delivered by the fulfilment engine.
// Its payment_reference is `reward_<referrer>_<n>`, so reward n is created at most once.

export interface ReferralConfig {
  threshold: number;
  maxRewards: number;
  botUsername: string;
}

// Consonants only, so a code never spells a real (or rude) word.
export const REF_ALPHABET = 'bcdfghjkmnpqrstvwxz';
const REF_CODE = /^ref_([a-z]{4})$/i;

export function generateRefCode(pick: (max: number) => number = randomInt): string {
  return Array.from({ length: 4 }, () => REF_ALPHABET[pick(REF_ALPHABET.length)]).join('');
}

/** "ref_ABCD" -> "abcd"; anything else -> undefined. */
export function parseRefPayload(payload: string | undefined): string | undefined {
  const code = REF_CODE.exec(payload?.trim() ?? '')?.[1]?.toLowerCase();
  return code && [...code].every((c) => REF_ALPHABET.includes(c)) ? code : undefined;
}

export function referralLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=ref_${code}`;
}

export function rewardReference(referrerId: number, n: number): string {
  return `reward_${referrerId}_${n}`;
}

export function isReward(order: Pick<Order, 'source'>): boolean {
  return order.source === 'referral_reward';
}

/** The user's code, made on first use. */
export async function ensureRefCode(db: Db, telegramId: number): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const [user] = await db.select({ refCode: users.refCode }).from(users).where(eq(users.telegramId, telegramId));
    if (user?.refCode) return user.refCode;
    try {
      await db
        .insert(users)
        .values({ telegramId, refCode: generateRefCode() })
        .onConflictDoUpdate({ target: users.telegramId, set: { refCode: sql`coalesce(${users.refCode}, excluded.ref_code)` } });
    } catch (err) {
      // Someone else has that code: draw again.
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error('could not assign a referral code');
}

export type AttributionResult = 'attributed' | 'existing_user' | 'unknown_code' | 'self';

/**
 * Only a user's first ever /start counts, so existing users can never be claimed. Unknown codes
 * and self referral are ignored. referred_by is written once.
 */
export async function attributeReferral(db: Db, telegramId: number, code: string, isNewUser: boolean): Promise<AttributionResult> {
  if (!isNewUser) return 'existing_user';
  const [referrer] = await db.select({ id: users.telegramId }).from(users).where(eq(users.refCode, code));
  if (!referrer) return 'unknown_code';
  if (referrer.id === telegramId) return 'self';
  const [updated] = await db
    .update(users)
    .set({ referredBy: referrer.id })
    .where(and(eq(users.telegramId, telegramId), isNull(users.referredBy)))
    .returning({ id: users.telegramId });
  if (!updated) return 'existing_user';
  await db.insert(referrals).values({ referrerId: referrer.id, referredId: telegramId }).onConflictDoNothing();
  return 'attributed';
}

/**
 * Marks the friend's referral qualified when this is a delivered, paid (amount above zero),
 * not refunded purchase. Returns the referrer if this call made it qualify, once per friend.
 */
export async function qualifyReferral(db: Db, orderId: string): Promise<number | undefined> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order || order.status !== 'delivered' || isReward(order) || order.amountNgn <= 0 || !order.paidAt) return undefined;
  const [row] = await db
    .update(referrals)
    .set({ qualifiedAt: sql`now()` })
    .where(and(eq(referrals.referredId, order.telegramId), isNull(referrals.qualifiedAt)))
    .returning({ referrerId: referrals.referrerId });
  return row?.referrerId;
}

export interface ReferralProgress {
  /** Friends whose first paid order was delivered. */
  qualified: number;
  /** Reward orders created so far (delivered or still on the way). */
  granted: number;
  /** Rewards earned but not created yet. */
  due: number;
  capReached: boolean;
}

export async function referralProgress(db: Db, telegramId: number, cfg: Pick<ReferralConfig, 'threshold' | 'maxRewards'>): Promise<ReferralProgress> {
  const [[q], [g]] = await Promise.all([
    db
      .select({ n: count() })
      .from(referrals)
      .where(and(eq(referrals.referrerId, telegramId), isNotNull(referrals.qualifiedAt))),
    db
      .select({ n: count() })
      .from(orders)
      .where(and(eq(orders.telegramId, telegramId), eq(orders.source, 'referral_reward'))),
  ]);
  const qualified = q?.n ?? 0;
  const granted = g?.n ?? 0;
  const earned = Math.min(Math.floor(qualified / cfg.threshold), cfg.maxRewards);
  return { qualified, granted, due: Math.max(0, earned - granted), capReached: earned >= cfg.maxRewards };
}

/** Creates reward orders up to what is earned. Idempotent: reward n has a fixed reference. */
export async function createRewardOrders(db: Db, telegramId: number, cfg: Pick<ReferralConfig, 'threshold' | 'maxRewards'>): Promise<string[]> {
  const progress = await referralProgress(db, telegramId, cfg);
  const created: string[] = [];
  for (let n = progress.granted + 1; n <= progress.granted + progress.due; n++) {
    const [row] = await db
      .insert(orders)
      .values({
        telegramId,
        quantity: 1,
        unitPriceNgn: 0,
        amountNgn: 0,
        status: 'paid',
        source: 'referral_reward',
        paymentReference: rewardReference(telegramId, n),
        paidAt: sql`now()`,
      })
      .onConflictDoNothing({ target: orders.paymentReference })
      .returning({ id: orders.id });
    if (row) created.push(row.id);
  }
  return created;
}

export interface ReferralDeps {
  db: Db;
  port: TelegramPort;
  logger: Logger;
  notify: Notify;
  reseller: Pick<ResellerClient, 'getAvailability'>;
  fulfil: (orderId: string) => Promise<unknown>;
  config: ReferralConfig;
}

export function createReferrals(deps: ReferralDeps) {
  const { db, logger, config } = deps;

  /**
   * Creates and fulfils the rewards this referrer has earned. While sales are paused or the
   * reseller cannot cover them, nothing is created: the reconciler tries again and the admin
   * is told. A reward whose purchase fails stays a paid order the reconciler retries.
   */
  async function grantRewards(referrerId: number): Promise<number> {
    const { due } = await referralProgress(db, referrerId, config);
    if (due === 0) return 0;
    let blocked: string | undefined;
    if (await isPaused(db)) blocked = 'sales are paused';
    else {
      try {
        const { maxQuantity } = await deps.reseller.getAvailability(await reservedUnits(db));
        if (maxQuantity < due) blocked = 'not enough stock or balance';
      } catch {
        blocked = 'the reseller could not be reached';
      }
    }
    if (blocked) {
      deps.notify({
        level: 'warning',
        title: 'referral reward waiting',
        body: `Free referral links are due but not sent yet: ${blocked}. They go out automatically once this clears.`,
        cooldownKey: 'referral_reward_waiting',
      });
      return 0;
    }
    const created = await createRewardOrders(db, referrerId, config);
    for (const orderId of created) {
      logger.info({ orderId, referrerId }, 'referral reward created');
      await deps.fulfil(orderId);
    }
    return created.length;
  }

  /** Call after any order is delivered. */
  async function orderDelivered(orderId: string): Promise<void> {
    const referrerId = await qualifyReferral(db, orderId);
    if (referrerId === undefined) return;
    const progress = await referralProgress(db, referrerId, config);
    logger.info({ referrerId, qualified: progress.qualified }, 'referral qualified');
    // A separate event for the referrer, so one short message is allowed. Quiet once capped,
    // unless this friend just earned the last reward.
    if (!progress.capReached || progress.due > 0) {
      const inCycle = progress.qualified % config.threshold || config.threshold;
      const text =
        inCycle === config.threshold
          ? `${inCycle} of ${config.threshold} friends bought 🎉 your free link is on the way`
          : `${inCycle} of ${config.threshold} friends bought 🎉`;
      await deps.port.send(referrerId, { text }).catch((err: unknown) => logger.warn({ referrerId, err: (err as Error).message }, 'referral progress not sent'));
    }
    await grantRewards(referrerId);
  }

  /** Reconciler: grants rewards that were held back (paused, no stock, crash). */
  async function grantPending(): Promise<number> {
    const rows = await db
      .select({ referrerId: referrals.referrerId })
      .from(referrals)
      .where(isNotNull(referrals.qualifiedAt))
      .groupBy(referrals.referrerId)
      .having(sql`count(*) >= ${config.threshold}`);
    let granted = 0;
    for (const { referrerId } of rows) granted += await grantRewards(referrerId);
    return granted;
  }

  return { orderDelivered, grantRewards, grantPending };
}

export type Referrals = ReturnType<typeof createReferrals>;

export interface ReferralStats {
  qualified: number;
  rewardsGranted: number;
  /** Reward links actually bought from the reseller. */
  rewardLinks: number;
}

export async function referralStats(db: Db): Promise<ReferralStats> {
  const [[q], [r]] = await Promise.all([
    db.select({ n: count() }).from(referrals).where(isNotNull(referrals.qualifiedAt)),
    db
      .select({
        granted: sql<number>`count(*)::int`,
        links: sql<number>`(count(*) filter (where ${orders.status} = 'delivered'))::int`,
      })
      .from(orders)
      .where(eq(orders.source, 'referral_reward')),
  ]);
  return { qualified: q?.n ?? 0, rewardsGranted: r?.granted ?? 0, rewardLinks: r?.links ?? 0 };
}
