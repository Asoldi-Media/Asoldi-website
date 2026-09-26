import { deepseekChatJson, isDeepseekConfigured } from '../deepseek.js';
import { detectLayoutFromEvidence, parseLayoutChoice } from './layout-detect.js';
import { PRODUCT_LAYOUT_RULES, summarizeCatalogs } from '../client-product-catalog.js';

const URL_RE = /https?:\/\/[^\s<>"']+/i;

export const PRODUCT_ASSISTANT_GREETING = [
  'Hei — klar til å sette opp nettsiden din sammen.',
  'Start med produktene. Last opp menyer, prislister eller bilder, lim inn nettside-lenker, og skriv notater i samme felt. Jeg leser alt sammen som én kilde — ikke hver fil for seg.',
].join('\n');

export function extractFirstUrl(text = '') {
  const match = String(text || '').match(URL_RE);
  return match ? match[0].replace(/[),.;]+$/, '') : '';
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
    return {
      assistantMessage: 'Takk, jeg henter alle synlige produkter fra den siden nå — priser, kategorier og bilder.',
      layout: layout || null,
      catalogPatch: null,
      nextAction: 'scrape',
      url,
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
  if (String(userText || '').trim().length > 40) {
    return {
      assistantMessage: 'Jeg leser teksten og legger produktene inn i katalogen.',
      layout: layout || null,
      catalogPatch: null,
      nextAction: 'ingest_text',
      questions: [],
    };
  }
  return {
    assistantMessage: 'Du kan lime inn en nettside-URL, laste opp Excel/PDF, skrive produktene her, eller sette dem opp manuelt i Kundedata.',
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
Hvis brukeren limer inn URL: nextAction=scrape.
Hvis de beskriver produkter: nextAction=ingest_text.
Hvis de vil gjøre det selv: nextAction=manual.`,
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
