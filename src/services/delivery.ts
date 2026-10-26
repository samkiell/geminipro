import { Api, GrammyError } from 'grammy';

// Fixed templates (docs/PRD.md 8.5): links never pass through the LLM, and the facts never drift.
// Plain text only, no parse mode, so nothing in a link can break the message formatting.

export interface DeliveredLink {
  /** 1-based position in the order, so numbering stays stable across partial deliveries. */
  number: number;
  link: string;
}

export class DeliveryError extends Error {
  override name = 'DeliveryError';
  /** blocked: the buyer blocked the bot or the chat is gone, retrying will not help. */
  readonly kind: 'blocked' | 'failed';

  constructor(kind: 'blocked' | 'failed', message: string) {
    super(message);
    this.kind = kind;
  }
}

export type SendMessage = (chatId: number, text: string) => Promise<void>;

export function telegramSender(token: string): SendMessage {
  const api = new Api(token, { timeoutSeconds: 15 });
  return async (chatId, text) => {
    try {
      await api.sendMessage(chatId, text, { link_preview_options: { is_disabled: true } });
    } catch (err) {
      // Only the description: the error's payload holds the message text, which holds links.
      if (err instanceof GrammyError) {
        const gone = err.error_code === 403 || /chat not found|user is deactivated/i.test(err.description);
        throw new DeliveryError(gone ? 'blocked' : 'failed', `telegram ${err.error_code}: ${err.description}`);
      }
      throw new DeliveryError('failed', `telegram send failed: ${(err as Error).name}`);
    }
  };
}

export interface LinksMessageInput {
  links: DeliveredLink[];
  quantity: number;
  /** The buyer has not received any link from this order before. */
  first: boolean;
  /** Links still being bought after this message. */
  remaining: number;
  supportWhatsapp: string;
}

export function linksMessage({ links, quantity, first, remaining, supportWhatsapp }: LinksMessageInput): string {
  const lines: string[] = [];
  const single = quantity === 1;

  if (first) {
    lines.push('payment confirmed.');
    if (single) lines.push('here is your link:');
    else if (remaining === 0) lines.push(`here are your ${quantity} links:`);
    else lines.push(`here ${links.length === 1 ? 'is' : 'are'} ${links.length} of your ${quantity} links:`);
  } else {
    lines.push(remaining === 0 ? 'here is the rest of your order:' : 'here is more of your order:');
  }

  for (const { number, link } of links) lines.push(single ? link : `${number}. ${link}`);
  lines.push('');

  if (single) {
    lines.push('open it, sign in to the google account you want it on, and activate. it runs for 18 months from activation.');
    lines.push('activate it now, the offer is ending soon.');
  } else {
    lines.push('open each one, sign in to the google account you want it on, and activate. each runs for 18 months from activation.');
    lines.push('activate them now, the offer is ending soon.');
  }
  if (remaining > 0) {
    lines.push(`the other ${remaining === 1 ? 'link is' : `${remaining} links are`} on the way and will come here shortly.`);
  }
  lines.push(`any issue, whatsapp ${supportWhatsapp}`);
  return lines.join('\n');
}

/** Links sent again on request (resend_my_links, /status). */
export function resendMessage({ links, quantity, supportWhatsapp }: Omit<LinksMessageInput, 'first' | 'remaining'>): string {
  const single = quantity === 1;
  return [
    single ? 'here is your link again:' : 'here are your links again:',
    ...links.map(({ number, link }) => (single ? link : `${number}. ${link}`)),
    '',
    'sign in to the google account you want it on, and activate soon, the offer is ending.',
    `any issue, whatsapp ${supportWhatsapp}`,
  ].join('\n');
}

/** Sent once when a paid order could not be fulfilled at all on the first try. */
export function delayedMessage({ quantity, supportWhatsapp }: { quantity: number; supportWhatsapp: string }): string {
  const single = quantity === 1;
  return [
    `payment confirmed. ${single ? 'your link is' : 'your links are'} taking a little longer than usual.`,
    `we're on it and will send ${single ? 'it' : 'them'} here, no need to pay again.`,
    `if you need help, whatsapp ${supportWhatsapp}`,
  ].join('\n');
}
