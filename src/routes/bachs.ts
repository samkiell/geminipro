import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { events, type Order } from '../db/schema.js';
import type { CheckoutSession } from '../services/bachs.js';
import type { Notify } from '../services/notifier.js';
import { findOrderForPayment, holdPayment, markPaid, PAYABLE } from '../services/orders.js';
import type { PaymentProvider } from '../services/payments.js';

export interface BachsWebhookOptions {
  db: Db;
  /** Without a webhook secret no delivery can be verified: every one gets 503 and is retried later. */
  payments: Pick<PaymentProvider, 'verifyPayment' | 'verifyWebhook' | 'webhookConfigured'>;
  notify: Notify;
  /** Called once per order, after it becomes paid. Runs after the response is sent. */
  onPaid: (orderId: string) => Promise<void> | void;
  /** Called after this route changed an order (paid or held), to refresh the buyer's chat. */
  onChange?: (orderId: string) => void;
}

// Both mean "this checkout was paid"; either can arrive first, and each can arrive more than once.
const PAID_EVENTS = new Set(['checkout.completed', 'collection.succeeded']);
const EVENT_KIND = 'bachs_webhook';

const envelopeSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  data: z
    .object({
      checkout_id: z.string().nullish(),
      reference: z.string().nullish(),
    })
    .nullish(),
});
type Envelope = z.infer<typeof envelopeSchema>;

// Bachs retries 5xx (and timeouts) for about 80 minutes, and stops on any other 4xx.
interface Outcome {
  status: 200 | 503;
  result: string;
}

export const bachsWebhookRoutes: FastifyPluginAsync<BachsWebhookOptions> = async (app, opts) => {
  // The signature covers the exact bytes, so keep the raw body (scoped to this plugin only).
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/bachs/webhook', async (req, reply) => {
    if (!opts.payments.webhookConfigured) {
      req.log.error('bachs webhook received but BACHS_WEBHOOK_SECRET is not set; asking for a retry');
      return reply.code(503).send({ ok: false });
    }
    const raw = req.body;
    if (!Buffer.isBuffer(raw) || !opts.payments.verifyWebhook(raw, req.headers)) {
      req.log.warn('bachs webhook rejected: bad or missing signature');
      opts.notify({
        level: 'warning',
        title: 'webhook signature failure',
        body: `Rejected a Bachs webhook with a bad signature from ${req.ip}.`,
      });
      return reply.code(401).send({ ok: false });
    }

    let envelope: Envelope;
    try {
      envelope = envelopeSchema.parse(JSON.parse(raw.toString('utf8')));
    } catch {
      return reply.code(400).send({ ok: false });
    }

    const outcome = await handleEvent(opts, envelope, req.log.child({ eventId: envelope.id }));
    return reply.code(outcome.status).send({ ok: outcome.status === 200, result: outcome.result });
  });
};

async function handleEvent(opts: BachsWebhookOptions, event: Envelope, log: FastifyBaseLogger): Promise<Outcome> {
  const { db } = opts;
  if (!PAID_EVENTS.has(event.type)) return { status: 200, result: 'ignored' };
  if (await eventSeen(db, event.id)) return { status: 200, result: 'duplicate' };

  const reference = event.data?.reference ?? undefined;
  const checkoutId = event.data?.checkout_id ?? undefined;
  const order = await findOrderForPayment(db, { reference, checkoutId });
  if (!order) {
    await recordEvent(db, event, 'unknown_order');
    opts.notify({
      level: 'warning',
      title: 'payment for unknown order',
      body: `Bachs reported a payment (checkout ${checkoutId ?? '?'}, reference ${reference ?? '?'}) that matches no order.`,
    });
    return { status: 200, result: 'unknown_order' };
  }

  const orderLog = log.child({ orderId: order.id });
  if (!PAYABLE.includes(order.status)) {
    await recordEvent(db, event, 'already_handled');
    return { status: 200, result: 'already_handled' };
  }

  const sessionId = checkoutId ?? order.checkoutId;
  if (!sessionId) {
    await recordEvent(db, event, 'no_checkout');
    opts.notify({
      level: 'critical',
      title: 'payment without checkout id',
      body: `Order ${order.id} got a payment event but has no checkout id to verify it with.`,
    });
    return { status: 200, result: 'no_checkout' };
  }

  // Never trust the webhook body alone: ask Bachs for the checkout's real state.
  let checkout: CheckoutSession;
  try {
    checkout = await opts.payments.verifyPayment(sessionId);
  } catch (err) {
    orderLog.warn({ err }, 'could not verify checkout with Bachs; asking for a retry');
    return { status: 503, result: 'verify_failed' };
  }
  if (checkout.status !== 'completed') {
    orderLog.info({ checkoutStatus: checkout.status }, 'checkout not completed yet; asking for a retry');
    return { status: 503, result: 'not_completed' };
  }

  const problem = paymentProblem(order, checkout);
  if (problem) {
    await db.transaction(async (tx) => {
      await recordEvent(tx, event, 'held');
      await holdPayment(tx, order.id, problem);
    });
    orderLog.error({ problem }, 'payment held for review');
    opts.onChange?.(order.id);
    opts.notify({
      level: 'critical',
      title: 'payment held for review',
      body: `Order ${order.id} was not marked paid: ${problem}.`,
    });
    return { status: 200, result: 'held' };
  }

  const paid = await db.transaction(async (tx) => {
    await recordEvent(tx, event, 'paid');
    return markPaid(tx, order.id);
  });
  if (!paid) return { status: 200, result: 'already_handled' };

  orderLog.info('order paid');
  opts.onChange?.(paid.id);
  setImmediate(() => {
    Promise.resolve()
      .then(() => opts.onPaid(paid.id))
      .catch((err: unknown) => orderLog.error({ err }, 'fulfilment trigger failed'));
  });
  return { status: 200, result: 'paid' };
}

/** Why a completed checkout must not mark the order paid, or undefined if it may. */
function paymentProblem(order: Order, checkout: CheckoutSession): string | undefined {
  if (checkout.reference !== order.paymentReference) {
    return `checkout reference ${checkout.reference ?? 'none'} is not ${order.paymentReference}`;
  }
  if (checkout.currency !== 'NGN') return `paid in ${checkout.currency}, expected NGN`;
  if (checkout.paymentStatus && !['succeeded', 'paid'].includes(checkout.paymentStatus)) {
    return `payment status is ${checkout.paymentStatus}`;
  }
  // Exactly the amount the checkout was created for (the Bachs docs: match amount and currency).
  const expectedMinor = order.amountNgn * 100;
  if (checkout.amountMinor !== expectedMinor) {
    return `checkout amount ${checkout.amountMinor / 100} NGN does not match the order amount ${order.amountNgn} NGN`;
  }
  return undefined;
}

async function eventSeen(db: Db, eventId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.kind, EVENT_KIND), eq(events.ref, eventId)))
    .limit(1);
  return row !== undefined;
}

async function recordEvent(db: Db, event: Envelope, outcome: string): Promise<void> {
  await db
    .insert(events)
    .values({
      kind: EVENT_KIND,
      ref: event.id,
      payload: {
        type: event.type,
        checkoutId: event.data?.checkout_id ?? null,
        reference: event.data?.reference ?? null,
        outcome,
      },
    })
    .onConflictDoNothing({ target: [events.kind, events.ref], where: sql`kind = 'bachs_webhook'` });
}
