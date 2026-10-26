# Runbook

Short answers for running the shop. Admin commands work only in an admin's own chat with the bot.

## Change the offer line

`/offertext` shows it. `/offertext last 30 links left` changes it everywhere at once (order card, /help, the agent, reminders). Never put a date in it.

## Pause and resume sales

`/pause` stops new orders at once (buyers are told sales are paused). `/resume` restarts them. Sales also pause by themselves if the reseller rejects the API key; fix the key, redeploy, then `/resume`.

## Check and top up the reseller balance

`/balance` shows the USD balance and how many links it covers. Top up on the reseller's bot. Paid orders that could not be fulfilled for lack of balance complete on their own once the balance is back (the reconciler retries them).

## Orders that need attention

`/allorders` lists the last 10; `/order GP-1042` shows one.

- **Paid, nothing bought** (balance, stock or supplier trouble): top up or wait for stock; it is retried automatically.
- **Buyer blocked the bot**: the links are saved. Ask them to unblock, then `/resend GP-1042`, or send the links by WhatsApp.
- **Payment held** (amount or currency did not match): check the payment in the Bachs dashboard before doing anything. Do not fulfil until it is clear.

## A buyer says a link does not work

Check it promptly. If it failed when used promptly, `/replace GP-1042` buys one more link through the normal path, sends it to the buyer and records it. Links left to expire unused are not refunded (see `src/content/help.ts`).

## Groq is down or rate limited

Nothing to do. The bot switches to scripted replies by itself and keeps selling through the order card, `/buy` and buttons. It goes back to the agent when Groq has room again.

## Render is asleep or restarting

Telegram retries updates and Bachs retries webhooks (about 80 minutes). The reconciler catches anything missed when the service wakes. If sales are being lost to sleeping, move to a paid instance.

## Rotate a key

Generate the new key in its dashboard (Bachs, reseller, Groq, Telegram via BotFather, Neon), update it in Render, redeploy, then revoke the old one. For the Telegram token or webhook secret, run `pnpm webhook:set` again. For the Bachs webhook secret, rotate it in the developer portal (the old one keeps working for 24 hours).
