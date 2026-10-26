import { HELP_HUB_TEXT, HELP_TOPICS, helpPage, type HelpContext, type HelpPage } from '../content/help.js';
import type { Order } from '../db/schema.js';
import { escapeHtml, packMessages, type Button, type Keyboard, type OutMessage } from './telegram.js';

// Pure renderers: data in, message out. Every buyer facing text in the bot's own voice lives here
// or in content/help.ts. Lowercase, short, no em dashes.

export interface UiFacts {
  unitPriceNgn: number;
  grossUp: boolean;
  supportIntl: string;
  supportLocal: string;
  maxQtyPerOrder: number;
  paymentWindowMinutes: number;
}

export const naira = (amount: number) => `₦${amount.toLocaleString('en-NG')}`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const WAT_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short' });
const WAT_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Lagos',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
export const watDate = (d: Date) => WAT_DATE.format(d).toLowerCase();
export const watDateTime = (d: Date) => `${watDate(d)}, ${WAT_TIME.format(d)} wat`;

// Callback data, all under Telegram's 64 bytes. Ids in it are never trusted: handlers re-check
// that the order belongs to whoever tapped.
export const cb = {
  noop: 'n',
  buy: (quantity: number) => `b:${quantity}`,
  qty: (orderId: string, quantity: number) => `q:${orderId}:${quantity}`,
  cancel: (orderId: string) => `x:${orderId}`,
  history: (page: number) => `h:${page}`,
  order: (orderId: string, page: number) => `o:${orderId}:${page}`,
  links: (orderId: string) => `l:${orderId}`,
  help: (page: HelpPage | 'hub') => `hp:${page}`,
  activated: (orderId: string) => `a:y:${orderId}`,
  activationHelp: (orderId: string) => `a:h:${orderId}`,
};

export function supportUrl(intl: string, orderNo?: string): string {
  const text = orderNo ? `hi, i need help with order ${orderNo}` : 'hi, i need help';
  return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
}

export function supportButton(facts: UiFacts, orderNo?: string, label = 'need help on whatsapp'): Button {
  return { text: label, url: supportUrl(facts.supportIntl, orderNo) };
}

export function feeLine(facts: UiFacts): string {
  return facts.grossUp ? 'payment fee included in the total' : 'plus a small payment fee at checkout (card 2%, bank transfer 1.5%)';
}

export function helpContext(facts: UiFacts, offerText: string): HelpContext {
  return {
    unitPriceNgn: facts.unitPriceNgn,
    feeLine: feeLine(facts),
    supportLocal: facts.supportLocal,
    offerText,
    maxQtyPerOrder: facts.maxQtyPerOrder,
    paymentWindowMinutes: facts.paymentWindowMinutes,
  };
}

// ---------------------------------------------------------------- start

export function startMessage(firstName: string | undefined, facts: UiFacts, offerText: string): OutMessage {
  const hi = firstName ? `hi ${firstName.toLowerCase()}!` : 'hi!';
  return {
    text: [
      `${hi} i sell google ai pro 18 month activation links for ${naira(facts.unitPriceNgn)} each.`,
      'pay here and your link comes to this chat automatically. ask me anything, or tap below.',
      `🔥 ${offerText}`,
    ].join('\n'),
    keyboard: [
      [{ text: 'buy a link', data: cb.buy(1) }],
      [
        { text: 'my orders', data: cb.history(1) },
        { text: 'how it works', data: cb.help('how') },
      ],
      [{ text: 'help', data: cb.help('hub') }],
    ],
  };
}

// ---------------------------------------------------------------- summary card (before payment)

export interface SummaryInput {
  order: Pick<Order, 'id' | 'orderNo' | 'quantity' | 'unitPriceNgn' | 'feeNgn' | 'amountNgn' | 'checkoutUrl'>;
  /** Most this buyer can have in this order right now. */
  maxQuantity: number;
  offerText: string;
  facts: UiFacts;
}

export function payLabel(order: Pick<Order, 'amountNgn'>, facts: UiFacts): string {
  return facts.grossUp ? naira(order.amountNgn) : `${naira(order.amountNgn)} + fee`;
}

