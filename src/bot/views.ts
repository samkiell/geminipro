import { HELP_HUB_TEXT, HELP_TOPICS, helpPage, type HelpContext, type HelpPage } from '../content/help.js';
import type { Order } from '../db/schema.js';
import { escapeHtml, packBlocks, type Button, type Keyboard, type OutMessage } from './telegram.js';

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
export const watTime = (d: Date) => WAT_TIME.format(d);

// Callback data, all under Telegram's 64 bytes. Ids in it are never trusted: handlers re-check
// that the order belongs to whoever tapped.
export const cb = {
  noop: 'n',
  buy: (quantity: number) => `b:${quantity}`,
  qty: (orderId: string, quantity: number) => `q:${orderId}:${quantity}`,
  draftQty: (quantity: number) => `dq:${quantity}`,
  // Buyer taps [continue] on the draft card to create the real order and checkout.
  continuePay: (orderId?: string) => (orderId ? `cp:${orderId}` : 'cp'),
  cancel: (orderId: string) => `x:${orderId}`,
  cancelDraft: 'cd',
  history: (page: number) => `h:${page}`,
  order: (orderId: string, page: number) => `o:${orderId}:${page}`,
  links: (orderId: string) => `l:${orderId}`,
  help: (page: HelpPage | 'hub') => `hp:${page}`,
  activated: (orderId: string) => `a:y:${orderId}`,
  activationHelp: (orderId: string) => `a:h:${orderId}`,
  price: (quantity: number) => `pr:${quantity}`,
  proof: 'pf',
  invite: 'inv',
  // One link: "i've activated it", then "yes" or "not yet".
  activate: (itemId: string) => `v:${itemId}`,
  activateYes: (itemId: string) => `v:y:${itemId}`,
  activateNo: (itemId: string) => `v:n:${itemId}`,
  // Channel gate: after joining, buyer taps to recheck.
  gateJoined: 'gj',
};

export function supportUrl(intl: string, orderNo?: string): string {
  const text = orderNo ? `hi, i need help with order ${orderNo}` : 'hi, i need help';
  return `https://wa.me/${intl}?text=${encodeURIComponent(text)}`;
}

export function supportButton(facts: UiFacts, orderNo?: string, label = 'need help on whatsapp'): Button {
  return { text: label, url: supportUrl(facts.supportIntl, orderNo) };
}

