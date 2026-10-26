import { createHmac, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { Logger } from '../util/logger.js';

// Bachs payments: https://docs.bachs.io (OpenAPI at /docs/openapi/openapi.json).
// Money is a decimal string ("3500.00"); we compare it in minor units (kobo).

export const BACHS_LIVE_URL = 'https://api.bachs.io';
export const BACHS_SANDBOX_URL = 'https://sandbox-api.bachs.io';

export function bachsBaseUrl(secretKey: string): string {
  return secretKey.startsWith('sk_live_') ? BACHS_LIVE_URL : BACHS_SANDBOX_URL;
}

/** "3500.00" -> 350000. Exact, no floating point. */
export function toMinorUnits(amount: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!match) throw new RangeError(`not a decimal amount: ${amount}`);
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export class BachsError extends Error {
  override name = 'BachsError';
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }

  /** The request may not have been processed; repeating it with the same Idempotency-Key is safe. */
  get retryable(): boolean {
    return (
      ['timeout', 'network_error', 'server_error', 'IDEMPOTENCY_IN_PROGRESS', 'RATE_LIMITED'].includes(this.code) ||
      this.status === 429
    );
  }
}

const createdBody = z.object({
  checkout_id: z.string().min(1),
  checkout_url: z.url(),
  expires_at: z.string().nullish(),
});

const sessionBody = z.object({
  checkout_id: z.string().min(1),
  status: z.string(),
  payment_status: z.string().nullish(),
  amount: z.string(),
  currency: z.string(),
  reference: z.string().nullish(),
});

const settingsBody = z.object({ fee_preference: z.enum(['customer_pays', 'org_pays']) });

const errorBody = z.object({ error_code: z.string(), detail: z.unknown().optional() });

export interface CreateCheckoutInput {
  orderId: string;
  reference: string;
  amountNgn: number;
  quantity: number;
  telegramId: number;
  expiresInMinutes: number;
  /** Public http(s) URL the buyer returns to, e.g. https://t.me/<bot>. Optional. */
  returnUrl?: string;
}

export interface CreatedCheckout {
  checkoutId: string;
  checkoutUrl: string;
  expiresAt: Date | undefined;
}

export interface CheckoutSession {
  checkoutId: string;
  /** open | completed | expired | cancelled */
  status: string;
  paymentStatus: string | undefined;
  amountMinor: number;
  currency: string;
  reference: string | undefined;
}

export type FeePreference = z.infer<typeof settingsBody>['fee_preference'];

export interface BachsClientOptions {
  secretKey: string;
  baseUrl?: string;
  logger?: Logger;
  fetch?: typeof fetch;
  /** Per request. Bachs gives webhooks 10s, and the webhook route calls getCheckout. Default 8s. */
  timeoutMs?: number;
  /** Attempts for createCheckout on a retryable failure. Default 2. */
  maxAttempts?: number;
  backoffMs?: number;
}

export class BachsClient {
  private readonly secretKey: string;
  private readonly baseUrl: string;
  private readonly logger: Logger | undefined;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;

  constructor(options: BachsClientOptions) {
    this.secretKey = options.secretKey;
    this.baseUrl = (options.baseUrl ?? bachsBaseUrl(options.secretKey)).replace(/\/+$/, '');
    this.logger = options.logger;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.backoffMs = options.backoffMs ?? 500;
  }

  /** Creates an NGN checkout for an order. Safe to call again for the same order. */
  async createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout> {
    const body = {
      pricing: { currency: 'NGN', amount: `${input.amountNgn}.00` },
      reference: input.reference,
      metadata: {
        order_id: input.orderId,
        telegram_id: String(input.telegramId),
        quantity: String(input.quantity),
      },
      // Telegram has no email; Bachs needs a customer identity, so use a stable synthetic one.
      customer: { email: `${input.telegramId}@tg.samkiel.dev` },
      payment_method_types: ['NGN_CARD', 'NGN_BANK_TRANSFER'],
      expires_in_minutes: input.expiresInMinutes,
      ...(input.returnUrl && { success_url: input.returnUrl, cancel_url: input.returnUrl }),
    };
    const idempotencyKey = `checkout_${input.orderId}`;

    for (let attempt = 1; ; attempt++) {
      try {
        const created = await this.request('POST', '/v1/checkout-sessions', createdBody, { body, idempotencyKey });
        return {
          checkoutId: created.checkout_id,
          checkoutUrl: created.checkout_url,
          expiresAt: created.expires_at ? new Date(created.expires_at) : undefined,
        };
      } catch (err) {
        if (!(err instanceof BachsError) || !err.retryable || attempt >= this.maxAttempts) throw err;
        this.logger?.warn({ code: err.code, attempt, orderId: input.orderId }, 'bachs checkout create failed, retrying');
        await sleep(this.backoffMs * attempt);
      }
    }
  }

