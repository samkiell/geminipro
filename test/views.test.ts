import { describe, expect, it } from 'vitest';
import { packMessages } from '../src/bot/telegram.js';
import {
  historyList,
  helpHub,
  helpView,
  linksMessages,
  orderCard,
  reminderMessage,
  renderStatus,
  startMessage,
  summaryCard,
  summaryResolved,
  supportUrl,
  type StatusOrder,
} from '../src/bot/views.js';
import { HELP_TOPICS, POLICY_TEXT } from '../src/content/help.js';
import type { OrderStatus } from '../src/db/schema.js';
import { DEFAULT_OFFER_TEXT } from '../src/services/settings.js';
import { facts } from './helpers/telegram.js';

const order = {
  id: '11111111-2222-4333-8444-555555555555',
  orderNo: 'GP-1042',
  quantity: 2,
  unitPriceNgn: 3500,
  feeNgn: 0,
  amountNgn: 7000,
  checkoutUrl: 'https://sandbox-checkout.bachs.io/c/abc',
};
const statusOrder = (status: OrderStatus, paid = true): StatusOrder => ({
  orderNo: 'GP-1042',
  status,
  quantity: 2,
  amountNgn: 7000,
  createdAt: new Date('2026-10-26T13:00:00Z'),
  paidAt: paid ? new Date('2026-10-26T13:05:00Z') : null,
  deliveredAt: status === 'delivered' ? new Date('2026-10-26T13:06:00Z') : null,
});
const ALL_STATUSES: OrderStatus[] = [
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
];
const DASHES = /[–—]/;
const DATES = /\b\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w* \d{4}\b|\b20\d\d-\d\d-\d\d\b/i;

describe('summary card', () => {
  it('shows the breakdown, the no refund line, the offer text and the buttons', () => {
    const card = summaryCard({ order, maxQuantity: 5, offerText: DEFAULT_OFFER_TEXT, facts });
    expect(card.text).toBe(
      [
        'order summary · GP-1042',
        'quantity: 2 links',
        'price per link: ₦3,500',
        'payment fee: added at checkout (card 2%, bank transfer 1.5%)',
        'total: ₦7,000 + fee',
        'you can buy up to 5 right now.',
        '⚠️ no refund if the link expires before you activate it.',
        '🔥 offer ending very soon',
      ].join('\n'),
    );
    expect(card.keyboard).toEqual([
      [
        { text: '−', data: `q:${order.id}:1` },
        { text: '2', data: 'n' },
        { text: '+', data: `q:${order.id}:3` },
      ],
      [{ text: 'pay ₦7,000 + fee', url: order.checkoutUrl }],
      [{ text: 'cancel', data: `x:${order.id}` }],
    ]);
    for (const row of card.keyboard ?? []) for (const b of row) if ('data' in b) expect(b.data.length).toBeLessThanOrEqual(64);
  });

  it('the stepper stops at 1 and at what is available', () => {
    const one = summaryCard({ order: { ...order, quantity: 1 }, maxQuantity: 5, offerText: 'x', facts });
    expect(one.keyboard?.[0]?.[0]).toEqual({ text: '−', data: 'n' });
    const top = summaryCard({ order: { ...order, quantity: 5 }, maxQuantity: 5, offerText: 'x', facts });
    expect(top.keyboard?.[0]?.[2]).toEqual({ text: '+', data: 'n' });
  });

  it('with gross up the fee is in the total', () => {
    const card = summaryCard({
      order: { ...order, quantity: 1, feeNgn: 72, amountNgn: 3572 },
      maxQuantity: 5,
      offerText: 'x',
      facts: { ...facts, grossUp: true },
    });
    expect(card.text).toContain('payment fee: ₦72');
    expect(card.text).toContain('total: ₦3,572');
    expect(card.keyboard?.[1]?.[0]?.text).toBe('pay ₦3,572');
  });

  it('collapses to one line with no buttons once its job is done', () => {
    expect(summaryResolved(order, 'paid')).toEqual({ text: 'paid ✅ order GP-1042' });
    expect(summaryResolved(order, 'expired').text).toBe('expired ⌛ order GP-1042. send /buy to start again.');
    expect(summaryResolved(order, 'cancelled').text).toBe('cancelled · order GP-1042');
    expect(summaryResolved(order, 'held').keyboard).toBeUndefined();
  });
});

