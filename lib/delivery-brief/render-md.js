/**
 * Norwegian markdown view of a delivery brief, for developers (GET …/brief?format=md). It lists the
 * package (tier and services), the facts with their source, every directive with its quote, the
 * iterations, promises, project items and follow-ups, and the transcripts by reference only.
 */
import { isPlainObject, text } from './text.js';

const TIER_LABELS = {
  'tier-1-standard': 'Standard (nivå 1)',
  'tier-2-seo': 'SEO (nivå 2)',
  'tier-3-ecommerce': 'Nettbutikk (nivå 3)',
  custom: 'Tilpasset',
};

const SERVICE_LABELS = {
  site: 'Nettside',
  changes: 'Endringer',
  seo: 'SEO',
  social: 'Omtaler og sosiale medier',
  email: 'E-postmarkedsføring',
  blog: 'Blogg',
  ecom: 'Nettbutikk',
  dashboard: 'Dashboard',
  multilingual: 'Flerspråklig',
  unlimited: 'Ubegrensede endringer',
  catalog: 'Katalog',
  booking: 'Timebestilling',
  backlinks: 'Lenkenettverk',
};

const PURPOSE_LABELS = { sales: 'salgsmøte', demo: 'demo', workshop: 'workshop', iteration: 'iterasjon', admin: 'admin' };
const KIND_LABELS = { change: 'Endre', add: 'Legg til', remove: 'Fjern', keep: 'Behold' };
const PRIORITY_LABELS = { must: 'må', should: 'bør', could: 'kan' };
const STATUS_LABELS = {
  open: 'åpen',
  accepted: 'godtatt',
  rejected: 'avvist',
  done: 'utført',
  superseded: 'erstattet',
  proposed: 'foreslått',
  'client-confirmed': 'bekreftet av kunden',
};
const AVAILABILITY_LABELS = { available: 'finnes', partial: 'delvis', missing: 'mangler', unknown: 'ukjent' };
const SOURCE_LABELS = { transcript: 'møte', client: 'kunden', admin: 'utvikler', scrape: 'nettet', offer: 'tilbud', plan: 'plan' };

const FACT_LABELS = [
  ['identity.brandName', 'Merkenavn'],
  ['identity.legalName', 'Juridisk navn'],
  ['identity.orgNumber', 'Org.nr.'],
  ['contact.email', 'E-post'],
  ['contact.phone', 'Telefon'],
  ['contact.address', 'Adresse'],
  ['contact.town', 'Sted'],
  ['contact.serviceArea', 'Område'],
  ['positioning.businessWhat', 'Hva bedriften gjør'],
  ['positioning.audience', 'Målgruppe'],
  ['positioning.toneOfVoice', 'Tone'],
  ['positioning.story', 'Historie'],
  ['shop.shipping', 'Frakt'],
  ['shop.returns', 'Retur'],
  ['timeline.targetLaunchAt', 'Ønsket lansering'],
  ['content.density', 'Tekstmengde'],
  ['content.structure', 'Struktur'],
  ['content.mediaPlan', 'Bilder og video'],
];

const LIST_LABELS = [
  ['positioning.services', 'Tjenester'],
  ['positioning.differentiators', 'Det som skiller dem ut'],
  ['positioning.priorities', 'Prioriteringer'],
  ['positioning.brandCues', 'Stil'],
  ['content.pagesRequested', 'Ønskede sider'],
  ['content.pagesExcluded', 'Sider de ikke vil ha'],
  ['content.keepAsIs', 'Beholdes som det er'],
  ['claims.awards', 'Priser'],
  ['claims.certifications', 'Sertifiseringer'],
  ['claims.guarantees', 'Garantier'],
];

function get(object, path) {
  return path.split('.').reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), object);
}

/** One line of markdown-safe text (no line breaks, no table pipes). */
function inline(value, max = 300) {
  return text(value, max).replace(/\s+/g, ' ').replace(/\|/g, '/');
}

function quoteLine(quote, { speaker = '', meetingId = '', purpose = '' } = {}) {
  const who = [speaker, PURPOSE_LABELS[purpose] || ''].filter(Boolean).join(', ');
  return `  > «${inline(quote, 400)}»${who ? ` (${inline(who, 80)})` : ''}${meetingId ? ` [${inline(meetingId, 80)}]` : ''}`;
}

function sourceLabel(source) {
  if (!isPlainObject(source)) return '';
  const label = SOURCE_LABELS[source.kind] || source.kind || '';
  const status = STATUS_LABELS[source.status] || source.status || '';
  return [label, status].filter(Boolean).join(', ');
}

