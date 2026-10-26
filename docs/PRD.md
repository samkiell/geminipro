# PRD: geminiprosamkiel_bot

| | |
|---|---|
| **Owner** | Samuel Ezekiel (@samkieldev) |
| **Bot handle** | @geminiprosamkiel_bot |
| **Repo** | geminipro |
| **Status** | Final v2.1 (agentic buyer chat) |
| **Date** | 26 Oct 2026 |
| **Offer deadline** | Jio's terms end the claim period on 29 Oct 2026. India time applies, so the day likely ends around 19:30 WAT |

## 1. Summary

A Telegram bot that sells Gemini Pro 18-month (Jio offer) activation links with zero manual steps. A buyer chats with the bot, pays in NGN through Bachs, and the bot automatically buys the links from the upstream reseller API and sends them to the buyer. Support runs through one WhatsApp number.

## 2. Problem

Selling manually means: fund the reseller balance, buy on the reseller's bot, copy the link, send it to the buyer, and confirm payment by hand. Directing buyers to WhatsApp DMs created too many messages and too much stress. The bot replaces that whole loop. The owner's only recurring job becomes topping up the reseller balance.

## 3. Goals

- Zero manual work per sale after launch.
- Link delivered within about 30 seconds of confirmed payment.
- Never deliver a link without a verified payment.
- Never take payment the bot cannot fulfil.
- Owner is alerted fast about low reseller balance and any failed order.
- Support load limited to genuine problems (dead links) through one WhatsApp number.

## 4. Non-goals (v1)

- Crypto payments from buyers.
- A website or web dashboard (admin analytics live inside the bot).
- Discount or loyalty features. (A referral program exists, see 8.10.)
- Automated reseller top ups (owner funds the reseller account manually in crypto).
- Other products.

## 5. Money flow

Two separate flows. The bot never moves money between them.

1. **NGN in:** buyer pays via Bachs (NGN card or bank transfer). Funds sit in the owner's Bachs balance (NGN is available immediately) and are withdrawn to his bank manually.
2. **USD out:** the reseller account is prepaid in USD, topped up by the owner in crypto. Each order deducts from that balance (about $1.20 per link as of 26 Oct).

**Pricing:** ₦3,500 per link. Payment fees are paid by the buyer, so the owner receives the full ₦3,500 per link. The bot tells buyers the price is "₦3,500 per link + fee". Implementation: set the Bachs account's `fee_preference` to `customer_pays`, so Bachs adds the exact fee at checkout. If the account stays on `org_pays`, the bot adds the fee itself (gross-up, about ₦3,572 for one link) and shows the buyer the total before payment. Bulk orders: ₦3,500 times quantity, fee on the total.

## 6. Users

- **Buyer:** a Telegram user, mostly Nigerian, who wants one or more Gemini Pro links.
- **Admin:** the owner only. Admin commands are restricted to an allowlist of Telegram user ids.

## 7. Buyer flow

1. Buyer messages the bot (for example "i want the gemini pro link", "how much", "i need 3") or sends /buy.
2. Bot shows a draft card: quantity with − and +, "₦3,500 each + fee", the no refund line and the offer line. No order exists yet and no order number is used.
3. Buyer taps [continue]. Code checks channel membership (8.2A), rechecks stock and balance, then creates ONE order (one order number) and ONE Bachs checkout for the final quantity.
4. The same message becomes the payment card with [pay now] and a live countdown to the provider's expiry.
5. Buyer pays.
6. Bachs webhook confirms payment. The payment card becomes "✅ paid, getting your links…".
7. Bot buys the links from the reseller.
8. Bot sends the link(s) with the confetti effect; the payment card becomes "🎉 delivered".
9. If anything fails after payment, bot tells the buyer it is being handled, gives the WhatsApp support number, and alerts the admin.

## 8. Functional requirements

### 8.1 Buyer agent (Groq, one call per message)

