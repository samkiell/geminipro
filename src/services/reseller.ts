import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Logger } from '../util/logger.js';

// Reseller API: https://api-geminipro.ignorelist.com/api/reseller/docs.txt
// Money arrives as decimal strings ("1.20"); we keep it as integer cents.

const API_ERROR_CODES = [
  'missing_api_key',
  'invalid_api_key',
  'invalid_json',
  'invalid_order_payload',
  'invalid_product_id',
  'invalid_quantity',
  'insufficient_funds',
  'product_not_found',
  'order_not_found',
  'out_of_stock',
  'supplier_purchase_pending',
  'supplier_purchase_failed',
  'transaction_error',
] as const;

export type ResellerErrorCode =
  | (typeof API_ERROR_CODES)[number]
  // raised by this client
  | 'timeout'
  | 'network_error'
  | 'server_error'
  | 'pending_timeout'
  | 'invalid_response'
  | 'unknown_error';

// The request may have reached the reseller, so the purchase outcome is unknown.
// Retrying with the same idempotency key is safe and is how the outcome is learned.
const OUTCOME_UNKNOWN = new Set<ResellerErrorCode>([
  'timeout',
  'network_error',
  'server_error',
  'pending_timeout',
]);

export class ResellerError extends Error {
  override name = 'ResellerError';
  readonly code: ResellerErrorCode;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly orderCode: string | undefined;

  constructor(
    code: ResellerErrorCode,
    message: string,
    details: { status?: number; requestId?: string; orderCode?: string } = {},
  ) {
    super(message);
    this.code = code;
    this.status = details.status;
    this.requestId = details.requestId;
    this.orderCode = details.orderCode;
  }

  /** True when the outcome is unknown and a retry with the same idempotency key is needed. */
  get retryable(): boolean {
    return OUTCOME_UNKNOWN.has(this.code);
  }
}

const cents = z.union([z.string(), z.number()]).transform((value, ctx) => {
  const amount = Number(value);
  if (value === '' || !Number.isFinite(amount)) {
    ctx.addIssue({ code: 'custom', message: 'expected a decimal amount' });
    return z.NEVER;
  }
  return Math.round(amount * 100);
});

const balanceBody = z.object({ ok: z.literal(true), balance: cents, currency: z.string() });

const productShape = z.object({
  id: z.number().int(),
  name: z.string(),
  price: cents,
  currency: z.string(),
  stock: z.number().int(),
  inStock: z.boolean(),
});
const productBody = z.object({ ok: z.literal(true), product: productShape });

const orderShape = z.object({
  orderCode: z.string().min(1),
  status: z.string(),
  total: cents.optional(),
  value: z.string().nullish(),
  error: z.string().nullish(),
});
const orderBody = z.object({ ok: z.literal(true), order: orderShape });

const errorBody = z.object({
  ok: z.literal(false),
  error: z.string(),
  message: z.string().optional(),
  requestId: z.string().optional(),
  orderCode: z.string().optional(),
  order: z.object({ orderCode: z.string() }).optional(),
});

export interface Balance {
  balanceCents: number;
  currency: string;
}

export interface Product {
  id: number;
  name: string;
  priceCents: number;
  currency: string;
  stock: number;
  inStock: boolean;
}

export type OrderStatus = 'completed' | 'pending' | 'failed';

export interface ResellerOrder {
  orderCode: string;
  status: OrderStatus;
  /** The delivered activation link. Sensitive: never log it. */
  value: string | undefined;
  totalCents: number | undefined;
  error: string | undefined;
}

export interface CompletedOrder {
  orderCode: string;
  /** The delivered activation link. Sensitive: never log it. */
  value: string;
  totalCents: number | undefined;
}

export interface Availability {
  canSell: boolean;
  maxQuantity: number;
}

// A purchase that is still pending, before we know its orderCode (409 supplier_purchase_pending).
type PurchaseState = ResellerOrder | { status: 'pending'; orderCode: string | undefined };

function normalizeStatus(status: string): OrderStatus {
  const s = status.toLowerCase();
  if (s === 'completed') return 'completed';
  if (['failed', 'error', 'cancelled', 'canceled', 'refunded'].includes(s)) return 'failed';
  return 'pending';
}

function toOrder(raw: z.output<typeof orderShape>): ResellerOrder {
  return {
    orderCode: raw.orderCode,
    status: normalizeStatus(raw.status),
    value: raw.value ?? undefined,
    totalCents: raw.total,
    error: raw.error ?? undefined,
  };
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | undefined)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/**
 * How many links we can sell right now (docs/ARCHITECTURE.md section 8).
 * `reservedUnits` are links already paid for but not yet bought; they need stock and balance too.
 */
