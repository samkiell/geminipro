# geminipro

Telegram agent ([@samkielbot_geminipro](https://t.me/samkielbot_geminipro)) that sells Gemini Pro 18 month activation links. Buyers chat with the bot, pay in NGN through Paystack, and the bot buys the link from the reseller API and delivers it.

- Product requirements: [docs/PRD.md](docs/PRD.md)
- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

Stack: Node.js 22, TypeScript, Fastify, grammY, Drizzle + Neon Postgres, zod, pino, vitest.

## Setup

1. Install Node.js 22 or newer, then install dependencies:

   ```sh
   npm install
   ```

2. Create a Neon project and copy the **pooled** connection string (it contains `-pooler` in the host and ends with `?sslmode=require`).

3. Create your env file and fill it in. Every variable is described in `.env.example`.

   ```sh
   cp .env.example .env
   ```

   The app validates the environment at boot and prints every missing or invalid variable, then exits.

4. Create the tables:

   ```sh
   npm run db:migrate
   ```

   This only needs `DATABASE_URL`, so you can run it before the rest of `.env` is filled in.

5. Start the dev server (restarts on file changes):

   ```sh
   npm run dev
   ```

   Check it: `curl http://localhost:3000/health` returns `{"ok":true,"db":"ok"}`. It returns 503 if the database is unreachable.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | run `src/index.ts` with reload |
| `npm run build` | compile to `dist/` |
| `npm run start` | run the compiled server |
| `npm run typecheck` | type check `src` and `test` |
| `npm run lint` | ESLint |
| `npm test` | vitest |
| `npm run db:generate` | generate a new SQL migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | apply pending migrations |

## Changing the database schema

1. Edit `src/db/schema.ts`.
2. `npm run db:generate` writes a new SQL file to `src/db/migrations/`. Read it before committing.
3. `npm run db:migrate` applies it.

Never edit a migration that has already been applied to a real database. Add a new one.
