// samkiel must review every line before launch.
//
// What the agent may say about its maker and the shop (Prompt B). Only these facts, nothing else
// about him. Never add: matric number, birth date, family, church, phone or laptop details,
// finances, the supplier's name, costs, margins, reseller balance, or anything about other buyers.

export type OwnerTopic = 'identity' | 'roles' | 'projects' | 'achievements' | 'services' | 'links' | 'shop';

export const OWNER_TOPICS: readonly OwnerTopic[] = ['identity', 'roles', 'projects', 'achievements', 'services', 'links', 'shop'];

export const OWNER: Record<OwnerTopic, readonly string[]> = {
  identity: [
    'samuel ezekiel, known as samkiel (SAMKIEL is his brand).',
    'full stack software engineer in nigeria with 4+ years of experience, studying software engineering at obafemi awolowo university (oau).',
    'founder and ceo of SAMKIEL ("software with intention"), a software company founded in january 2023, with studio (products) and agency (client work) divisions.',
    'lead frontend engineer at axile (axile.ng), a live event ticketing platform. co-founder and cto at tarra (tarra.ng).',
    'works with react, next.js, node.js and typescript, express, hono and react native. builds ai agents and also does web3.',
  ],
  roles: [
    'co-lead of the aws student builder group at oau.',
    'active in oau developer communities (gdg oau, d3v++).',
  ],
  projects: [
    'samkiel.dev: his portfolio, with blog.samkiel.dev, his engineering blog (next.js).',
    'cortexa (cortexa.samkiel.dev): full stack ai chat platform with voice input, image upload and web search.',
    'axis (useaxis.onrender.com): payment authorization and policy engine for ai agents (spend limits, merchant allowlists, typescript sdk useaxis on npm). he was a backend developer on the team.',
    'voxy (voxyvoice.vercel.app): multilingual ai voice and chat assistant for businesses (english, pidgin, yoruba). pre-launch.',
    'veradoc (veradoc.vercel.app): document verification and trust tool.',
    'scoutlayer (scoutlayerhack.vercel.app): ai system for sourcing and screening startups, built solo at a global ai hackathon.',
    'redress (redressamd.vercel.app): ai complaint resolution agent built for the amd developer hackathon.',
    'zox: a whatsapp ai companion (a SAMKIEL studio product).',
    'the axile referral platform (referral.axile.ng).',
  ],
  achievements: [
    'won the jci nigeria global digital economy hackathon (oct 2026) with team blockx, building voxy.',
    'top 5 at the tesa oau hackathon with veradoc.',
    '75th of 1,600+ teams at squad hackathon 3.0 with veradoc.',
  ],
  services: [
    'builds websites, web apps, ai agents and bots, and mobile apps through SAMKIEL.',
    'contact: hello@samkiel.dev or samkiel.dev. landing pages also on fiverr.com/samkiel488.',
    'prices depend on the project, so talk to him directly. never quote a price.',
  ],
  links: [
    'portfolio: samkiel.dev',
    'blog: blog.samkiel.dev',
    'github: github.com/samkiell',
    'linkedin: linkedin.com/in/samkiell',
    'email: hello@samkiel.dev',
  ],
  shop: [
    "the product is google's 18 month ai pro offer from jio in india.",
    'samkiel buys activation links in bulk from a supplier and resells them. the shop is not affiliated with google or jio.',
    "activating moves the buyer's google account to google ai pro for 18 months from the activation date.",
    'problems are handled on whatsapp support. the refund and replacement rules are in /help under refunds and expiry.',
  ],
};

/** Always in the system prompt (max 80 words), so "who made you" never needs a tool call. */
export const OWNER_BLURB =
  'you were built by samkiel (samuel ezekiel), a full stack software engineer in nigeria with 4+ years of experience, studying software engineering at oau. he is founder and ceo of SAMKIEL (software with intention), lead frontend engineer at axile and co-founder and cto at tarra. he builds with react, next.js, node.js and typescript, makes ai agents and does web3. he runs this shop.';

export function ownerInfo(topic: OwnerTopic): string {
  return OWNER[topic].join('\n');
}

/** Normal web links (never activation links) shown as buttons with some answers. */
export const OWNER_LINKS = {
  portfolio: 'https://samkiel.dev',
  blog: 'https://blog.samkiel.dev',
  github: 'https://github.com/samkiell',
  linkedin: 'https://linkedin.com/in/samkiell',
} as const;

export type OwnerLink = keyof typeof OWNER_LINKS;

export function ownerButtons(topic: OwnerTopic): OwnerLink[] {
  switch (topic) {
    case 'identity':
    case 'links':
      return ['portfolio', 'github', 'linkedin'];
    case 'projects':
      return ['portfolio', 'github', 'blog'];
    case 'services':
    case 'achievements':
      return ['portfolio'];
    default:
      return [];
  }
}
