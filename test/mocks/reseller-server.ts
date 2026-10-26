import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

// In-memory stand-in for the reseller API (same paths, bodies and error shape).
// Tests drive it through the returned control object; `npm run mock:reseller` runs it
// standalone and exposes the same controls at POST /__mock/control.

const PREFIX = '/api/reseller/v1';

/** Applied to the next POST /orders requests, one fault per request, in order. */
export type MockFault =
  | 'timeout' // the order is created, but the reply is held for `timeoutDelayMs`
  | 'server_error' // 500, nothing created
  | 'pending' // order created as pending; completes after `pendingPolls` checks
  | 'out_of_stock'
  | 'insufficient_funds'
  | 'supplier_purchase_failed';

export type MockFailureCode = 'supplier_purchase_failed' | 'out_of_stock' | 'insufficient_funds';

export interface MockOrder {
  orderCode: string;
  idempotencyKey: string | undefined;
  productId: number;
  status: 'pending' | 'completed';
  value: string;
  totalCents: number;
  pollsLeft: number;
  createdAt: string;
}

export interface MockResellerOptions {
  /** When set, X-API-Key must equal it. Otherwise any non-empty key is accepted. */
  apiKey?: string;
  productId?: number;
  priceCents?: number;
  stock?: number;
  balanceCents?: number;
  timeoutDelayMs?: number;
  pendingPolls?: number;
  /** Whether a 409 supplier_purchase_pending reply carries the orderCode. */
  pendingIncludesOrderCode?: boolean;
}

export interface MockResellerState {
  productId: number;
  priceCents: number;
  stock: number;
  balanceCents: number;
  timeoutDelayMs: number;
  pendingPolls: number;
  pendingIncludesOrderCode: boolean;
  orders: MockOrder[];
  faults: MockFault[];
  /** 1-based purchase number (first sighting of an idempotency key) -> error to return. */
  failingItems: Map<number, MockFailureCode>;
  seenKeys: string[];
  requests: { method: string; path: string; idempotencyKey: string | undefined }[];
}

const ERROR_STATUS: Record<MockFailureCode, number> = {
  supplier_purchase_failed: 400,
  out_of_stock: 409,
  insufficient_funds: 402,
};

const usd = (c: number) => (c / 100).toFixed(2);
const requestId = () => `req_${randomBytes(12).toString('hex')}`;

function sendError(reply: FastifyReply, status: number, error: string, message: string, extra = {}) {
  return reply.code(status).send({ ok: false, error, message, requestId: requestId(), ...extra });
}

function orderJson(order: MockOrder) {
  return {
    orderCode: order.orderCode,
    productId: order.productId,
    name: 'Gemini Pro 18 Months',
    quantity: 1,
    status: order.status,
    total: usd(order.totalCents),
    currency: 'USD',
    value: order.status === 'completed' ? order.value : null,
    error: null,
    createdAt: order.createdAt,
    updatedAt: order.createdAt,
  };
}

