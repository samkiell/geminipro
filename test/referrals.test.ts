import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFlows } from '../src/bot/flows.js';
import { historyList, inviteView } from '../src/bot/views.js';
import { orders, referrals, users } from '../src/db/schema.js';
import { fulfil, type FulfilmentDeps } from '../src/services/fulfilment.js';
import type { Alert } from '../src/services/notifier.js';
import { historyPage } from '../src/services/orders.js';
import {
  attributeReferral,
  createReferrals,
  ensureRefCode,
  generateRefCode,
  parseRefPayload,
  REF_ALPHABET,
  referralLink,
  referralProgress,
  referralStats,
  type ReferralConfig,
} from '../src/services/referrals.js';
import { computeAvailability, ResellerClient } from '../src/services/reseller.js';
import { setPaused } from '../src/services/settings.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { getOrder, insertOrder } from './helpers/orders.js';
import { facts, fakePort, type FakePort } from './helpers/telegram.js';
import { startMockReseller, type MockReseller } from './mocks/reseller-server.js';

const API_KEY = 'mock-key';
const REFERRER = 7;
const logger = createLogger({ level: 'silent' });
const config: ReferralConfig = { threshold: 3, maxRewards: 3, botUsername: 'geminiprosamkiel_bot' };

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let mock: MockReseller;
let tg: FakePort;
let alerts: Alert[];
let canSell: number;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(async () => {
  await testDb.reset();
  mock = await startMockReseller({ apiKey: API_KEY });
  tg = fakePort();
  alerts = [];
  canSell = 10;
});
afterEach(async () => {
  await mock.close();
});

function setup(overrides: Partial<ReferralConfig> = {}) {
  const cfg = { ...config, ...overrides };
  const fulfilmentDeps: FulfilmentDeps = {
    db: testDb.db,
    reseller: new ResellerClient({
      baseUrl: mock.url,
      apiKey: API_KEY,
      productId: 1,
      maxQtyPerOrder: 10,
      logger,
      timeoutMs: 1_000,
      backoffMs: 1,
      pollIntervalMs: 5,
      pendingTimeoutMs: 500,
    }),
    productId: 1,
    port: tg.port,
    facts,
    notify: (alert) => alerts.push(alert),
    logger,
    itemRetryDelaysMs: [1],
    onDelivered: (orderId) => refs.orderDelivered(orderId),
  };
  const refs = createReferrals({
    db: testDb.db,
    port: tg.port,
    logger,
    notify: (alert) => alerts.push(alert),
    reseller: {
      getAvailability: async (reserved) =>
        computeAvailability({ balanceCents: canSell * 120, priceCents: 120, stock: canSell, inStock: canSell > 0, reservedUnits: reserved, maxQtyPerOrder: 10 }),
    },
    fulfil: (orderId) => fulfil(fulfilmentDeps, orderId),
    config: cfg,
  });
  return { refs, run: (orderId: string) => fulfil(fulfilmentDeps, orderId) };
}

/** A friend who joined through the referrer's link. */
async function friend(id: number) {
  await testDb.db.insert(users).values({ telegramId: id }).onConflictDoNothing();
  const code = await ensureRefCode(testDb.db, REFERRER);
  expect(await attributeReferral(testDb.db, id, code, true)).toBe('attributed');
}

/** The friend buys and receives a paid order. */
async function friendBuys(run: (orderId: string) => Promise<unknown>, id: number) {
  const orderId = await insertOrder(testDb.db, { telegramId: id });
  await run(orderId);
  expect((await getOrder(testDb.db, orderId)).status).toBe('delivered');
  return orderId;
}

const rewardOrders = () => testDb.db.select().from(orders).where(eq(orders.source, 'referral_reward'));

describe('codes', () => {
  it('are 4 lowercase consonants, made once per user and kept', async () => {
    for (let i = 0; i < 50; i++) expect(generateRefCode()).toMatch(new RegExp(`^[${REF_ALPHABET}]{4}$`));
    const code = await ensureRefCode(testDb.db, REFERRER);
    expect(await ensureRefCode(testDb.db, REFERRER)).toBe(code);
    expect(referralLink('geminiprosamkiel_bot', code)).toBe(`https://t.me/geminiprosamkiel_bot?start=ref_${code}`);
  });

  it('parse case insensitively and reject anything else', () => {
    expect(parseRefPayload('ref_BCDF')).toBe('bcdf');
    expect(parseRefPayload('REF_bcdf')).toBe('bcdf');
    expect(parseRefPayload('ref_abcd')).toBeUndefined(); // vowels are never in a code
    expect(parseRefPayload('ref_bcd')).toBeUndefined();
    expect(parseRefPayload('')).toBeUndefined();
    expect(parseRefPayload(undefined)).toBeUndefined();
  });
});

