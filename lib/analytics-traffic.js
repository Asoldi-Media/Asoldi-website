export const RANGE_PRESETS = ['7d', '14d', '30d', '90d', '6m', '1y', 'custom'];

export function rangeFromPreset(range = '30d', customFrom = '', customTo = '', now = Date.now()) {
  const to = new Date(now);
  const from = new Date(now);
  switch (String(range || '30d')) {
    case '7d':
    case 'week':
      from.setDate(from.getDate() - 7);
      break;
    case '14d':
      from.setDate(from.getDate() - 14);
      break;
    case '30d':
    case 'month':
      from.setDate(from.getDate() - 30);
      break;
    case '90d':
      from.setDate(from.getDate() - 90);
      break;
    case '6m':
    case '6months':
      from.setMonth(from.getMonth() - 6);
      break;
    case '1y':
    case 'year':
      from.setFullYear(from.getFullYear() - 1);
      break;
    case 'custom': {
      const start = Date.parse(customFrom);
      const end = Date.parse(customTo);
      return {
        preset: 'custom',
        from: Number.isFinite(start) ? new Date(start) : new Date(0),
        to: Number.isFinite(end) ? new Date(end) : to,
      };
    }
    default:
      from.setDate(from.getDate() - 30);
  }
  return { preset: String(range || '30d'), from, to };
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function hostOf(value = '') {
  try {
    return new URL(value).host.replace(/^www\./i, '');
  } catch {
    return String(value || '').replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '');
  }
}

/**
 * First-party events: { type: pageview|ping|leave, visitorId, sessionId, path, referrer, ua, at, ms? }
 */
export function summarizeTrafficEvents(events = [], { from, to } = {}) {
  const rows = Array.isArray(events) ? events : [];
  const sessions = new Map();
  const visitors = new Set();
  const pages = new Map();
  const referrers = new Map();
  const devices = { desktop: 0, mobile: 0, tablet: 0 };
  const byDay = new Map();

  function deviceOf(ua = '') {
    const text = String(ua || '').toLowerCase();
    if (/ipad|tablet/.test(text)) return 'tablet';
    if (/mobi|iphone|android/.test(text)) return 'mobile';
    return 'desktop';
  }

  function bump(map, key, n = 1) {
    const id = String(key || '(direct)').trim() || '(direct)';
    map.set(id, (map.get(id) || 0) + n);
  }

  for (const event of rows) {
    const at = Date.parse(event?.at || '');
    if (!Number.isFinite(at)) continue;
    if (from && at < from.getTime()) continue;
    if (to && at > to.getTime()) continue;
    const sessionId = String(event.sessionId || '');
    const visitorId = String(event.visitorId || '');
    if (visitorId) visitors.add(visitorId);
    if (sessionId && !sessions.has(sessionId)) {
      sessions.set(sessionId, {
        id: sessionId,
        visitorId,
        paths: new Set(),
        start: at,
        end: at,
        bounced: true,
        device: deviceOf(event.ua),
        referrer: String(event.referrer || ''),
      });
    }
    const session = sessionId ? sessions.get(sessionId) : null;
    if (session) {
      session.end = Math.max(session.end, at);
      session.start = Math.min(session.start, at);
      if (event.path) session.paths.add(String(event.path));
      if (session.paths.size > 1 || event.type === 'ping') session.bounced = false;
    }
    if (event.type === 'pageview') {
      bump(pages, event.path || '/');
      const ref = String(event.referrer || '');
      if (ref && !ref.includes(String(event.host || ''))) bump(referrers, hostOf(ref) || ref);
      else if (!ref) bump(referrers, '(direct)');
      const day = dayKey(at);
      const bucket = byDay.get(day) || { date: day, pageviews: 0, visits: 0, visitors: new Set() };
      bucket.pageviews += 1;
      if (visitorId) bucket.visitors.add(visitorId);
      byDay.set(day, bucket);
    }
  }

  const sessionList = [...sessions.values()];
  sessionList.forEach((session) => {
    devices[session.device] = (devices[session.device] || 0) + 1;
    const day = dayKey(session.start);
    const bucket = byDay.get(day) || { date: day, pageviews: 0, visits: 0, visitors: new Set() };
    bucket.visits += 1;
    byDay.set(day, bucket);
  });

  const pageviews = rows.filter((event) => event.type === 'pageview').length;
  const visits = sessionList.length;
  const bounces = sessionList.filter((session) => session.bounced && session.paths.size <= 1).length;
  const durationMs = sessionList.reduce((sum, session) => sum + Math.max(0, session.end - session.start), 0);

  return {
    pageviews,
    visits,
    uniqueVisitors: visitors.size,
    bounceRate: visits ? Math.round((bounces / visits) * 1000) / 10 : 0,
    avgDurationSec: visits ? Math.round(durationMs / visits / 1000) : 0,
    viewRate: visits ? Math.round((pageviews / visits) * 10) / 10 : 0,
    topPages: [...pages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([path, count]) => ({ path, count })),
    referrers: [...referrers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([source, count]) => ({ source, count })),
    devices,
    series: [...byDay.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((row) => ({ date: row.date, pageviews: row.pageviews, visits: row.visits, uniqueVisitors: row.visitors.size })),
  };
}

export function summarizeOrdersForAnalytics(orders = [], visits = 0) {
  const rows = Array.isArray(orders) ? orders.filter((order) => order?.status !== 'cancelled') : [];
  const revenue = rows.reduce((sum, order) => sum + (Number(order.amount) || 0), 0);
  const products = new Map();
  for (const order of rows) {
    const name = String(order.productName || order.productId || 'Ukjent');
    const current = products.get(name) || { name, count: 0, revenue: 0 };
    current.count += Number(order.quantity) || 1;
    current.revenue += Number(order.amount) || 0;
    products.set(name, current);
  }
  return {
    orders: rows.length,
    revenue,
    aov: rows.length ? revenue / rows.length : 0,
    conversionRate: visits ? Math.round((rows.length / visits) * 1000) / 10 : 0,
    topProducts: [...products.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 8),
  };
}