export function buildMockReseller(options: MockResellerOptions = {}) {
  const state: MockResellerState = {
    productId: options.productId ?? 1,
    priceCents: options.priceCents ?? 120,
    stock: options.stock ?? 100,
    balanceCents: options.balanceCents ?? 10_000,
    timeoutDelayMs: options.timeoutDelayMs ?? 20_000,
    pendingPolls: options.pendingPolls ?? 2,
    pendingIncludesOrderCode: options.pendingIncludesOrderCode ?? false,
    orders: [],
    faults: [],
    failingItems: new Map(),
    seenKeys: [],
    requests: [],
  };

  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith(PREFIX)) return;
    const key = req.headers['x-api-key'];
    const idem = req.headers['x-idempotency-key'];
    state.requests.push({
      method: req.method,
      path: req.url.slice(PREFIX.length),
      idempotencyKey: typeof idem === 'string' ? idem : undefined,
    });
    if (typeof key !== 'string' || key === '') {
      return sendError(reply, 401, 'missing_api_key', 'API key is required.');
    }
    if (options.apiKey !== undefined && key !== options.apiKey) {
      return sendError(reply, 401, 'invalid_api_key', 'API key is invalid or disabled.');
    }
  });

  function productJson() {
    return {
      id: state.productId,
      productId: state.productId,
      name: 'Gemini Pro 18 Months',
      title: 'Gemini Pro 18 Months',
      description: 'mock product',
      price: usd(state.priceCents),
      currency: 'USD',
      stock: state.stock,
      inStock: state.stock > 0,
    };
  }

  // A pending order moves toward completion each time it is checked.
  function progress(order: MockOrder) {
    if (order.status !== 'pending') return;
    order.pollsLeft -= 1;
    if (order.pollsLeft <= 0) order.status = 'completed';
  }

  function createOrder(idempotencyKey: string | undefined, status: MockOrder['status']): MockOrder {
    state.stock -= 1;
    state.balanceCents -= state.priceCents;
    const orderCode = `rs_${randomBytes(8).toString('hex')}`;
    const order: MockOrder = {
      orderCode,
      idempotencyKey,
      productId: state.productId,
      status,
      value: `https://mock-reseller.local/activate/${randomBytes(12).toString('hex')}`,
      totalCents: state.priceCents,
      pollsLeft: status === 'pending' ? state.pendingPolls : 0,
      createdAt: new Date().toISOString(),
    };
    state.orders.push(order);
    return order;
  }

  function replyWithOrder(reply: FastifyReply, order: MockOrder) {
    if (order.status === 'pending') {
      const extra = state.pendingIncludesOrderCode ? { orderCode: order.orderCode } : {};
      return sendError(reply, 409, 'supplier_purchase_pending', 'Supplier purchase is pending.', extra);
    }
    return reply.send({ ok: true, order: orderJson(order) });
  }

  app.get(`${PREFIX}/account/balance`, async () => ({
    ok: true,
    balance: usd(state.balanceCents),
    currency: 'USD',
  }));

  app.get(`${PREFIX}/products`, async () => ({ ok: true, products: [productJson()] }));

  app.get<{ Params: { id: string } }>(`${PREFIX}/products/:id`, async (req, reply) => {
    if (Number(req.params.id) !== state.productId) {
      return sendError(reply, 404, 'product_not_found', 'Product was not found or is not available.');
    }
    return { ok: true, product: productJson() };
  });

  app.get(`${PREFIX}/orders`, async () => ({
    ok: true,
    orders: state.orders.map((o) => ({
      orderCode: o.orderCode,
      productId: o.productId,
      quantity: 1,
      status: o.status,
      total: usd(o.totalCents),
      error: null,
      createdAt: o.createdAt,
    })),
  }));

  app.get<{ Params: { code: string } }>(`${PREFIX}/orders/:code`, async (req, reply) => {
    const order = state.orders.find((o) => o.orderCode === req.params.code);
    if (!order) return sendError(reply, 404, 'order_not_found', 'Order was not found for this API key.');
    progress(order);
    return { ok: true, order: orderJson(order) };
  });

  app.post<{ Body: { productId?: unknown; quantity?: unknown } }>(`${PREFIX}/orders`, async (req, reply) => {
    const { productId, quantity } = req.body ?? {};
    if (!Number.isInteger(productId)) return sendError(reply, 400, 'invalid_product_id', 'Invalid productId.');
    if (quantity !== 1) return sendError(reply, 400, 'invalid_quantity', 'This mock only sells quantity 1.');
    if (productId !== state.productId) {
      return sendError(reply, 404, 'product_not_found', 'Product was not found or is not available.');
    }

    const header = req.headers['x-idempotency-key'];
    const key = typeof header === 'string' ? header : undefined;
    const existing = key ? state.orders.find((o) => o.idempotencyKey === key) : undefined;
    if (key && !state.seenKeys.includes(key)) state.seenKeys.push(key);

    const fault = state.faults.shift();
    if (fault === 'server_error') {
      return sendError(reply, 500, 'internal_error', 'Simulated server error.');
    }
    if (fault === 'out_of_stock' || fault === 'insufficient_funds' || fault === 'supplier_purchase_failed') {
      return sendError(reply, ERROR_STATUS[fault], fault, `Simulated ${fault}.`);
    }

    let order = existing;
    if (order) {
      progress(order);
    } else {
      const itemNumber = key ? state.seenKeys.indexOf(key) + 1 : 0;
      const failure = state.failingItems.get(itemNumber);
      if (failure) return sendError(reply, ERROR_STATUS[failure], failure, `Simulated ${failure}.`);
      if (state.stock <= 0) return sendError(reply, 409, 'out_of_stock', 'Product is out of stock.');
      if (state.balanceCents < state.priceCents) {
        return sendError(reply, 402, 'insufficient_funds', 'Insufficient balance.');
      }
      order = createOrder(key, fault === 'pending' ? 'pending' : 'completed');
    }

    if (fault === 'timeout') {
      await new Promise((resolve) => setTimeout(resolve, state.timeoutDelayMs));
    }
    return replyWithOrder(reply, order);
  });

  const control = {
    state,
    /** Faults for the next POST /orders requests, one per request. */
    queueFaults(...faults: MockFault[]) {
      state.faults.push(...faults);
    },
    /** The nth distinct purchase (by idempotency key, 1-based) fails until cleared. */
    failNthItem(n: number, code: MockFailureCode = 'supplier_purchase_failed') {
      state.failingItems.set(n, code);
    },
    clearFailures() {
      state.faults.length = 0;
      state.failingItems.clear();
    },
    set(values: Partial<Pick<MockResellerState, 'balanceCents' | 'stock' | 'priceCents' | 'pendingPolls'>>) {
      Object.assign(state, values);
    },
    /** POST /orders requests seen so far. */
    orderRequests() {
      return state.requests.filter((r) => r.method === 'POST' && r.path === '/orders');
    },
  };

  // Same controls over HTTP for end to end runs against the standalone mock.
  app.get('/__mock/state', async () => ({
    balanceCents: state.balanceCents,
    stock: state.stock,
    priceCents: state.priceCents,
    orders: state.orders.length,
    faults: state.faults,
    failingItems: Object.fromEntries(state.failingItems),
  }));
  app.post<{
    Body: {
      set?: Parameters<typeof control.set>[0];
      faults?: MockFault[];
      failNthItem?: { n: number; code?: MockFailureCode };
      clearFailures?: boolean;
    };
  }>('/__mock/control', async (req) => {
    const body = req.body ?? {};
    if (body.clearFailures) control.clearFailures();
    if (body.set) control.set(body.set);
    if (body.faults) control.queueFaults(...body.faults);
    if (body.failNthItem) control.failNthItem(body.failNthItem.n, body.failNthItem.code);
    return { ok: true };
  });

  return { app, control };
}

export type MockReseller = ReturnType<typeof buildMockReseller>['control'] & {
  /** Base URL to give the client, including /api/reseller/v1. */
  url: string;
  close: () => Promise<void>;
};

export async function startMockReseller(
  options: MockResellerOptions & { port?: number; host?: string } = {},
): Promise<MockReseller> {
  const { app, control } = buildMockReseller(options);
  const address = await app.listen({ port: options.port ?? 0, host: options.host ?? '127.0.0.1' });
  return { ...control, url: `${address}${PREFIX}`, close: () => app.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.MOCK_RESELLER_PORT ?? 4010);
  const mock = await startMockReseller({ port });
  console.error(`mock reseller listening at ${mock.url}`);
}
