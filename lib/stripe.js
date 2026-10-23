import Stripe from 'stripe';
import { assertSafeModeAllows } from './safe-mode.js';

let client = null;

function clean(value = '') {
  return String(value ?? '').trim();
}

export function isStripeConfigured() {
  return Boolean(clean(process.env.STRIPE_SECRET_KEY));
}

export function getStripe() {
  if (!isStripeConfigured()) {
    throw new Error('Stripe is not configured (missing STRIPE_SECRET_KEY).');
  }
  // Safe mode: billing with a live key only when HUB_SAFE_MODE_ALLOW has paymentsLive.
  if (!/^(sk|rk)_test_/.test(clean(process.env.STRIPE_SECRET_KEY))) assertSafeModeAllows('paymentsLive', 'Stripe billing live key');
  if (!client) {
    client = new Stripe(clean(process.env.STRIPE_SECRET_KEY));
  }
  return client;
}

export function getPublishableKey() {
  return clean(process.env.STRIPE_PUBLISHABLE_KEY);
}

export function getWebhookSecret() {
  return clean(process.env.STRIPE_WEBHOOK_SECRET);
}

export function getStripeCurrency() {
  return clean(process.env.STRIPE_CURRENCY).toLowerCase() || 'nok';
}

// Maps a standard plan id to its configured Stripe recurring Price id.
// The offer/custom tier does not use this — it carries its own price/amount.
export function priceIdForPlan(planId) {
  const map = {
    'tier-1-standard': process.env.STRIPE_PRICE_TIER_1_STANDARD,
    'tier-2-seo': process.env.STRIPE_PRICE_TIER_2_SEO,
    'tier-3-ecommerce': process.env.STRIPE_PRICE_TIER_3_ECOMMERCE,
  };
  return clean(map[clean(planId)]);
}
