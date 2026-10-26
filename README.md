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
| `pnpm start` | run the compiled server |
| `pnpm typecheck` | type check `src` and `test` |
| `pnpm lint` | ESLint |
| `pnpm test` | vitest |
| `pnpm db:generate` | generate a new SQL migration after editing `src/db/schema.ts` |
| `pnpm db:migrate` | apply pending migrations |
| `pnpm mock:reseller` | run the mock reseller API on port 4010 (`pnpm dev` already starts it when `RESELLER_MOCK=true`) |
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
