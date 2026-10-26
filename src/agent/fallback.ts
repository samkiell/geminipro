import { cb, naira, supportUrl, type UiFacts } from '../bot/views.js';
import type { Keyboard } from '../bot/telegram.js';
import type { HelpPage } from '../content/help.js';
import { OWNER_LINKS } from '../knowledge/owner.js';
import type { Lang } from './buyer.js';

// Scripted replies for when the model is rate limited, busy or down (docs/ARCHITECTURE.md 5.1
// step 6). Not one canned line: it recognises what the buyer wants and acts on it the same way
// the agent would (opens the order card, history, the right help page), and varies its wording.
// Lowercase, short, no em dashes.

export type ScriptedAction =
  | { kind: 'buy'; quantity: number }
  | { kind: 'history' }
  | { kind: 'order'; orderNo: string }
  | { kind: 'help'; page: HelpPage | 'hub' }
  | { kind: 'cancel' }
  /** The proof album. */
  | { kind: 'proof' }
  | { kind: 'invite' }
  /** Saves the message as a lead for samkiel, then replies. */
  | { kind: 'lead'; text: string; keyboard: Keyboard }
  | { kind: 'reply'; text: string; keyboard?: Keyboard };

export interface ScriptedContext {
  lang: Lang;
  facts: UiFacts;
  /** Chooses one of several wordings; the bot passes one that avoids repeating itself. */
  pick?: (options: readonly string[]) => string;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, single: 1, two: 2, couple: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** "i need 3", "two links", "abeg give me 5" -> the quantity, if one is named. */
export function quantityIn(text: string): number | undefined {
  const digits = /(?:^|[^\d₦,.])(\d{1,2})(?![\d,.])/.exec(text);
  if (digits) {
    const n = Number(digits[1]);
    if (n >= 1) return n;
  }
  for (const [word, n] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return n;
  }
  if (/\b(a|an) (link|gemini|code)\b/.test(text)) return 1;
  return undefined;
}

/** The buttons every scripted reply falls back to (Prompt C section 5). */
export function fallbackButtons(facts: UiFacts): Keyboard {
  return [
    [
      { text: 'buy a link', data: cb.buy(1) },
      { text: 'price', data: cb.price(1) },
    ],
    [
      { text: 'see proof', data: cb.proof },
      { text: 'support', url: supportUrl(facts.supportIntl) },
    ],
  ];
}

const random = (options: readonly string[]) => options[Math.floor(Math.random() * options.length)] ?? options[0] ?? '';

/**
 * A clear request to buy now ("can i pay now", "i need 3 links", "buy one"), as opposed to a
 * question that merely mentions wanting something. The bot opens the order card itself when the
 * agent missed one of these.
 */
export function isPurchaseRequest(text: string): boolean {
  const t = text.toLowerCase();
  // "give me a free link" is not an order.
  if (/\bfree\b/.test(t)) return false;
  return (
    /\b(buy|pay now|can i pay|purchase|i('ll| will) take|send me|give me)\b/.test(t) ||
    /\b(want|need|wan)\b.*\b(\d{1,2}|one|two|three|four|five|a|an)\s+(links?|gemini|codes?)\b/.test(t)
  );
}

/** "who made you", "are you a bot", "who is samkiel", "show me your portfolio"... */
export function isOwnerQuestion(text: string): boolean {
  return /(who (made|built|created|owns|runs|is behind) (you|this|the shop)|who are you|are you (a |an )?(bot|robot|human|person|real|ai)|who is samkiel|\bsamkiel\b|your (creator|owner|maker|boss|oga)|portfolio)/i.test(
    text,
  );
}

export function scriptedTurn(userText: string, c: ScriptedContext): ScriptedAction {
  const t = userText.toLowerCase().trim();
  const pick = c.pick ?? random;
  const pcm = c.lang === 'pcm';
  const price = naira(c.facts.unitPriceNgn);
  const support = { text: 'whatsapp support', url: supportUrl(c.facts.supportIntl) };
  const MENU = fallbackButtons(c.facts);

  const orderNo = /\bgp-?\s?(\d{3,7})\b/.exec(t);
  if (orderNo) return { kind: 'order', orderNo: `GP-${orderNo[1]}` };

  if (/\b(invite|refer|referral)\b/.test(t)) return { kind: 'invite' };
  if (/\b(cancel|stop (the |my )?order|don'?t want (it|again|am)|no longer want)\b/.test(t)) return { kind: 'cancel' };

  if (/\b(build|make|design|develop|create)\b.*\b(app|website|site|webapp|bot|landing page|software|platform|store)\b/.test(t) || /\b(hire (him|you|samkiel)|freelanc)/.test(t)) {
    return {
      kind: 'lead',
      text: pick([
        "samkiel builds websites, apps and ai bots through SAMKIEL. i've passed your request to him and he'll reach out. you can also email hello@samkiel.dev.",
        "nice, samkiel does exactly that. i've sent him your message, he'll get back to you. his work is below, or email hello@samkiel.dev.",
      ]),
      keyboard: [[{ text: 'portfolio', url: OWNER_LINKS.portfolio }]],
    };
  }

  if (isOwnerQuestion(t)) {
    return {
      kind: 'reply',
      text: pick([
        "i'm an ai assistant built by samkiel (samuel ezekiel), a full stack engineer and founder of SAMKIEL. he runs this shop. want to see his work?",
        "samkiel made me. he's a nigerian full stack engineer who builds web apps and ai agents, and he runs this shop. his work is below.",
      ]),
      keyboard: [[
        { text: 'portfolio', url: OWNER_LINKS.portfolio },
        { text: 'github', url: OWNER_LINKS.github },
        { text: 'linkedin', url: OWNER_LINKS.linkedin },
      ]],
    };
  }

  if (/(my orders?|history|order status|where( is|'?s)? (my|the) link|i (never|didn'?t|haven'?t|no) (get|got|receive|see|collect)|not (get|got|receive)|show (me )?my links?|resend|send (it|the link|am) again|my links?\b|my receipt)/.test(t)) {
    return { kind: 'history' };
  }

  // Doubt gets the real screenshots, with the fixed honest text (src/content/replies.ts).
  if (/\b(legit|scam|fake|trust|safe|genuine|original|sure say|proof|believe)\b|\breal\b|where (do|does|did) (the|these|your) links? come from|where (you|una) (dey )?get/.test(t)) {
    return { kind: 'proof' };
  }

  if (/\b(activate|activation|redeem|how (do|to|can) i use|how e dey work|how to use)\b/.test(t)) return { kind: 'help', page: 'activate' };
  if (/(already (have|get|dey use|on)|existing (plan|subscription)|current (plan|subscription)|google one|ai premium)/.test(t)) {
    return { kind: 'help', page: 'plan' };
  }
  if (/\b(refund|money back|expire|expiry|expired|replace|replacement|not working|doesn'?t work|no dey work|failed|dead link|invalid|error)\b/.test(t)) {
    return { kind: 'help', page: 'policy' };
  }

  const quantity = quantityIn(t);
  const wantsToBuy = /\b(buy|want|need|purchase|pay|send me|give me|i wan|collect|interested|order (one|two|\d)|can i (get|have)|i'?d like|let me get)\b|\babeg\b/.test(t);
  if (wantsToBuy) return { kind: 'buy', quantity: quantity ?? 1 };

  if (/(how much|price|cost|amount|naira|₦|hw much|wetin be (the )?price|how far (the )?price)/.test(t)) {
    const q = quantity && quantity > 1 && quantity <= c.facts.maxQtyPerOrder ? quantity : undefined;
    const fee = 'plus a small payment fee at checkout';
    const text = q
      ? pcm
        ? `${q} links na ${naira(q * c.facts.unitPriceNgn)}, plus small fee for checkout. tap below make you buy.`
        : `${q} links come to ${naira(q * c.facts.unitPriceNgn)}, ${fee}. tap below to buy.`
      : pick(
          pcm
            ? [`na ${price} per link, plus small fee for checkout. tap below make you buy.`, `one link na ${price}. how many you want?`]
            : [
                `it's ${price} per link, ${fee}. tap below to buy.`,
                `one link is ${price}, ${fee}. how many do you need?`,
                `${price} per link, ${fee}. send /buy 3 for three, or tap below.`,
              ],
        );
    return {
      kind: 'reply',
      text,
      keyboard: [[{ text: 'buy 1', data: cb.buy(1) }, ...(q ? [{ text: `buy ${q}`, data: cb.buy(q) }] : [])]],
    };
  }

  if (/(what (do|will) i get|what is (it|this|gemini pro|google ai pro)|features|benefits|what does it (do|include|come with)|how long)/.test(t)) {
    return { kind: 'help', page: 'get' };
  }
  if (/(how (does|do) (it|this|i) (work|buy)|how it works|how do i (buy|pay)|how to buy)/.test(t)) return { kind: 'help', page: 'how' };
  if (/\b(offer|deadline|last day|ending|still available|still dey)\b/.test(t)) return { kind: 'help', page: 'offer' };

  if (/\b(support|help me|problem|issue|complain|complaint|whatsapp|contact|talk to (a )?(human|person|someone))\b/.test(t)) {
    return {
      kind: 'reply',
      text: pick([
        `tap below to chat with support on whatsapp (${c.facts.supportLocal}).`,
        `support is on whatsapp, ${c.facts.supportLocal}. tap below and they'll help you out.`,
      ]),
      keyboard: [[support]],
    };
  }

  if (/\b(thanks|thank you|thank u|thx|tnx|nice one|e se|god bless|appreciate)\b/.test(t)) {
    return {
      kind: 'reply',
      text: pick(
        pcm
          ? ['no wahala! enjoy am.', 'anytime my person!', 'you welcome! holla if you need anything.']
          : ["you're welcome! enjoy google ai pro.", 'anytime! shout if you need anything else.', 'glad to help 🙌'],
      ),
    };
  }

  if (/^(hi|hello|hey|hy|hola|good (morning|afternoon|evening|day)|how far|wetin dey|sup|yo|howdy|start)\b/.test(t)) {
    return {
      kind: 'reply',
      text: pick(
        pcm
          ? [
              'how far! i dey sell google ai pro 18 month link. you want one?',
              'hello, welcome! tap buy below, or ask me anything.',
              'my person! you wan buy gemini pro link? tap below.',
            ]
          : [
              'hi! i sell google ai pro 18 month links. want one?',
              'hey, welcome! tap buy a link below, or ask me anything.',
              'hello! looking for a gemini pro link? i can sort you out in a minute.',
              "hi there, i'm samkiel's shop assistant. tap below to buy or see how it works.",
            ],
      ),
      keyboard: MENU,
    };
  }

  if (/\b(help|menu|options|commands)\b/.test(t)) return { kind: 'help', page: 'hub' };

  return {
    kind: 'reply',
    text: pick(
      pcm
        ? [
            'i fit help you buy google ai pro 18 month link. tap buy below or send /buy.',
            'you wan gemini pro link? tap below, e no go take time.',
            'i no too understand, but i fit sell you link sharp sharp. tap below.',
            'use /buy to buy, /history to see your orders, /help if you need help.',
            'na gemini pro link i dey sell. tap below make we start.',
            `one link na ${price}. tap below make you buy, or send /help.`,
          ]
        : [
            'i can help you buy a google ai pro 18 month link. tap buy a link below, or send /buy.',
            'want a gemini pro link? tap below, or send /buy 3 if you need three.',
            "not sure what you mean, but i can sell you a google ai pro link in a minute. tap below.",
            'you can buy with /buy, see your orders with /history, or get help with /help.',
            "i'm the gemini pro link shop. tap buy a link, or ask about price, activation or your order.",
            "here's what i can do: sell you a link, show your orders, or explain how it works. tap below.",
            `need a google ai pro link? it's ${price} each. tap below to start.`,
            "i'm best at selling gemini pro links 🙂 tap below, or send /help for how it works.",
            'quick menu below: buy a link, check your orders, or see how it works.',
            'want 18 months of google ai pro? tap buy a link below.',
            "send /buy to get a link, /history for your orders, or /help if you're stuck.",
          ],
    ),
    keyboard: MENU,
  };
}

/** Per user, never the same wording twice in a row. */
export function createPicker() {
  const last = new Map<number, string>();
  return (userId: number) => (options: readonly string[]) => {
    const choices = options.length > 1 ? options.filter((o) => o !== last.get(userId)) : options;
    const choice = random(choices);
    last.set(userId, choice);
    if (last.size > 10_000) last.clear();
    return choice;
  };
}