export function summaryCard({ order, maxQuantity, offerText, facts }: SummaryInput): OutMessage {
  const q = order.quantity;
  const fee = facts.grossUp
    ? `payment fee: ${naira(order.feeNgn)}`
    : 'payment fee: added at checkout (card 2%, bank transfer 1.5%)';
  const keyboard: Keyboard = [
    [
      { text: '−', data: q > 1 ? cb.qty(order.id, q - 1) : cb.noop },
      { text: `${q}`, data: cb.noop },
      { text: '+', data: q < maxQuantity ? cb.qty(order.id, q + 1) : cb.noop },
    ],
  ];
  if (order.checkoutUrl) keyboard.push([{ text: `pay ${payLabel(order, facts)}`, url: order.checkoutUrl }]);
  keyboard.push([{ text: 'cancel', data: cb.cancel(order.id) }]);
  return {
    text: [
      `order summary · ${order.orderNo}`,
      `quantity: ${q} ${plural(q, 'link', 'links')}`,
      `price per link: ${naira(order.unitPriceNgn)}`,
      fee,
      `total: ${payLabel(order, facts)}`,
      `you can buy up to ${maxQuantity} right now.`,
      '⚠️ no refund if the link expires before you activate it.',
      `🔥 ${offerText}`,
    ].join('\n'),
    keyboard,
  };
}

export type SummaryOutcome = 'paid' | 'held' | 'expired' | 'cancelled';

/** What the summary card collapses to once its job is done. No buttons. */
export function summaryResolved(order: Pick<Order, 'orderNo'>, outcome: SummaryOutcome): OutMessage {
  const text = {
    paid: `paid ✅ order ${order.orderNo}`,
    held: `payment received, being checked · order ${order.orderNo}`,
    expired: `expired ⌛ order ${order.orderNo}. send /buy to start again.`,
    cancelled: `cancelled · order ${order.orderNo}`,
  }[outcome];
  return { text };
}

// ---------------------------------------------------------------- live status and receipt

export type StatusOrder = Pick<
  Order,
  'orderNo' | 'status' | 'quantity' | 'amountNgn' | 'paidAt' | 'deliveredAt' | 'createdAt'
>;

export function renderStatus(order: StatusOrder, facts: UiFacts): OutMessage {
  const q = order.quantity;
  const getting = `getting your ${plural(q, 'link', 'links')}`;
  const steps = ['order created', 'waiting for payment', 'payment received', getting, 'delivered'];
  const tick = (marks: string[], extra: string[] = []) =>
    [`order ${order.orderNo}`, ...steps.map((s, i) => `${marks[i] ?? '⬜'} ${s}`), ...extra].join('\n');

  let text: string;
  switch (order.status) {
    case 'created':
    case 'awaiting_payment':
      text = tick(['✅', '⏳'], [`pay within ${facts.paymentWindowMinutes} minutes.`]);
      break;
    case 'paid':
    case 'fulfilling':
      text = tick(['✅', '✅', '✅', '⏳']);
      break;
    case 'partial':
      text = tick(['✅', '✅', '✅', '⏳'], ["some links are ready, the rest are being sorted. we'll message you here."]);
      break;
    case 'delivered':
      text = tick(['✅', '✅', '✅', '✅', '✅'], [
        '',
        `receipt: ${q} ${plural(q, 'link', 'links')} · ${naira(order.amountNgn)} paid${facts.grossUp ? '' : ' + fee'}`,
        order.paidAt ? `paid ${watDateTime(order.paidAt)}` : '',
      ].filter(Boolean));
      break;
    case 'needs_attention':
      text = order.paidAt
        ? tick(['✅', '✅', '✅', '⚠️'], [
            `your order needs a quick check by support. we'll message you here, or whatsapp ${facts.supportLocal}.`,
          ])
        : `order ${order.orderNo}\n✅ order created\n⚠️ we're checking your payment. support will message you here, or whatsapp ${facts.supportLocal}.`;
      break;
    case 'expired':
      text = `order ${order.orderNo}\n✅ order created\n⌛ payment window closed. send /buy to start again.`;
      break;
    case 'cancelled':
      text = `order ${order.orderNo}\ncancelled.`;
      break;
    case 'refunded':
      text = `order ${order.orderNo}\nrefunded.`;
      break;
  }
  return { text };
}

