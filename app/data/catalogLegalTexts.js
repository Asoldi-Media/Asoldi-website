// Legal texts from the clause catalog (GET /api/legal/texts/:doc). The routes answer 404 while
// the legal switch is off; the pages then keep their static texts, so nothing changes for a visitor.
import { useEffect, useState } from 'react';

/** The JSON body of a legal text, or null for any non-200 answer or network error. */
export async function fetchLegalText(doc, { version = '', fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const query = version ? `?version=${encodeURIComponent(version)}` : '';
  try {
    const response = await fetchImpl(`/api/legal/texts/${encodeURIComponent(doc)}${query}`, { headers: { Accept: 'application/json' } });
    if (!response || response.status !== 200) return null;
    const body = await response.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

/**
 * The pricing cards with the catalog's "what's included" for tiers 1-3. Without a payload, or for a
 * card the payload does not name, the card is returned unchanged (the same array when nothing changes).
 */
export function mergeCatalogSalesProducts(products, payload) {
  const tiers = payload && typeof payload === 'object' ? payload.tiers : null;
  if (!tiers || typeof tiers !== 'object') return products;
  const byMarketingId = new Map(Object.values(tiers).filter(Boolean).map((tier) => [tier.marketingId, tier]));
  let changed = false;
  const next = products.map((product) => {
    const tier = byMarketingId.get(product.id);
    if (!tier || !Array.isArray(tier.included) || !tier.included.length) return product;
    changed = true;
    return { ...product, includedFeatures: [...tier.included], notIncludedFeatures: Array.isArray(tier.excluded) ? [...tier.excluded] : [] };
  });
  return changed ? next : products;
}

/** React hook: the pricing cards, with the catalog's copy once the API answers 200. */
export function useCatalogSalesProducts(products) {
  const [payload, setPayload] = useState(null);
  useEffect(() => {
    let alive = true;
    fetchLegalText('salg').then((body) => {
      if (alive && body) setPayload(body);
    });
    return () => {
      alive = false;
    };
  }, []);
  return mergeCatalogSalesProducts(products, payload);
}

/**
 * React hook: a legal document from the catalog, or null while loading, when the switch is off or on
 * any error (the page then shows its static text). `{legacy: true}` asks for the static text too.
 */
export function useCatalogLegalDoc(doc, version = '') {
  const [state, setState] = useState(null);
  useEffect(() => {
    let alive = true;
    setState(null);
    fetchLegalText(doc, { version }).then((body) => {
      if (alive) setState(body && !body.legacy && Array.isArray(body.sections) ? body : null);
    });
    return () => {
      alive = false;
    };
  }, [doc, version]);
  return state;
}
