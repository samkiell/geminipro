# Architecture: geminiprosamkiel_bot

Owner: Samuel Ezekiel (@samkieldev) | Version 1 | 26 Oct 2026 | Companion to `docs/PRD.md`

## 1. Design principle

**The agent proposes, the code disposes.**

The buyer talks to an AI agent (Groq, tool calling). The agent decides what to say and which tool to call. But anything involving money, links, or state is done by deterministic code that validates every request. The agent can start a payment. It can never confirm one, never buy a link, and never see a link.

## 2. System overview

```mermaid
flowchart LR
  B[Buyer on Telegram] -->|messages| TG[Telegram]
  TG -->|webhook| S[Fastify server on Render]
  S --> A[Agent loop - Groq]
  A -->|tool calls| T[Tool layer - validated code]
  T --> DB[(Neon Postgres)]
  T -->|create checkout| PS[Bachs]
  B -->|pays| PS
  PS -->|checkout.completed webhook| S
  S --> F[Fulfilment engine]
  F -->|POST /orders| R[Reseller API]
  F --> DB
  F -->|send links| TG
  S --> N[Notifier: email, Telegram admin, ntfy]
  U[Uptime monitor] -->|GET /health| S
  REC[Reconciler timer] --> F
```

## 3. Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 22, TypeScript (strict) |
| HTTP server | Fastify |
| Telegram | grammY (webhook mode with secret token) |
| LLM | Groq SDK (`groq-sdk`), tool calling, model from `GROQ_MODEL` with fallbacks |
| Database | Neon Postgres, Drizzle ORM, `postgres` driver, drizzle-kit migrations |
| Validation | zod (tool args, env, API responses) |
| Logging | pino (redaction for secrets and links) |
| Email | Resend API (fallback: SMTP via nodemailer) |
| Push alerts | ntfy.sh |
| Tests | vitest |
| Hosting | Render free web service plus uptime monitor |

## 4. Repo structure

```
geminipro/
  docs/PRD.md, ARCHITECTURE.md, CLAUDE_CODE_PROMPTS.md
  src/
    index.ts              boot: env, db, bot api, flows, agent, server, timers
    config.ts             zod validated env
    server.ts             fastify routes
    routes/
      telegram.ts         POST /telegram/webhook (secret token)
      bachs.ts            POST /bachs/webhook (raw body, signature, verify, atomic paid)
      health.ts           GET /health
    bot/
      bot.ts              middleware (private only, per user queue, rate limit), 4 commands, button routing, chat
      flows.ts            everything the buyer sees about an order: card, stepper, status, history, links, help
      views.ts            pure renderers: summary card, status/receipt, links, history, order card, help, reminder
      telegram.ts         TelegramPort over the Bot API (send, edit, edit buttons, answer), html escape, splitting
      commands.ts         command menus for buyers and admins
      admin.ts            admin commands, allowlist
    agent/
      agent.ts            tool calling loop, reply cleanup, payment nudge text
      llm.ts              ModelPool: rate limit aware Groq model selection, fail fast
      turn.ts             one agent turn: history, offer text, buyer context, prompt
      prompt.ts           system prompt and knowledge base
      tools.ts            9 tool schemas and executors
      actions.ts          what the tools call (flows, pricing, reseller, leads)
      fallback.ts         smart scripted replies when no model is free
      buyer.ts            buyer context and pidgin detection
      history.ts          last 10 turns
      nudge.ts            abandoned payment nudge
    content/help.ts       /help hub pages; the refund and replacement wording
    knowledge/owner.ts    what the agent may say about samkiel and the shop
    services/
      payments.ts         PaymentProvider interface
      bachs.ts            BachsClient, BachsProvider, webhook signature check
      pricing.ts          fee gross up, totals
      orders.ts           order state machine, history queries
      reseller.ts         reseller client, error mapping, availability
      fulfilment.ts       fulfil orders, partial handling, delivery
      reminders.ts        activation reminder with quiet hours
      leads.ts            business inquiries
      settings.ts         paused, offer_text
      reconciler.ts       timers: expire, nudge, verify, recover, balance, reminders, daily summary
      notifier.ts         email, telegram admin, ntfy
    db/
      schema.ts, client.ts, migrate.ts, migrations/
    util/
      logger.ts, redact.ts, semaphore.ts, time.ts
  scripts/                eval-agent.ts, set-webhook.ts, create-test-order.ts
  test/
    mocks/reseller-server.ts, helpers/
    *.test.ts
  .env.example
  render.yaml
```