export function feeLine(_facts: UiFacts): string {
  return 'plus a small payment fee at checkout';
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

export function startMessage(
  firstName: string | undefined,
  facts: UiFacts,
  offerText: string,
  returning = false,
): OutMessage {
  const greeting = returning && firstName
    ? `welcome back ${firstName.toLowerCase()} 👋`
    : 'hey 👋 get google ai pro for 18 months, delivered right here after payment.';
  return {
    text: [
      greeting,
      `${naira(facts.unitPriceNgn)} per link + fee.`,
      `🔥 ${offerText}`,
    ].join('\n'),
    keyboard: [
      [{ text: 'buy a link', data: cb.buy(1) }],
      [
        { text: 'see proof', data: cb.proof },
        { text: 'how it works', data: cb.help('how') },
      ],
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

export interface DraftCardInput {
  quantity: number;
  unitPriceNgn: number;
  totalNgn: number;
  maxQuantity: number;
  offerText: string;
  facts: UiFacts;
}

export function draftCard({ quantity: q, unitPriceNgn, totalNgn, maxQuantity, offerText, facts }: DraftCardInput): OutMessage {
  const keyboard: Keyboard = [
    [
      { text: '−', data: q > 1 ? cb.draftQty(q - 1) : cb.noop },
      { text: `${q}`, data: cb.noop },
      { text: '+', data: q < maxQuantity ? cb.draftQty(q + 1) : cb.noop },
    ],
    [{ text: `continue · ${facts.grossUp ? naira(totalNgn) : `${naira(totalNgn)} + fee`}`, data: cb.continuePay() }],
    [{ text: 'cancel', data: cb.cancelDraft }],
  ];
  return {
    text: [
      'how many links?',
      `${naira(unitPriceNgn)} each + fee`,
      '⚠️ no refund if a link expires before you activate it',
      `🔥 ${offerText}`,
    ].join('\n'),
    keyboard,
  };
}

export interface PaymentCardInput {
  order: Pick<Order, 'id' | 'orderNo' | 'quantity' | 'amountNgn' | 'checkoutUrl' | 'expiresAt'>;
  facts: UiFacts;
  now?: Date;
}

export function paymentCard({ order, facts, now = new Date() }: PaymentCardInput): OutMessage {
  const expiresAt = order.expiresAt ?? new Date(now.getTime() + 15 * 60 * 1000);
  const total = facts.grossUp ? naira(order.amountNgn) : `${naira(order.amountNgn)} + fee`;
  const timeWat = watTime(expiresAt);
  const remainingSec = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  const mm = String(Math.floor(remainingSec / 60)).padStart(2, '0');
  const ss = String(remainingSec % 60).padStart(2, '0');
  const keyboard: Keyboard = [];
  if (order.checkoutUrl) {
    keyboard.push([{ text: 'pay now', url: order.checkoutUrl }]);
  }
  keyboard.push([{ text: 'cancel', data: cb.cancel(order.id) }]);
  return {
    text: [
      `order ${order.orderNo} · ${order.quantity} ${plural(order.quantity, 'link', 'links')}`,
      total,
      `⏳ pay before ${timeWat} wat · ${mm}:${ss} left`,
    ].join('\n'),
    keyboard,
  };
}

export function gateCard(channelUrl: string): OutMessage {
  return {
    text: 'join our channel to continue 👇',
    keyboard: [
      [{ text: 'join channel', url: channelUrl }],
      [{ text: 'i have joined ✅', data: cb.gateJoined }],
    ],
  };
}

export function summaryCard({ order, maxQuantity, offerText, facts }: SummaryInput): OutMessage {
  const q = order.quantity;
  const keyboard: Keyboard = [
    [
      { text: '−', data: q > 1 ? cb.qty(order.id, q - 1) : cb.noop },
      { text: `${q}`, data: cb.noop },
      { text: '+', data: q < maxQuantity ? cb.qty(order.id, q + 1) : cb.noop },
    ],
  ];
  if (order.checkoutUrl) {
    keyboard.push([{ text: `pay · ${payLabel(order, facts)}`, url: order.checkoutUrl }]);
  } else {
    keyboard.push([{ text: `continue · ${payLabel(order, facts)}`, data: cb.continuePay(order.id) }]);
  }
  keyboard.push([{ text: 'cancel', data: cb.cancel(order.id) }]);
  return {
    text: [
      `how many links?`,
      `${naira(order.unitPriceNgn)} each + fee`,
      '⚠️ no refund if a link expires before you activate it',
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
    expired: `expired ⌛ send /buy to start again`,
    cancelled: `cancelled`,
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
  /** 1-based position in the order; numbers past the quantity are replacements. */
  number: number;
  link: string;
  /** order_items.id. With it, an open link gets its own "i've activated it" button. */
  itemId?: string;
  /** Activated links are closed: shown as done, never as a link again. */
  activatedAt?: Date | null;
}

export type LinksMode = 'first' | 'more' | 'again' | 'replacement';

/** A links message, and the order_items it shows (to edit it when one of them is activated). */
export type LinksMessage = OutMessage & { itemIds: string[] };

/** How a link is named to the buyer: nothing for a lone link, else "link 2 of 3" or "replacement link". */
export function linkLabel(number: number, quantity: number, shown: number): string | undefined {
  if (quantity <= 1 && shown <= 1 && number <= 1) return undefined;
  return number > quantity ? 'replacement link' : `link ${number} of ${quantity}`;
}

/**
 * Tap-to-copy links: each in <code> (escaped), HTML parse mode, no previews, split under 4096
 * characters. Each open link has a button to mark it activated; once activated it is closed and
 * the message is edited to say so. Support and history buttons go on the last part.
 */
export function linksMessages(input: {
  orderNo: string;
  quantity: number;
  links: LinkItem[];
  mode: LinksMode;
  /** Links of this order still on the way. */
  remaining: number;
  facts: UiFacts;
}): LinksMessage[] {
  const { orderNo, quantity, links, mode, remaining, facts } = input;
  const open = links.filter((l) => !l.activatedAt);
  const tappable = open.filter((l) => l.itemId);
  const label = (l: LinkItem) => linkLabel(l.number, quantity, links.length);
  const header = {
    first: `payment confirmed ✅ order ${orderNo}`,
    more: `more of order ${orderNo} is ready ✅`,
    again: `order ${orderNo}`,
    replacement: `replacement for order ${orderNo} ✅`,
  }[mode];
  const intro =
    open.length > 0
      ? `your ${plural(open.length, 'link', 'links')}, tap to copy:`
      : `${plural(links.length, 'this link is', 'these links are')} activated ✅`;
  const linkBlocks = links.map((l) => {
    const name = label(l);
    if (l.activatedAt) {
      const done = `activated ✅ ${watDate(l.activatedAt)}, closed`;
      return name ? `${name}: ${done}` : `${done}.`;
    }
    const code = `<code>${escapeHtml(l.link)}</code>`;
    return name ? `${name}\n${code}` : code;
  });
  const still =
    remaining > 0
      ? [`the other ${remaining === 1 ? 'link is' : `${remaining} links are`} being sorted, we'll send ${plural(remaining, 'it', 'them')} here.`]
      : [];
  const footer =
    open.length > 0
      ? [
          "open the browser where you're already signed in to the google account you want it on, paste the link and activate it.",
          open.length > 1
            ? '⚠️ these links expire soon, so activate them now. if one expires before you activate it, there is no refund.'
            : '⚠️ this link expires soon, so activate it now. if it expires before you activate it, there is no refund.',
          ...(tappable.length === 1 ? ["once it's activated, tap ✅ below and i'll close it here."] : []),
          ...(tappable.length > 1 ? ["once a link is activated, tap its ✅ below and i'll close it here."] : []),
          ...still,
        ]
      : ['enjoy google ai pro!', ...still];
  const blocks = [`${header}\n${intro}`, ...linkBlocks, footer.join('\n')];
  const groups = packBlocks(blocks);

  return groups.map((group, p) => {
    // Block 0 is the header and the last one the footer; the ones between are links, in order.
    const shown = group.filter((b) => b >= 1 && b <= links.length).map((b) => links[b - 1] as LinkItem);
    const taps = shown
      .filter((l) => !l.activatedAt && l.itemId)
      .map((l) => {
        const name = label(l);
        return { text: name ? `✅ ${name.replace(/ of \d+$/, '')} activated` : "✅ i've activated it", data: cb.activate(l.itemId as string) };
      });
    const keyboard: Keyboard = [];
    for (let i = 0; i < taps.length; i += 2) keyboard.push(taps.slice(i, i + 2));
    if (p === groups.length - 1) {
      // [need help] (WhatsApp) + [invite & earn 🎁] on last message, per Prompt D §5.
      // ✅ per-link buttons are already above; these are the footer actions.
      keyboard.push([{ text: 'need help', url: supportUrl(facts.supportIntl, orderNo) }, { text: 'invite & earn 🎁', data: cb.invite }]);
    }
    return {
      text: group.map((b) => blocks[b]).join('\n'),
      html: true,
      ...(keyboard.length > 0 && { keyboard }),
      itemIds: shown.flatMap((l) => (l.itemId ? [l.itemId] : [])),
    };
  });
}

/** Swaps a link's ✅ button for a confirmation: closing a link cannot be undone. */
export function activationConfirm(itemId: string, name: string | undefined): Keyboard {
  const what = name ? name.replace(/ of \d+$/, '') : 'it';
  return [
    [{ text: `yes, ${what} is activated. close it`, data: cb.activateYes(itemId) }],
    [{ text: 'not yet', data: cb.activateNo(itemId) }],
  ];
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

export type HistoryOrder = Pick<Order, 'id' | 'orderNo' | 'quantity' | 'status' | 'createdAt' | 'paidAt'> &
  Partial<Pick<Order, 'activatedConfirmedAt'>>;

export function statusLabel(order: Pick<Order, 'status' | 'paidAt'> & Partial<Pick<Order, 'activatedConfirmedAt'>>): string {
  switch (order.status) {
    case 'delivered':
      return order.activatedConfirmedAt ? 'activated ✅' : 'delivered ✅';
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
  openLinks,
  activatedLinks = 0,
  facts,
}: {
  order: StatusOrder & Pick<Order, 'id' | 'checkoutUrl'>;
  page: number;
  /** Delivered links not activated yet: only these can be shown again. */
  openLinks: number;
  activatedLinks?: number;
  facts: UiFacts;
}): OutMessage {
  const keyboard: Keyboard = [];
  if (openLinks > 0) keyboard.push([{ text: 'show my links', data: cb.links(order.id) }]);
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
      ...(activatedLinks > 0 ? [`activated: ${activatedLinks} ${plural(activatedLinks, 'link', 'links')} ✅ (closed)`] : []),
    ].join('\n'),
    keyboard,
  };
}

// ---------------------------------------------------------------- help hub

export function helpHub(facts: UiFacts): OutMessage {
  const topics = HELP_TOPICS.map((t) => ({ text: t.label, data: cb.help(t.page) }));
  const keyboard: Keyboard = [];
  for (let i = 0; i < topics.length; i += 2) keyboard.push(topics.slice(i, i + 2));
  keyboard.push([{ text: 'see proof', data: cb.proof }, { text: 'my orders', data: cb.history(1) }]);
  keyboard.push([supportButton(facts, undefined, 'support')]);
  return { text: HELP_HUB_TEXT, keyboard };
}

// ---------------------------------------------------------------- price (no order yet)

/** "3 links: ₦10,500 + fee" with a buy button. `totalNgn` already includes the fee when grossed up. */
export function priceView(quantity: number, totalNgn: number, facts: UiFacts): OutMessage {
  const q = Math.max(1, quantity);
  const total = facts.grossUp ? `${naira(totalNgn)} in total` : `${naira(totalNgn)} + fee`;
  return {
    text: q === 1 ? `one link is ${total}. it lands here about a minute after you pay.` : `${q} links come to ${total}. they land here about a minute after you pay.`,
    keyboard: [[{ text: q === 1 ? 'buy a link' : `buy ${q}`, data: cb.buy(q) }, { text: 'see proof', data: cb.proof }]],
  };
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
    text: `did you activate your ${plural(order.quantity, 'link', 'links')}? order ${order.orderNo}\nif yes, tap below and i'll close ${plural(order.quantity, 'it', 'them')} here.`,
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
