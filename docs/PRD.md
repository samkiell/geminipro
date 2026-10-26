# PRD: samkielbot_geminipro

| | |
|---|---|
| **Owner** | Samuel Ezekiel (@samkieldev) |
| **Bot handle** | @samkielbot_geminipro |
| **Repo** | geminipro |
| **Status** | Final v2.1 (agentic buyer chat) |
| **Date** | 26 Oct 2026 |
| **Offer deadline** | Jio's terms end the claim period on 29 Oct 2026. India time applies, so the day likely ends around 19:30 WAT |

## 1. Summary

A Telegram bot that sells Gemini Pro 18-month (Jio offer) activation links with zero manual steps. A buyer chats with the bot, pays in NGN through Paystack, and the bot automatically buys the links from the upstream reseller API and sends them to the buyer. Support runs through one WhatsApp number.

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
- Referral, discount, or loyalty features.
- Automated reseller top ups (owner funds the reseller account manually in crypto).
- Other products.

## 5. Money flow

Two separate flows. The bot never moves money between them.

1. **NGN in:** buyer pays via Paystack. Funds sit in the owner's Paystack balance and are withdrawn to his bank manually.
2. **USD out:** the reseller account is prepaid in USD, topped up by the owner in crypto. Each order deducts from that balance (about $0.90 per link).

**Pricing:** ₦3,500 per link. Paystack transaction fees are paid by the buyer, so the owner receives the full ₦3,500 per link. The bot tells buyers the price is "₦3,500 plus paystack fees". Implementation: use Paystack's setting that makes the customer bear transaction fees if it is available on the account. If it is not, the bot adds the fee itself (gross-up with a configurable fee formula, about ₦3,655 for one link at 1.5% + ₦100) and shows the buyer the total before payment. Bulk orders: ₦3,500 times quantity, fee on the total.

## 6. Users

- **Buyer:** a Telegram user, mostly Nigerian, who wants one or more Gemini Pro links.
- **Admin:** the owner only. Admin commands are restricted to an allowlist of Telegram user ids.

## 7. Buyer flow

1. Buyer messages the bot (for example "i want the gemini pro link", "how much", "i need 3").
2. Bot replies briefly with price and what they get.
3. Bot runs pre-sale checks (stock, reseller balance, quantity).
4. Bot creates a Paystack transaction and sends the payment link with the exact amount.
5. Buyer pays.
6. Paystack webhook confirms payment.
7. Bot buys the links from the reseller.
8. Bot sends the link(s) with a short note.
9. If anything fails after payment, bot tells the buyer it is being handled, gives the WhatsApp support number, and alerts the admin.

## 8. Functional requirements

### 8.1 Buyer agent (Groq, tool calling)

- The bot is an agent, not a script. It runs a tool calling loop on Groq (`GROQ_MODEL`, default `openai/gpt-oss-120b`, with fallback models). It reads the buyer's message and recent history (last 10 turns), decides what to do, calls tools, and replies.
- Tools, all executed by code: `get_price`, `check_availability`, `create_payment_link`, `get_my_orders`, `resend_my_links`, `cancel_pending_order`, `escalate_to_support`. Full spec in `docs/ARCHITECTURE.md`.
- Agentic behavior: handles multi step requests ("i need 3, how much, can i pay now"), answers questions about the offer from a built in knowledge base (including what happens for people who already have a Google plan, and that the 18 months run from activation), handles trust questions and objections briefly, resumes unfinished orders, sends one follow up nudge for an abandoned payment link, and escalates unclear or problem cases to WhatsApp support.
- Hard limits: the agent never sees or writes activation links, never confirms a payment, never calls the reseller, and cannot change the price. Money and delivery are deterministic code. Tool arguments are validated in code (quantity limits, one pending order per user). User text is untrusted.
- Style: very short, lowercase, casual, no em dashes (stripped in code).
- If Groq fails or rate limits, the bot falls back to scripted replies with inline buttons so sales never stop.
- Command fallbacks: `/start`, `/buy`, `/status`, `/help`.
- Owner side (stretch goal): natural language read only questions ("how much did i sell today", "what's the balance") through an admin tool set. Destructive actions stay explicit commands.

### 8.2 Pre-sale checks (before issuing a payment link)

- Product in stock: `GET /products/{id}` (`inStock`, `stock`).
- Balance covers the order: `GET /account/balance`, minus the cost of orders already paid but not yet fulfilled.
- Maximum quantity per order = the lowest of: stock, what the balance can cover, and `MAX_QTY_PER_ORDER` (default 10).
- If the buyer asks for more than available, the bot says how many it can sell right now.
- If nothing can be sold, the bot says it is out of stock and does not create a payment link.
- **No time cutoff by default.** Selling stops only when the reseller has no stock or balance is too low. An optional `SALES_CUTOFF` env var exists but is off.
- One pending payment per user at a time.

### 8.3 Payment (Paystack)

- Initialize an NGN transaction with a unique reference tied to our order id.
- Payment link expires after a set window (default 15 minutes).
- Webhook verifies the `x-paystack-signature` header (HMAC SHA512 with the secret key). Invalid signatures are rejected and logged.
- On `charge.success`, also call Paystack's verify endpoint, and check amount, currency, and reference against the order before fulfilling.
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

