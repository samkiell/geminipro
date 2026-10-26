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