describe('status message', () => {
  it('ticks the steps as the order moves', () => {
    expect(renderStatus(statusOrder('awaiting_payment', false), facts).text).toBe(
      [
        'order GP-1042',
        '✅ order created',
        '⏳ waiting for payment',
        '⬜ payment received',
        '⬜ getting your links',
        '⬜ delivered',
        'pay within 15 minutes.',
      ].join('\n'),
    );
    expect(renderStatus(statusOrder('fulfilling'), facts).text).toContain('✅ payment received\n⏳ getting your links\n⬜ delivered');
  });

  it('the delivered state is the receipt, in WAT', () => {
    const text = renderStatus(statusOrder('delivered'), facts).text;
    expect(text).toContain('✅ delivered');
    expect(text).toContain('receipt: 2 links · ₦7,000 paid + fee');
    expect(text).toContain('paid 26 oct, 14:05 wat');
  });

  it('renders every state in plain words, without dashes or buttons', () => {
    for (const status of ALL_STATUSES) {
      for (const paid of [true, false]) {
        const message = renderStatus(statusOrder(status, paid), facts);
        expect(message.text.startsWith('order GP-1042')).toBe(true);
        expect(message.text).not.toMatch(DASHES);
        expect(message.keyboard).toBeUndefined();
      }
    }
    expect(renderStatus(statusOrder('partial'), facts).text).toContain('some links are ready, the rest are being sorted');
    expect(renderStatus(statusOrder('needs_attention'), facts).text).toContain('needs a quick check by support');
    expect(renderStatus(statusOrder('needs_attention', false), facts).text).toContain("we're checking your payment");
    expect(renderStatus(statusOrder('expired', false), facts).text).toContain('payment window closed');
  });
});

describe('links messages', () => {
  it('one link: the fixed template with the link in a code block', () => {
    const [message, ...rest] = linksMessages({
      orderNo: 'GP-1042',
      quantity: 1,
      links: [{ number: 1, link: 'https://one.google.com/x' }],
      mode: 'first',
      remaining: 0,
      facts,
    });
    expect(rest).toEqual([]);
    expect(message?.html).toBe(true);
    expect(message?.text).toBe(
      [
        'payment confirmed ✅ order GP-1042',
        'your link, tap to copy:',
        '<code>https://one.google.com/x</code>',
        "open the browser where you're already signed in to the google account you want it on, paste the link and activate it.",
        '⚠️ this link expires soon, so activate it now. if it expires before you activate it, there is no refund.',
      ].join('\n'),
    );
    expect(message?.keyboard).toEqual([
      [
        { text: 'need help on whatsapp', url: supportUrl('2348087357158', 'GP-1042') },
        { text: 'my orders', data: 'h:1' },
      ],
    ]);
  });

  it('several links are numbered, escaped, and never shown as plain urls', () => {
    const [message] = linksMessages({
      orderNo: 'GP-1042',
      quantity: 3,
      links: [
        { number: 1, link: 'https://a.test/1?x=1&y=2' },
        { number: 3, link: 'https://a.test/<3>' },
      ],
      mode: 'first',
      remaining: 1,
      facts,
    });
    expect(message?.text).toContain('your links, tap to copy:');
    expect(message?.text).toContain('link 1 of 3\n<code>https://a.test/1?x=1&amp;y=2</code>');
    expect(message?.text).toContain('link 3 of 3\n<code>https://a.test/&lt;3&gt;</code>');
    expect(message?.text).toContain("the other link is being sorted, we'll send it here.");
    expect(message?.text.replace(/<code>[^<]*<\/code>/g, '')).not.toMatch(/https?:\/\//);
  });

  it('packs blocks into messages under the limit without splitting a block', () => {
    const blocks = Array.from({ length: 12 }, (_, i) => `${i}:${'x'.repeat(900)}`);
    const parts = packMessages(blocks);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(4000);
    expect(parts.join('\n').split('\n')).toEqual(blocks);
  });
});

describe('history and order card', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    orderNo: `GP-10${40 + i}`,
    quantity: i + 1,
    status: 'delivered' as const,
    createdAt: new Date('2026-10-26T12:00:00Z'),
    paidAt: new Date('2026-10-26T12:00:00Z'),
  }));

  it('lists orders as buttons with prev and next', () => {
    const view = historyList({ orders: rows, page: 2, hasNext: true });
    expect(view.keyboard?.[0]).toEqual([{ text: 'GP-1040 · 1 link · 26 oct · delivered ✅', data: `o:${rows[0]?.id}:2` }]);
    expect(view.keyboard?.at(-1)).toEqual([
      { text: '‹ newer', data: 'h:1' },
      { text: 'older ›', data: 'h:3' },
    ]);
  });

  it('empty history offers to buy', () => {
    expect(historyList({ orders: [], page: 1, hasNext: false })).toEqual({
      text: "you haven't bought anything yet. tap below to get your first link.",
      keyboard: [[{ text: 'buy now', data: 'b:1' }]],
    });
  });

  it('the order card offers links only when there are some', () => {
    const base = { ...statusOrder('delivered'), id: order.id, checkoutUrl: null };
    const withLinks = orderCard({ order: base, page: 2, hasLinks: true, facts });
    expect(withLinks.keyboard?.flat().map((b) => b.text)).toEqual(['show my links', 'need help on whatsapp', '‹ back to my orders']);
    expect(withLinks.keyboard?.at(-1)?.[0]).toEqual({ text: '‹ back to my orders', data: 'h:2' });
    expect(orderCard({ order: base, page: 1, hasLinks: false, facts }).keyboard?.flat().map((b) => b.text)).not.toContain(
      'show my links',
    );
  });
});

