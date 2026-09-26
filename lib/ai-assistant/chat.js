import { deepseekChatJson, isDeepseekConfigured } from '../deepseek.js';
import { detectLayoutFromEvidence, parseLayoutChoice } from './layout-detect.js';
import { PRODUCT_LAYOUT_RULES, summarizeCatalogs } from '../client-product-catalog.js';
import { firstSiteUrlFromText, looksLikeTypedProductList, siteHostLabel } from './site-urls.js';

export const PRODUCT_ASSISTANT_GREETING = [
  'Hei — klar til å sette opp nettsiden din sammen.',
  'Start med produktene. Skriv som du ville sagt det — «sjekk cafeen.no for prisene», last opp en meny, eller lim inn en liste. Du trenger ikke https://. Jeg leser alt i feltet som én kilde.',
].join('\n');

export function extractFirstUrl(text = '') {
  return firstSiteUrlFromText(text);
}

export function buildOpeningState(profile = {}) {
  const bank = profile?.clientDataBank || {};
  const industry = bank?.businessCard?.industry || '';
  const summary = summarizeCatalogs(bank?.productCatalogs || []);
  const layoutGuess = detectLayoutFromEvidence('', industry);
  return {
    currentStep: 'products',
    greeting: PRODUCT_ASSISTANT_GREETING,
    industry,
    layout: summary.layout || layoutGuess.layout,
    layoutConfidence: summary.layout ? 'high' : layoutGuess.confidence,
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
    const guess = detectLayoutFromEvidence(userText, industry);
    if (guess.confidence === 'none') {
      return {
        assistantMessage: 'Før jeg mapper feltene trenger jeg å vite hvordan produktene skal vises:\n\n• Normal — vanlige produkter med bilde, pris og beskrivelse\n• Meny — retter med allergener og tillegg\n• Tiers — pakker med punkter som er inkludert\n\nHvilken passer dere?',
        layout: null,
        catalogPatch: null,
        nextAction: 'ask_layout',
        questions: ['layout'],
      };
    }
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
      system: `Du er Asoldi AI-assistent for produktdata (steg 1). Snakk norsk, kort og konkret.
Ikke spør om bedriftsnavn, tone, målgruppe eller nettsidemål.
Målet er å fylle web-suite produktkatalogen.
${PRODUCT_LAYOUT_RULES}
Svar JSON:
{
  "assistantMessage": string,
  "layout": "normal"|"meny"|"tiers"|null,
  "nextAction": "wait"|"ask_layout"|"scrape"|"ingest_text"|"manual",
  "url": string,
  "questions": string[]
}
Hvis brukeren nevner et nettsted (cafeen.no, www.shop.no eller https://…): nextAction=scrape og url må være https://… — ikke be om https:// på nytt.
Hvis de beskriver eller limer inn en produktliste: nextAction=ingest_text.
Hvis de vil gjøre det selv: nextAction=manual.
Snakk naturlig og kort. Ikke late som du allerede har hentet produkter før jobben er ferdig.`,
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
