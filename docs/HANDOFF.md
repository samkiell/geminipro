# Handoff: geminipro (@geminiprosamkiel_bot)

State on 26 Oct 2026. Branch `main`, everything pushed. 251 tests pass; typecheck, lint and build are clean.

## Production (since 26 Oct 2026)
- Live at https://geminiprosamkiel.onrender.com with live Bachs keys, `RESELLER_MOCK=false`, `NODE_ENV=production`. `/health` shows the deployed commit.
- The Render service was made by hand with npm defaults (`npm install; npm run build`, Node 26 from `engines`). `typescript` and `@types/node` are dependencies so that build works with `NODE_ENV=production` (`2c4d24a`).
- The local `.env` uses the same Neon database and bot token as prod. Production marks the database (`settings.live_shop_database`): `pnpm dev` on it refuses to start, a running one stops its reconciler, and local polling never deletes a set webhook. Local work needs a Neon branch and a test bot.
- Verified 26 Oct: health and database OK. The Telegram webhook route rejects requests without the secret and accepts the `.env` secret. The Bachs webhook secret is set (unsigned requests get 401). The Groq key works and all 3 models exist. The live reseller key works: balance $8.75 covers 7 links at $1.25, stock 151. No paid-but-undelivered test orders.
- The prod database still has the sandbox test orders (12 delivered), so `/stats` includes them. The proof album's only item was `FHENIX SPEAKERS (5 of 109).jpg` (owner asked to remove with `/delproof 1`).

## What this is
Telegram bot that sells Google AI Pro 18 month (Jio offer) activation links for ₦3,500 + fee. Node 22, TypeScript strict, Fastify, grammY, Drizzle + Neon Postgres, zod, pino, vitest (PGlite in-memory DB in tests), pnpm. Payments: Bachs (not Paystack). Links bought from a reseller API (mock reseller runs in-process when `RESELLER_MOCK=true`). LLM: Groq.

Read first: `CLAUDE.md` (rules), `docs/PRD.md`, `docs/ARCHITECTURE.md` (section 5B covers Prompt D), `README.md`, `RUNBOOK.md` (has the launch checklist), `docs/CLAUDE_CODE_PROMPTS.md`, `PROMPT_D_polish_referral_gate.md`.

## Done (all pushed to origin main)
- Prompts 0 to 8 from `docs/CLAUDE_CODE_PROMPTS.md`, Prompts A, B, C.
- Prompt D, every section:
  - 1 (`940a399`): one response per action, copy deck, no stubs, no fee percentages.
  - 2 and 3 (`a77ba76`): draft cart (`order_drafts`), order number only on [continue], channel gate with fail open.
  - 4 (`d0286b0`, fix `b137a10`): live countdown loop. The fix stores the Bachs session `expires_at` as `orders.expires_at`; `BACHS_SESSION_TTL_MINUTES` is the requested length and the fallback.
  - 1/4 fix (`b9bdbc0`): after payment the payment card itself becomes "✅ paid, getting your links…" then "🎉 delivered". The old five line status message is no longer sent for new orders. Reconciler expiry uses the full expired text.
  - 5 (`8273948`): delivery message with confetti. The plain resend happens only on a Telegram 400, so a timeout never sends links twice.
  - 6 (`98af14f`): referral program. `src/services/referrals.ts`, migration `0008_referrals.sql` (applied to the Neon DB in `.env`), `/invite`, `invite` agent intent, help hub button, referral lines in `/stats` and the daily summary, `test/referrals.test.ts`.
  - 7 (`58d4c0b`): `/myid`, admin id count logged at boot, buyer menu start, buy, history, invite, help.
  - 8 (`51281aa`): PRD, ARCHITECTURE, README, RUNBOOK, `.env.example`, `render.yaml`.
- Prompt 8 pass (`f6a194c`): launch checklist in RUNBOOK. The referral hook no longer awaits reward fulfilment inside the 3 slot fulfilment semaphore (that could deadlock).

## Decisions worth knowing
- `BOT_USERNAME` from Prompt D is the existing `TELEGRAM_BOT_USERNAME`; no new variable.
- Reward orders: `status='paid'` at creation, `payment_reference = reward_<referrer>_<n>` (idempotent), amount 0. They are created only when sales are on and the reseller can cover them; otherwise the reconciler step `referral rewards` retries and admins get one alert per 30 minutes.
- Only a user's first contact can be attributed: the users upsert middleware detects a fresh insert with `xmax = 0`.
- Sales stats (`/stats` revenue, links) count `source='purchase'` only; rewards have their own line.

## Still open
- **Telegram webhook switch** to Render is for the owner to run (auto mode blocks it): `PUBLIC_URL=https://geminiprosamkiel.onrender.com pnpm webhook:set`.
- **Live acceptance not run.** It needs real Telegram accounts: real purchase with confetti, channel gate with a non member, referral with a brand new account. The same paths are covered by the automated tests.
- **Bachs session cancel** on cancel or expire is not implemented. Nobody has confirmed from the Bachs docs that the API supports it.
- **Confetti id** `5046509860389126442` is the commonly used 🎉 effect. The Bot API docs do not list effect ids, so confirm it in the first live delivery. If Telegram rejects it, the message still goes out without the effect.
- The owner's Windows environment sets `NODE_TLS_REJECT_UNAUTHORIZED=0` (not in `.env`). Make sure it is not set on Render.

## Rules (must follow)
- Never commit `.env` or any secret. Before each commit run the secret scan: `git diff | grep -nE 'npg_[A-Za-z0-9]{6,}|rsp_live_[A-Za-z0-9]{20,}|sk_(live|sandbox)_[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,}'` must print nothing.
- Never add Co-Authored-By or any AI attribution to commits. Commit per section, then push to origin main.
- Run `pnpm typecheck && pnpm lint && pnpm test` before every commit.
- No em dashes in user facing text. Lowercase, short bot copy. Never log secrets or activation links. Every external call has a timeout; reseller purchases use idempotency keys; money state changes are conditional UPDATEs.
- Never kill processes by port: the user runs `pnpm dev` on port 3000.
- Migrations: edit `src/db/schema.ts`, run `pnpm db:generate`, then `pnpm db:migrate` (applies to Neon so the user's dev server keeps working).
- Link replacements are best effort, never promised.