## 5. The agent

### 5.1 Loop

1. Telegram message arrives. Private chats only, one update at a time per user (a per chat queue), rate limit per user (20 messages per 10 minutes). Buttons left on the previous agent reply are removed. The buyer's language is noted (`users.lang`).
2. If the model pool has no free model (all rate limited or busy), skip to step 6 at once.
3. Build the system prompt with the current offer text and a one line buyer context, load the last 10 turns, call Groq with the tools, `temperature 0.4`, `max_tokens 300`. Tool calls are validated with zod and executed, results go back to the model, at most 5 rounds and 20 seconds per turn.
4. Final text is cleaned (no URLs, no markdown, em dashes become commas) and sent with any buttons the tools attached (portfolio, support). Cards and history views were already rendered by the tools themselves.
5. Save the turn to `messages`.
6. No model free, rate limited, errors, or too slow: `fallback.ts` answers. It recognises what the buyer wants and acts like the agent would (opens the order card for the quantity they named, shows history or an order, opens the right help page, cancels, saves a lead) or replies with one of many varied, lowercase lines (english or pidgin), never the same twice in a row, always with buttons and pointing to /buy, /history and /help.

### 5.2 Tools (buyer agent)

| Tool | Args | What the code does | Returns to the model |
|---|---|---|---|
| `get_price` | `quantity` (default 1) | computes base, fee, total | `{quantity, baseNgn, feeNgn, totalNgn, feeNote?}` |
| `check_availability` | none | paused, cutoff, reseller stock and balance minus reserved links | `{canSell, maxQuantity}` |
| `create_payment_link` | `quantity` (default 1) | creates or replaces the unpaid order and shows the summary card with the pay button (once per turn) | `{shown, orderNo, quantity, totalNgn, feeNote?}` |
| `show_history` | none | renders the paginated history in the chat | `{shown: true}` |
| `show_order` | `orderNo` | renders that order's card if it is the caller's | `{shown}` |
| `cancel_pending_order` | none | cancels the caller's unpaid order, retires its card | `{cancelled}` |
| `escalate_to_support` | `reason` | alerts admin, attaches a whatsapp button | `{supportWhatsapp}` |
| `get_owner_info` | `topic` | facts from `knowledge/owner.ts`, attaches portfolio/github/linkedin/blog buttons | `{ok, text}` |
| `save_lead` | `summary` | saves a business inquiry (3 a day per user), alerts admin | `{saved}` |

Rules enforced in code, regardless of what the model says:
- quantity is clamped and validated, never trusted
- an order is only created through `create_payment_link` (or /buy and the buy buttons)
- no tool returns an activation link, a checkout URL or a payment secret; views render in code
- tools only act on the calling user's `telegram_id`, taken from the update, never from model args

### 5.3 Agentic behaviors

