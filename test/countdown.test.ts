import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { orders } from '../src/db/schema.js';
import { createCountdownRunner } from '../src/services/countdown.js';
import { createLogger } from '../src/util/logger.js';
import { createTestDb } from './helpers/db.js';
import { getOrder, insertOrder } from './helpers/orders.js';
import { facts, fakePort, type FakePort } from './helpers/telegram.js';

const logger = createLogger({ level: 'silent' });
let testDb: Awaited<ReturnType<typeof createTestDb>>;
let tg: FakePort;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});
beforeEach(async () => {
  await testDb.reset();
  tg = fakePort();
});

describe('live payment countdown (Section 4)', () => {
  it('updates card text with 12-hour WAT time and mm:ss remaining', async () => {
    let nowMs = new Date('2026-10-26T12:00:00Z').getTime(); // 13:00 WAT (1:00pm)
    const expiresAt = new Date(nowMs + 10 * 60 * 1000); // 13:10 WAT (1:10pm)
    const orderId = await insertOrder(testDb.db, {
      status: 'awaiting_payment',
      expiresAt,
      telegramId: 42,
    });
    const msgId = await tg.port.send(42, { text: 'initial payment card' });
    await testDb.db.update(orders).set({ summaryMessageId: msgId }).where(eq(orders.id, orderId));

    const runner = createCountdownRunner({
      db: testDb.db,
      port: tg.port,
      facts,
      logger,
      now: () => nowMs,
      sleep: async () => {},
    });

    // First tick updates the card
    const count = await runner.tick();
    expect(count).toBe(1);
    const text1 = tg.get(msgId)?.text;
    expect(text1).toContain('1:10pm wat');
    expect(text1).toContain('10:00 left');

    // 15 seconds later (> 60s left, 30s interval): should NOT edit yet
    nowMs += 15_000;
    expect(await runner.tick()).toBe(0);

    // 35 seconds later (total 35s since last edit): edits again
    nowMs += 20_000;
    expect(await runner.tick()).toBe(1);
    expect(tg.get(msgId)?.text).toContain('09:25 left');
  });

  it('in the final minute, ticks every 10 seconds', async () => {
    let nowMs = new Date('2026-10-26T12:00:00Z').getTime();
    const expiresAt = new Date(nowMs + 50 * 1000); // 50 seconds remaining (< 60s)
    const orderId = await insertOrder(testDb.db, {
      status: 'awaiting_payment',
      expiresAt,
      telegramId: 42,
    });
    const msgId = await tg.port.send(42, { text: 'initial payment card' });
    await testDb.db.update(orders).set({ summaryMessageId: msgId }).where(eq(orders.id, orderId));

    const runner = createCountdownRunner({
      db: testDb.db,
      port: tg.port,
      facts,
      logger,
      now: () => nowMs,
      sleep: async () => {},
    });

    // First tick in final minute
    expect(await runner.tick()).toBe(1);
    expect(tg.get(msgId)?.text).toContain('00:50 left');

    // 5 seconds later: should not edit yet (interval is 10s)
    nowMs += 5_000;
    expect(await runner.tick()).toBe(0);

    // 11 seconds later: edits again
    nowMs += 6_000;
    expect(await runner.tick()).toBe(1);
    expect(tg.get(msgId)?.text).toContain('00:39 left');
  });

  it('marks card expired at deadline and removes buttons', async () => {
    let nowMs = new Date('2026-10-26T12:00:00Z').getTime();
    const expiresAt = new Date(nowMs + 5_000);
    const orderId = await insertOrder(testDb.db, {
      status: 'awaiting_payment',
      expiresAt,
      telegramId: 42,
    });
    const msgId = await tg.port.send(42, { text: 'initial payment card', keyboard: [[{ text: 'cancel', data: 'x' }]] });
    await testDb.db.update(orders).set({ summaryMessageId: msgId }).where(eq(orders.id, orderId));

    let changedOrderId: string | undefined;
    const runner = createCountdownRunner({
      db: testDb.db,
      port: tg.port,
      facts,
      logger,
      now: () => nowMs,
      onChange: (id) => (changedOrderId = id),
      sleep: async () => {},
    });

    // First tick before expiry
    expect(await runner.tick()).toBe(1);

    // Advance past expiry
    nowMs += 6_000;
    expect(await runner.tick()).toBe(1);

    expect(tg.get(msgId)?.text).toBe(
      'expired ⌛ send /buy to start again. if you already paid, wait a minute, your link will still arrive.',
    );
    expect(tg.get(msgId)?.keyboard).toBeUndefined();
    expect((await getOrder(testDb.db, orderId)).status).toBe('expired');
    expect(changedOrderId).toBe(orderId);
  });

  it('stops editing when paid or cancelled', async () => {
    const nowMs = Date.now();
    const orderId = await insertOrder(testDb.db, {
      status: 'paid', // not awaiting_payment
      expiresAt: new Date(nowMs + 10 * 60 * 1000),
      telegramId: 42,
    });
    const msgId = await tg.port.send(42, { text: 'paid card' });
    await testDb.db.update(orders).set({ summaryMessageId: msgId }).where(eq(orders.id, orderId));

    const runner = createCountdownRunner({
      db: testDb.db,
      port: tg.port,
      facts,
      logger,
      now: () => nowMs,
      sleep: async () => {},
    });

    expect(await runner.tick()).toBe(0);
    expect(tg.get(msgId)?.text).toBe('paid card');
  });

  it('clears message id if message is gone in Telegram', async () => {
    const nowMs = Date.now();
    const orderId = await insertOrder(testDb.db, {
      status: 'awaiting_payment',
      expiresAt: new Date(nowMs + 10 * 60 * 1000),
      telegramId: 42,
    });
    // Set a nonexistent message ID
    await testDb.db.update(orders).set({ summaryMessageId: 99999 }).where(eq(orders.id, orderId));

    const runner = createCountdownRunner({
      db: testDb.db,
      port: tg.port,
      facts,
      logger,
      now: () => nowMs,
      sleep: async () => {},
    });

    expect(await runner.tick()).toBe(0);
    const refreshed = await getOrder(testDb.db, orderId);
    expect(refreshed.summaryMessageId).toBeNull();
  });
});