export function computeAvailability(input: {
  balanceCents: number;
  priceCents: number;
  stock: number;
  inStock: boolean;
  reservedUnits: number;
  maxQtyPerOrder: number;
}): Availability {
  const { balanceCents, priceCents, stock, inStock, reservedUnits, maxQtyPerOrder } = input;
  if (!inStock || priceCents <= 0) return { canSell: false, maxQuantity: 0 };

  const stockLeft = stock - reservedUnits;
  const affordable = Math.floor((balanceCents - reservedUnits * priceCents) / priceCents);
  const maxQuantity = Math.max(0, Math.min(stockLeft, affordable, maxQtyPerOrder));
  return { canSell: maxQuantity > 0, maxQuantity };
}

export interface ResellerClientOptions {
  baseUrl: string;
  apiKey: string;
  productId: number;
  maxQtyPerOrder: number;
  logger?: Logger;
  fetch?: typeof fetch;
  /** Per request. Default 15s. */
  timeoutMs?: number;
  /** Balance and product reads. Default 10s. */
  cacheTtlMs?: number;
  /** POST /orders attempts on timeout, network error or 5xx. Default 3. */
  maxAttempts?: number;
  /** First retry delay, doubled each retry. Default 1s. */
  backoffMs?: number;
  /** How long to poll a pending purchase. Default 30s. */
  pendingTimeoutMs?: number;
  pollIntervalMs?: number;
}

const BALANCE_CACHE_KEY = 'balance';

