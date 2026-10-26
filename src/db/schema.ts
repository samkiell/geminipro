import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Mirrors docs/ARCHITECTURE.md section 6. Columns with a default are also NOT NULL.

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const users = pgTable('users', {
  telegramId: bigint('telegram_id', { mode: 'number' }).primaryKey(),
  username: text('username'),
  firstName: text('first_name'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
  blocked: boolean('blocked').notNull().default(false),
  // 'en' or 'pcm' (Nigerian Pidgin), guessed from what they write.
  lang: text('lang', { enum: ['en', 'pcm'] }).notNull().default('en'),
  // Referral program (Prompt D section 6): own 4 letter code, made on first use, and who invited them.
  refCode: text('ref_code').unique(),
  referredBy: bigint('referred_by', { mode: 'number' }),
});

// Human readable order numbers: GP-1001, GP-1002, ... (the uuid stays internal).
export const orderNoSeq = pgSequence('order_no_seq', { startWith: 1001 });

export const orderStatus = pgEnum('order_status', [
  'created',
  'awaiting_payment',
  'paid',
  'fulfilling',
  'partial',
  'delivered',
  'expired',
  'needs_attention',
  'refunded',
  'cancelled',
]);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderNo: text('order_no')
      .notNull()
      .unique()
      .default(sql`'GP-' || nextval('order_no_seq')`),
    telegramId: bigint('telegram_id', { mode: 'number' })
      .notNull()
      .references(() => users.telegramId),
    quantity: integer('quantity').notNull(),
    unitPriceNgn: integer('unit_price_ngn').notNull(),
    feeNgn: integer('fee_ngn').notNull().default(0),
    amountNgn: integer('amount_ngn').notNull(),
    status: orderStatus('status').notNull().default('created'),
    // 'referral_reward': a free link earned by inviting friends (amount 0, never takes a payment).
    source: text('source', { enum: ['purchase', 'referral_reward'] }).notNull().default('purchase'),
    // `gp_${id}`, sent to Bachs as the checkout reference
    paymentReference: text('payment_reference').notNull().unique(),
    checkoutId: text('checkout_id').unique(),
    checkoutUrl: text('checkout_url'),
    paidAt: timestamptz('paid_at'),
    expiresAt: timestamptz('expires_at'),
    deliveredAt: timestamptz('delivered_at'),
    nudgeSent: boolean('nudge_sent').notNull().default(false),
    // Chat messages kept in sync with the order (Telegram message ids in the buyer's chat).
    summaryMessageId: integer('summary_message_id'),
    payMessageId: integer('pay_message_id'),
    statusMessageId: integer('status_message_id'),
    reminderSentAt: timestamptz('reminder_sent_at'),
    activatedConfirmedAt: timestamptz('activated_confirmed_at'),
    fulfilLeaseUntil: timestamptz('fulfil_lease_until'),
    error: text('error'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at')
      .notNull()
      .defaultNow()
      .$onUpdate(() => sql`now()`),
  },
  (t) => [
    check('orders_quantity_check', sql`${t.quantity} > 0`),
    index('orders_status_updated_at_idx').on(t.status, t.updatedAt),
    index('orders_telegram_id_created_at_idx').on(t.telegramId, t.createdAt.desc()),
    // One unpaid order per user at a time, enforced by the database even under concurrent requests.
    uniqueIndex('orders_one_pending_per_user_idx')
      .on(t.telegramId)
      .where(sql`status in ('created', 'awaiting_payment')`),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    idx: integer('idx').notNull(),
    status: text('status', { enum: ['pending', 'completed', 'failed'] })
      .notNull()
      .default('pending'),
    // `${orderId}-${idx}`, sent to the reseller as X-Idempotency-Key
    idempotencyKey: text('idempotency_key').notNull().unique(),
    resellerOrderCode: text('reseller_order_code'),
    // Sensitive: never log this column.
    activationLink: text('activation_link'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    // Set once Telegram accepted a message containing this link.
    deliveredAt: timestamptz('delivered_at'),
    // The buyer tapped "i've activated it": the link is closed and never shown again.
    activatedAt: timestamptz('activated_at'),
    // Buyer chat messages that show this link, so closing it can edit every one of them.
    messageIds: integer('message_ids').array().notNull().default(sql`'{}'::integer[]`),
  },
  (t) => [unique('order_items_order_id_idx_unique').on(t.orderId, t.idx)],
);

export const events = pgTable(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    ref: text('ref'),
    payload: jsonb('payload'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    // Bachs delivers at least once; ref is the event id.
    uniqueIndex('events_bachs_webhook_ref_idx')
      .on(t.kind, t.ref)
      .where(sql`kind = 'bachs_webhook'`),
  ],
);

export const messages = pgTable('messages', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
  role: text('role').notNull(),
  content: text('content').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

// paused, last_low_balance_alert, etc.
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
});

// Business inquiries the agent saved (save_lead).
export const leads = pgTable('leads', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).notNull(),
  username: text('username'),
  summary: text('summary').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

// Proof screenshots (Prompt C section 6), seeded from assets/proof/ and added by admins with
// /addproof. file_id is Telegram's id after the first upload, so later sends are instant.
export const proofItems = pgTable('proof_items', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  // The file name in assets/proof/, or "tg:<file_unique_id>" for one an admin sent.
  key: text('key').notNull().unique(),
  fileId: text('file_id'),
  caption: text('caption'),
  position: integer('position').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

// Draft carts before payment (Prompt D section 2). Order numbers are only created when continuing.
export const orderDrafts = pgTable('order_drafts', {
  telegramId: bigint('telegram_id', { mode: 'number' }).primaryKey(),
  quantity: integer('quantity').notNull().default(1),
  messageId: integer('message_id'),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
});

// One row per invited friend, made when they first /start with a referral code. qualified_at is set
// when their first paid order is delivered, so a friend counts once however many links they buy.
export const referrals = pgTable(
  'referrals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    referrerId: bigint('referrer_id', { mode: 'number' })
      .notNull()
      .references(() => users.telegramId),
    referredId: bigint('referred_id', { mode: 'number' })
      .notNull()
      .unique()
      .references(() => users.telegramId),
    qualifiedAt: timestamptz('qualified_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('referrals_referrer_id_idx').on(t.referrerId)],
);

export type User = typeof users.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderStatus = (typeof orderStatus.enumValues)[number];
export type OrderItem = typeof orderItems.$inferSelect;
export type OrderDraft = typeof orderDrafts.$inferSelect;
export type NewOrderDraft = typeof orderDrafts.$inferInsert;