- Multi step handling: "i need 3, can i pay now" shows the card for 3 in one turn.
- Offer knowledge from the built in knowledge base, the offer line from settings (never a date).
- Order awareness: "where is my link" opens the history; an order number opens that order.
- Owner knowledge (Prompt B): who made it, who samkiel is, his work, is this legit, where the links come from. Honest, short, with his links as buttons. Never claims to be samkiel, Google or Jio.
- Leads: "can you build me a website" saves a lead and alerts the owner.
- Light memory: first name, new or returning, past orders, language. Pidgin in, light pidgin out.
- Abandoned payment nudge: one follow up about 10 minutes after an unpaid payment link (model written, template fallback).
- Activation, the last step: every open link in a links message has a ✅ button (`v:<itemId>`). A tap swaps it for a confirmation (`v:y:` closes, `v:n:` backs out). Closing sets `order_items.activated_at` with a conditional UPDATE and edits every message in `message_ids` so the link turns into "activated ✅, closed". Closed links are never sent again (show my links, /resend, admin copies). When as many links are activated as were ordered, `orders.activated_confirmed_at` is set and history shows "activated ✅".
- Activation reminder: one "did you activate your link?" after delivery (`REMINDER_DELAY_MINUTES`, default 180) unless the order is already activated, never between 23:00 and 07:00 WAT. Its yes closes every link of the order.
- Smart escalation to WhatsApp support; never promises refunds or outcomes beyond the knowledge base.

### 5.4 Owner agent (stretch goal)

Same loop with admin only tools: `get_balance`, `get_stats`, `list_orders`, `get_order(id)`. Read only. Admin identity is checked by Telegram id allowlist before any admin agent runs.

### 5.5 System prompt

