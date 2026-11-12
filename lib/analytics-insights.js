/**
 * CTA destination + store funnel helpers.
 * Template-agnostic: paths and button text, never class names.
 */

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function normalizeAnalyticsPath(value = '') {
  let raw = compact(value);
  if (!raw) return '';
  try {
    if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/')) raw = `/${raw}`;
    const url = raw.startsWith('/') ? new URL(raw, 'https://analytics.local') : new URL(raw);
    let path = url.pathname || '/';
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return (path || '/').toLowerCase();
  } catch {
    const fallback = raw.startsWith('/') ? raw : `/${raw}`;
    return fallback.replace(/\/+$/, '').toLowerCase() || '/';
  }
}

export function pathMatchesCta(eventPath = '', ctaPath = '') {
  const a = normalizeAnalyticsPath(eventPath);
  const b = normalizeAnalyticsPath(ctaPath);
  if (!b) return false;
  if (a === b) return true;
  return b !== '/' && a.startsWith(`${b}/`);
}

export function phrasesFromKeywordPlan(plan = null, limit = 5) {
  if (!plan || typeof plan !== 'object') return [];
  const rows = [
    ...(Array.isArray(plan.primary) ? plan.primary : []),
    ...(Array.isArray(plan.local) ? plan.local : []),
    ...(Array.isArray(plan.secondary) ? plan.secondary : []),
  ];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const phrase = compact(typeof row === 'string' ? row : (row?.keyword || ''));
    const key = phrase.toLowerCase();
    if (!phrase || seen.has(key)) continue;
    seen.add(key);
    out.push(phrase);
    if (out.length >= limit) break;
  }
  return out;
}

export function analyticsGoalsFromBank(bank = {}) {
  const questions = bank?.websiteCreatorQuestions || {};
  const seo = bank?.seo || {};
  const mainCtaText = compact(questions.mainCtaText || questions.primaryAction);
  const mainCtaUrl = compact(questions.mainCtaUrl);
  return {
    mainCtaText,
    mainCtaUrl,
    ctaPath: normalizeAnalyticsPath(mainCtaUrl),
    mapsKeywords: phrasesFromKeywordPlan(seo.keywordPlan, 5),
  };
}

function inWindow(event, from, to) {
  const at = Date.parse(event?.at || '');
  if (!Number.isFinite(at)) return false;
  if (from && at < from.getTime()) return false;
  if (to && at > to.getTime()) return false;
  return true;
}

export function summarizeCta(events = [], ctaPath = '', { from, to, visits = 0 } = {}) {
  const path = normalizeAnalyticsPath(ctaPath);
  if (!path) {
    return {
      configured: false,
      path: '',
      pageviews: 0,
      sessions: 0,
      visitors: 0,
      clicks: 0,
      rate: 0,
    };
  }
  const sessions = new Set();
  const visitors = new Set();
  let pageviews = 0;
  let clicks = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (!inWindow(event, from, to)) continue;
    const onDest = pathMatchesCta(event.path, path);
    const clickHit = event.type === 'cta' && pathMatchesCta(event.href || event.path, path);
    if (clickHit) clicks += 1;
    if (event.type === 'pageview' && onDest) pageviews += 1;
    if (!onDest && !clickHit) continue;
    if (event.sessionId) sessions.add(String(event.sessionId));
    if (event.visitorId) visitors.add(String(event.visitorId));
  }
  const totalVisits = Number(visits) || 0;
  return {
    configured: true,
    path,
    pageviews,
    sessions: sessions.size,
    visitors: visitors.size,
    clicks,
    rate: totalVisits ? Math.round((sessions.size / totalVisits) * 1000) / 10 : 0,
  };
}

const PRODUCT_RE = /\/(product|products|produkt|shop|butikk|store|meny|menu|item|vare|catalog|katalog|collection|samling|tjenester|services)\b/i;
const CART_RE = /\/(cart|handlekurv|kurv|basket|bag)\b/i;
const CHECKOUT_RE = /\/(checkout|kasse|betaling|payment|bestilling|order-complete|takk-for|thank)\b/i;