// ---------------------------------------------------------------- links (delivery and "show my links")

export interface LinkItem {
  /** 1-based position in the order. */
  number: number;
  link: string;
}

export type LinksMode = 'first' | 'more' | 'again';

/**
 * Tap-to-copy links: each in <code> (escaped), HTML parse mode, no previews, split under 4096
 * characters. Buttons only on the last part. These messages are never edited or deleted.
 */
export function linksMessages(input: {
  orderNo: string;
  quantity: number;
  links: LinkItem[];
  mode: LinksMode;
  /** Links of this order still on the way. */
  remaining: number;
  facts: UiFacts;
}): OutMessage[] {
  const { orderNo, quantity, links, mode, remaining, facts } = input;
  const many = links.length > 1;
  const header = {
    first: `payment confirmed ✅ order ${orderNo}`,
    more: `more of order ${orderNo} is ready ✅`,
    again: `order ${orderNo}`,
  }[mode];
  const blocks = [
    `${header}\nyour ${plural(links.length, 'link', 'links')}, tap to copy:`,
    ...links.map(({ number, link }) =>
      quantity > 1 ? `link ${number} of ${quantity}\n<code>${escapeHtml(link)}</code>` : `<code>${escapeHtml(link)}</code>`,
    ),
    [
      "open the browser where you're already signed in to the google account you want it on, paste the link and activate it.",
      many
        ? '⚠️ these links expire soon, so activate them now. if one expires before you activate it, there is no refund.'
        : '⚠️ this link expires soon, so activate it now. if it expires before you activate it, there is no refund.',
      ...(remaining > 0
        ? [`the other ${remaining === 1 ? 'link is' : `${remaining} links are`} being sorted, we'll send ${plural(remaining, 'it', 'them')} here.`]
        : []),
    ].join('\n'),
  ];
  const parts = packMessages(blocks);
  return parts.map((text, i) => ({
    text,
    html: true,
    ...(i === parts.length - 1 && {
      keyboard: [[supportButton(facts, orderNo), { text: 'my orders', data: cb.history(1) }]],
    }),
  }));
}

/** Sent once when a paid order could not be fulfilled at all on the first try. */
export function delayedMessage(order: Pick<Order, 'orderNo' | 'quantity'>, facts: UiFacts): OutMessage {
  const one = order.quantity === 1;
  return {
    text: [
      `payment confirmed ✅ order ${order.orderNo}`,
      `${one ? 'your link is' : 'your links are'} taking a little longer than usual. we're on it and will send ${one ? 'it' : 'them'} here, no need to pay again.`,
    ].join('\n'),
    keyboard: [[supportButton(facts, order.orderNo)]],
  };
}

// ---------------------------------------------------------------- history and order card

export type HistoryOrder = Pick<Order, 'id' | 'orderNo' | 'quantity' | 'status' | 'createdAt' | 'paidAt'>;

export function statusLabel(order: Pick<Order, 'status' | 'paidAt'>): string {
  switch (order.status) {
    case 'delivered':
      return 'delivered ✅';
    case 'created':
    case 'awaiting_payment':
      return 'waiting for payment ⏳';
    case 'paid':
    case 'fulfilling':
      return 'paid, preparing ⏳';
    case 'partial':
      return 'partly sent ⏳';
    case 'needs_attention':
      return order.paidAt ? 'being checked ⚠️' : 'payment being checked ⚠️';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'cancelled';
    case 'refunded':
      return 'refunded';
  }
}

