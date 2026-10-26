# Handoff: geminipro (@geminiprosamkiel_bot)

State on 26 Oct 2026. Branch `main`, last pushed commit `5cac855`. All 219 tests pass, typecheck, lint and build are clean.

## What this is
Telegram bot that sells Google AI Pro 18 month (Jio offer) activation links for ₦3,500 + fee. Node 22, TypeScript strict, Fastify, grammY, Drizzle + Neon Postgres, zod, pino, vitest (PGlite in-memory DB in tests), pnpm. Payments: Bachs (not Paystack). Links bought from a reseller API (mock reseller runs in-process when `RESELLER_MOCK=true`). LLM: Groq free tier.

Read first: `CLAUDE.md` (rules), `docs/PRD.md`, `docs/ARCHITECTURE.md`, `README.md`, `RUNBOOK.md`, `docs/CLAUDE_CODE_PROMPTS.md`.

## Done (all pushed)
- Prompts 0 to 7 from `docs/CLAUDE_CODE_PROMPTS.md` (Prompt 7: `pnpm start` runs migrations, Render blueprint, deploy guide in README).
- Prompt A (Bachs, buyer UX), Prompt B (owner knowledge, leads, pidgin, buyer memory).
- Prompt 6: admin commands, `/admin` panel with a button for every command, notifier (email via Resend from hello@samkiel.dev to ezekiel.samuel@samkiel.tech, Telegram, ntfy), reconciler.
- Link activation: every delivered link has a ✅ button, confirm step, then the link is closed (edited out of every message, never resent). Columns `order_items.activated_at`, `message_ids`.
- **Prompt C is DONE**: single Groq call per message (`src/agent/decide.ts`, `brain.ts`, `fastpath.ts`, `bot/respond.ts`), fast paths, 5 min cache, model failover (`GROQ_MODELS` default qwen/qwen3.8-27b, openai/gpt-oss-120b, openai/gpt-oss-20b), proof screenshots (`proof_items`, `/addproof`, `/proofs`, `/delproof`, `pnpm proof:optimize`), live eval `pnpm eval:agent` (qwen passed all checks, p50 about 0.9s).
- Migrations 0000 to 0006 are applied to Neon.

## Remaining
1. **Prompt D** (the user has the file `PROMPT_D_polish_referral_gate.md`; ask them to paste it). Sections: 1 one response per action and copy deck (drop model reply when an intent shows UI, no "moved below" stubs, callbacks never rate limited, remove every "card 2%" / "1.5%" mention); 2 draft cart table `order_drafts`, order number only on [continue]; 3 channel gate `@samkieldevtg` via getChatMember at continue, fail open; 4 live payment countdown synced with Bachs expiry; 5 delivery message with confetti `message_effect_id`; 6 referral program (`/invite`, ref codes, reward orders); 7 `/myid`, admin id boot log; 8 docs and tests.
   - Keep the per-link ✅ activation buttons (user asked for them after D was written) next to D's [need help] and [invite & earn 🎁].
2. Prompt 8 (hardening, launch checklist) from `docs/CLAUDE_CODE_PROMPTS.md`.

## Rules (must follow)
- Never commit `.env` or any secret. Before each commit run the secret scan: `git diff | grep -nE 'npg_[A-Za-z0-9]{6,}|rsp_live_[A-Za-z0-9]{20,}|sk_(live|sandbox)_[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,}'` must print nothing.
- Never add Co-Authored-By or any AI attribution to commits. Commit per section, then push to origin main.
- Run `pnpm typecheck && pnpm lint && pnpm test` before every commit. Tests can time out under load (the user runs several `pnpm dev`); rerun before assuming a bug.
- No em dashes in user facing text. Lowercase, short bot copy. Never log secrets or activation links. Every external call has a timeout; reseller purchases use idempotency keys; money state changes are conditional UPDATEs.
- Never kill processes by port: the user runs `pnpm dev` on port 3000.
- New migration: edit `src/db/schema.ts`, `pnpm exec drizzle-kit generate --name <name>`, then `pnpm db:migrate` (applies to Neon so the user's dev server keeps working).
- Link replacements are best effort, never promised.

## Open notes for the user
- `assets/proof/FHENIX SPEAKERS (5 of 109).jpg` is in the proof folder but is not an activation screenshot and is not committed. If it stays, the next boot seeds it into the proof album (the table is empty). Remove it or replace with real blurred screenshots.
- Groq free tier is not enough for launch: upgrade the plan.
- Three dev servers were running at once (two `npm run dev`, one `pnpm dev`); keep one, or Telegram polling conflicts.
- `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in the shell environment; it disables TLS checks for every Node process.
