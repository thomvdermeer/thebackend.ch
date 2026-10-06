/**
 * Being Human (beinghuman.thebackend.ch) — Stripe webhook → Brevo confirmation email.
 * Adapted from the hyht events webhook; only reacts to
 * checkouts tagged metadata.event = "being-human-2026".
 *
 * Flow: Stripe Payment Link checkout completes → Stripe POSTs the event here →
 * we fetch the authoritative event back from Stripe's API (no signature
 * dependency) and send the Brevo template with the buyer's details.
 *
 * Secrets (Worker → Settings → Variables and Secrets):
 *   STRIPE_API_KEY   restricted key, Events read (+ Checkout Sessions read)
 *   BREVO_API_KEY    xkeysib-... from Brevo → SMTP & API
 * Plain vars (set via wrangler.jsonc):
 *   BREVO_TEMPLATE_ID, BREVO_LIST_ID
 */

/* Calendar links live in the Brevo template as "Add to calendar" buttons
   (hosted .ics for Apple, calendar.google.com link for Google) — the email
   itself carries no attachments. */

export default {
    async fetch(request, env) {
        /* Only /webhook/stripe is ours; any other path that isn't a static
           file (e.g. a typo) goes back to the event page. */
        if (new URL(request.url).pathname !== "/webhook/stripe") {
            return Response.redirect(new URL("/", request.url).toString(), 302);
        }
        if (request.method !== "POST") {
            /* diagnostic: fingerprint (hash prefix + length) of the stored secrets —
               reveals nothing, but lets us confirm which values are configured */
            const fp = async v => {
                if (!v) return "unset";
                const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
                return [...new Uint8Array(h)].slice(0, 4).map(b => b.toString(16).padStart(2, "0")).join("") + ":" + v.length;
            };
            return new Response("ok stripe=" + await fp(env.STRIPE_API_KEY) + " brevo=" + await fp(env.BREVO_API_KEY), { status: 200 });
        }

        /* Authenticity via fetch-back: take only the event id from the posted
           payload and load the authoritative event straight from Stripe's API.
           Forged posts can at most reference real events, and the duplicate
           guard below makes replays harmless. */
        let posted;
        try { posted = JSON.parse(await request.text()); } catch { return new Response("bad json", { status: 400 }); }
        const eventId = typeof posted?.id === "string" && /^evt_[A-Za-z0-9]+$/.test(posted.id) ? posted.id : null;
        if (!eventId) return new Response("bad event id", { status: 400 });

        const evRes = await fetch("https://api.stripe.com/v1/events/" + eventId, {
            headers: { Authorization: "Bearer " + env.STRIPE_API_KEY },
        });
        if (!evRes.ok) return new Response("unknown event", { status: 400 });
        const event = await evRes.json();
        if (event.type !== "checkout.session.completed") {
            return new Response("ignored", { status: 200 });
        }

        /* Duplicate guard: Stripe retries and manual resends can deliver the
           same event more than once — only the first one sends an email. */
        const cache = globalThis.caches?.default;
        const dedupeKey = new Request("https://dedupe.hyht.internal/being-human/" + event.id);
        if (cache && await cache.match(dedupeKey)) {
            return new Response("duplicate ignored", { status: 200 });
        }

        const s = event.data.object;
        /* Only event-ticket checkouts get the confirmation email — other
           payments on this account (e.g. open contribution links) are ignored. */
        if (s.metadata?.event !== "being-human-2026") {
            return new Response("not an event checkout", { status: 200 });
        }
        /* Not configured yet → 503 so Stripe retries later instead of the
           email being lost. */
        if (!env.BREVO_TEMPLATE_ID) return new Response("template not configured", { status: 503 });
        const email = s.customer_details?.email;
        if (!email) return new Response("no email", { status: 200 });

        /* Global duplicate check: every send is tagged with its Stripe event id
           in Brevo, whose log is global — unlike the per-datacenter cache above.
           If a send for this event already exists anywhere, skip. */
        const dup = await fetch(
            "https://api.brevo.com/v3/smtp/statistics/events?limit=1&tags=" + encodeURIComponent(event.id),
            { headers: { "api-key": env.BREVO_API_KEY } });
        if (dup.ok) {
            const dj = await dup.json();
            if (dj.events && dj.events.length) return new Response("duplicate ignored (global)", { status: 200 });
        }

        const name = (s.customer_details?.name || "there").split(" ")[0];
        const tickets = parseInt(s.metadata?.tickets || "1", 10);
        const tier = s.metadata?.tier === "launch" ? "launch price"
                   : s.metadata?.tier === "guest" ? "our guest"
                   : "regular";
        const total = s.amount_total === 0 ? "Free"
                    : (s.currency || "chf").toUpperCase() + " " + (s.amount_total / 100).toFixed(2).replace(/\.00$/, "");
        const attendees = (s.custom_fields || []).find(f => f.key === "attendees")?.text?.value || "";

        const res = await fetch("https://api.brevo.com/v3/smtp/email", {
            method: "POST",
            headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json" },
            body: JSON.stringify({
                to: [{ email, name: s.customer_details?.name || undefined }],
                tags: [event.id],
                templateId: parseInt(env.BREVO_TEMPLATE_ID, 10),
                params: {
                    NAME: name,
                    TICKETS: `${tickets} ticket${tickets > 1 ? "s" : ""} (${tier})`,
                    TOTAL: total,
                    ATTENDEES: attendees,
                },
            }),
        });

        if (!res.ok) {
            console.error("brevo error", res.status, await res.text());
            // 500 → Stripe retries later, so a Brevo hiccup doesn't lose the email
            return new Response("brevo failed", { status: 500 });
        }
        if (cache) {
            await cache.put(dedupeKey, new Response("sent", {
                headers: { "Cache-Control": "max-age=259200" },
            }));
        }

        /* Save the buyer to the Brevo attendee list so scheduled campaigns
           (reminders, thank-you) reach them. Non-fatal: a hiccup here must
           not fail the webhook — the confirmation email already went out. */
        if (env.BREVO_LIST_ID) {
            const fullName = s.customer_details?.name || "";
            await fetch("https://api.brevo.com/v3/contacts", {
                method: "POST",
                headers: { "api-key": env.BREVO_API_KEY, "content-type": "application/json" },
                body: JSON.stringify({
                    email,
                    updateEnabled: true,
                    listIds: [parseInt(env.BREVO_LIST_ID, 10)],
                    attributes: {
                        VORNAME: name,
                        NACHNAME: fullName.split(" ").slice(1).join(" "),
                    },
                }),
            }).catch(e => console.error("brevo contact error", e));
        }

        return new Response("sent", { status: 200 });
    },
};

