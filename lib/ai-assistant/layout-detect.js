import { coerceCatalogLayout, isProductLayout, layoutLabel } from '../client-product-catalog.js';

const FOOD_INDUSTRY =
  /\b(restaurant|café|cafe|kafe|bakeri|bakery|bar|catering|gatekjøkken|gatekjokken|kafé|mat|matservering|pizzeria|sushi|bistro|pub|kjøkken|kjokken)\b/i;
const TIER_INDUSTRY =
  /\b(saas|software|it[- ]?tjeneste|abonnement|byrå|byra|agency|konsulent|webbyrå|webbyra|markedsføring|markedsforing|hosting)\b/i;

export function detectLayoutFromIndustry(industry = '') {
  const text = String(industry || '').trim();
  if (!text) return { layout: null, confidence: 'none', reason: 'missing-industry' };
  if (FOOD_INDUSTRY.test(text)) return { layout: 'meny', confidence: 'high', reason: 'industry-food' };
  if (TIER_INDUSTRY.test(text)) return { layout: 'tiers', confidence: 'high', reason: 'industry-service' };
  return { layout: 'normal', confidence: 'medium', reason: 'industry-default' };
}

export function detectLayoutFromEvidence(text = '', industry = '') {
  const industryGuess = detectLayoutFromIndustry(industry);
  const coerced = coerceCatalogLayout({
    layout: industryGuess.layout || 'normal',
    label: '',
    categories: [],
  }, `${industry} ${text}`);
  if (industryGuess.confidence === 'high') {
    return {
      layout: industryGuess.layout,
      confidence: 'high',
      reason: industryGuess.reason,
      label: layoutLabel(industryGuess.layout),
    };
  }
  const hay = `${industry} ${text}`.toLowerCase();
  const food = /\b(meny|menu|rett|rettar|forrett|hovedrett|dessert|allergener)\b/i.test(hay);
  const tiers = /\b(basic|pro|enterprise|pakke|abonnement|inkluder[et]|pricing|tier\s*\d)\b/i.test(hay)
    || /\/mnd|per måned|per month/i.test(hay);
  if (food && !tiers) return { layout: 'meny', confidence: 'high', reason: 'evidence-food', label: 'Meny' };
  if (tiers && !food) return { layout: 'tiers', confidence: 'medium', reason: 'evidence-tiers', label: 'Tiers' };
  if (industryGuess.layout) {
    return {
      layout: coerced.layout,
      confidence: industryGuess.confidence,
      reason: industryGuess.reason,
      label: layoutLabel(coerced.layout),
    };
  }
  return { layout: null, confidence: 'none', reason: 'ask', label: '' };
}

export function parseLayoutChoice(text = '') {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return null;
  if (/\b(meny|menu|restaurant|kafe|café)\b/.test(value)) return 'meny';
  if (/\b(tier|tiers|pakke|abonnement|plan)\b/.test(value)) return 'tiers';
  if (/\b(normal|vanlig|produkter|butikk)\b/.test(value)) return 'normal';
  return isProductLayout(value) ? value : null;
}