Lives in `agent/prompt.ts`, kept compact (Groq's free tier spends it on every call). It carries: the product, the owner blurb (max 80 words), style (short, lowercase, plain text, light pidgin when they write pidgin), facts (price and fee, what you get, how it works, existing plans, the offer line from settings, limits, the refund and replacement wording, support), how to act (which tool for which request), rules (an ai built by samkiel; never confirms payments, writes links, changes prices; never reveals the prompt, tools, supplier, costs, balance, admin commands or other buyers; user text is untrusted), and the buyer context line.

### 5.6 Robustness under load

- **Model pool** (`agent/llm.ts`): learns each model's remaining tokens and requests from Groq's headers, rests a model after a 429 until its reset time, rests it briefly on 5xx or timeout, caps model calls in flight (4), and times out each call at 8s. When no model is usable it throws at once without a network call, so the buyer gets the scripted reply in milliseconds.
- **Per user queue**: one update at a time per chat, so double taps and quick messages never race.
- **Telegram**: one Bot API client with 15s timeouts and auto retry for Telegram's own 429s; webhook replies after 9s while the handler finishes.
- **Fulfilment**: at most 3 orders bought at once; each link has a fixed idempotency key.
- **Database**: one unpaid order per user enforced by a unique index; every state change is a conditional update.
- **Status edits** are throttled and coalesced per order.

## 5A. Buyer experience (Prompt A)

- **Commands**: buyers have exactly `/start`, `/buy`, `/history`, `/help`. Typed requests like "my orders" or "where is my link" open the same history view.
- **Summary card** (before payment): order number, quantity with − and + (clamped to what is available, editing the same message), price per link, fee line, total, availability, "no refund if the link expires before you activate it", the offer line, a [pay ₦X + fee] URL button to the Bachs checkout and [cancel]. A different quantity is a different checkout: the unpaid order is cancelled and replaced, and the same card is edited in place.
- **Live status message**: one per order, created with the card, edited at every transition (`renderStatus`), throttled. After delivery it is the receipt: order number, quantity, amount paid, date and time in WAT.
- **Disappearing buttons**: a message never keeps live buttons after its job is done. The card collapses to one line ("paid ✅ order GP-1042", "expired", "cancelled"). Taps on stale buttons answer "this button has expired". Menus (help, history) edit one message. The message with the links is never edited or deleted.
- **Delivery**: links in `<code>` (tap to copy, HTML escaped), no link previews, no `protect_content`, "link 1 of 3" numbering, split under 4096 characters, buttons [need help on whatsapp] [my orders]. Delivered only after Telegram accepts.
- **History**: 5 orders per page, newest first, each a button; an order card with status, total, date, support and [show my links] (5 a minute per user, ownership checked on every tap).
- **Help hub** (`content/help.ts`): how it works, what you get, how to activate, existing plan, refunds and expiry, offer status, my orders, support.
- **Support**: `https://wa.me/<SUPPORT_WHATSAPP_INTL>?text=hi, i need help with order GP-1042`.
- **Offer line**: `settings.offer_text` (default "offer ending very soon"), changed with `/offertext`. No end date anywhere in buyer facing text.

## 6. Data model (Postgres)

```sql
create table users (
  telegram_id bigint primary key,
  username text, first_name text,
  created_at timestamptz default now(),
  last_seen_at timestamptz default now(),
  blocked boolean default false,
  lang text not null default 'en'          -- 'en' or 'pcm' (pidgin), from what they write
);

create sequence order_no_seq start with 1001;  -- GP-1001, GP-1002, ...

create type order_status as enum
 ('created','awaiting_payment','paid','fulfilling','partial','delivered',
  'expired','needs_attention','refunded','cancelled');

create table orders (
  id uuid primary key default gen_random_uuid(),
  order_no text unique not null default 'GP-' || nextval('order_no_seq'),  -- shown to buyers
  telegram_id bigint references users(telegram_id) not null,
  quantity int not null check (quantity > 0),
  unit_price_ngn int not null,
  fee_ngn int not null default 0,
  amount_ngn int not null,
  status order_status not null default 'created',
  payment_reference text unique not null,  -- gp_{id}, the Bachs checkout reference
  checkout_id text unique, checkout_url text,
  paid_at timestamptz, expires_at timestamptz, delivered_at timestamptz,
  nudge_sent boolean default false,
  summary_message_id int, pay_message_id int, status_message_id int,  -- chat messages kept in sync
  reminder_sent_at timestamptz, activated_confirmed_at timestamptz,
  fulfil_lease_until timestamptz,
  error text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create index on orders (status, updated_at);
create index on orders (telegram_id, created_at desc);
create unique index on orders (telegram_id) where status in ('created','awaiting_payment');  -- one unpaid order per user

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders(id) not null,
  idx int not null,
  status text not null default 'pending',  -- pending, completed, failed
  idempotency_key text unique not null,    -- {orderId}-{idx}
  reseller_order_code text,
  activation_link text,
  attempts int default 0,
  error text,
  delivered_at timestamptz,                -- set once Telegram accepted the message with it
  activated_at timestamptz,                -- buyer tapped ✅ and confirmed: closed, never shown again
  message_ids integer[] not null default '{}', -- buyer messages showing it, edited when it closes
  unique (order_id, idx)
);

create table leads (                       -- business inquiries saved by the agent
  id bigserial primary key,
  telegram_id bigint not null, username text,
  summary text not null,
  created_at timestamptz default now()
);

create table events (
  id bigserial primary key,
  kind text not null, ref text, payload jsonb,
  created_at timestamptz default now()
);
create unique index on events (kind, ref) where kind = 'bachs_webhook';  -- ref = Bachs event id

create table messages (
  id bigserial primary key,
  telegram_id bigint not null,
  role text not null, content text not null,
  created_at timestamptz default now()
);

create table settings (key text primary key, value jsonb);  -- paused, offer_text, alert cooldowns, etc.
```

`activation_link` is sensitive. It is never logged, and `events.payload` for reseller responses is stored with `value` redacted.

## 7. Key flows

### 7.1 Purchase

```mermaid
sequenceDiagram
  participant B as Buyer
  participant Ag as Agent
  participant T as Tools
  participant PS as Bachs
  participant W as Webhook
  participant F as Fulfilment
  participant R as Reseller
  B->>Ag: i need 2 links (or /buy 2)
  Ag->>T: create_payment_link(2)
  T->>PS: create checkout (NGN amount, reference)
  T-->>B: summary card (stepper, pay button) + live status message
  T-->>Ag: shown, orderNo, total
  Ag-->>B: one short line
  B->>PS: pays
  PS->>W: checkout.completed / collection.succeeded
  W->>W: verify signature, dedupe, fetch checkout, match amount
  W->>F: order paid
  F->>R: POST /orders x2 (idempotency keys)
  R-->>F: links
  F-->>B: tap-to-copy links via Telegram, status message becomes the receipt
```

### 7.2 Bachs specifics

Payments go through Bachs (https://docs.bachs.io). `sk_sandbox_` keys use `https://sandbox-api.bachs.io`, `sk_live_` keys use `https://api.bachs.io`, auth is `Authorization: Bearer <key>`. Money is a decimal string (`"3500.00"`), compared in minor units.

- Create checkout: `POST /v1/checkout-sessions` with `pricing {currency: NGN, amount}`, `reference` (`gp_{orderId}`, unique per account forever), `metadata {order_id, telegram_id, quantity}`, `customer {email: {telegram_id}@tg.samkiel.dev}` (Telegram has no email), `payment_method_types [NGN_CARD, NGN_BANK_TRANSFER]`, `expires_in_minutes` (15), `success_url`/`cancel_url` back to the bot, and header `Idempotency-Key: checkout_{orderId}`. Returns `checkout_id` and `checkout_url` (the pay button).
- Webhook: Bachs signs `"{timestamp}.{raw_body}"` with HMAC SHA256 using the endpoint's signing secret (`BACHS_WEBHOOK_SECRET`). Verify `X-Bachs-Signature-V2` (`t=..,v1=..`, any `v1` may match during a secret rotation) or `X-Bachs-Timestamp` + `X-Bachs-Signature`, with a timing safe compare and a 5 minute replay window. Bad signature: 401 and alert.
- On `checkout.completed` or `collection.succeeded` (either can come first, each can repeat): skip if the event id is already in `events`, find the order by `data.reference` or `data.checkout_id`, then `GET /v1/checkout-sessions/{checkout_id}` and require `status = completed`, `currency = NGN`, the same `reference`, and `amount = order.amount_ngn` exactly (the checkout amount stays the order amount; a `customer_pays` fee shows only on the charge, confirmed in the sandbox: 3500.00 checkout, 3552.50 charge). Not completed yet or Bachs unreachable: answer 503 so Bachs retries (about 80 minutes of retries). Mismatch: hold the order as `needs_attention` and alert.
- Atomic transition, in one transaction with recording the event id: `UPDATE orders SET status='paid', paid_at=now() WHERE id=$1 AND status IN ('created','awaiting_payment','expired','cancelled') RETURNING *`. No row, no work. Late payments are honored, after expiry (a bank transfer already on its way can complete an expired checkout) or after the buyer cancelled or changed quantity, because the money has already moved.
- Fees: the Bachs account's `fee_preference` decides who pays the processing fee (NGN card 2%, NGN bank transfer 1.5% capped at 2000). With `customer_pays`, set `GROSS_UP=false`: Bachs adds the exact fee at checkout. With `org_pays`, set `GROSS_UP=true`: `pricing.ts` computes `total = ceil((base + FEE_FLAT) / (1 - FEE_PCT))` (`FEE_PCT=0.02`, `FEE_FLAT=0`). The app reads `GET /v1/accounts/checkout/settings` at boot and alerts if the two disagree.

### 7.3 Fulfilment

```
fulfil(orderId):
  claim: UPDATE orders SET status='fulfilling', fulfil_lease_until=now()+interval '2 minutes'
         WHERE id=$1 AND paid_at IS NOT NULL
           AND (status IN ('paid','partial','needs_attention')
                OR (status='fulfilling' AND fulfil_lease_until < now()))
         RETURNING *
  if no row: return
  ensure order_items rows exist for idx 0..quantity-1
  for each item with status != 'completed':
     POST /orders {productId, quantity:1}  header X-Idempotency-Key = item.idempotency_key
     200 completed -> store order.value as activation_link, status completed
     409 supplier_purchase_pending -> poll GET /orders/{orderCode} up to 30s
     402 insufficient_funds / 409 out_of_stock / 400 supplier_purchase_failed -> retry 3x with backoff, then mark item failed
     timeout/5xx -> retry with same key, then GET /orders to check
  if all completed: deliver(order) ; status=delivered
  else if some completed: deliver completed ones now, status='partial', notify admin
  if nothing completed after retries: status='needs_attention', tell buyer, notify admin
```

`deliver(order)` sends links through Telegram (tap-to-copy `<code>` blocks, split under 4096 characters). Each link is marked delivered only after Telegram accepts the message carrying it; a retry sends only the links not yet delivered. If the user blocked the bot, status becomes `needs_attention` and admin is alerted (links remain in the database). A held payment (`needs_attention` with no `paid_at`) is never fulfilled. Every status change refreshes the buyer's status message. At most 3 orders are fulfilled at once.

### 7.4 Reconciler (timer every 30 seconds, and once at boot)

- `awaiting_payment` past `expires_at`: mark `expired` and retire its card; before that, if unpaid after ~10 minutes and `nudge_sent=false`, send the single nudge.
- Orders still `awaiting_payment` or `expired` for up to 24 hours: fetch the Bachs checkout to catch missed webhooks.
- `paid`, `partial`, or `fulfilling` with expired lease: run `fulfil`. Paid `needs_attention` orders are retried every 10 minutes (after a top up they complete on their own), except deliveries blocked by the buyer, which wait for `/resend`.
- Balance check every 5 minutes: alert if fewer than `LOW_BALANCE_ORDERS` links are left by stock or by balance, after subtracting units promised to open orders (with a cooldown so alerts are not spammed).
- Each job is isolated (one failing never stops the others) and a run waits for the fulfilments it started, so ticks never overlap.
- Activation reminders (quiet hours 23:00 to 07:00 WAT) and the daily admin summary at 21:00 WAT.

## 8. Reseller client

- Base URL and key from env. Every request has a 15 second timeout.
- Errors mapped from the reseller error codes: `insufficient_funds`, `out_of_stock`, `invalid_api_key`, `supplier_purchase_failed`, `supplier_purchase_pending`, `invalid_quantity`, `product_not_found`.
- `invalid_api_key` pauses sales and fires an immediate alert.
- Stock and balance reads are cached for 10 seconds to protect rate limits.
- Availability for a buyer: `maxQuantity = min(stock, floor((balance - reservedForPaidOrders) / unitCostUsd), MAX_QTY_PER_ORDER)`.

## 9. Alerts

`notifier.ts` sends to all three channels in parallel (8 second timeout each), never throws, never blocks the caller, and strips every link from the text:
- email via Resend, from `ALERT_EMAIL_FROM` (a domain verified in Resend) to `ALERT_EMAIL`
- Telegram message to the admin chat id(s)
- ntfy.sh topic push (high priority for failures)

Triggers: low balance, out of stock, `needs_attention` order, partial order, invalid API key, webhook signature failure, repeated Groq failure, boot after crash, buyer asked for support, buyer needs help activating, new lead. Each trigger type has a cooldown (default 30 minutes, stored in `settings` as `alert_cooldown:<key>` so a restart does not resend, checked one at a time per key so a burst sends once) except order failures. A daily summary goes out at 21:00 WAT: orders, links sold, revenue, failures, reseller balance and links left, pending orders.

## 10. Deployment

- **Render** web service (free), Node 22. Build: `corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm build`. Start: `pnpm start` (`node dist/db/migrate.js && node dist/index.js`: pending migrations, then the server). With `RESELLER_MOCK=true` (sandbox keys only) the app runs the mock reseller in process on 127.0.0.1, so a sandbox deploy works end to end.
- **Health:** `GET /health` returns 200 with db check. Uptime monitor pings every 10 minutes (free instances sleep after 15 idle minutes).
- **Telegram:** `pnpm webhook:set` calls `setWebhook` to `https://<service>.onrender.com/telegram/webhook` with `secret_token` (the route rejects requests without the matching header) and registers the command menus: four buyer commands by default, plus the admin list in each admin's chat (`BotCommandScopeChat`).
- **Bachs:** webhook endpoint `https://<service>.onrender.com/bachs/webhook` for `checkout.completed`, `collection.succeeded`, `checkout.expired`, set in the developer portal (sandbox and live are separate, each with its own signing secret).
- **Neon:** use the pooled connection string, `sslmode=require`.
- **Cold starts:** a sleeping service takes about a minute to wake. Telegram retries updates and Bachs retries webhooks, and the reconciler recovers anything missed. If sales are lost to sleeping, move to the $7/month instance.
- Keep `render.yaml` in the repo so the service can be recreated quickly.

### Environment variables

```
NODE_ENV, PORT, PUBLIC_URL
TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET, ADMIN_TELEGRAM_IDS
BACHS_SECRET_KEY, BACHS_WEBHOOK_SECRET, BACHS_BASE_URL (optional), GROSS_UP, FEE_PCT, FEE_FLAT
RESELLER_BASE_URL, RESELLER_API_KEY, RESELLER_PRODUCT_ID, RESELLER_MOCK, RESELLER_MOCK_URL
GROQ_API_KEY, GROQ_MODEL, GROQ_FALLBACK_MODELS
DATABASE_URL
UNIT_PRICE_NGN=3500, MAX_QTY_PER_ORDER=10, LOW_BALANCE_ORDERS=5
SUPPORT_WHATSAPP_INTL=2348087357158, REMINDER_DELAY_MINUTES=180
ALERT_EMAIL, ALERT_EMAIL_FROM, RESEND_API_KEY, NTFY_TOPIC
SALES_CUTOFF (optional, empty by default)
(the offer line is a setting, not an env var: /offertext)
```

## 11. Security checklist

- All secrets in env vars. `.env` gitignored, `.env.example` committed.
- Verify Telegram secret header and Bachs signature on raw bodies.
- Sandbox payment keys only run with the mock reseller, live keys only with the real one (enforced at boot).
- Admin commands and admin agent gated by Telegram id allowlist.
- LLM has no secrets, no links, no payment authority. Tool args validated with zod. Per user rate limits.
- Log redaction for tokens, keys, and activation links.
- Constant time comparisons for signatures.
- Parameterized queries only (Drizzle).
- Rotate keys if the repo or logs ever leak them.

## 12. Testing

- **Unit:** fee gross up, quantity clamping, signature verification, state transitions, idempotency key generation, availability math.
- **Integration:** local mock reseller server (`RESELLER_MOCK=true`) that can simulate success, pending, out of stock, insufficient funds, timeouts, and partial failures. Bachs sandbox with a simulated signed webhook.
- **Agent evals:** `pnpm eval:agent` runs scripted buyer conversations against the real Groq models (buy 1, buy 3, price, existing plan, "where is my link", prompt injection, off topic, who made you, who is samkiel, bot or person, is this legit, where the links come from, are you from google, what samkiel built, build me a website, portfolio, supplier injection, balance, pidgin, returning buyer) and checks tool calls, buttons, leads, that replies are short and lowercase, and never include a link or private information.
- **Buyer UX:** delivery formatting (code tags, escaping, splitting), buttons removed after pay, expiry and cancel, history pagination and ownership, status rendering for every state, offer text never a date, stepper limits, reminder quiet hours. `test/flows.test.ts` runs the whole buy, step to 3, pay, deliver, history, show links flow.
- **Smoke test before launch:** one Bachs sandbox payment end to end against the mock, then one real $1.20 reseller purchase with a live key and a small real payment.

## 13. Build order

1. Scaffold, config, health route, Neon connection, migrations.
2. Reseller client plus mock server.
3. Bachs service plus webhook route.
4. Order state machine plus fulfilment engine plus delivery.
5. Agent loop, tools, prompt, scripted fallback.
5A. Bachs and the buyer UX layer (Prompt A), owner knowledge and buyer memory (Prompt B), robustness under load.
6. Admin commands, alerts, reconciler.
7. Deploy to Render, set webhooks, uptime monitor.
8. Test mode end to end, then live pilot.