- One model call per free text message at most (Prompt C, the same design as SKDL). The model (`GROQ_MODELS`, best first: qwen/qwen3.8-27b, openai/gpt-oss-120b, openai/gpt-oss-20b) reads a small static prompt, the last 6 messages and a short context block (price, stock, offer, buyer), and returns one JSON decision: an intent (`buy`, `price`, `history`, `show_order`, `proof`, `help`, `owner`, `shop`, `support`, `lead`, `invite`, `chat`), its details (quantity, order number, topic, lead summary) and a reply of at most 240 characters. Code validates it and carries it out: cards, prices, orders, proof and owner texts are rendered by code, never by the model. Full spec in `docs/ARCHITECTURE.md` section 5.
- Zero model calls for commands, buttons, the stepper, history navigation, the help hub and the most common messages (greetings, price, buy, my orders, proof questions, help, support), answered from `src/content/`. Repeated general questions are cached for 5 minutes.
- Proof (8.1A): skeptical buyers get real, blurred screenshots of past activations with a fixed honest text.
- Agentic behavior: handles multi step requests ("i need 3, how much, can i pay now"), answers questions about the offer from a built in knowledge base (including what happens for people who already have a Google plan, and that the 18 months run from activation), handles trust questions and objections briefly, resumes unfinished orders, sends one follow up nudge for an abandoned payment link, and escalates unclear or problem cases to WhatsApp support.
- Owner knowledge (from `src/knowledge/owner.ts`, reviewed by samkiel): answers who made it (an AI assistant built by samkiel, never claims to be him, Google or Jio), who samkiel is, his projects and achievements, and whether the shop is legit and where links come from, honestly and briefly, with portfolio, GitHub and LinkedIn buttons. Never reveals the supplier, costs, margins, balance, admin commands or other buyers.
- Leads: "can you build me a website" saves a lead (3 a day per user) and alerts the owner. Never quotes prices.
- Light memory: first name, new or returning, past orders, preferred language. Pidgin in, light pidgin out.
- Hard limits: the agent never sees or writes activation links, never confirms a payment, never calls the reseller, and cannot change the price. Money and delivery are deterministic code. Decisions are validated in code (quantity limits, order ownership, one pending order per user); any intent outside the list, or invalid JSON, gets the scripted reply. User text is untrusted.
- Style: very short, lowercase (enforced in code), casual, english unless the buyer writes pidgin, no em dashes (stripped in code).
- Resilience: each model call times out at 6s, at most 2 models are tried per message, a rate limited model is skipped until its reset, 6 model messages per buyer per minute, `LLM_CONCURRENCY` calls at once with a short queue. Otherwise the bot switches at once to smart scripted replies: it still opens the order card, history, the right help page or the proof album, in varied wording (english or pidgin), with [buy] [price] [proof] [support], so sales never stop. More than 5 scripted replies in 5 minutes alerts the owner; the sales summary counts model calls and fallbacks. Groq's free tier is not enough for launch traffic: upgrade the plan before launch.
- One response per action: a UI intent (buy, price, history, show_order, proof, help, support, owner, shop, invite) sends only its UI and drops the model's reply; `chat` sends only the reply. One user action produces at most 2 new messages (edits do not count). Button taps never count toward the message rate limit, and the rate limit notice is sent once per window.
- Buyer commands, exactly five: `/start`, `/buy`, `/history`, `/invite`, `/help`. `/myid` is unlisted and answers anyone with their Telegram id. Typed requests like "my orders" or "where is my link" open the history view.
- Owner side (stretch goal): natural language read only questions ("how much did i sell today", "what's the balance") through an admin tool set. Destructive actions stay explicit commands.

### 8.1A Proof

