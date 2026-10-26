# geminipro

Telegram agent that sells Gemini Pro 18 month activation links. Read docs/PRD.md and docs/ARCHITECTURE.md before any task. They are the source of truth.

Rules:
- Node.js 22, TypeScript strict, Fastify, grammY, Drizzle + Postgres (Neon), zod, pino, vitest.
- The LLM agent proposes, code disposes. The agent never sees or writes activation links, never confirms payments, never calls the reseller. All money and delivery logic is deterministic code.
- Never log secrets or activation links. Redact them.
- Never use em dashes in any user facing text.
- Every external call has a timeout. Every reseller purchase uses an idempotency key.
- Keep changes small, add tests for money and state logic, run `npm run typecheck && npm test` before finishing a task.
- Do not commit .env. Keep .env.example updated.
