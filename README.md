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
| `pnpm eval:agent` | run scripted buyer conversations against the real Groq models and check tool use and reply rules |

## Test mode and live mode

Bachs sandbox keys (`sk_sandbox_`) must run with `RESELLER_MOCK=true`, and live keys (`sk_live_`) with `RESELLER_MOCK=false`. The app refuses to boot otherwise, because a sandbox payment must never spend the real reseller balance and a real payment must never get a mock link. The key also picks the Bachs environment: `sk_sandbox_` talks to `sandbox-api.bachs.io`, `sk_live_` to `api.bachs.io`.

## Payments (Bachs)

1. In the Bachs dashboard, set **who pays the processing fee** to the customer (`fee_preference: customer_pays`) and keep `GROSS_UP=false`. Bachs then adds the exact fee at checkout and you receive the full price. If you keep `org_pays`, set `GROSS_UP=true` so the bot adds the fee itself. The app checks this at boot and alerts if they disagree.
2. Add a webhook endpoint at `https://<your service>/bachs/webhook` for the events `checkout.completed`, `collection.succeeded` and `checkout.expired`, and put its signing secret in `BACHS_WEBHOOK_SECRET`. Sandbox and live each need their own endpoint and secret.
3. To receive sandbox webhooks on your machine without a public URL, run `bachs listen --forward-to localhost:3000/bachs/webhook --events checkout.completed,collection.succeeded,checkout.expired` and use the `whsec_` secret it prints.

An order is only marked paid after the signature checks out and Bachs itself reports the checkout as completed, in NGN, for at least the order amount. Anything else holds the order as `needs_attention` and alerts the owner.

The mock reseller keeps everything in memory. While it runs, `POST http://127.0.0.1:4010/__mock/control` changes its behaviour, for example `{"set":{"stock":0}}`, `{"faults":["timeout"]}` or `{"failNthItem":{"n":2}}`. `GET /__mock/state` shows the current state.

## Changing the database schema

1. Edit `src/db/schema.ts`.
2. `pnpm db:generate` writes a new SQL file to `src/db/migrations/`. Read it before committing.
3. `pnpm db:migrate` applies it.

Never edit a migration that has already been applied to a real database. Add a new one.
