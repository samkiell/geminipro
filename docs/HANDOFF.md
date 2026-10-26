# Handoff: geminipro (@geminiprosamkiel_bot)

State on 26 Oct 2026. Branch `main`, last pushed commit `a7a8ae0`. All 232 tests pass, typecheck, lint and build are clean.

## What this is
Telegram bot that sells Google AI Pro 18 month (Jio offer) activation links for ₦3,500 + fee. Node 22, TypeScript strict, Fastify, grammY, Drizzle + Neon Postgres, zod, pino, vitest (PGlite in-memory DB in tests), pnpm. Payments: Bachs (not Paystack). Links bought from a reseller API (mock reseller runs in-process when `RESELLER_MOCK=true`). LLM: Groq free tier.

Read first: `CLAUDE.md` (rules), `docs/PRD.md`, `docs/ARCHITECTURE.md`, `README.md`, `RUNBOOK.md`, `docs/CLAUDE_CODE_PROMPTS.md`, `PROMPT_D_polish_referral_gate.md`.

## Done (all pushed to origin main)
- Prompts 0 to 7 from `docs/CLAUDE_CODE_PROMPTS.md`.
- Prompt A (Bachs, buyer UX), Prompt B (owner knowledge, leads, pidgin, buyer memory).
- Prompt 6: admin commands, `/admin` panel with a button for every command, notifier, reconciler.
- Link activation: every delivered link has a ✅ button, confirm step, then the link is closed.
- Prompt C: single Groq call per message, fast paths, 5 min cache, model failover, proof screenshots.
- **Prompt D Sections 1 through 5 are DONE**:
  - **Section 1 (`940a399`)**: One response per action, clean copy deck, no "moved below" stubs, removed fee percentage mentions.
  - **Sections 2 & 3 (`a77ba76`)**: Draft cart (`order_drafts` table, migration `0007_nasty_jack_flag.sql`), order numbers (GP-XXXX) only allocated on [continue], draft quantity adjustments edit in place, channel gate `@samkieldevtg` with fail-open and 30m alert cooldown.
  - **Section 4 (`d0286b0`)**: Live payment countdown synced with Bachs (`src/services/countdown.ts` scheduler loop editing awaiting_payment cards every 30s, and every 10s in the final minute, 429 backoff), 12-hour WAT time format (`1:45pm wat`), and 5-minute reminder nudges (`src/agent/nudge.ts`).
  - **Section 5 (`8273948`)**: Delivery message with Telegram confetti effect (`message_effect_id: 5046509860389126442`, retries once without effect if Telegram rejects), tap-to-copy `<code>` blocks, `🎁 your free link` for rewards, and preserved per-link `[✅ i've activated it]` buttons alongside `[need help]` and `[invite & earn 🎁]`.
  - **Reconciler fix (`a7a8ae0`)**: Draft cleanup uses `olderThan.toISOString()::timestamptz` for date comparison in `deleteOldOrderDrafts`.

## What Remains for Claude Code (Prompt D Sections 6-8 + Prompt 8)
1. **Prompt D Section 6 (Referral Program)**:
   - Schema additions in `src/db/schema.ts`:
     - `users.ref_code` (text, unique)
     - `users.referred_by` (bigint referencing `users.telegramId`)
     - `referrals` table: `id` (uuid pk), `referrer_id` (bigint), `referred_id` (bigint, unique), `qualified_at` (timestamptz)
     - `orders.source` (text, e.g. `'direct' | 'referral_reward'`)
   - Run `pnpm db:generate` (`pnpm exec drizzle-kit generate`) then `pnpm db:migrate`.
   - Generate unique 4-letter consonant codes lazily (`bcdfghjkmnpqrstvwxz`).
   - Link format: `https://t.me/geminiprosamkiel_bot?start=ref_abcd`.
   - On first ever `/start ref_<code>`, attribute `users.referred_by` (ignore self, unknown code, or existing user).
   - Qualify referral when referred user's first order with amount > 0 reaches `delivered` and is not refunded.
   - For every 3 qualified referrals, issue 1 free link reward order (`source='referral_reward'`, amount 0, qty 1, own order_no) fulfilled through standard fulfilment, capped at `REFERRAL_MAX_REWARDS=3` per user.
   - Implement `/invite` command and `[invite & earn 🎁]` button view with progress bar (`▰▰▱ 2 of 3 friends have bought`), share URL (`https://t.me/share/url?...`), and my orders button.
2. **Prompt D Section 7 (Admin Helpers)**:
   - Add unlisted `/myid` command for everyone that replies with their numeric Telegram ID.
   - On boot, log how many admin IDs are configured in `ADMIN_TELEGRAM_IDS` and warn if 0.
   - Update registered command lists: buyer scope `start, buy, history, invite, help`; admin scope as before.
3. **Prompt D Section 8 (Docs & Acceptance)**:
   - Update `docs/PRD.md`, `docs/ARCHITECTURE.md`, `README.md`, `RUNBOOK.md`, `.env.example`, `render.yaml`.
4. **Prompt 8 from `docs/CLAUDE_CODE_PROMPTS.md`**:
   - Final hardening & launch acceptance checklist pass.

## Rules (must follow)
- Never commit `.env` or any secret. Before each commit run the secret scan: `git diff | grep -nE 'npg_[A-Za-z0-9]{6,}|rsp_live_[A-Za-z0-9]{20,}|sk_(live|sandbox)_[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,}'` must print nothing.
- Never add Co-Authored-By or any AI attribution to commits. Commit per section, then push to origin main.
- Run `pnpm typecheck && pnpm lint && pnpm test` before every commit.
- No em dashes in user facing text. Lowercase, short bot copy. Never log secrets or activation links. Every external call has a timeout; reseller purchases use idempotency keys; money state changes are conditional UPDATEs.
- Never kill processes by port: the user runs `pnpm dev` on port 3000.
- Migrations: edit `src/db/schema.ts`, run `pnpm db:generate`, then `pnpm db:migrate` (applies to Neon so user's dev server keeps working).
- Link replacements are best effort, never promised.

