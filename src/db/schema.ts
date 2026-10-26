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
});

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
    telegramId: bigint('telegram_id', { mode: 'number' })
      .notNull()
      .references(() => users.telegramId),
    quantity: integer('quantity').notNull(),
    unitPriceNgn: integer('unit_price_ngn').notNull(),
    feeNgn: integer('fee_ngn').notNull().default(0),
    amountNgn: integer('amount_ngn').notNull(),
    status: orderStatus('status').notNull().default('created'),
    // `gp_${id}`, sent to Bachs as the checkout reference
    paymentReference: text('payment_reference').notNull().unique(),
    checkoutId: text('checkout_id').unique(),
    checkoutUrl: text('checkout_url'),
    paidAt: timestamptz('paid_at'),
    expiresAt: timestamptz('expires_at'),
    deliveredAt: timestamptz('delivered_at'),
    nudgeSent: boolean('nudge_sent').notNull().default(false),
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

export type User = typeof users.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderStatus = (typeof orderStatus.enumValues)[number];
export type OrderItem = typeof orderItems.$inferSelect;
