import { naira } from './prompt.js';
import type { PayButton } from './tools.js';

// Scripted replies for when every Groq model fails (docs/ARCHITECTURE.md 5.1 step 6), so sales
// never stop. Buttons are plain data; the bot turns them into an inline keyboard.

export type Button = { text: string; callbackData: string } | { text: string; url: string };

export interface ScriptedReply {
  text: string;
  buttons: Button[][];
}

export interface FallbackFacts {
  unitPriceNgn: number;
  grossUp: boolean;
  supportWhatsapp: string;
  maxQtyPerOrder: number;
}

/** 08087357158 -> https://wa.me/2348087357158 */
export function whatsappUrl(number: string): string {
  const digits = number.replace(/\D/g, '');
  return `https://wa.me/${digits.startsWith('0') ? `234${digits.slice(1)}` : digits}`;
}

export function menuButtons(facts: FallbackFacts): Button[][] {
  return [
    [
      { text: 'buy 1 link', callbackData: 'buy:1' },
      { text: 'price', callbackData: 'price' },
    ],
    [{ text: 'whatsapp support', url: whatsappUrl(facts.supportWhatsapp) }],
  ];
}

export function priceText(facts: FallbackFacts): string {
  const fee = facts.grossUp ? 'plus payment fees' : 'plus a small payment fee shown at checkout';
  return `it's ${naira(facts.unitPriceNgn)} per link ${fee}. you get google ai pro for 18 months from activation. send /buy 3 to buy 3, or tap buy 1 below.`;
}

export function supportText(facts: FallbackFacts): string {
  return `for dead links or any problem, whatsapp ${facts.supportWhatsapp}.`;
}

export function paymentText(button: PayButton): string {
  const what = button.quantity === 1 ? '1 link' : `${button.quantity} links`;
  return `here's your payment for ${what}, total ${naira(button.totalNgn)}. tap pay now below, your link comes here right after payment.`;
}

/** Keyword routing, good enough to keep selling while the model is down. */
export function fallbackReply(userText: string, facts: FallbackFacts): ScriptedReply {
  const text = userText.toLowerCase();
  const buttons = menuButtons(facts);
  if (/(price|how much|cost|amount|naira)/.test(text)) return { text: priceText(facts), buttons };
  if (/(link|status|order|receive|sent|deliver)/.test(text)) {
    return { text: 'send /status to see your orders. if something is wrong, whatsapp ' + facts.supportWhatsapp + '.', buttons };
  }
  if (/(buy|want|need|get|pay|purchase)/.test(text)) {
    return { text: `tap buy 1 below, or send /buy 3 (any number up to ${facts.maxQtyPerOrder}) to buy more.`, buttons };
  }
  return {
    text: `hi, i sell google ai pro 18 month links for ${naira(facts.unitPriceNgn)}. tap below to buy or see the price, or send /help.`,
    buttons,
  };
}