  async getCheckout(checkoutId: string): Promise<CheckoutSession> {
    const s = await this.request('GET', `/v1/checkout-sessions/${encodeURIComponent(checkoutId)}`, sessionBody);
    let amountMinor: number;
    try {
      amountMinor = toMinorUnits(s.amount);
    } catch {
      throw new BachsError('invalid_response', `checkout ${checkoutId} has an unreadable amount`);
    }
    return {
      checkoutId: s.checkout_id,
      status: s.status,
      paymentStatus: s.payment_status ?? undefined,
      amountMinor,
      currency: s.currency,
      reference: s.reference ?? undefined,
    };
  }

  /** Who pays the processing fee on checkouts: the buyer (customer_pays) or us (org_pays). */
  async getFeePreference(): Promise<FeePreference> {
    const settings = await this.request('GET', '/v1/accounts/checkout/settings', settingsBody);
    return settings.fee_preference;
  }

  private async request<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    init: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<z.output<S>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      Accept: 'application/json',
    };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;

    let status: number;
    let body: unknown;
    try {
      const res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = res.status;
      const text = await res.text();
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new BachsError('timeout', `${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw new BachsError('network_error', `${method} ${path} failed: ${(err as Error).message}`);
    }

    if (status >= 500) throw new BachsError('server_error', `${method} ${path} returned ${status}`, status);
    if (status >= 400) {
      const error = errorBody.safeParse(body);
      const code = error.success ? error.data.error_code : 'unknown_error';
      const detail = error.success && typeof error.data.detail === 'string' ? `: ${error.data.detail}` : '';
      throw new BachsError(code, `${method} ${path} returned ${status} ${code}${detail}`, status);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new BachsError('invalid_response', `${method} ${path} returned an unexpected body`, status);
    }
    return parsed.data;
  }
}

/** Bachs behind the PaymentProvider interface. */
export class BachsProvider {
  readonly webhookConfigured: boolean;

  constructor(
    readonly client: BachsClient,
    private readonly webhookSecret: string | undefined,
  ) {
    this.webhookConfigured = Boolean(webhookSecret);
  }

  createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout> {
    return this.client.createCheckout(input);
  }

  verifyPayment(checkoutId: string): Promise<CheckoutSession> {
    return this.client.getCheckout(checkoutId);
  }

  verifyWebhook(rawBody: Buffer, headers: Headers): boolean {
    return this.webhookSecret !== undefined && verifyWebhookSignature(rawBody, headers, this.webhookSecret);
  }

  getFeePreference(): Promise<FeePreference> {
    return this.client.getFeePreference();
  }
}

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function hexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Checks a Bachs webhook signature: HMAC-SHA256 hex of `${timestamp}.${rawBody}` with the
 * endpoint's signing secret. Prefers X-Bachs-Signature-V2 (several v1 values during a secret
 * rotation), falls back to X-Bachs-Signature + X-Bachs-Timestamp. Old timestamps are replays.
 * `headers` must have lowercase names, as Node gives them.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  headers: Headers,
  secret: string,
  { nowSeconds = Date.now() / 1000, toleranceSeconds = 300 } = {},
): boolean {
  let timestamp: string | undefined;
  let signatures: string[];

  const v2 = header(headers, 'x-bachs-signature-v2');
  if (v2) {
    const parts = v2.split(',').map((part) => part.trim().split('=', 2) as [string, string | undefined]);
    timestamp = parts.find(([key]) => key === 't')?.[1];
    signatures = parts.filter(([key, value]) => key === 'v1' && value).map(([, value]) => value as string);
  } else {
    timestamp = header(headers, 'x-bachs-timestamp');
    const legacy = header(headers, 'x-bachs-signature');
    signatures = legacy ? [legacy] : [];
  }

  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
  return signatures.some((signature) => hexEqual(expected, signature));
}
