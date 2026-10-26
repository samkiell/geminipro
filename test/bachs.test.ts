import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BachsClient,
  BachsError,
  bachsBaseUrl,
  toMinorUnits,
  verifyWebhookSignature,
} from '../src/services/bachs.js';

const SECRET = 'whsec_test_secret';
const sign = (timestamp: number, body: string, secret = SECRET) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

describe('verifyWebhookSignature', () => {
  const body = '{"id":"evt_1","type":"checkout.completed"}';
  const now = 1_800_000_000;

  it('accepts a valid V2 signature', () => {
    const headers = { 'x-bachs-signature-v2': `t=${now},v1=${sign(now, body)}` };
    expect(verifyWebhookSignature(Buffer.from(body), headers, SECRET, { nowSeconds: now })).toBe(true);
  });

  it('accepts any matching v1 value during a secret rotation', () => {
    const headers = { 'x-bachs-signature-v2': `t=${now},v1=${sign(now, body, 'old')},v1=${sign(now, body)}` };
    expect(verifyWebhookSignature(Buffer.from(body), headers, SECRET, { nowSeconds: now })).toBe(true);
  });

  it('accepts the legacy timestamp and signature headers', () => {
    const headers = { 'x-bachs-timestamp': String(now), 'x-bachs-signature': sign(now, body) };
    expect(verifyWebhookSignature(Buffer.from(body), headers, SECRET, { nowSeconds: now })).toBe(true);
  });

  it('rejects a tampered body, a wrong secret, a stale timestamp and missing headers', () => {
    const headers = { 'x-bachs-signature-v2': `t=${now},v1=${sign(now, body)}` };
    expect(verifyWebhookSignature(Buffer.from(body.replace('evt_1', 'evt_2')), headers, SECRET, { nowSeconds: now })).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(body), headers, 'other', { nowSeconds: now })).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(body), headers, SECRET, { nowSeconds: now + 301 })).toBe(false);
    expect(verifyWebhookSignature(Buffer.from(body), {}, SECRET, { nowSeconds: now })).toBe(false);
    expect(
      verifyWebhookSignature(Buffer.from(body), { 'x-bachs-signature-v2': `t=${now},v1=short` }, SECRET, { nowSeconds: now }),
    ).toBe(false);
  });
});

describe('toMinorUnits', () => {
  it('parses decimal strings exactly', () => {
    expect(toMinorUnits('3500.00')).toBe(350_000);
    expect(toMinorUnits('3500')).toBe(350_000);
    expect(toMinorUnits('3500.5')).toBe(350_050);
    expect(toMinorUnits('0.07')).toBe(7);
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'abc', '-1.00', '1.234', '1e3']) expect(() => toMinorUnits(bad)).toThrow(RangeError);
  });
});

