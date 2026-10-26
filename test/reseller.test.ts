import { afterEach, describe, expect, it } from 'vitest';
import {
  computeAvailability,
  ResellerClient,
  ResellerError,
  type ResellerClientOptions,
} from '../src/services/reseller.js';
import { startMockReseller, type MockReseller, type MockResellerOptions } from './mocks/reseller-server.js';

const API_KEY = 'test-key';
let mock: MockReseller;
const started: MockReseller[] = [];

async function setup(mockOptions: MockResellerOptions = {}, clientOptions: Partial<ResellerClientOptions> = {}) {
  mock = await startMockReseller({ apiKey: API_KEY, timeoutDelayMs: 400, ...mockOptions });
  started.push(mock);
  return new ResellerClient({
    baseUrl: mock.url,
    apiKey: API_KEY,
    productId: 1,
    maxQtyPerOrder: 10,
    timeoutMs: 150,
    backoffMs: 5,
    pollIntervalMs: 10,
    pendingTimeoutMs: 2_000,
    ...clientOptions,
  });
}

async function rejection(promise: Promise<unknown>): Promise<ResellerError> {
  const err = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ResellerError);
  return err as ResellerError;
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((m) => m.close()));
});

describe('reseller client against the mock', () => {
  it('success path returns a link in order.value', async () => {
    const client = await setup();
    const order = await client.createOrder(1, 'order-a-0');
    expect(order.value).toMatch(/^https:\/\/mock-reseller\.local\/activate\//);
    expect(order.orderCode).toMatch(/^rs_/);
    expect(order.totalCents).toBe(120);
    expect(mock.state.orders).toHaveLength(1);
    expect(mock.orderRequests()[0]?.idempotencyKey).toBe('order-a-0');
  });

  it('same idempotency key twice returns the same order, not two', async () => {
    const client = await setup({ balanceCents: 1_000 });
    const first = await client.createOrder(1, 'order-b-0');
    const second = await client.createOrder(1, 'order-b-0');
    expect(second.orderCode).toBe(first.orderCode);
    expect(second.value).toBe(first.value);
    expect(mock.state.orders).toHaveLength(1);
    expect(mock.state.balanceCents).toBe(880);
  });

  it('timeout then success only creates one order', async () => {
    const client = await setup();
    mock.queueFaults('timeout');
    const order = await client.createOrder(1, 'order-c-0');
    expect(order.value).toBeTruthy();
    expect(mock.orderRequests()).toHaveLength(2);
    expect(mock.orderRequests().every((r) => r.idempotencyKey === 'order-c-0')).toBe(true);
    expect(mock.state.orders).toHaveLength(1);
  });

  it('retries 5xx with the same key and gives up after 3 attempts', async () => {
    const client = await setup();
    mock.queueFaults('server_error', 'server_error');
    await expect(client.createOrder(1, 'order-d-0')).resolves.toMatchObject({ value: expect.any(String) });
    expect(mock.orderRequests()).toHaveLength(3);

    mock.queueFaults('server_error', 'server_error', 'server_error');
    const err = await rejection(client.createOrder(1, 'order-d-1'));
    expect(err.code).toBe('server_error');
    expect(err.retryable).toBe(true);
    expect(mock.orderRequests()).toHaveLength(6);
    expect(mock.state.orders).toHaveLength(1);
  });

  it('pending resolves via polling (409 without orderCode, replays the same key)', async () => {
    const client = await setup({ pendingPolls: 3 });
    mock.queueFaults('pending');
    const order = await client.createOrder(1, 'order-e-0');
    expect(order.value).toBeTruthy();
    expect(mock.state.orders).toHaveLength(1);
    expect(mock.orderRequests().length).toBeGreaterThan(1);
  });

  it('pending resolves via GET /orders/{orderCode} when the code is known', async () => {
    const client = await setup({ pendingPolls: 2, pendingIncludesOrderCode: true });
    mock.queueFaults('pending');
    const order = await client.createOrder(1, 'order-f-0');
    expect(order.orderCode).toBe(mock.state.orders[0]?.orderCode);
    expect(mock.orderRequests()).toHaveLength(1);
    expect(mock.state.requests.filter((r) => r.path.startsWith('/orders/rs_'))).toHaveLength(2);
  });

  it('gives up on a purchase that stays pending, as retryable', async () => {
    const client = await setup({ pendingPolls: 1_000 }, { pendingTimeoutMs: 80 });
    mock.queueFaults('pending');
    const err = await rejection(client.createOrder(1, 'order-g-0'));
    expect(err.code).toBe('pending_timeout');
    expect(err.retryable).toBe(true);
  });

  it('maps out_of_stock to a typed, non retryable error', async () => {
    const client = await setup({ stock: 0 });
    const err = await rejection(client.createOrder(1, 'order-h-0'));
    expect(err).toMatchObject({ code: 'out_of_stock', status: 409, retryable: false });
    expect(err.requestId).toMatch(/^req_/);
    expect(mock.orderRequests()).toHaveLength(1);
  });

  it('maps insufficient_funds to a typed, non retryable error', async () => {
    const client = await setup({ balanceCents: 0 });
    const err = await rejection(client.createOrder(1, 'order-i-0'));
    expect(err).toMatchObject({ code: 'insufficient_funds', status: 402, retryable: false });
    expect(mock.orderRequests()).toHaveLength(1);
  });

  it('maps a bad API key to invalid_api_key', async () => {
    const client = await setup({}, { apiKey: 'wrong' });
    const err = await rejection(client.getBalance());
    expect(err).toMatchObject({ code: 'invalid_api_key', status: 401 });
  });

  it('fails the nth item until cleared, then a retry with the same key completes it', async () => {
    const client = await setup();
    mock.failNthItem(2);
    await client.createOrder(1, 'order-j-0');
    const err = await rejection(client.createOrder(1, 'order-j-1'));
    expect(err.code).toBe('supplier_purchase_failed');
    await client.createOrder(1, 'order-j-2');
    expect(mock.state.orders).toHaveLength(2);

    mock.clearFailures();
    await client.createOrder(1, 'order-j-0');
    await client.createOrder(1, 'order-j-1');
    await client.createOrder(1, 'order-j-2');
    expect(mock.state.orders).toHaveLength(3);
  });

  it('getOrder returns the order and maps unknown codes to order_not_found', async () => {
    const client = await setup();
    const created = await client.createOrder(1, 'order-k-0');
    const fetched = await client.getOrder(created.orderCode);
    expect(fetched).toMatchObject({ orderCode: created.orderCode, status: 'completed', value: created.value });
    const err = await rejection(client.getOrder('rs_missing'));
    expect(err).toMatchObject({ code: 'order_not_found', status: 404 });
  });
});

describe('reads and caching', () => {
  it('parses money into cents and caches balance and product reads', async () => {
    const client = await setup({ balanceCents: 2_345, priceCents: 120, stock: 7 });
    expect(await client.getBalance()).toEqual({ balanceCents: 2_345, currency: 'USD' });
    expect(await client.getProduct(1)).toMatchObject({ id: 1, priceCents: 120, stock: 7, inStock: true });

    await client.getBalance();
    await client.getProduct(1);
    const reads = mock.state.requests.filter((r) => r.method === 'GET');
    expect(reads).toHaveLength(2);
  });

  it('refreshes the balance after a purchase', async () => {
    const client = await setup({ balanceCents: 1_000 });
    expect((await client.getBalance()).balanceCents).toBe(1_000);
    await client.createOrder(1, 'order-l-0');
    expect((await client.getBalance()).balanceCents).toBe(880);
  });

  it('getAvailability applies stock, balance, reservations and the per order cap', async () => {
    const client = await setup({ balanceCents: 500, priceCents: 120, stock: 100 });
    // floor((500 - 1 * 120) / 120) = 3
    expect(await client.getAvailability(1)).toEqual({ canSell: true, maxQuantity: 3 });
  });

  it('rejects a malformed success body as invalid_response', async () => {
    const client = new ResellerClient({
      baseUrl: 'http://reseller.test/api/reseller/v1',
      apiKey: API_KEY,
      productId: 1,
      maxQtyPerOrder: 10,
      fetch: async () => new Response(JSON.stringify({ ok: true, balance: 'lots' }), { status: 200 }),
    });
    const err = await rejection(client.getBalance());
    expect(err.code).toBe('invalid_response');
  });
});

describe('computeAvailability', () => {
  const base = { balanceCents: 10_000, priceCents: 120, stock: 100, inStock: true, reservedUnits: 0, maxQtyPerOrder: 10 };

  it('is capped by MAX_QTY_PER_ORDER', () => {
    expect(computeAvailability(base)).toEqual({ canSell: true, maxQuantity: 10 });
  });

  it('is capped by stock left after reservations', () => {
    expect(computeAvailability({ ...base, stock: 5, reservedUnits: 2 })).toEqual({ canSell: true, maxQuantity: 3 });
  });

  it('is capped by balance left after reservations', () => {
    // 1000 - 3 * 120 = 640 -> 5 links
    expect(computeAvailability({ ...base, balanceCents: 1_000, reservedUnits: 3 })).toEqual({
      canSell: true,
      maxQuantity: 5,
    });
  });

  it('cannot sell when reservations use everything up', () => {
    expect(computeAvailability({ ...base, balanceCents: 240, reservedUnits: 2 })).toEqual({
      canSell: false,
      maxQuantity: 0,
    });
    expect(computeAvailability({ ...base, stock: 2, reservedUnits: 3 })).toEqual({ canSell: false, maxQuantity: 0 });
  });

  it('cannot sell when out of stock or the balance is below one link', () => {
    expect(computeAvailability({ ...base, inStock: false })).toEqual({ canSell: false, maxQuantity: 0 });
    expect(computeAvailability({ ...base, balanceCents: 119 })).toEqual({ canSell: false, maxQuantity: 0 });
  });
});

describe('ResellerError', () => {
  it('marks only unknown outcomes as retryable', () => {
    expect(new ResellerError('timeout', 'x').retryable).toBe(true);
    expect(new ResellerError('server_error', 'x').retryable).toBe(true);
    expect(new ResellerError('out_of_stock', 'x').retryable).toBe(false);
    expect(new ResellerError('supplier_purchase_failed', 'x').retryable).toBe(false);
  });
});