describe('attribution', () => {
  it('only a new user is attributed, once; unknown codes and self referral are ignored', async () => {
    const code = await ensureRefCode(testDb.db, REFERRER);
    await testDb.db.insert(users).values([{ telegramId: 50 }, { telegramId: 51 }]);

    expect(await attributeReferral(testDb.db, 50, code, false)).toBe('existing_user');
    expect(await attributeReferral(testDb.db, 51, 'zzzz', true)).toBe('unknown_code');
    expect(await attributeReferral(testDb.db, REFERRER, code, true)).toBe('self');
    expect(await attributeReferral(testDb.db, 51, code, true)).toBe('attributed');
    // A second referrer cannot take the friend over.
    const other = await ensureRefCode(testDb.db, 8);
    expect(await attributeReferral(testDb.db, 51, other, true)).toBe('existing_user');

    const rows = await testDb.db.select().from(referrals);
    expect(rows).toEqual([expect.objectContaining({ referrerId: REFERRER, referredId: 51, qualifiedAt: null })]);
    const [user] = await testDb.db.select().from(users).where(eq(users.telegramId, 51));
    expect(user?.referredBy).toBe(REFERRER);
  });
});

describe('qualification and rewards', () => {
  it('a friend buying twice counts once, and 2 friends earn nothing', async () => {
    const { run } = setup();
    await friend(51);
    await friend(52);
    await friendBuys(run, 51);
    await friendBuys(run, 51);
    await friendBuys(run, 52);

    expect(await referralProgress(testDb.db, REFERRER, config)).toMatchObject({ qualified: 2, granted: 0, due: 0 });
    expect(await rewardOrders()).toHaveLength(0);
    expect(tg.textsTo(REFERRER)).toEqual(['1 of 3 friends bought 🎉', '2 of 3 friends bought 🎉']);
  });

  it('the 3rd friend earns exactly one free link, delivered with the reward header', async () => {
    const { run } = setup();
    for (const id of [51, 52, 53]) await friend(id);
    for (const id of [51, 52, 53]) await friendBuys(run, id);

    const rewards = await rewardOrders();
    expect(rewards).toHaveLength(1);
    expect(rewards[0]).toMatchObject({ telegramId: REFERRER, quantity: 1, amountNgn: 0, status: 'delivered' });
    expect(rewards[0]?.orderNo).toMatch(/^GP-\d+$/);

    const texts = tg.textsTo(REFERRER);
    expect(texts).toContain('3 of 3 friends bought 🎉 your free link is on the way');
    const delivery = texts.find((t) => t.startsWith('🎁 your free link'));
    expect(delivery).toMatch(/<code>https:\/\/mock-reseller\.local\/activate\/[0-9a-f]+<\/code>/);
    // No paid-order checklist for a free link.
    expect(texts.some((t) => t.includes('payment received'))).toBe(false);
  });

  it('a reward order never qualifies anyone, and the cap is respected', async () => {
    const { run } = setup({ maxRewards: 1 });
    // The referrer was themselves referred by 9: their free link must not count for 9.
    await testDb.db.insert(users).values([{ telegramId: 9 }, { telegramId: REFERRER }]);
    expect(await attributeReferral(testDb.db, REFERRER, await ensureRefCode(testDb.db, 9), true)).toBe('attributed');

    for (const id of [51, 52, 53, 54, 55, 56]) await friend(id);
    for (const id of [51, 52, 53, 54, 55, 56]) await friendBuys(run, id);

    expect(await rewardOrders()).toHaveLength(1);
    expect(await referralProgress(testDb.db, REFERRER, { threshold: 3, maxRewards: 1 })).toMatchObject({ qualified: 6, granted: 1, due: 0, capReached: true });
    expect(await referralProgress(testDb.db, 9, config)).toMatchObject({ qualified: 0 });
  });

  it('a reward whose purchase fails stays pending and is retried', async () => {
    const { run } = setup();
    for (const id of [51, 52, 53]) await friend(id);
    await friendBuys(run, 51);
    await friendBuys(run, 52);
    mock.failNthItem(4, 'supplier_purchase_failed'); // friend 53's purchase is the 3rd, the reward the 4th
    await friendBuys(run, 53);

    const [reward] = await rewardOrders();
    expect(reward?.status).toBe('needs_attention');
    expect(alerts.some((a) => a.title === 'free referral link not sent yet')).toBe(true);
    // The buyer is not told "payment confirmed" for a free link.
    expect(tg.textsTo(REFERRER).some((t) => t.startsWith('payment confirmed'))).toBe(false);

    mock.clearFailures();
    expect(await run(reward?.id ?? '')).toBe('delivered');
    expect(await rewardOrders()).toHaveLength(1);
  });

  it('while sales are paused nothing is created; the reconciler grants it later', async () => {
    const { run, refs } = setup();
    for (const id of [51, 52, 53]) await friend(id);
    for (const id of [51, 52]) await friendBuys(run, id);
    await setPaused(testDb.db, true);
    await friendBuys(run, 53);

    expect(await rewardOrders()).toHaveLength(0);
    expect(alerts.some((a) => a.title === 'referral reward waiting')).toBe(true);

    await setPaused(testDb.db, false);
    expect(await refs.grantPending()).toBe(1);
    expect(await refs.grantPending()).toBe(0);
    expect((await rewardOrders())[0]?.status).toBe('delivered');
    expect(await referralStats(testDb.db)).toEqual({ qualified: 3, rewardsGranted: 1, rewardLinks: 1 });
  });

  it('no stock: the reward waits instead of failing', async () => {
    const { run, refs } = setup();
    for (const id of [51, 52, 53]) await friend(id);
    for (const id of [51, 52]) await friendBuys(run, id);
    canSell = 0;
    await friendBuys(run, 53);
    expect(await rewardOrders()).toHaveLength(0);

    canSell = 10;
    expect(await refs.grantPending()).toBe(1);
  });

  it('the reward order appears in /history as a free link', async () => {
    const { run } = setup();
    for (const id of [51, 52, 53]) await friend(id);
    for (const id of [51, 52, 53]) await friendBuys(run, id);

    const page = await historyPage(testDb.db, REFERRER, 1);
    expect(page.orders).toHaveLength(1);
    const view = historyList({ ...page, page: 1 });
    expect(view.keyboard?.[0]?.[0]?.text).toContain('free link 🎁');
  });
});

