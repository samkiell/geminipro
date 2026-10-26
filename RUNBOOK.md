# Runbook

Short answers for running the shop. Admin commands work only in an admin's own chat with the bot. `/admin` opens a panel with a button for every admin command.

## Alerts

Alerts arrive by email, in your Telegram chat with the bot, and on ntfy, all at once (see the README for the list). The same system alert (low balance, rate limits...) comes at most once every 30 minutes, so silence after an alert does not mean it is fixed: check with `/balance` or `/stats`. Order alerts come every time. The daily summary arrives at 21:00 WAT.

## How sales are going

`/stats` shows today and all time (orders, links, revenue), plus failures, orders in progress, orders waiting for payment, and how many delivered links buyers have marked activated. `/leads` lists the latest people who asked samkiel to build something.

## Change the offer line

`/offertext` shows it. `/offertext last 30 links left` changes it everywhere at once (order card, /help, the agent, reminders). Never put a date in it.

## Pause and resume sales

`/pause` stops new orders at once (buyers are told sales are paused). `/resume` restarts them. Sales also pause by themselves if the reseller rejects the API key; fix the key, redeploy, then `/resume`.

## Check and top up the reseller balance

`/balance` shows the USD balance and how many links it covers. Top up on the reseller's bot. Paid orders that could not be fulfilled for lack of balance complete on their own once the balance is back (the reconciler retries them).

## Orders that need attention

`/allorders` lists the last 10; `/order GP-1042` shows one.

- **Paid, nothing bought** (balance, stock or supplier trouble): top up or wait for stock; it is retried automatically every 10 minutes.
- **Buyer blocked the bot**: the links are saved. Ask them to unblock, then `/resend GP-1042`, or send the links by WhatsApp.
- **Payment held** (amount or currency did not match): check the payment in the Bachs dashboard before doing anything. Do not fulfil until it is clear.

## A buyer marked a link activated by mistake

Closed links are never shown again, by the bot or by `/resend` (the buyer had to confirm). If the link really was not used, `/replace GP-1042` sends a new one; check the `/order` view first, it shows when each link was activated.

## A buyer says a link does not work

Check it promptly. If it failed when used promptly, `/replace GP-1042` buys one more link through the normal path, sends it to the buyer and records it. Links left to expire unused are not refunded (see `src/content/help.ts`).

## Groq is down or rate limited

The bot switches to scripted replies by itself and keeps selling through the order card, `/buy`, buttons and proof. It goes back to the model when Groq has room again. You get an alert when more than 5 buyers in 5 minutes got scripted replies, and the daily summary shows model calls, 429s and fallbacks. If it keeps happening: upgrade the Groq plan, and check the limits page in the Groq console (each model in `GROQ_MODELS` has its own limits).

## Proof screenshots

Add one by sending the photo to the bot with the caption `/addproof` (real, personal details blurred). `/proofs` lists the album in order, `/delproof 2` removes the second. Files in `assets/proof/` are only read at boot while the album is empty.

## Render is asleep or restarting

Telegram retries updates and Bachs retries webhooks (about 80 minutes). The reconciler catches anything missed when the service wakes. If sales are being lost to sleeping, move to a paid instance.

## Rotate a key

Generate the new key in its dashboard (Bachs, reseller, Groq, Telegram via BotFather, Neon), update it in Render, redeploy, then revoke the old one. For the Telegram token or webhook secret, run `pnpm webhook:set` again. For the Bachs webhook secret, rotate it in the developer portal (the old one keeps working for 24 hours).