export class ResellerClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly productId: number;
  private readonly maxQtyPerOrder: number;
  private readonly logger: Logger | undefined;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly pendingTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly cache = new Map<string, { expiresAt: number; value: Promise<unknown> }>();

  constructor(options: ResellerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.productId = options.productId;
    this.maxQtyPerOrder = options.maxQtyPerOrder;
    this.logger = options.logger;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffMs = options.backoffMs ?? 1_000;
    this.pendingTimeoutMs = options.pendingTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
  }

  getBalance(): Promise<Balance> {
    return this.cached(BALANCE_CACHE_KEY, async () => {
      const body = await this.request('GET', '/account/balance', balanceBody);
      return { balanceCents: body.balance, currency: body.currency };
    });
  }

  getProduct(productId: number): Promise<Product> {
    return this.cached(`product:${productId}`, async () => {
      const { product } = await this.request('GET', `/products/${productId}`, productBody);
      return {
        id: product.id,
        name: product.name,
        priceCents: product.price,
        currency: product.currency,
        stock: product.stock,
        inStock: product.inStock,
      };
    });
  }

  async getOrder(orderCode: string): Promise<ResellerOrder> {
    const { order } = await this.request('GET', `/orders/${encodeURIComponent(orderCode)}`, orderBody);
    return toOrder(order);
  }

  async getAvailability(reservedUnits: number): Promise<Availability> {
    const [balance, product] = await Promise.all([this.getBalance(), this.getProduct(this.productId)]);
    return computeAvailability({
      balanceCents: balance.balanceCents,
      priceCents: product.priceCents,
      stock: product.stock,
      inStock: product.inStock,
      reservedUnits,
      maxQtyPerOrder: this.maxQtyPerOrder,
    });
  }

  /**
   * Buys one link. Retries timeouts and 5xx with the same idempotency key, and polls a pending
   * purchase for up to `pendingTimeoutMs`. Business errors (out_of_stock, insufficient_funds,
   * supplier_purchase_failed, ...) are thrown at once for the caller to handle.
   *
   * A thrown error with `retryable === true` means the outcome is unknown: the caller must retry
   * later with the same idempotency key, never a new one.
   */
  async createOrder(productId: number, idempotencyKey: string): Promise<CompletedOrder> {
    try {
      const first = await this.postOrderWithRetry(productId, idempotencyKey);
      const order = await this.waitUntilSettled(first, productId, idempotencyKey);
      this.logger?.info({ orderCode: order.orderCode, idempotencyKey }, 'reseller order completed');
      return order;
    } catch (err) {
      if (err instanceof ResellerError) {
        this.logger?.warn(
          { code: err.code, requestId: err.requestId, orderCode: err.orderCode, idempotencyKey },
          'reseller order not completed',
        );
      }
      throw err;
    } finally {
      // Any purchase attempt may have moved the balance.
      this.cache.delete(BALANCE_CACHE_KEY);
    }
  }

  private async postOrderWithRetry(productId: number, idempotencyKey: string): Promise<PurchaseState> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.postOrder(productId, idempotencyKey);
      } catch (err) {
        if (!(err instanceof ResellerError) || !err.retryable || attempt >= this.maxAttempts) throw err;
        this.logger?.warn(
          { code: err.code, attempt, idempotencyKey },
          'reseller order request failed, retrying with the same idempotency key',
        );
        await sleep(this.backoffMs * 2 ** (attempt - 1));
      }
    }
  }

  private async postOrder(productId: number, idempotencyKey: string): Promise<PurchaseState> {
    try {
      const { order } = await this.request('POST', '/orders', orderBody, {
        body: { productId, quantity: 1 },
        idempotencyKey,
      });
      return toOrder(order);
    } catch (err) {
      if (err instanceof ResellerError && err.code === 'supplier_purchase_pending') {
        return { status: 'pending', orderCode: err.orderCode };
      }
      throw err;
    }
  }

  private async waitUntilSettled(
    first: PurchaseState,
    productId: number,
    idempotencyKey: string,
  ): Promise<CompletedOrder> {
    const deadline = Date.now() + this.pendingTimeoutMs;
    let state = first;
    let orderCode = first.orderCode;

    while (state.status === 'pending') {
      if (Date.now() >= deadline) {
        throw new ResellerError(
          'pending_timeout',
          `purchase still pending after ${this.pendingTimeoutMs}ms`,
          { orderCode },
        );
      }
      await sleep(this.pollIntervalMs);
      try {
        // Without an orderCode, replaying the POST with the same key is the documented way to check.
        state = orderCode
          ? await this.getOrder(orderCode)
          : await this.postOrder(productId, idempotencyKey);
        orderCode ??= state.orderCode;
      } catch (err) {
        if (err instanceof ResellerError && err.retryable) continue;
        throw err;
      }
    }

    if (state.status === 'failed') {
      throw new ResellerError('supplier_purchase_failed', state.error ?? 'reseller marked the order failed', {
        orderCode,
      });
    }
    if (!state.value || !orderCode) {
      throw new ResellerError('invalid_response', 'completed order has no value', { orderCode });
    }
    return { orderCode, value: state.value, totalCents: state.totalCents };
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as Promise<T>;

    const value = load();
    this.cache.set(key, { expiresAt: Date.now() + this.cacheTtlMs, value });
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }

  private async request<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    init: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<z.output<S>> {
    const headers: Record<string, string> = { 'X-API-Key': this.apiKey, Accept: 'application/json' };
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';
    if (init.idempotencyKey) headers['X-Idempotency-Key'] = init.idempotencyKey;

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
      if (isTimeout(err)) {
        throw new ResellerError('timeout', `${method} ${path} timed out after ${this.timeoutMs}ms`);
      }
      throw new ResellerError('network_error', `${method} ${path} failed: ${(err as Error).message}`);
    }

    const error = errorBody.safeParse(body);
    const details = error.success
      ? {
          status,
          requestId: error.data.requestId,
          orderCode: error.data.orderCode ?? error.data.order?.orderCode,
        }
      : { status };

    if (status >= 500) {
      const reason = error.success ? `: ${error.data.error}` : '';
      throw new ResellerError('server_error', `${method} ${path} returned ${status}${reason}`, details);
    }
    if (error.success) {
      const known = (API_ERROR_CODES as readonly string[]).includes(error.data.error);
      throw new ResellerError(
        known ? (error.data.error as ResellerErrorCode) : 'unknown_error',
        error.data.message ?? error.data.error,
        details,
      );
    }
    if (status >= 400) {
      throw new ResellerError('unknown_error', `${method} ${path} returned ${status}`, details);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ResellerError('invalid_response', `${method} ${path} returned an unexpected body`, { status });
    }
    return parsed.data;
  }
}

export function createResellerClient(config: Config, logger?: Logger): ResellerClient {
  return new ResellerClient({
    baseUrl: config.RESELLER_MOCK ? config.RESELLER_MOCK_URL : config.RESELLER_BASE_URL,
    apiKey: config.RESELLER_API_KEY,
    productId: config.RESELLER_PRODUCT_ID,
    maxQtyPerOrder: config.MAX_QTY_PER_ORDER,
    ...(logger && { logger }),
  });
}
