import { deepseekChatJson, isDeepseekConfigured } from '../deepseek.js';
import { parseLayoutChoice } from './layout-detect.js';
import { PRODUCT_LAYOUT_RULES, summarizeCatalogs } from '../client-product-catalog.js';
import { businessLabel, nextIntakeStep, questionFor } from './intake.js';
import { firstSiteUrlFromText, looksLikeTypedProductList, siteHostLabel } from './site-urls.js';

export const PRODUCT_ASSISTANT_GREETING = questionFor('products', '');

export function extractFirstUrl(text = '') {
  return firstSiteUrlFromText(text);
}

export function buildOpeningState(profile = {}) {
  const bank = profile?.clientDataBank || {};
  const industry = bank?.businessCard?.industry || '';
  const summary = summarizeCatalogs(bank?.productCatalogs || []);
  const name = businessLabel(bank, profile);
  const currentStep = nextIntakeStep(bank);
  return {
    currentStep,
    stepLabel: currentStep,
    greeting: questionFor(currentStep, name),
    redirectTo: currentStep === 'done' ? '/kunde/innstillinger' : '',
    industry,
    layout: summary.layout || null,
    layoutConfidence: summary.layout ? 'high' : 'none',
    summary,
    chips: [
      { id: 'upload', label: 'Last opp fil' },
      { id: 'url', label: 'Lim inn URL' },
      { id: 'type', label: 'Skriv inn' },
      { id: 'manual', label: 'Sett opp manuelt' },
    ],
  };
}

function fallbackReply({ userText, industry, summary, layout }) {
  const url = extractFirstUrl(userText);
  const layoutChoice = parseLayoutChoice(userText);
  if (url) {
    const host = siteHostLabel(url);
    return {
      assistantMessage: host
        ? `Jeg går gjennom hele ${host} nå og henter det som ser ut som produkter, pakker og priser.`
        : 'Jeg går gjennom nettstedet nå og henter det som ser ut som produkter, pakker og priser.',
      layout: layout || null,
      catalogPatch: null,
      nextAction: 'scrape',
      url,
      questions: [],
    };
  }
  if (/\b(sjekk|se på|hent|les|scrape|gjennomgå|finn)\b/i.test(userText)
    && /\b(nettside|nettsted|hjemmeside|side|url|lenke|pris|produkt|meny)\b/i.test(userText)) {
    return {
      assistantMessage: 'Hvilken nettside skal jeg gå gjennom? Du kan skrive bare domenet, for eksempel cafeen.no.',
      layout: layout || null,
      catalogPatch: null,
      nextAction: 'wait',
      questions: [],
    };
  }
  if (layoutChoice) {
    return {
      assistantMessage: `Da bruker vi ${layoutChoice === 'meny' ? 'meny' : layoutChoice === 'tiers' ? 'tiers' : 'normale produkter'}. Last opp fil, lim inn en URL, eller skriv inn produktene.`,
      layout: layoutChoice,
      catalogPatch: null,
      nextAction: 'set_layout',
      questions: [],
    };
  }
  if (!layout && !summary.productCount) {
    return {
      assistantMessage: 'Send en nettside, en fil, eller skriv tilbudene her. Jeg velger kategori ut fra det som står i kilden.',
      layout: null,
      catalogPatch: null,
      nextAction: 'wait',
      questions: [],
    };
  }
  if (looksLikeTypedProductList(userText)) {
    return {
      assistantMessage: 'Jeg leser listen og legger produktene inn i katalogen.',
      layout: layout || null,
      catalogPatch: null,
      nextAction: 'ingest_text',
      questions: [],
    };
  }
  return {
    assistantMessage: 'Du kan be meg sjekke nettsiden (cafeen.no er nok), laste opp Excel/PDF, skrive produktene her, eller sette dem opp manuelt i Kundedata.',
    layout: layout || null,
    catalogPatch: null,
    nextAction: 'wait',
    questions: [],
  };
}

export async function runProductAssistantTurn({
  messages = [],
  industry = '',
  layout = '',
  summary = {},
} = {}) {
  const lastUser = [...messages].reverse().find((row) => row.role === 'user');
  const userText = lastUser?.text || '';
  const deterministic = fallbackReply({ userText, industry, summary, layout });
  if (deterministic.nextAction !== 'wait' || !isDeepseekConfigured()) {
    return deterministic;
  }

  try {
    const parsed = await deepseekChatJson({
      temperature: 0.3,
      maxTokens: 1200,
      system: `Du er Asoldi sin datainnsamling for produkter. Snakk norsk, kort og konkret.
Ikke spør om bransje, tonalitet, adresse, farger, org.nr, språk, sted, telefon eller e-post.
Ikke spør hvilken layout (normal/meny/tiers) de vil ha. Kategorien velges fra kilden.
${PRODUCT_LAYOUT_RULES}
Svar JSON:
{
  "assistantMessage": string,
  "layout": "normal"|"meny"|"tiers"|null,
  "nextAction": "wait"|"scrape"|"ingest_text"|"manual",
  "url": string,
  "questions": string[]
}
Hvis brukeren nevner et nettsted: nextAction=scrape og url må være https://…
Hvis de limer inn en produktliste: nextAction=ingest_text.
Hvis de vil gjøre det selv: nextAction=manual.
Ikke late som produktene allerede er hentet.`,
      user: JSON.stringify({
        industry,
        currentLayout: layout || null,
        catalogSummary: summary,
        messages: messages.slice(-8).map((row) => ({ role: row.role, text: row.text })),
      }),
    });
    return {
      assistantMessage: parsed.assistantMessage || deterministic.assistantMessage,
      layout: parsed.layout || layout || null,
      catalogPatch: null,
      nextAction: parsed.nextAction || 'wait',
      url: parsed.url || extractFirstUrl(userText),
      questions: Array.isArray(parsed.questions) ? parsed.questions : [],
    };
  } catch {
    return deterministic;
  }
}
