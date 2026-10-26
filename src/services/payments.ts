import type { Order } from '../db/schema.js';
import type { CheckoutSession, CreateCheckoutInput, CreatedCheckout } from './bachs.js';

// Payments sit behind this small interface so the provider can be swapped later. Bachs is the
// only implementation (BachsProvider in bachs.ts).

export type { CheckoutSession, CreateCheckoutInput, CreatedCheckout };

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface PaymentProvider {
  /** Creates a hosted checkout for an order. Safe to repeat for the same order (idempotent). */
  createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout>;
  /** The provider's own view of a checkout: the only thing that may mark an order paid. */
  verifyPayment(checkoutId: string): Promise<CheckoutSession>;
  /** False when no webhook secret is configured, so no delivery can be trusted yet. */
  readonly webhookConfigured: boolean;
  /** Signature check on the exact raw body. */
  verifyWebhook(rawBody: Buffer, headers: WebhookHeaders): boolean;
}

/**
 * Why a completed checkout must not mark the order paid, or undefined if it may. Shared by the
 * webhook and the reconciler, so a missed webhook is judged exactly like a delivered one.
 */
export function paymentProblem(order: Order, checkout: CheckoutSession): string | undefined {
  if (checkout.reference !== order.paymentReference) {
    return `checkout reference ${checkout.reference ?? 'none'} is not ${order.paymentReference}`;
  }
  if (checkout.currency !== 'NGN') return `paid in ${checkout.currency}, expected NGN`;
  if (checkout.paymentStatus && !['succeeded', 'paid'].includes(checkout.paymentStatus)) {
    return `payment status is ${checkout.paymentStatus}`;
  }
  // Exactly the amount the checkout was created for (Bachs docs: match amount and currency). With
  // customer_pays the fee shows on the charge, not here (sandbox: 3500.00 checkout, 3552.50 charge).
  const expectedMinor = order.amountNgn * 100;
  if (checkout.amountMinor !== expectedMinor) {
    return `checkout amount ${checkout.amountMinor / 100} NGN does not match the order amount ${order.amountNgn} NGN`;
  }
  return undefined;
}
