// Fixed replies the bot sends without the model (fast paths, proof, fallbacks). Lowercase, short,
// no em dashes. Prices and numbers are filled in by code.

/** Sent before the proof album, word for word (Prompt C section 6). */
export const PROOF_INTRO =
  "yes, the offer is real. it is google's official 18 month ai pro offer with jio in india. samkiel gets the activation links through a supplier and resells them, so this shop is not run by google or jio. here are real activations from past buyers 👇";

/** On the first photo of the proof album. */
export const PROOF_CAPTION = 'real activations from past buyers, personal details hidden';

export const PROOF_MISSING =
  "proof screenshots are being added right now. tap below and support will show you on whatsapp, they're quick.";

export const PROOF_AFTER = 'want one? tap below.';

export const GREETINGS = {
  en: [
    'hi! i sell google ai pro 18 month links. want one? tap buy below.',
    'hey, welcome! tap buy a link below, or ask me anything.',
    'hello! looking for a gemini pro link? i can sort you out in a minute. tap below.',
  ],
  pcm: [
    'how far! i dey sell google ai pro 18 month link. tap buy below.',
    'my person! you wan buy gemini pro link? tap below.',
    'welcome! tap buy below, or ask me anything.',
  ],
} as const;

export const SUPPORT_REPLY = (supportLocal: string) => `support is on whatsapp (${supportLocal}). tap below and they'll help you out.`;

export const ORDER_NOT_FOUND = (orderNo: string) => `i couldn't find order ${orderNo} on your account. tap below to see your orders.`;

export const LEAD_REPLY =
  "samkiel builds websites, apps and ai bots. i've passed your request to him and he'll reach out. you can also email hello@samkiel.dev.";