describe('help, start, support, reminder', () => {
  it('the hub links every topic, my orders and support', () => {
    const hub = helpHub(facts);
    const labels = hub.keyboard?.flat().map((b) => b.text) ?? [];
    for (const topic of HELP_TOPICS) expect(labels).toContain(topic.label);
    expect(labels).toEqual(expect.arrayContaining(['my orders', 'support']));
  });

  it('no help page, start message or card ever states a date, and none uses dashes', () => {
    const texts = [
      ...HELP_TOPICS.map((t) => helpView(t.page, facts, DEFAULT_OFFER_TEXT).text),
      startMessage('Sam', facts, DEFAULT_OFFER_TEXT).text,
      summaryCard({ order, maxQuantity: 5, offerText: DEFAULT_OFFER_TEXT, facts }).text,
      POLICY_TEXT,
    ];
    for (const text of texts) {
      expect(text).not.toMatch(DATES);
      expect(text).not.toMatch(DASHES);
      expect(text).not.toMatch(/29 oct/i);
    }
    expect(helpView('offer', facts, 'last few links left').text).toContain('🔥 last few links left.');
  });

  it('the policy says replacements are not guaranteed and unused links are not refunded', () => {
    expect(POLICY_TEXT).toContain('replace them where possible, as soon as you report it, but a replacement is not guaranteed');
    expect(POLICY_TEXT).toContain('links left to expire unused are not refunded');
    expect(helpView('policy', facts, 'x').text).not.toMatch(/vpn/i);
  });

  it('support links open whatsapp with the order number filled in', () => {
    expect(supportUrl('2348087357158', 'GP-1042')).toBe(
      'https://wa.me/2348087357158?text=hi%2C%20i%20need%20help%20with%20order%20GP-1042',
    );
    expect(supportUrl('2348087357158')).toBe('https://wa.me/2348087357158?text=hi%2C%20i%20need%20help');
  });

  it('the activation reminder asks with two buttons', () => {
    expect(reminderMessage({ id: order.id, orderNo: 'GP-1042', quantity: 1 })).toEqual({
      text: 'did you activate your link? order GP-1042',
      keyboard: [
        [
          { text: 'yes, activated ✅', data: `a:y:${order.id}` },
          { text: 'i need help', data: `a:h:${order.id}` },
        ],
      ],
    });
  });
});