describe('/invite card', () => {
  const base = { link: 'https://t.me/geminiprosamkiel_bot?start=ref_bcdf', threshold: 3, maxRewards: 3 };

  it('shows progress, earned links and the tap-to-copy link', () => {
    const view = inviteView({ ...base, qualified: 2, earned: 0, capReached: false });
    expect(view.text).toBe(
      [
        'invite 3 friends who buy a link and get 1 free link 🎁',
        'progress: ▰▰▱ 2 of 3 friends have bought',
        'free links earned: 0',
        'your link, tap to copy:',
        '<code>https://t.me/geminiprosamkiel_bot?start=ref_bcdf</code>',
      ].join('\n'),
    );
    expect(view.html).toBe(true);
    const [share, orders] = view.keyboard ?? [];
    expect(share?.[0]).toEqual({
      text: 'share with friends',
      url: `https://t.me/share/url?url=${encodeURIComponent(base.link)}&text=${encodeURIComponent('get google ai pro for 18 months, delivered on telegram 👇')}`,
    });
    expect(orders?.[0]).toEqual({ text: 'my orders', data: 'h:1' });
  });

  it('starts a new cycle after each reward, and says so plainly at the cap', () => {
    expect(inviteView({ ...base, qualified: 4, earned: 1, capReached: false }).text).toContain('progress: ▰▱▱ 1 of 3 friends have bought\nfree links earned: 1');
    const capped = inviteView({ ...base, qualified: 9, earned: 3, capReached: true }).text;
    expect(capped).toContain("you've earned the most free links (3) 🎉");
    expect(capped).not.toContain('progress');
  });

  it('/invite makes the code lazily and edits in place from the help hub', async () => {
    const flows = createFlows({
      db: testDb.db,
      port: tg.port,
      logger,
      reseller: { getAvailability: async () => ({ canSell: true, maxQuantity: 10 }) as never },
      payments: { createCheckout: async () => ({ checkoutId: 'c', checkoutUrl: 'https://pay.test', expiresAt: undefined }) },
      pricing: { unitPriceNgn: 3500, grossUp: false, feePct: 0.02, feeFlat: 0 },
      facts,
      salesCutoff: undefined,
      returnUrl: undefined,
      notify: () => {},
      referral: config,
    });
    await flows.showHelp(REFERRER, 'hub');
    const hub = tg.sent[0];
    await flows.showInvite(REFERRER, hub?.id);
    expect(tg.sent).toHaveLength(1);
    const code = await ensureRefCode(testDb.db, REFERRER);
    expect(tg.get(hub?.id)?.text).toContain(`<code>https://t.me/geminiprosamkiel_bot?start=ref_${code}</code>`);
    expect(tg.get(hub?.id)?.text).toContain('0 of 3 friends have bought');
  });
});
