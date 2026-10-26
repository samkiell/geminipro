# geminipro

Telegram agent ([@geminiprosamkiel_bot](https://t.me/geminiprosamkiel_bot)) that sells Gemini Pro 18 month activation links. Buyers chat with the bot, pay in NGN through [Bachs](https://docs.bachs.io), and the bot buys the link from the reseller API and delivers it.

- Product requirements: [docs/PRD.md](docs/PRD.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

Stack: Node.js 22, TypeScript, Fastify, grammY, Drizzle + Neon Postgres, zod, pino, vitest.

## Setup

1. Install Node.js 22 or newer and pnpm (`corepack enable`), then install dependencies:

   ```sh
   pnpm install
   ```

2. Create a Neon project and copy the **pooled** connection string (it contains `-pooler` in the host and ends with `?sslmode=require`).

3. Create your env file and fill it in. Every variable is described in `.env.example`.

   ```sh
   cp .env.example .env
   ```

   The app validates the environment at boot and prints every missing or invalid variable, then exits.

4. Create the tables:

   ```sh
   pnpm db:migrate
   ```

   This only needs `DATABASE_URL`, so you can run it before the rest of `.env` is filled in.

5. Start the dev server (restarts on file changes):

   ```sh
   pnpm dev
   ```

   Check it: `curl http://localhost:3000/health` returns `{"ok":true,"db":"ok"}`. It returns 503 if the database is unreachable.

   In development the bot reads Telegram updates by long polling, so you can chat with it without a public URL. Polling removes any webhook set on the same bot, so after testing locally run `pnpm webhook:set` again before relying on the deployed service.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | run `src/index.ts` with reload |
| `pnpm build` | compile to `dist/` |
| `pnpm start` | apply pending migrations, then run the compiled server (what Render runs) |
| `pnpm typecheck` | type check `src` and `test` |
| `pnpm lint` | ESLint |
| `pnpm test` | vitest |
| `pnpm db:generate` | generate a new SQL migration after editing `src/db/schema.ts` |
| `pnpm db:migrate` | apply pending migrations |
| `pnpm mock:reseller` | run the mock reseller API on port 4010 (the app already runs it itself when `RESELLER_MOCK=true`) |
| `pnpm order:test [qty] [telegramId]` | sandbox only: create an order and print its Bachs checkout link; `--cancel` cancels it |
| `pnpm eval:agent [names]` | run scripted buyer conversations against the real Groq models and check tool use and reply rules |
| `pnpm webhook:set` | point Telegram at `PUBLIC_URL`, register the command menus, print the Bachs webhook URL |

## Test mode and live mode

Bachs sandbox keys (`sk_sandbox_`) must run with `RESELLER_MOCK=true`, and live keys (`sk_live_`) with `RESELLER_MOCK=false`. The app refuses to boot otherwise, because a sandbox payment must never spend the real reseller balance and a real payment must never get a mock link. The key also picks the Bachs environment: `sk_sandbox_` talks to `sandbox-api.bachs.io`, `sk_live_` to `api.bachs.io`.

## Payments (Bachs)

1. In the Bachs dashboard, set **who pays the processing fee** to the customer (`fee_preference: customer_pays`) and keep `GROSS_UP=false`. Bachs then adds the exact fee at checkout and you receive the full price. If you keep `org_pays`, set `GROSS_UP=true` so the bot adds the fee itself. The app checks this at boot and alerts if they disagree.
2. Add a webhook endpoint at `https://<your service>/bachs/webhook` for the events `checkout.completed`, `collection.succeeded` and `checkout.expired`, and put its signing secret in `BACHS_WEBHOOK_SECRET`. Sandbox and live each need their own endpoint and secret.
3. To receive sandbox webhooks on your machine without a public URL, run `bachs listen --forward-to localhost:3000/bachs/webhook --events checkout.completed,collection.succeeded,checkout.expired` and use the `whsec_` secret it prints.

An order is only marked paid after the signature checks out and Bachs itself reports the checkout as completed, in NGN, for at least the order amount. Anything else holds the order as `needs_attention` and alerts the owner.

The mock reseller keeps everything in memory. While it runs, `POST http://127.0.0.1:4010/__mock/control` changes its behaviour, for example `{"set":{"stock":0}}`, `{"faults":["timeout"]}` or `{"failNthItem":{"n":2}}`. `GET /__mock/state` shows the current state.

## Deploy to Render

The service is a free Render web service described by `render.yaml`: Node 22, build `corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm build`, start `pnpm start`, health check `/health`. `pnpm start` applies pending migrations, then boots, so a fresh clone with only env vars set deploys on its own. A fresh database gets its tables on first boot, and later boots skip migrations that are already applied.

### 1. Neon

1. Use your Neon project (or a separate branch for production) and copy the **pooled** connection string: `-pooler` in the host, `?sslmode=require` at the end. That is `DATABASE_URL`.
2. Nothing else to do: the first deploy creates the tables.

### 2. Render

1. Push the repo to GitHub. In Render: **New > Blueprint**, pick the repo. Render reads `render.yaml`.
2. Render asks for every variable marked `sync: false` (table below). The rest already have values in `render.yaml`.
3. Deploy. When it is live, open `https://<service>.onrender.com/health`: it should say `{"ok":true,"db":"ok"}`.
4. Put that URL in `PUBLIC_URL` on Render if you did not already, and redeploy.
5. On your machine, with the same `PUBLIC_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` and `ADMIN_TELEGRAM_IDS` in `.env`, run `pnpm webhook:set`. It points Telegram at `/telegram/webhook`, registers the command menus and prints the Bachs webhook URL.
6. Add that Bachs webhook endpoint in the Bachs developer portal, put its signing secret in `BACHS_WEBHOOK_SECRET` on Render, and redeploy.
7. Stop `pnpm dev` on your machine while the deployed bot is live: local polling removes the webhook. If it happens, run `pnpm webhook:set` again. (A second bot from BotFather for local testing avoids this.)

| Variable (set in Render) | What to put |
|---|---|
| `PUBLIC_URL` | `https://<service>.onrender.com` |
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | a long random string, for example `openssl rand -hex 32` |
| `ADMIN_TELEGRAM_IDS` | your Telegram user id, comma separated for more admins |
| `BACHS_SECRET_KEY` | `sk_sandbox_...` to start, `sk_live_...` at launch |
| `BACHS_WEBHOOK_SECRET` | the signing secret of the Bachs webhook endpoint for that environment |
| `BACHS_BASE_URL` | leave empty (the key picks sandbox or live) |
| `RESELLER_MOCK` | `true` with a sandbox key, `false` with a live key |
| `RESELLER_API_KEY` | from the reseller bot (any value while `RESELLER_MOCK=true`) |
| `GROQ_API_KEY` | from the Groq console |
| `DATABASE_URL` | the Neon pooled connection string |
| `ALERT_EMAIL`, `ALERT_EMAIL_FROM`, `RESEND_API_KEY` | where alerts go and who sends them (Resend, verified domain) |
| `NTFY_TOPIC` | a long, hard to guess topic; subscribe to it in the ntfy app |
| `SALES_CUTOFF` | optional, leave empty |

### 3. Keep it awake (UptimeRobot)

Free Render services sleep after 15 idle minutes and take about a minute to wake (Telegram and Bachs retry meanwhile, and the reconciler catches up). In [UptimeRobot](https://uptimerobot.com) add an **HTTP(s)** monitor on `https://<service>.onrender.com/health` every **10 minutes**. It keeps the service awake and alerts you if `/health` fails (it returns 503 when the database is unreachable). One always-on free service fits in Render's monthly free hours.

### 4. Sandbox first, then live

With `sk_sandbox_` and `RESELLER_MOCK=true` the deployed bot runs end to end with no real money: sandbox payments, links from the built in mock reseller (it runs inside the app on 127.0.0.1). To go live:

1. In Bachs, create the **live** webhook endpoint (same URL, live mode) and copy its signing secret. Check the live account's fee setting (`customer_pays` with `GROSS_UP=false`).
2. On Render set `BACHS_SECRET_KEY=sk_live_...`, `BACHS_WEBHOOK_SECRET=<live signing secret>`, `RESELLER_MOCK=false` and the real `RESELLER_API_KEY`, all in one go (the app refuses to boot with a mismatched pair), then redeploy.
3. Send `/balance` to the bot to confirm the reseller key and balance, then make one small real purchase.

### 5. Reseller balance

Every link is bought from the reseller at about $1.20. Top up on the reseller's bot. `/balance` shows the USD balance, how many links it covers, the stock, links promised to open orders and how many you can still sell. You get an alert when fewer than `LOW_BALANCE_ORDERS` links are left, and paid orders that waited on the balance complete by themselves within 10 minutes of a top up.

## What buyers see

- **Commands**: `/start`, `/buy`, `/history`, `/help`. Everything else is chat ("i need 3", "where is my link", "who made you").
- **Buying**: an order summary card with − and + for quantity, the fee line, the offer line, [pay] and [cancel], plus a live status message that turns into the receipt.
- **Delivery**: links in tap-to-copy code blocks, numbered for bulk orders, with [need help on whatsapp] [my orders].
- **Activation, the last step**: each link has a ✅ button. After activating, the buyer taps it and confirms; the link is closed in every message that showed it and never shown again. /stats counts activations.
- **History**: orders as buttons (GP-1042 · 2 links · 26 oct · delivered ✅), each with its card and [show my links].
- **Buttons disappear** once their job is done; stale taps say "this button has expired".
- **When Groq is rate limited** (free tier), the bot answers instantly with scripted replies that still open the card, history and help pages, in english or pidgin.

Admins (ids in `ADMIN_TELEGRAM_IDS`) also get `/admin`, `/balance`, `/stats`, `/allorders`, `/order`, `/resend`, `/replace`, `/pause`, `/resume`, `/offertext`, `/leads`. Nobody else sees or can run them. `/admin` opens a panel with a button for every one of them: orders open with a tap, "find an order" and "change offer text" ask for a reply, and replace asks to confirm because it costs money. Run `pnpm webhook:set` to register both menus.

The offer line ("offer ending very soon") is a setting, not code: change it with `/offertext last 50 links left`. Buyer facing text never states an end date.

## Alerts and the reconciler

Every alert goes out at once to email (Resend, from `ALERT_EMAIL_FROM` to `ALERT_EMAIL`), to each admin's Telegram chat, and to the ntfy topic in `NTFY_TOPIC` (install the ntfy app and subscribe to it). A channel that fails is logged and the others still go. Alerts never contain a link.

- **Always, per order**: a paid order that could not be fulfilled, a payment held for review.
- **At most once per 30 minutes per trigger** (remembered across restarts): low stock, low reseller balance (fewer than `LOW_BALANCE_ORDERS` links left), reseller key rejected, bad webhook signatures, Groq unavailable, fee setup mismatch, service restarted.
- **Daily summary at 21:00 WAT**: today's orders, links and revenue, failures, the reseller balance and stock.

The reconciler runs at boot and then every 30 seconds (balance every 5 minutes). It expires unpaid orders and retires their cards, asks Bachs about unpaid checkouts up to a day old in case a webhook was lost, finishes paid orders that never started or whose fulfilment died mid way (the reseller idempotency keys make that safe), retries paid orders stuck for lack of balance or stock every 10 minutes, and sends payment nudges and activation reminders.

## Review before launch

samkiel must read these two files line by line; the bot says what they say.

- [ ] `src/knowledge/owner.ts`: every fact about samkiel is true and public, nothing private (no matric number, birth date, family, church, finances, supplier, costs, margins, balance).
- [ ] `src/content/help.ts`: how it works, what you get, activation steps, existing plan answer, and the refund and replacement policy are exactly what you will honour.
- [ ] `src/agent/prompt.ts` and `src/bot/views.ts`: the price, fee wording and support number read right.
- [ ] `/offertext` set to what you want buyers to see.
- [ ] `pnpm eval:agent` passes (run it twice; it costs a few Groq calls).

## Changing the database schema

1. Edit `src/db/schema.ts`.
2. `pnpm db:generate` writes a new SQL file to `src/db/migrations/`. Read it before committing.
3. `pnpm db:migrate` applies it.

Never edit a migration that has already been applied to a real database. Add a new one.
