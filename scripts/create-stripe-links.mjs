#!/usr/bin/env node
/**
 * Being Human — creates the Stripe Payment Links for beinghuman.thebackend.ch:
 * one product, 6 prices (launch price × quantities 1–6, no discounts),
 * 6 payment links tagged metadata.event = "being-human-2026" (the tag the
 * being-human worker listens for). Prints the snippet for EVENT.stripeLinks.
 *
 * Usage:
 *   STRIPE_SECRET_KEY=sk_live_... node scripts/create-stripe-links.mjs
 *
 * Use a restricted key (Developers → API keys → Create restricted key) with
 * write access to Products, Prices and Payment Links only.
 * Enable TWINT first: Dashboard → Settings → Payments → Payment methods.
 * Re-running creates a fresh set (old links can be deactivated in the dashboard).
 */

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
    console.error("Set STRIPE_SECRET_KEY (restricted key with Products/Prices/Payment Links write access).");
    process.exit(1);
}

const EVENT_NAME = "Being Human — one-day workshop, Zürich";
const EVENT_DATE = "Saturday 21 November 2026, 10:00–16:00, Dorfzentrum Albisrieden, 8047 Zürich";
const CURRENCY = "chf";
const TIERS = { launch: 210 };
const DISCOUNT = () => 0;   // no group discounts for this event
const QUANTITIES = [1, 2, 3, 4, 5, 6];

async function stripe(path, params) {
    const res = await fetch("https://api.stripe.com/v1/" + path, {
        method: "POST",
        headers: {
            Authorization: "Bearer " + KEY,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(params),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(path + ": " + (json.error?.message || res.status));
    return json;
}

let productId = process.env.STRIPE_PRODUCT_ID;
if (!productId) {
    const product = await stripe("products", {
        name: EVENT_NAME,
        description: EVENT_DATE,
    });
    productId = product.id;
}
console.error("product:", productId);

const links = { launch: {}, regular: {} };
for (const [tier, unit] of Object.entries(TIERS)) {
    for (const q of QUANTITIES) {
        const total = Math.round(q * unit * (1 - DISCOUNT(q)));
        const label = `Launch price × ${q}` +
            (DISCOUNT(q) ? ` (${DISCOUNT(q) * 100}% group discount)` : "");
        const price = await stripe("prices", {
            product: productId,
            currency: CURRENCY,
            unit_amount: String(total * 100),
            nickname: label,
        });
        const link = await stripe("payment_links", {
            "line_items[0][price]": price.id,
            "line_items[0][quantity]": "1",
            "metadata[event]": "being-human-2026",
            "metadata[tier]": tier,
            "metadata[tickets]": String(q),
            "custom_fields[0][key]": "attendees",
            "custom_fields[0][label][type]": "custom",
            "custom_fields[0][label][custom]": "Attendee name(s)",
            "custom_fields[0][type]": "text",
            "custom_fields[0][optional]": "false",
            "after_completion[type]": "hosted_confirmation",
            "after_completion[hosted_confirmation][custom_message]":
                `You're in! ${q} place${q > 1 ? "s" : ""} reserved for ${EVENT_NAME} — ${EVENT_DATE}. A receipt is on its way to your inbox. See you there!`,
        });
        links[tier][q] = link.url;
        console.error(`${label}: CHF ${total} → ${link.url}`);
    }
}

console.log("\nPaste into EVENT.stripeLinks in public/index.html:\n");
console.log("stripeLinks: " + JSON.stringify(links, null, 4).replace(/"(\w+)":/g, "$1:") + ",");