- Purpose: skeptical buyers get real proof that the offer works.
- Up to 10 real screenshots of activations from past buyers, emails, names and phone numbers blurred, never edited or generated. They live in `assets/proof/` (seeded into `proof_items` at boot) or are added by an admin with `/addproof` followed by the photos (or a photo captioned `/addproof`); `/proofs` lists them by id with a remove button each, `/delproof <id>` removes one for good.
- Sent as one album with the caption "real activations from past buyers, personal details hidden", after this exact text: "yes, the offer is real. it is google's official 18 month ai pro offer with jio in india. samkiel gets the activation links through a supplier and resells them, so this shop is not run by google or jio. here are real activations from past buyers 👇". Then [buy now] [whatsapp support].
- Triggered by "is this real", "proof", "legit", "scam" and similar (no model call), the `proof` intent, [see proof] on the order card and in /help.
- Honesty: the bot never claims the shop is official or affiliated with Google or Jio, and never claims anything the screenshots do not show.

### 8.2 Pre-sale checks (before issuing a payment link)

- Product in stock: `GET /products/{id}` (`inStock`, `stock`).
- Balance covers the order: `GET /account/balance`, minus the cost of orders already paid but not yet fulfilled.
- Maximum quantity per order = the lowest of: stock, what the balance can cover, and `MAX_QTY_PER_ORDER` (default 10).
- If the buyer asks for more than available, the bot says how many it can sell right now.
- If nothing can be sold, the bot says it is out of stock and does not create a payment link.
- **No time cutoff by default.** Selling stops only when the reseller has no stock or balance is too low. An optional `SALES_CUTOFF` env var exists but is off.
- One pending payment per user at a time. Pressing buy again shows that same payment card instead of a new order.

### 8.2A Draft cart and order numbers

- `/buy`, the buy buttons and the `buy` intent never create an order. They create or update a draft (`order_drafts`, one per user) and the − and + buttons only edit the draft quantity in the same message (clamped to availability and `MAX_QTY_PER_ORDER`).
- An order number comes from the sequence only when an order row is created, which happens only on [continue]. Tapping + five times then continuing uses exactly one order number; an abandoned draft uses none. Drafts older than 24 hours are deleted by the reconciler.

### 8.2B Channel gate

- Buyers must be members of `GATE_CHANNEL` (@samkieldevtg) to tap [continue]. Nothing is gated at /start, in chat, price, proof or help. The bot must be an administrator of the channel.
- Checked on every [continue] with a fresh `getChatMember`. `creator`, `administrator`, `member`, and `restricted` with `is_member` count as members. Non members see "join our channel to continue 👇" with [join channel] and [i have joined ✅]; once they join, the draft card comes back with the quantity kept. Not joined yet: an alert "you haven't joined yet".
- Fail open: if the check errors (bot not admin, Telegram error), the buyer goes through and admins get an alert (30 minute cooldown).
- Never gated: payment confirmation, delivery, history, show links, support, admin commands. Admins bypass the gate.

### 8.3 Payment (Bachs)