The delivery message is a fixed short template (so the facts are always right and links never pass through the LLM). Questions about existing subscriptions are answered flexibly by the agent. Example:

> payment confirmed. here is your link:
> {link}
> open it, sign in to the google account you want it on, and activate. it runs for 18 months from activation. any issue, whatsapp 08087357158

For bulk orders, links are sent as a numbered list. The message also reminds buyers to activate quickly because the offer is ending. Activation links are never written to logs.

### 8.6 Support

- Dead link or any complaint: buyer messages the owner's WhatsApp support number (08087357158), which the bot shows in delivery messages, `/help`, and error messages.
- Owner replaces links from reseller stock through an admin command and the bot records the replacement.

### 8.7 Error handling

| Case | Behavior |
|---|---|
| `insufficient_funds`, `out_of_stock` after payment | retry briefly, then `needs_attention`, tell buyer it is being handled with the support number, alert admin on all channels |
| `supplier_purchase_failed` | retry with same idempotency key, then as above |
| `supplier_purchase_pending` | poll order status |
| `invalid_api_key` | pause sales, alert admin immediately |
| Reseller timeout or 5xx | retry with backoff, verify order status before giving up |
| Paystack amount mismatch | do not fulfil, alert admin |
| Groq failure or rate limit | scripted fallback with buttons |
| Render cold start | Paystack retries webhooks; reconciliation job catches anything missed |

### 8.8 Admin features (owner only, by Telegram id allowlist)

- `/balance`: reseller USD balance and how many links it covers.
- `/stats`: sales and revenue today and total, failures.
- `/orders`: recent orders with status.
- `/resend <order>`: resend delivered links.
- `/replace <order>`: send a replacement link for a dead one.
- `/pause` and `/resume`: stop or restart sales.

### 8.9 Alerts

Sent to three channels: the owner's email, his main Telegram account, and ntfy.sh push notifications on his phone. Triggers: low balance (default: covers fewer than 5 links), out of stock, any `needs_attention` order, invalid API key, webhook signature failures, repeated Groq failures, service restart.

## 9. Order states

`created` → `awaiting_payment` → `paid` → `fulfilling` → `delivered`

Side states: `expired` (unpaid), `partial` (some links delivered), `needs_attention`, `refunded`, `cancelled`.

State changes are persisted before external calls. A reconciliation job runs on startup and on a timer, re-checking `awaiting_payment`, `paid`, `fulfilling`, and `partial` orders against Paystack and the reseller.

## 10. Data (Neon Postgres)

- **users:** telegram_user_id, username, first seen.
- **orders:** id, telegram_user_id, quantity, status, amount_ngn, paystack_reference (unique), timestamps, error info.
- **order_items:** order_id, index, reseller_order_code, activation_link, status.
- **events:** webhook payloads and reseller responses with secrets redacted.
- **messages:** short chat history per user (last 10 turns used for the LLM).

## 11. Non-functional requirements

- **Hosting:** Render free web service for the bot and webhook server, plus an uptime monitor pinging `/health` about every 10 minutes (Render free services sleep after 15 idle minutes). If sleeping causes missed sales, upgrade to the $7/month instance.
- **Database:** Neon Postgres (not SQLite, because Render's free disk does not persist).
- **Stack:** Node.js with TypeScript.
- **Security:** all secrets in environment variables (Telegram token, Paystack secret, reseller API key, Groq key, SMTP or email key, ntfy topic). `.env` gitignored, `.env.example` committed. Admin allowlist by Telegram id.
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
| Render free tier sleeps | uptime monitor, Paystack webhook retries, reconciliation job, paid instance as fallback |
| Groq outage or rate limit | model fallbacks, scripted button fallback |
| Webhook spoofing or replay | signature check, verify API call, idempotency |
| Bulk order partly fails | per item orders, partial delivery, retries, admin alert |
| Reseller terms or offer eligibility problems | owner to confirm reseller terms; honest buyer messaging with no guarantees beyond replacement support |

## 14. Remaining details to confirm during build

1. Verify with one real buyer who already has a Google plan how activation behaves. The bot's answer about existing subscriptions follows the owner's description and should be checked.
2. Alert email address (assumed hello@samkiel.dev).
3. Whether Paystack's customer-bears-fees setting is available on the account (otherwise the bot grosses up the amount).
4. `MAX_QTY_PER_ORDER` (default 10).

## 15. Milestones

| Date (WAT) | Milestone |
|---|---|
| Mon 26 Oct | PRD final, repo and Render service created, Neon database, bot skeleton, Paystack init and webhook in test mode |
| Tue 27 Oct | reseller integration, bulk fulfilment, Groq chat, delivery, alerts, admin commands, end to end test |
| Wed 28 Oct | live with real payments, small pilot, fix issues, update flyer and channel post to the bot link |
| Thu 29 Oct | last day to claim; full push; watch balance and alerts |

## 16. Next steps

1. Approve this PRD and add it to `docs/PRD.md` in the geminipro repo.
2. Architecture doc: bot, webhook server, Paystack, reseller API, Neon, Groq, alerts.
3. Claude Code prompts, then implementation.