export function renderBriefMarkdown(brief) {
  const lines = [];
  const facts = isPlainObject(brief?.facts) ? brief.facts : {};
  const sources = isPlainObject(brief?.factSources) ? brief.factSources : {};
  const name = text(facts.identity?.brandName) || text(brief?.salesClientId) || 'ukjent kunde';
  lines.push(`# Leveransebrief: ${inline(name, 120)}`);
  lines.push('');
  lines.push(`Versjon ${Number(brief?.version) || 0} · laget ${text(brief?.generatedAt) || 'ukjent'} · ${text(brief?.hash)}`);
  lines.push('');

  lines.push('## Pakke');
  const plan = isPlainObject(brief?.sitePlan) ? brief.sitePlan : null;
  if (plan) {
    lines.push(`- Nivå: ${TIER_LABELS[plan.tierId] || inline(plan.tierId, 60)} (\`${inline(plan.tierId, 60)}\`)`);
    const services = (Array.isArray(plan.services) ? plan.services : []).map((id) => `${SERVICE_LABELS[id] || id} (\`${id}\`)`);
    lines.push(`- Tjenester: ${services.length ? services.join(', ') : 'ingen'}`);
    lines.push(`- Sider: ${Number(plan.pages) || 0} · Betaling: ${plan.billing === 'once' ? 'engangsbeløp' : 'månedlig'}${plan.signedAt ? ` · Signert: ${plan.signedAt.slice(0, 10)}` : ''}`);
  } else {
    lines.push('- Nivå: ingen plan i kraft ennå');
  }
  const offer = isPlainObject(brief?.offer) ? brief.offer : null;
  if (offer) {
    lines.push(`- Tilbud: ${inline(offer.title || offer.id, 160)} (${inline(offer.status, 40)})`);
    if (Array.isArray(offer.alternatives) && offer.alternatives.length > 1) {
      lines.push(`- Alternativer: ${offer.alternatives.map((alt) => `${inline(alt.title || alt.tierId, 80)}${alt.chosen ? ' (valgt)' : ''}`).join(' / ')}`);
    }
    if (Array.isArray(offer.includes) && offer.includes.length) lines.push(`- Inkluderer: ${offer.includes.map((entry) => inline(entry, 80)).join(', ')}`);
  }
  if (brief?.delivery?.targetLaunchAt) lines.push(`- Ønsket lansering: ${inline(brief.delivery.targetLaunchAt, 20)}`);
  lines.push('');

  lines.push('## Fakta');
  lines.push('| Felt | Verdi | Kilde |');
  lines.push('|---|---|---|');
  let factRows = 0;
  for (const [path, label] of FACT_LABELS) {
    const value = get(facts, path);
    if (value === undefined || value === null || value === '') continue;
    lines.push(`| ${label} | ${inline(value, 200)} | ${sourceLabel(sources[path])} |`);
    factRows += 1;
  }
  for (const [path, label] of LIST_LABELS) {
    const list = get(facts, path);
    if (!Array.isArray(list) || !list.length) continue;
    lines.push(`| ${label} | ${list.map((entry) => inline(entry, 80)).join('; ')} | ${sourceLabel(sources[`${path}[0]`])} |`);
    factRows += 1;
  }
  for (const [platform, url] of Object.entries(isPlainObject(facts.socials) ? facts.socials : {})) {
    if (!text(url)) continue;
    lines.push(`| ${inline(platform, 40)} | ${inline(url, 200)} | ${sourceLabel(sources[`socials.${platform}`])} |`);
    factRows += 1;
  }
  if (!factRows) lines.push('| – | ingen fakta ennå | |');
  const stats = Array.isArray(facts.claims?.stats) ? facts.claims.stats : [];
  if (stats.length) {
    lines.push('');
    lines.push('Tall (brukes bare med sitat):');
    for (const stat of stats) {
      lines.push(`- ${stat.value} ${inline(stat.unit, 40)} ${inline(stat.label, 120)} (${STATUS_LABELS[stat.status] || stat.status})`);
      if (stat.source?.quote) lines.push(quoteLine(stat.source.quote, { speaker: stat.source.speaker, purpose: stat.source.meeting, meetingId: stat.source.meetingId }));
    }
  }
  const catalogs = Array.isArray(facts.products?.catalogs) ? facts.products.catalogs : [];
  if (catalogs.length) lines.push(`\nProduktkataloger fra Kundedata: ${catalogs.length}`);
  lines.push('');

  lines.push('## Direktiver');
  const directives = Array.isArray(brief?.directives) ? brief.directives : [];
  if (!directives.length) lines.push('Ingen direktiver.');
  for (const directive of directives) {
    const area = directive.target?.area || 'site';
    lines.push(`- **${KIND_LABELS[directive.kind] || directive.kind}** \`${inline(area, 80)}\`: ${inline(directive.ask, 300)} (${PRIORITY_LABELS[directive.priority] || directive.priority}, ${STATUS_LABELS[directive.status] || directive.status}${directive.supersededBy ? `, erstattet av ${directive.supersededBy}` : ''}) \`${directive.id}\``);
    if (directive.quote) lines.push(quoteLine(directive.quote, { speaker: directive.speaker, purpose: directive.source, meetingId: directive.meetingId }));
  }
  lines.push('');

  const iterations = Array.isArray(brief?.iterations) ? brief.iterations : [];
  if (iterations.length) {
    lines.push('## Iterasjoner');
    for (const item of iterations) {
      lines.push(`- ${item.keepAsIs ? '**Behold**' : '**Endre**'} \`${inline(item.area, 80)}\`: ${inline(item.ask, 300)} (${STATUS_LABELS[item.status] || item.status}) \`${item.id}\``);
      if (item.quote) lines.push(quoteLine(item.quote, { speaker: item.speaker, purpose: 'iteration', meetingId: item.meetingId }));
    }
    lines.push('');
  }

  const feedback = Array.isArray(facts.previewFeedback) ? facts.previewFeedback : [];
  if (feedback.length) {
    lines.push('## Tilbakemeldinger på forhåndsvisning');
    for (const item of feedback) {
      lines.push(`- ${inline(item.text, 300)}`);
      if (item.quote) lines.push(quoteLine(item.quote, { meetingId: item.meetingId }));
    }
    lines.push('');
  }

  const promises = Array.isArray(brief?.promises) ? brief.promises : [];
  if (promises.length) {
    lines.push('## Løfter fra salg');
    for (const item of promises) {
      lines.push(`- ${inline(item.text, 300)}${item.featureKey ? ` (\`${item.featureKey}\`, ${AVAILABILITY_LABELS[item.availability] || item.availability})` : ''}`);
      if (item.quote) lines.push(quoteLine(item.quote, { speaker: item.speaker, meetingId: item.meetingId }));
    }
    lines.push('');
  }

  for (const [key, title] of [['todos', 'Gjøremål'], ['openDecisions', 'Åpne beslutninger'], ['outOfScope', 'Utenfor scope']]) {
    const list = Array.isArray(brief?.[key]) ? brief[key] : [];
    if (!list.length) continue;
    lines.push(`## ${title}`);
    for (const item of list) {
      if (typeof item === 'string') lines.push(`- ${inline(item, 300)}`);
      else lines.push(`- [${item.done ? 'x' : ' '}] ${inline(item.title, 180)}${item.detail ? `: ${inline(item.detail, 300)}` : ''}`);
    }
    lines.push('');
  }

  const followUps = Array.isArray(brief?.followUps) ? brief.followUps : [];
  const questions = Array.isArray(brief?.openQuestions) ? brief.openQuestions : [];
  if (followUps.length || questions.length) {
    lines.push('## Oppfølging');
    for (const item of followUps) {
      lines.push(`- ${inline(item.text, 200)}${item.dueAt ? ` (${inline(item.dueAt, 40)})` : ''}${item.who ? ` · ${inline(item.who, 80)}` : ''}`);
      if (item.quote) lines.push(quoteLine(item.quote, { meetingId: item.meetingId }));
    }
    for (const item of questions) {
      lines.push(`- Åpent spørsmål: ${inline(item.text, 200)}`);
      if (item.quote) lines.push(quoteLine(item.quote, { speaker: item.speaker, meetingId: item.meetingId }));
    }
    lines.push('');
  }

  const keywords = Array.isArray(brief?.seo?.agreedKeywords) ? brief.seo.agreedKeywords : [];
  if (keywords.length) {
    lines.push('## Avtalte søkeord');
    for (const row of keywords) lines.push(`- ${inline(row.keyword, 120)} (${inline(row.status, 40)})`);
    lines.push('');
  }

  lines.push('## Møter (bare referanser)');
  const transcripts = Array.isArray(brief?.transcripts) ? brief.transcripts : [];
  if (!transcripts.length) lines.push('Ingen møtereferater.');
  for (const item of transcripts) {
    lines.push(`- ${PURPOSE_LABELS[item.purpose] || item.purpose} ${text(item.startedAt).slice(0, 10)} · ${Number(item.chars) || 0} tegn · \`${text(item.sha256).slice(0, 12)}\``);
  }
  const gaps = Number(brief?.stats?.chunks?.gaps) || 0;
  if (gaps) lines.push('', `**Hull:** ${gaps} del${gaps === 1 ? '' : 'er'} av møtene ga ikke noe svar fra modellen og mangler i briefen. Be om ny bygging med «prøv hull på nytt» når årsaken er rettet.`);
  lines.push('');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}
