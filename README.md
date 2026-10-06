# thebackend.ch

## Being Human — beinghuman.thebackend.ch (21 November 2026)

One Cloudflare Worker (`thebackend-beinghuman`, config [`wrangler.jsonc`](wrangler.jsonc)):

- `public/` — the only folder that is served: the page (`index.html`, all
  content in the `EVENT` config at the top), poster + icons, calendar file.
- `src/worker.js` — runs for `/webhook/*` only: Stripe `checkout.session.completed`
  → Brevo confirmation email + attendee list, for checkouts tagged
  `metadata.event = "being-human-2026"` only (every other payment on the shared
  Stripe account is ignored — the hyht breathwork worker does the same in reverse).
- `scripts/create-stripe-links.mjs` — creates the 6 launch-price Payment Links
  (CHF 210 × 1–6 tickets). Run locally, never deployed.

Fully separate from the hyht.ch repo / events.hyht.ch: own repo, own worker,
own API keys, own Brevo template + list, own Stripe webhook endpoint.

### Go-live
1. **Cloudflare**: Workers & Pages → Create → Import a repository →
   `thomvdermeer/thebackend.ch`, worker name `thebackend-beinghuman`, branch
   `main`, all build settings default (root `/`, no build command, deploy
   `npx wrangler deploy`). Settings → Domains & Routes → Custom domain
   `beinghuman.thebackend.ch`. Secrets: `STRIPE_API_KEY`, `BREVO_API_KEY`
   (new keys, used only by this worker).
   Check: `https://beinghuman.thebackend.ch/webhook/stripe` shows two fingerprints.
2. **Brevo**: duplicate the confirmation template, adapt it, create list
   "Being Human 2026 — attendees"; put both ids in `wrangler.jsonc` `vars`.
3. **Stripe**: new webhook endpoint `https://beinghuman.thebackend.ch/webhook/stripe`
   (`checkout.session.completed` only; leave the existing hyht endpoint alone).
   Then `STRIPE_SECRET_KEY=rk_live_... node scripts/create-stripe-links.mjs`
   and paste the printed block into `EVENT.stripeLinks` in `public/index.html`.
4. **Test**: temporary CHF 1 Payment Link with metadata `event=being-human-2026`,
   `tier=launch`, `tickets=1` and a text field `attendees` → exactly one email,
   contact lands in the new list; refund and deactivate the link.