export function classifyStorePath(path = '') {
  const p = String(path || '');
  if (CHECKOUT_RE.test(p)) return 'checkout';
  if (CART_RE.test(p)) return 'cart';
  if (PRODUCT_RE.test(p)) return 'product';
  return '';
}

function pct(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

export function summarizeEcommerceFunnel(events = [], orders = [], { from, to } = {}) {
  const sessions = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    if (!inWindow(event, from, to)) continue;
    const sessionId = String(event.sessionId || '');
    if (!sessionId) continue;
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, { product: false, cart: false, checkout: false });
    }
    const row = sessions.get(sessionId);
    const stage = classifyStorePath(event.path);
    if (stage === 'product') row.product = true;
    if (stage === 'cart' || event.type === 'add_to_cart') row.cart = true;
    if (stage === 'checkout') row.checkout = true;
  }
  const list = [...sessions.values()];
  const liveOrders = (Array.isArray(orders) ? orders : []).filter((order) => order?.status !== 'cancelled');
  const counts = {
    sessions: list.length,
    product: list.filter((row) => row.product).length,
    cart: list.filter((row) => row.cart).length,
    checkout: list.filter((row) => row.checkout).length,
    purchase: liveOrders.length,
  };
  const stages = [
    { id: 'sessions', label: 'Økter', count: counts.sessions },
    { id: 'product', label: 'Så et produkt', count: counts.product },
    { id: 'cart', label: 'La i handlekurv', count: counts.cart },
    { id: 'checkout', label: 'Startet kasse', count: counts.checkout },
    { id: 'purchase', label: 'Fullførte kjøp', count: counts.purchase },
  ].map((stage, index, all) => {
    const prev = index === 0 ? null : all[index - 1];
    return {
      ...stage,
      share: pct(stage.count, counts.sessions),
      dropoff: prev && prev.count ? pct(prev.count - stage.count, prev.count) : 0,
      kept: prev && prev.count ? pct(stage.count, prev.count) : 100,
    };
  });
  return {
    stages,
    counts,
    abandonment: {
      cart: pct(Math.max(0, counts.cart - counts.checkout), counts.cart),
      checkout: pct(Math.max(0, counts.checkout - counts.purchase), counts.checkout),
    },
  };
}

export function summarizeShopifyCommerce(orders = [], visits = 0) {
  const list = Array.isArray(orders) ? orders : [];
  const live = list.filter((order) => order?.status !== 'cancelled');
  const cancelled = list.filter((order) => order?.status === 'cancelled');
  const revenue = live.reduce((sum, order) => sum + (Number(order.amount) || 0), 0);
  const items = live.reduce((sum, order) => sum + (Number(order.quantity) || 1), 0);
  const products = new Map();
  const byDay = new Map();
  const freq = new Map();
  for (const order of live) {
    const name = String(order.productName || order.productId || 'Ukjent');
    const current = products.get(name) || { name, count: 0, revenue: 0 };
    current.count += Number(order.quantity) || 1;
    current.revenue += Number(order.amount) || 0;
    products.set(name, current);
    const day = String(order.purchasedAt || order.createdAt || '').slice(0, 10);
    if (day) {
      const bucket = byDay.get(day) || { date: day, orders: 0, revenue: 0 };
      bucket.orders += 1;
      bucket.revenue += Number(order.amount) || 0;
      byDay.set(day, bucket);
    }
    const email = compact(order.customerEmail).toLowerCase();
    if (email) freq.set(email, (freq.get(email) || 0) + 1);
  }
  const customers = freq.size;
  const returning = [...freq.values()].filter((n) => n > 1).length;
  return {
    orders: live.length,
    cancelled: cancelled.length,
    revenue,
    aov: live.length ? revenue / live.length : 0,
    unitsSold: items,
    itemsPerOrder: live.length ? Math.round((items / live.length) * 10) / 10 : 0,
    conversionRate: visits ? pct(live.length, visits) : 0,
    customers,
    returningCustomers: returning,
    newCustomers: Math.max(0, customers - returning),
    returningRate: customers ? pct(returning, customers) : 0,
    topProducts: [...products.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8),
    series: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