- Create an NGN checkout with a unique reference tied to our order id (card and bank transfer).
- The checkout asks Bachs for a `BACHS_SESSION_TTL_MINUTES` (15) session, and the expiry Bachs returns is stored as `orders.expires_at`; the local window is only a fallback when the response has none. A bank transfer already on its way can still complete it later, and is honored.
- Payment card: "order GP-1042 · 2 links / ₦7,000 + fee / ⏳ pay before 1:45pm wat · 12:30 left" with [pay now] and [cancel]. One scheduler loop (every 5 seconds) edits awaiting cards every 30 seconds and every 10 seconds in the last minute, under a global edit rate limit with backoff on Telegram 429. At expiry the card reads "expired ⌛ send /buy to start again. if you already paid, wait a minute, your link will still arrive." Cancel edits it to "cancelled". After payment the same message becomes "✅ paid, getting your links…" and then "🎉 delivered"; there is no separate checklist or receipt.
- Webhook verifies the Bachs signature (HMAC SHA256 over timestamp and raw body, with the endpoint's signing secret). Invalid signatures are rejected, logged and alerted.
- On `checkout.completed` or `collection.succeeded`, also fetch the checkout from Bachs, and check status, amount, currency, and reference against the order before fulfilling.
- Idempotent: duplicate or replayed webhooks never cause a second purchase (unique constraint on reference plus an atomic status change from `paid` to `fulfilling`).

### 8.4 Fulfilment (reseller API)

- Base URL `https://api-geminipro.ignorelist.com/api/reseller/v1`, auth via `X-API-Key`.
- For quantity N, make N separate `POST /orders` calls with `quantity: 1`, each with its own idempotency key `{orderId}-{i}`. Reason: the docs do not describe how `order.value` looks when quantity is above 1, and separate calls let partial success be handled cleanly. (Optional later: test `quantity: N` once and switch if the format is clear.)
- Read each link from `order.value`, store it per item, then send to the buyer.
- Retry transient failures with backoff, always with the same idempotency key.
- `409 supplier_purchase_pending`: poll `GET /orders/{orderCode}` until completed or failed.
- After any timeout, check order status before treating it as failed.
- Partial success: deliver the links that succeeded immediately, retry the rest, then mark the order `needs_attention` and alert the admin if still incomplete.

### 8.5 Delivery message

The delivery message is a fixed short template in code (so the facts are always right and links never pass through the LLM). Links are inside `<code>` so tapping copies them, never plain URLs, no link previews:

> 🎉 order GP-1042 delivered
> 🔑 link 1 of 2, tap to copy:
> `{link}`
> paste it in the browser where you're signed in to the google account you want it on, then activate.
> ⚠️ expires soon. no refund if it expires before you activate it.

Buttons: [✅ i've activated it] per link, then [need help] (WhatsApp, prefilled with the order number) and [invite & earn 🎁]. A free referral link uses the header "🎁 your free link". Long orders are split across messages under Telegram's limit. Activation links are never written to logs.

The first delivery message carries Telegram's confetti message effect (`MESSAGE_EFFECT_CONFETTI`, private chats only). If Telegram rejects the effect (HTTP 400) the message is sent once more without it; any other failure is not resent, so links are never sent twice. A link counts as delivered only after Telegram accepts the message.

The last step of the buy flow: once the buyer activates a link they tap its ✅ and confirm ("yes, it is activated. close it" or "not yet"). The link is then closed: every message that showed it is edited to "activated ✅, closed", and it is never shown again (not in history, not by /resend). The bot cannot cancel the link at Google; closing it only means the shop stops showing it. Activations are counted in /stats and the sales summary.

### 8.5A Buyer experience

- Before payment, the draft card (8.2A), then the payment card with its countdown (8.3). Prices read "₦3,500 per link + fee"; the fee is never shown as a percentage.
- One message follows the order: draft card, payment card, "✅ paid, getting your links…", "🎉 delivered". No stub messages: a card that must move to the bottom is deleted and sent again.
- Buttons never stay live after their job: the card loses them once paid, expired or cancelled, stale taps answer "this button has expired", menus edit one message.
- `/history`: orders as buttons, 5 per page; an order card with its timeline and [show my links].
- `/help` hub: how it works, what you get, how to activate, existing plan, refunds and expiry, offer status, see proof, my orders, invite & earn, support. Each page is at most 4 short lines.
- Human readable order numbers (GP-1001 onward). The offer line is a setting (default "offer ending very soon", changed with `/offertext`); buyer facing text never states an end date.
- One activation reminder per order about 3 hours after delivery, unless every link is already marked activated ("did you activate your link?" with [yes, activated ✅] [i need help]; yes closes all its links), never between 23:00 and 07:00 WAT.

### 8.6 Support

- Dead link or any complaint: buyer taps a support button that opens WhatsApp (08087357158, `https://wa.me/2348087357158`) with "hi, i need help with order GP-1042" filled in. It appears on delivery messages, order cards, `/help`, and error messages.
- Policy: failed links are checked and replaced where possible, as soon as they are reported, but a replacement is not guaranteed. Links left to expire unused are not refunded. The wording lives in `src/content/help.ts`.
- Owner replaces links from reseller stock through an admin command and the bot records the replacement.

### 8.7 Error handling

| Case | Behavior |
|---|---|
| `insufficient_funds`, `out_of_stock` after payment | retry briefly, then `needs_attention`, tell buyer it is being handled with the support number, alert admin on all channels |
| `supplier_purchase_failed` | retry with same idempotency key, then as above |
| `supplier_purchase_pending` | poll order status |
| `invalid_api_key` | pause sales, alert admin immediately |
| Reseller timeout or 5xx | retry with backoff, verify order status before giving up |
| Payment amount mismatch | do not fulfil, hold as `needs_attention`, alert admin |
| Groq failure or rate limit | scripted fallback with buttons |
| Render cold start | Bachs retries webhooks; reconciliation job catches anything missed |

### 8.8 Admin features (owner only, by Telegram id allowlist)

- `/admin`: panel with buttons for the commands below.
- `/balance`: reseller USD balance and how many links it covers.
- `/stats`: sales and revenue today and total, failures, activations, and referrals (friends qualified, free links granted, their reseller cost).
- `/allorders`: last 10 orders with status. `/order GP-1042`: one order.
- `/resend GP-1042`: resend delivered links.
- `/replace GP-1042`: buy one extra link through the normal reseller path, send it, and record it.
- `/pause` and `/resume`: stop or restart sales.
- `/offertext <text>`: change the offer line; `/offertext` alone shows it.
- `/leads`: latest 10 business inquiries.
- Admin commands are only visible to and usable by admins; for anyone else they do not exist. To find your id, send `/myid` to the bot and put it in `ADMIN_TELEGRAM_IDS`. At boot the service logs how many admin ids are set (not the ids) and warns if there are none.
- Sales summary every 5 hours (`SUMMARY_EVERY_HOURS`), none from 23:00 to 07:00 WAT: sales since the last summary, today and all time, failures, pending orders, reseller balance and links left, activations, referrals, AI usage.

### 8.10 Referral program

- Every user gets a 4 letter code, lowercase consonants only (`bcdfghjkmnpqrstvwxz`, so it never spells a word), made the first time they open /invite. Link: `https://t.me/geminiprosamkiel_bot?start=ref_<code>`.
- Attribution: only a user's first ever /start with `ref_<code>` (any case) sets `referred_by`, once. Unknown codes, self referral and existing users are ignored.
- A friend qualifies when their first paid order (amount above zero) is delivered and not refunded, once however many links they buy. Free links never qualify anyone.
- Every `REFERRAL_THRESHOLD` (3) qualified friends earn 1 free link, up to `REFERRAL_MAX_REWARDS` (3) per person. A reward is a normal order (`source = 'referral_reward'`, amount 0, quantity 1, its own order number) bought and delivered through the same fulfilment engine and idempotency keys, with the "🎁 your free link" header. While sales are paused or stock or balance is short, the reward waits, admins are alerted, and the reconciler grants it later. A failed reward purchase is retried like any paid order.
- The referrer gets one short message when a friend qualifies ("1 of 3 friends bought 🎉").
- `/invite` and [invite & earn 🎁] show one message: the offer, progress ("▰▰▱ 2 of 3 friends have bought"), free links earned, the tap-to-copy link, [share with friends] and [my orders]. At the cap it says so plainly.

### 8.9 Alerts

Sent to three channels: the owner's email, his main Telegram account, and ntfy.sh push notifications on his phone. Triggers: low balance (default: covers fewer than 5 links), out of stock, any `needs_attention` order, invalid API key, webhook signature failures, repeated Groq failures, service restart.

## 9. Order states

`created` → `awaiting_payment` → `paid` → `fulfilling` → `delivered`

Side states: `expired` (unpaid), `partial` (some links delivered), `needs_attention`, `refunded`, `cancelled`.

State changes are persisted before external calls. A reconciliation job runs on startup and on a timer, re-checking `awaiting_payment`, `paid`, `fulfilling`, and `partial` orders against Bachs and the reseller.

## 10. Data (Neon Postgres)

- **users:** telegram_user_id, username, first seen, ref_code, referred_by.
- **orders:** id, order_no, telegram_user_id, quantity, status, source (`purchase` or `referral_reward`), amount_ngn, payment_reference (unique), checkout_id, expires_at (from Bachs), timestamps, error info.
- **order_drafts:** one draft cart per user (quantity, card message id), before any order exists.
- **referrals:** referrer_id, referred_id (unique), qualified_at.
- **order_items:** order_id, index, reseller_order_code, activation_link, status, delivered_at, activated_at, and the buyer messages that show it.
- **events:** webhook payloads and reseller responses with secrets redacted.
- **messages:** short chat history per user (last 10 turns used for the LLM).

## 11. Non-functional requirements

- **Hosting:** Render free web service for the bot and webhook server, plus an uptime monitor pinging `/health` about every 10 minutes (Render free services sleep after 15 idle minutes). If sleeping causes missed sales, upgrade to the $7/month instance.
- **Database:** Neon Postgres (not SQLite, because Render's free disk does not persist).
- **Stack:** Node.js with TypeScript.
- **Security:** all secrets in environment variables (Telegram token, Bachs secret key and webhook secret, reseller API key, Groq key, SMTP or email key, ntfy topic). `.env` gitignored, `.env.example` committed. Admin allowlist by Telegram id.
- **Logging:** structured logs with order id on every line, no secrets or links.
- **Performance:** delivery within about 30 seconds of payment when the service is awake.
- **Time zone:** user facing times in WAT (UTC+1).

## 12. Success metrics

- Share of paid orders delivered with no admin action (target 95% or higher).
- Median time from payment to delivery.
- Zero double purchases and zero deliveries without verified payment.
- Number of orders ending in `needs_attention`.
- Support messages per 100 sales.

## 13. Risks

| Risk | Mitigation |
|---|---|
| Offer ends 29 Oct 2026 (Jio's terms, unless Jio changes it), likely around 19:30 WAT by India time | ship the core flow first; bot warns buyers to activate quickly; optional `SALES_CUTOFF` available |
| Multi party chain (Google, Jio, upstream reseller, us), so links can fail or expire | clear buyer messaging, replacement flow, WhatsApp hot support, admin alerts |
| Reseller balance runs out mid sales | pre-sale balance check, low balance alerts on three channels, "unavailable" state |
| Render free tier sleeps | uptime monitor, Bachs webhook retries, reconciliation job, paid instance as fallback |
| Groq outage or rate limit | model fallbacks, scripted button fallback |
| Webhook spoofing or replay | signature check, verify API call, idempotency |
| Bulk order partly fails | per item orders, partial delivery, retries, admin alert |
| Reseller terms or offer eligibility problems | owner to confirm reseller terms; honest buyer messaging with no guarantees beyond replacement support |

## 14. Remaining details to confirm during build

1. Verify with one real buyer who already has a Google plan how activation behaves. The bot's answer about existing subscriptions follows the owner's description and should be checked.
2. Alert email: sent from hello@samkiel.dev (verified in Resend) to ezekiel.samuel@samkiel.tech.
3. Bachs `fee_preference`: `customer_pays` (Bachs adds the fee, `GROSS_UP=false`) or `org_pays` (the bot grosses up, `GROSS_UP=true`). The live account was on `org_pays` on 26 Oct.
4. `MAX_QTY_PER_ORDER` (default 10).

## 15. Milestones

| Date (WAT) | Milestone |
|---|---|
| Mon 26 Oct | PRD final, repo and Render service created, Neon database, bot skeleton, Bachs checkout and webhook in the sandbox |
| Tue 27 Oct | reseller integration, bulk fulfilment, Groq chat, delivery, alerts, admin commands, end to end test |
| Wed 28 Oct | live with real payments, small pilot, fix issues, update flyer and channel post to the bot link |
| Thu 29 Oct | last day to claim; full push; watch balance and alerts |

## 16. Next steps

1. Approve this PRD and add it to `docs/PRD.md` in the geminipro repo.
2. Architecture doc: bot, webhook server, Bachs, reseller API, Neon, Groq, alerts.
3. Claude Code prompts, then implementation.