describe('bachsBaseUrl', () => {
  it('picks the environment from the key', () => {
    expect(bachsBaseUrl('sk_live_x')).toBe('https://api.bachs.io');
    expect(bachsBaseUrl('sk_sandbox_x')).toBe('https://sandbox-api.bachs.io');
  });
});

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(responses: Array<{ status: number; body: unknown } | 'timeout'>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift();
    if (!next || next === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const checkoutInput = {
  orderId: 'b1c2',
  reference: 'gp_b1c2',
  amountNgn: 10_500,
  quantity: 3,
  telegramId: 42,
  expiresInMinutes: 15,
  returnUrl: 'https://t.me/geminiprosamkiel_bot',
};
const created = {
  checkout_id: 'chk_1',
  checkout_url: 'https://checkout.bachs.io/c/abc',
  status: 'open',
  expires_at: '2026-10-26T12:15:00Z',
};

describe('BachsClient.createCheckout', () => {
  it('creates an NGN checkout tied to the order', async () => {
    const { fetch, calls } = fakeFetch([{ status: 201, body: created }]);
    const client = new BachsClient({ secretKey: 'sk_sandbox_abc', fetch });
    const checkout = await client.createCheckout(checkoutInput);

    expect(checkout).toEqual({
      checkoutId: 'chk_1',
      checkoutUrl: 'https://checkout.bachs.io/c/abc',
      expiresAt: new Date('2026-10-26T12:15:00Z'),
    });
    const [call] = calls;
    expect(call?.url).toBe('https://sandbox-api.bachs.io/v1/checkout-sessions');
    expect(call?.method).toBe('POST');
    expect(call?.headers.Authorization).toBe('Bearer sk_sandbox_abc');
    expect(call?.headers['Idempotency-Key']).toBe('checkout_b1c2');
    expect(call?.body).toEqual({
      pricing: { currency: 'NGN', amount: '10500.00' },
      reference: 'gp_b1c2',
      metadata: { order_id: 'b1c2', telegram_id: '42', quantity: '3' },
      customer: { email: '42@tg.samkiel.dev' },
      payment_method_types: ['NGN_CARD', 'NGN_BANK_TRANSFER'],
      expires_in_minutes: 15,
      success_url: 'https://t.me/geminiprosamkiel_bot',
      cancel_url: 'https://t.me/geminiprosamkiel_bot',
    });
  });

  it('retries a timeout or 5xx once with the same idempotency key', async () => {
    const { fetch, calls } = fakeFetch(['timeout', { status: 201, body: created }]);
    const client = new BachsClient({ secretKey: 'sk_sandbox_abc', fetch, backoffMs: 1 });
    await expect(client.createCheckout(checkoutInput)).resolves.toMatchObject({ checkoutId: 'chk_1' });
    expect(calls.map((c) => c.headers['Idempotency-Key'])).toEqual(['checkout_b1c2', 'checkout_b1c2']);
    expect(calls[0]?.body).toEqual(calls[1]?.body);

    const failing = fakeFetch([
      { status: 502, body: {} },
      { status: 503, body: {} },
    ]);
    const err = await new BachsClient({ secretKey: 'sk_sandbox_abc', fetch: failing.fetch, backoffMs: 1 })
      .createCheckout(checkoutInput)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BachsError);
    expect(err).toMatchObject({ code: 'server_error', retryable: true });
    expect(failing.calls).toHaveLength(2);
  });

  it('maps API errors to their error_code without retrying', async () => {
    const { fetch, calls } = fakeFetch([
      { status: 400, body: { detail: 'Missing required field(s): pricing', error_code: 'VALIDATION_ERROR' } },
    ]);
    const err = await new BachsClient({ secretKey: 'sk_sandbox_abc', fetch })
      .createCheckout(checkoutInput)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'VALIDATION_ERROR', status: 400, retryable: false });
    expect(calls).toHaveLength(1);
  });
});

describe('BachsClient.getCheckout', () => {
  it('reads status, amount in minor units and reference', async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 200,
        body: {
          checkout_id: 'chk_1',
          status: 'completed',
          payment_status: 'succeeded',
          amount: '3500.00',
          currency: 'NGN',
          reference: 'gp_b1c2',
          customer: null,
          created_at: '2026-10-26T12:00:00Z',
          updated_at: '2026-10-26T12:01:00Z',
          some_new_field: true,
        },
      },
    ]);
    const session = await new BachsClient({ secretKey: 'sk_live_abc', fetch }).getCheckout('chk_1');
    expect(calls[0]?.url).toBe('https://api.bachs.io/v1/checkout-sessions/chk_1');
    expect(session).toEqual({
      checkoutId: 'chk_1',
      status: 'completed',
      paymentStatus: 'succeeded',
      amountMinor: 350_000,
      currency: 'NGN',
      reference: 'gp_b1c2',
    });
  });

  it('treats an unexpected body as invalid_response', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: { checkout_id: 'chk_1' } }]);
    const err = await new BachsClient({ secretKey: 'sk_live_abc', fetch }).getCheckout('chk_1').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid_response' });
  });
});