export function historyList({ orders, page, hasNext }: { orders: HistoryOrder[]; page: number; hasNext: boolean }): OutMessage {
  if (orders.length === 0 && page === 1) {
    return {
      text: "you haven't bought anything yet. tap below to get your first link.",
      keyboard: [[{ text: 'buy now', data: cb.buy(1) }]],
    };
  }
  const keyboard: Keyboard = orders.map((o) => [
    {
      text: `${o.orderNo} · ${o.quantity} ${plural(o.quantity, 'link', 'links')} · ${watDate(o.createdAt)} · ${statusLabel(o)}`,
      data: cb.order(o.id, page),
    },
  ]);
  const nav: Button[] = [];
  if (page > 1) nav.push({ text: '‹ newer', data: cb.history(page - 1) });
  if (hasNext) nav.push({ text: 'older ›', data: cb.history(page + 1) });
  if (nav.length > 0) keyboard.push(nav);
  return { text: `your orders${page > 1 ? ` (page ${page})` : ''}. tap one to see it.`, keyboard };
}

export function orderCard({
  order,
  page,
  hasLinks,
  facts,
}: {
  order: StatusOrder & Pick<Order, 'id' | 'checkoutUrl'>;
  page: number;
  hasLinks: boolean;
  facts: UiFacts;
}): OutMessage {
  const keyboard: Keyboard = [];
  if (hasLinks) keyboard.push([{ text: 'show my links', data: cb.links(order.id) }]);
  if ((order.status === 'awaiting_payment' || order.status === 'created') && order.checkoutUrl) {
    keyboard.push([{ text: `pay ${payLabel(order, facts)}`, url: order.checkoutUrl }]);
  }
  keyboard.push([supportButton(facts, order.orderNo)]);
  keyboard.push([{ text: '‹ back to my orders', data: cb.history(page) }]);
  return {
    text: [
      renderStatus(order, facts).text,
      '',
      `${order.quantity} ${plural(order.quantity, 'link', 'links')} · ${naira(order.amountNgn)}${facts.grossUp ? '' : ' + fee'}`,
      `ordered ${watDateTime(order.createdAt)}`,
    ].join('\n'),
    keyboard,
  };
}

// ---------------------------------------------------------------- help hub

export function helpHub(facts: UiFacts): OutMessage {
  const topics = HELP_TOPICS.map((t) => ({ text: t.label, data: cb.help(t.page) }));
  const keyboard: Keyboard = [];
  for (let i = 0; i < topics.length; i += 2) keyboard.push(topics.slice(i, i + 2));
  keyboard.push([{ text: 'my orders', data: cb.history(1) }, supportButton(facts, undefined, 'support')]);
  return { text: HELP_HUB_TEXT, keyboard };
}

export function helpView(page: HelpPage, facts: UiFacts, offerText: string): OutMessage {
  const keyboard: Keyboard = [];
  if (page === 'how' || page === 'get' || page === 'offer') keyboard.push([{ text: 'buy a link', data: cb.buy(1) }]);
  if (page === 'policy' || page === 'plan') keyboard.push([supportButton(facts)]);
  keyboard.push([{ text: '‹ back', data: cb.help('hub') }]);
  return { text: helpPage(page, helpContext(facts, offerText)), keyboard };
}

// ---------------------------------------------------------------- activation reminder

export function reminderMessage(order: Pick<Order, 'id' | 'orderNo' | 'quantity'>): OutMessage {
  return {
    text: `did you activate your ${plural(order.quantity, 'link', 'links')}? order ${order.orderNo}`,
    keyboard: [
      [
        { text: 'yes, activated ✅', data: cb.activated(order.id) },
        { text: 'i need help', data: cb.activationHelp(order.id) },
      ],
    ],
  };
}

export function activatedReply(order: Pick<Order, 'orderNo'>): OutMessage {
  return { text: `great, enjoy google ai pro ✅ order ${order.orderNo}` };
}

export function activationHelpReply(order: Pick<Order, 'orderNo'>, facts: UiFacts): OutMessage {
  return {
    text: `no problem. tap below to message support on whatsapp about order ${order.orderNo}, they'll sort you out.`,
    keyboard: [[supportButton(facts, order.orderNo)]],
  };
}

export const STALE_BUTTON = 'this button has expired';
