// The /help hub (Prompt A section 9). samkiel must review every line before launch.
// Plain text, lowercase, short, no em dashes. The refund and replacement wording here is the
// one source of truth: the agent and other messages point here instead of restating it.

export type HelpPage = 'how' | 'get' | 'activate' | 'plan' | 'policy' | 'offer';

export interface HelpContext {
  unitPriceNgn: number;
  feeLine: string;
  supportLocal: string;
  offerText: string;
  maxQtyPerOrder: number;
  paymentWindowMinutes: number;
}

export const HELP_HUB_TEXT = "how can i help? tap a topic below.";

export const HELP_TOPICS: { page: HelpPage; label: string }[] = [
  { page: 'how', label: 'how it works' },
  { page: 'get', label: 'what you get' },
  { page: 'activate', label: 'how to activate' },
  { page: 'plan', label: 'already have a google plan' },
  { page: 'policy', label: 'refunds and expiry' },
  { page: 'offer', label: 'offer status' },
];

export const POLICY_TEXT =
  "if a link doesn't work when you use it, report it on whatsapp right away. we check failed links and replace them where possible, as soon as you report it, but a replacement is not guaranteed. links left to expire unused are not refunded, so activate as soon as you get yours.";

export function helpPage(page: HelpPage, c: HelpContext): string {
  switch (page) {
    case 'how':
      return [
        'how it works',
        `1. pick how many links (up to ${c.maxQtyPerOrder} per order)`,
        '2. pay on the secure checkout',
        '3. your link lands here in about a minute',
        `\u20a6${c.unitPriceNgn.toLocaleString('en-NG')} per link + fee.`,
      ].join('\n');
    case 'get':
      return [
        'what you get',
        'google ai pro for 18 months from the day you activate:',
        '• higher gemini limits',
        '• 5tb storage across drive, photos and gmail',
        '• veo 3, nano banana, flow and whisk',
        '• notebooklm and deep research',
        '• up to 1000 ai credits every month',
        '• gemini in gmail, docs, sheets and more',
      ].join('\n');
    case 'activate':
      return [
        'how to activate',
        '1. tap the link in your order message to copy it.',
        "2. open the browser where you're already signed in to the google account you want it on.",
        '3. paste the link in the address bar and open it.',
        '4. follow the steps on the page to activate.',
        'the 18 months start from the day you activate, so do it right away.',
      ].join('\n');
    case 'plan':
      return [
        'already have a google plan?',
        'activating moves that google account to google ai pro, and it runs for 18 months from the day you activate.',
        `not sure? whatsapp ${c.supportLocal} before you buy.`,
      ].join('\n');
    case 'policy':
      return ['refunds and expiry', POLICY_TEXT, `support: whatsapp ${c.supportLocal}`].join('\n');
    case 'offer':
      return ['offer status', `🔥 ${c.offerText}.`, 'activate as soon as you get your link.'].join('\n');
  }
}
