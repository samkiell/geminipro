# Proof screenshots

Real screenshots of real activations from past buyers. The bot sends them as one album when a buyer asks whether the offer is real (with a fixed, honest text: the offer is Google's, the shop resells it and is not run by Google or Jio).

Before a screenshot goes in this folder:

- [ ] It is real and unedited, apart from blurring. Never edit, fake or generate a proof image.
- [ ] Every email address, name, phone number, profile photo and order or payment id is blurred.
- [ ] It shows only what it shows: no captions or arrows that claim more.

Then run `pnpm proof:optimize` (at most 1280px wide, JPEG, under 1 MB each, at most 10) and commit. Files are sent in file name order (`01-...jpg`, `02-...jpg`). The table is seeded from this folder at boot only while it is empty; after that, add screenshots by sending the photo to the bot with the caption `/addproof`, list them with `/proofs` and remove one with `/delproof <n>`.
