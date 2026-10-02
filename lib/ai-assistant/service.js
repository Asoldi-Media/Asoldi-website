import * as clientPortal from '../../data/client-portal.js';
import { PRODUCT_IMPORT_CAP, capCatalogsToProductLimit, mergeImportedCatalogs, summarizeCatalogs } from '../client-product-catalog.js';
import { applyMakerBundleToPortal } from '../maker-bundle-sync.js';
import { runProductAssistantTurn, buildOpeningState, extractFirstUrl } from './chat.js';
import {
  SETTINGS_PATH,
  businessLabel,
  doneMessage,
  isAffirmativeOnly,
  isDecline,
  nextIntakeStep,
  parseAffiliationsAnswer,
  parseOpeningHoursAnswer,
  parseStaffAnswer,
  questionFor,
  withIntakeFlag,
} from './intake.js';
import { createAssistantJob, getAssistantJob, publicJobView, updateAssistantJob } from './jobs.js';
import { extractUrlsFromText, ingestProductSources, shouldIngestSources } from './products-ingest.js';
import { isMediaAssetSource, partitionAssistantFiles, sniffSourceKind } from './source-kind.js';
import { siteHostLabel } from './site-urls.js';
import { saveClientUploadBuffer } from '../client-media-store.js';

function bankOf(userId) {
  return clientPortal.getClientProfileByUserId(userId)?.clientDataBank || {};
}

function persistCatalogs(userId, catalogs) {
  const current = bankOf(userId);
  const profileNow = clientPortal.getClientProfileByUserId(userId);
  const incoming = capCatalogsToProductLimit(catalogs, PRODUCT_IMPORT_CAP);
  const merged = mergeImportedCatalogs(current.productCatalogs || [], incoming.catalogs);
  const profile = clientPortal.setClientDataBank(userId, {
    ...current,
    productCatalogs: merged,
  }, { businessId: profileNow?.businessId });
  return {
    profile,
    catalogs: profile?.clientDataBank?.productCatalogs || merged,
    truncated: incoming.truncated,
    dropped: incoming.dropped,
  };
}

function makerCandidateUrls(profile) {
  const raw = [
    profile?.clientDataBank?.makerLink?.tunnelUrl,
    globalThis.__asoldiMakerTunnelUrl,
    process.env.WEBSITE_MAKER_BASE_URL,
    process.env.WEBSITE_MAKER_URL,
    process.env.WEBSITE_MAKER_LOCAL_URL,
    'http://localhost:3000',
  ];
  const seen = new Set();
  const urls = [];
  for (const value of raw) {
    const url = String(value || '').trim().replace(/\/$/, '');
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

async function pullMakerBundleForProfile(profile) {
  const queries = [];
  const bundleId = String(profile?.clientDataBank?.makerLink?.bundleId || '').trim();
  const email = String(profile?.email || profile?.clientDataBank?.generalInfo?.companyEmail || profile?.clientDataBank?.makerLink?.email || '').trim().toLowerCase();
  if (bundleId) queries.push(`id=${encodeURIComponent(bundleId)}`);
  if (email) queries.push(`email=${encodeURIComponent(email)}`);
  if (!queries.length) return null;
  for (const base of makerCandidateUrls(profile)) {
    for (const query of queries) {
      try {
        const response = await fetch(`${base}/api/client-bundles?${query}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) continue;
        const payload = await response.json().catch(() => ({}));
        if (payload.client) return payload.client;
      } catch {
        // try next Maker URL (local, LAN, or public tunnel)
      }
    }
  }
  return null;
}

function firstProductNames(catalogs = [], limit = 5) {
  const names = [];
  for (const catalog of catalogs || []) {
    for (const category of catalog.categories || []) {
      for (const product of category.products || []) {
        const title = String(product.title || product.name || '').replace(/\s+/g, ' ').trim();
        if (!title || names.includes(title)) continue;
        names.push(title);
        if (names.length >= limit) return names;
      }
    }
  }
  return names;
}

function uniqueUrls(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

async function persistMediaFiles(userId, files = []) {
  const urls = [];
  for (const file of files) {
    const name = file.originalName || file.name || 'media';
    if (!isMediaAssetSource({ ...file, fileName: name }) || !file.buffer) continue;
    const saved = await saveClientUploadBuffer(userId, {
      buffer: file.buffer,
      originalName: name,
      prefix: 'assistant',
    });
    urls.push(saved.url);
  }
  if (!urls.length) {
    return { urls: [], profile: clientPortal.getClientProfileByUserId(userId) };
  }
  const current = bankOf(userId);
  const profileNow = clientPortal.getClientProfileByUserId(userId);
  const profile = clientPortal.setClientDataBank(userId, {
    ...current,
    media: {
      ...(current.media || {}),
      uncategorized: uniqueUrls([...(current.media?.uncategorized || []), ...urls]),
    },
  }, { businessId: profileNow?.businessId });
  return { urls, profile };
}

function formatIngestDoneMessage({
  catalogs = [],
  urls = [],
  mediaCount = 0,
  documentCount = 0,
  truncated = false,
  dropped = 0,
} = {}) {
  const summary = summarizeCatalogs(catalogs);
  const host = siteHostLabel(urls[0] || '');
  const names = firstProductNames(catalogs);
  const sample = names.length ? ` Blant annet ${names.join(', ')}.` : '';
  const capBit = truncated
    ? ` Jeg stoppet på ${PRODUCT_IMPORT_CAP} produkter${dropped ? ` (hoppet over ${dropped})` : ''}. Større kataloger lastes inn uten AI.`
    : '';
  const mediaBit = mediaCount
    ? ` ${mediaCount === 1 ? '1 bilde/video er lagt i mediabiblioteket.' : `${mediaCount} bilder/video er lagt i mediabiblioteket.`}`
    : '';
  if (!summary.productCount && mediaCount && !documentCount) {
    return `Jeg har lagt inn ${mediaCount === 1 ? 'bildet/videoen' : `${mediaCount} mediafiler`} i biblioteket.${host ? ` Fant ingen nye produkter på ${host}.` : ''}`;
  }
  if (!summary.productCount) {
    return host
      ? `Jeg gikk gjennom ${host}, men fant ingen tydelige produkter eller priser. Last opp en prisliste, eller skriv produktene her.`
      : 'Jeg fant ingen produkter i det du sendte. Last opp et dokument, lim inn en nettside, eller skriv listen her.';
  }
  const catWord = summary.categoryCount === 1 ? 'kategori' : 'kategorier';
  return host
    ? `Jeg har gått gjennom ${host} og lagt inn ${summary.productCount} produkter i ${summary.categoryCount} ${catWord}.${sample}${mediaBit}${capBit}`
    : `Ferdig. Jeg har lagt inn ${summary.productCount} produkter i ${summary.categoryCount} ${catWord}.${sample}${mediaBit}${capBit}`;
}

function startingIngestMessage({ files = [], urls = [], text = '' } = {}) {
  const host = siteHostLabel(urls[0] || '');
  const parts = partitionAssistantFiles(files);
  if (host && !files.length) {
    return `Jeg går gjennom hele ${host} nå — ikke bare én underside — og henter det som ser ut som produkter, pakker og priser.`;
  }
  if (parts.documents.length && parts.media.length) {
    return `Jeg leser ${parts.documents.length === 1 ? 'dokumentet' : `${parts.documents.length} dokumenter`} som tekst, og lagrer ${parts.media.length === 1 ? 'bildet/videoen' : `${parts.media.length} mediafiler`} separat.`;
  }
  if (parts.documents.length) {
    return `Jeg leser ${parts.documents.length === 1 ? 'dokumentet' : `${parts.documents.length} dokumenter`} som tekst — ikke som bilde — og bygger katalogen.`;
  }
  if (parts.media.length) {
    return `Jeg lagrer ${parts.media.length === 1 ? 'bildet/videoen' : `${parts.media.length} mediafiler`} og sjekker om det også er en synlig prisliste der.`;
  }
  if (files.length || urls.length) {
    return 'Jeg leser alle kildene dine sammen — dokumenter, lenker og det du skrev — og bygger én produktkatalog.';
  }
  return 'Jeg leser teksten og legger produktene inn i katalogen.';
}

function catalogFingerprint(catalogs = []) {
  return summarizeCatalogs(catalogs).categories
    .map((category) => `${category.name}:${category.productCount}`)
    .join('|');
}

function reconcileStoredCatalogs(userId, profile) {
  const current = profile?.clientDataBank?.productCatalogs || [];
  if (!current.length) return profile;
  const cleaned = mergeImportedCatalogs(current, []);
  if (catalogFingerprint(current) === catalogFingerprint(cleaned)) return profile;
  const profileNow = clientPortal.getClientProfileByUserId(userId);
  return clientPortal.setClientDataBank(userId, {
    ...(profile?.clientDataBank || {}),
    productCatalogs: cleaned,
  }, { businessId: profileNow?.businessId || profile?.businessId }) || profile;
}

export async function getAssistantState(userId) {
  let profile = clientPortal.getClientProfileByUserId(userId);
  const bundle = await pullMakerBundleForProfile(profile);
  if (bundle) {
    const applied = applyMakerBundleToPortal({
      portalUserId: userId,
      email: profile?.email,
      businessId: profile?.businessId,
      bundle,
    });
    if (applied.ok) profile = applied.profile;
  }
  profile = reconcileStoredCatalogs(userId, profile);
  return {
    profile,
    ...buildOpeningState(profile || {}),
    summary: summarizeCatalogs(profile?.clientDataBank?.productCatalogs || []),
    makerLinked: Boolean(profile?.clientDataBank?.makerLink?.bundleId),
  };
}

export function getJobForUser(jobId, userId) {
  const job = getAssistantJob(jobId, userId);
  if (!job) return null;
  const profile = clientPortal.getClientProfileByUserId(userId);
  return {
    ...publicJobView(job),
    profile,
    catalogs: job.catalogs || (job.catalog ? [job.catalog] : []),
    summary: summarizeCatalogs(job.catalogs || (job.catalog ? [job.catalog] : profile?.clientDataBank?.productCatalogs || [])),
  };
}

async function runUnifiedIngestJob(jobId, userId, { files = [], text = '', urls = [] } = {}) {
  updateAssistantJob(jobId, { status: 'running', progress: { step: 'starting', message: 'Leser alle kilder sammen…' } });
  try {
    const bank = bankOf(userId);
    const split = partitionAssistantFiles(files);
    if (split.media.length) {
      updateAssistantJob(jobId, { progress: { step: 'media', message: 'Lagrer bilder og video…' } });
    }
    const mediaSaved = await persistMediaFiles(userId, split.media);
    const result = await ingestProductSources({
      files,
      text,
      urls,
      userId,
      industry: bank?.businessCard?.industry || '',
      layoutHint: summarizeCatalogs(bank.productCatalogs || []).layout || '',
      businessName: bank?.businessCard?.companyName || '',
      existingCatalogs: bank.productCatalogs || [],
      onProgress: (progress) => updateAssistantJob(jobId, { progress }),
    });
    const saved = persistCatalogs(userId, result.catalogs);
    const summary = summarizeCatalogs(saved.catalogs);
    let assistantMessage = formatIngestDoneMessage({
      catalogs: saved.catalogs,
      urls,
      mediaCount: mediaSaved.urls.length,
      documentCount: split.documents.length,
      truncated: Boolean(saved.truncated || result.truncated),
      dropped: Number(saved.dropped || result.dropped || 0),
    });
    let redirectTo = '';
    if (summary.productCount) {
      const profile = saveIntakeFlag(userId, 'products', 'done');
      const name = businessLabel(profile?.clientDataBank || {}, profile);
      const step = nextIntakeStep(profile?.clientDataBank || {});
      const follow = questionFor(step, name);
      if (follow && !assistantMessage.includes(follow)) assistantMessage = `${assistantMessage}\n\n${follow}`;
      if (step === 'done') redirectTo = SETTINGS_PATH;
    }
    updateAssistantJob(jobId, {
      status: 'done',
      catalog: saved.catalogs[0] || null,
      catalogs: saved.catalogs,
      assistantMessage,
      redirectTo,
      nextAction: redirectTo ? 'done' : 'wait',
      progress: {
        step: 'done',
        message: assistantMessage,
        found: summary.productCount,
      },
    });
  } catch (error) {
    updateAssistantJob(jobId, {
      status: 'failed',
      error: error?.message || 'Klarte ikke å lese kildene.',
    });
  }
}

function saveIntakeFlag(userId, step, status) {
  const current = bankOf(userId);
  const profileNow = clientPortal.getClientProfileByUserId(userId);
  return clientPortal.setClientDataBank(userId, withIntakeFlag(current, step, status), {
    businessId: profileNow?.businessId,
  });
}

function patchClientBank(userId, nextBank) {
  const profileNow = clientPortal.getClientProfileByUserId(userId);
  return clientPortal.setClientDataBank(userId, nextBank, { businessId: profileNow?.businessId });
}

function replyAfter(userId, profile, prefix = '') {
  const bank = profile?.clientDataBank || bankOf(userId);
  const name = businessLabel(bank, profile);
  const step = nextIntakeStep(bank);
  const follow = questionFor(step, name);
  return {
    assistantMessage: [prefix, follow].filter(Boolean).join('\n\n'),
    nextAction: step === 'done' ? 'done' : 'wait',
    redirectTo: step === 'done' ? SETTINGS_PATH : '',
    currentStep: step,
    profile,
    summary: summarizeCatalogs(bank.productCatalogs || []),
  };
}

function chatEnvelope(state, extra = {}) {
  return {
    profile: state.profile,
    summary: state.summary,
    currentStep: nextIntakeStep(state.profile?.clientDataBank || {}),
    ...extra,
  };
}

export async function handleAssistantChat(userId, { text = '', messages = [], files = [] } = {}) {
  const state = await getAssistantState(userId);
  const industry = state.industry || '';
  const layout = state.layout || '';
  const bank = state.profile?.clientDataBank || {};
  const step = nextIntakeStep(bank);
  const name = businessLabel(bank, state.profile);
  const urls = extractUrlsFromText(text);
  const trimmed = String(text || '').trim();
  const pricedLine = /\d+\s*(?:kr|,-|nok)\b/i.test(trimmed);

  if (step === 'done') {
    return chatEnvelope(state, {
      assistantMessage: doneMessage(name),
      nextAction: 'done',
      redirectTo: SETTINGS_PATH,
      currentStep: 'done',
    });
  }

  if (step !== 'products') {
    return handleIntakeAnswer(userId, state, { step, name, text: trimmed, files });
  }

  if (isDecline(trimmed) && !files.length && !urls.length) {
    return replyAfter(userId, saveIntakeFlag(userId, 'products', 'skipped'));
  }

  if (shouldIngestSources({ files, urls, text }) || pricedLine) {
    const job = createAssistantJob(userId, 'ingest', { urls });
    setTimeout(() => {
      void runUnifiedIngestJob(job.id, userId, { files, text, urls });
    }, 10);
    return {
      assistantMessage: startingIngestMessage({ files, urls, text }),
      nextAction: 'ingest',
      jobId: job.id,
      layout,
      profile: state.profile,
      summary: state.summary,
    };
  }

  const turn = await runProductAssistantTurn({
    messages: messages.length ? messages : [{ role: 'user', text }],
    industry,
    layout,
    summary: state.summary,
  });

  if (turn.nextAction === 'manual') {
    return { ...turn, profile: state.profile, catalogs: state.profile?.clientDataBank?.productCatalogs || [], summary: state.summary };
  }

  if (turn.nextAction === 'set_layout' && turn.layout) {
    const current = bankOf(userId);
    const catalogs = (current.productCatalogs || []).map((catalog, index) => (
      index === 0 ? { ...catalog, layout: turn.layout, label: turn.layout } : catalog
    ));
    const saved = persistCatalogs(userId, catalogs);
    return { ...turn, catalogs: saved.catalogs, profile: saved.profile, summary: summarizeCatalogs(saved.catalogs) };
  }

  if ((turn.nextAction === 'scrape' || turn.nextAction === 'ingest_text') && (turn.url || text)) {
    const job = createAssistantJob(userId, 'ingest');
    setTimeout(() => {
      void runUnifiedIngestJob(job.id, userId, { files, text, urls: turn.url ? [turn.url] : urls });
    }, 10);
    return {
      ...turn,
      nextAction: 'ingest',
      jobId: job.id,
      profile: state.profile,
      summary: state.summary,
    };
  }

  return {
    ...turn,
    profile: state.profile,
    catalogs: state.profile?.clientDataBank?.productCatalogs || [],
    summary: state.summary,
    currentStep: 'products',
  };
}

async function handleIntakeAnswer(userId, state, { step, name, text, files }) {
  const parts = partitionAssistantFiles(files);
  const images = parts.media.filter((file) => sniffSourceKind(file) === 'image');

  if (step === 'media') {
    if (isDecline(text) && !parts.media.length) {
      return replyAfter(userId, saveIntakeFlag(userId, 'media', 'skipped'));
    }
    if ((parts.documents.length || files.length) && !parts.media.length) {
      return chatEnvelope(state, {
        assistantMessage: 'Mediabiblioteket tar bilder og video. Tekstfiler hører ikke hjemme der. Last opp bilde eller video, eller si at dere hopper over.',
        nextAction: 'wait',
        currentStep: 'media',
      });
    }
    if (parts.media.length) {
      const saved = await persistMediaFiles(userId, parts.media);
      const profile = saveIntakeFlag(userId, 'media', saved.urls.length ? 'done' : 'skipped');
      const count = saved.urls.length;
      const prefix = count
        ? (count === 1 ? 'Bildet eller videoen er lagt i mediabiblioteket.' : `${count} filer er lagt i mediabiblioteket.`)
        : 'Jeg fikk ikke lagret filene som media.';
      return replyAfter(userId, profile, prefix);
    }
    return chatEnvelope(state, {
      assistantMessage: questionFor('media', name),
      nextAction: 'wait',
      currentStep: 'media',
    });
  }

  if (step === 'logo') {
    if (isDecline(text) && !images.length) {
      return replyAfter(userId, saveIntakeFlag(userId, 'logo', 'skipped'));
    }
    if (!images.length) {
      return chatEnvelope(state, {
        assistantMessage: 'Last opp selve logobildet (png, jpg eller svg). En tekstfil kan ikke brukes som logo.',
        nextAction: 'wait',
        currentStep: 'logo',
      });
    }
    const file = images[0];
    const saved = await saveClientUploadBuffer(userId, {
      buffer: file.buffer,
      originalName: file.originalName || file.name || 'logo',
      prefix: 'logo',
    });
    const current = bankOf(userId);
    const profile = patchClientBank(userId, withIntakeFlag({
      ...current,
      brandIdentity: {
        ...(current.brandIdentity || {}),
        logos: {
          ...(current.brandIdentity?.logos || {}),
          normal: saved.url,
        },
      },
      media: {
        ...(current.media || {}),
        logos: uniqueUrls([...(current.media?.logos || []), saved.url]),
      },
    }, 'logo', 'done'));
    return replyAfter(userId, profile, 'Logoen er lagt på vanlig logoplass.');
  }

  if (step === 'staff') {
    const parsed = parseStaffAnswer(text);
    if (parsed.action === 'skip' || (isDecline(text) && !files.length)) {
      return replyAfter(userId, saveIntakeFlag(userId, 'staff', 'skipped'));
    }
    if (parsed.action === 'details') {
      return chatEnvelope(state, {
        assistantMessage: questionFor('staffDetails', name),
        nextAction: 'wait',
        currentStep: 'staff',
      });
    }
    if (parsed.action !== 'save') {
      return chatEnvelope(state, {
        assistantMessage: 'Skriv én person per linje: navn, tittel, telefon, e-post. Eller si at det ikke er aktuelt.',
        nextAction: 'wait',
        currentStep: 'staff',
      });
    }
    const current = bankOf(userId);
    const staff = [...(current.staff || [])];
    for (const person of parsed.people) {
      staff.push({
        id: '',
        title: person.title,
        name: person.name,
        phone: person.phone,
        email: person.email,
        imageUrl: '',
      });
    }
    const profile = patchClientBank(userId, withIntakeFlag({ ...current, staff }, 'staff', 'done'));
    const count = parsed.people.length;
    return replyAfter(userId, profile, count === 1 ? 'Jeg la inn personen under Ansatte.' : `Jeg la inn ${count} personer under Ansatte.`);
  }

  if (step === 'hours') {
    const parsed = parseOpeningHoursAnswer(text);
    if (parsed.action === 'unclear') {
      return chatEnvelope(state, {
        assistantMessage: 'Si åpningstidene fra mandag til søndag, at dere er åpne 24/7, eller at det ikke er relevant.',
        nextAction: 'wait',
        currentStep: 'hours',
      });
    }
    const current = bankOf(userId);
    const profile = patchClientBank(userId, withIntakeFlag({
      ...current,
      openingHours: {
        ...(current.openingHours || {}),
        status: parsed.status,
        days: parsed.days,
      },
    }, 'hours', 'done'));
    const prefix = parsed.status === 'always'
      ? 'Jeg satte dere som døgnåpne.'
      : parsed.status === 'not-relevant'
        ? 'Jeg merket åpningstider som ikke relevant.'
        : 'Åpningstidene er lagret.';
    return replyAfter(userId, profile, prefix);
  }

  if (step === 'affiliations') {
    const parsed = parseAffiliationsAnswer(text);
    if (parsed.action === 'skip' || isDecline(text)) {
      return replyAfter(userId, saveIntakeFlag(userId, 'affiliations', 'skipped'));
    }
    if (parsed.action === 'details') {
      return chatEnvelope(state, {
        assistantMessage: questionFor('affiliationDetails', name),
        nextAction: 'wait',
        currentStep: 'affiliations',
      });
    }
    if (parsed.action !== 'save') {
      return chatEnvelope(state, {
        assistantMessage: 'Skriv partnerne, gjerne med gruppenavn foran. For eksempel «Sponsorer: Navn, Navn».',
        nextAction: 'wait',
        currentStep: 'affiliations',
      });
    }
    const current = bankOf(userId);
    const affiliations = [...(current.affiliations || [])];
    for (const category of parsed.categories) {
      const hit = affiliations.find((row) => String(row.categoryName || '').toLowerCase() === category.categoryName.toLowerCase());
      if (hit) hit.items = [...(hit.items || []), ...category.items];
      else affiliations.push(category);
    }
    const profile = patchClientBank(userId, withIntakeFlag({ ...current, affiliations }, 'affiliations', 'done'));
    return replyAfter(userId, profile, 'Partnerne er lagt inn.');
  }

  return replyAfter(userId, state.profile);
}

export async function startProductScrape(userId, url) {
  const job = createAssistantJob(userId, 'ingest', { url });
  setTimeout(() => { void runUnifiedIngestJob(job.id, userId, { text: url, urls: [url] }); }, 10);
  return { jobId: job.id, job: publicJobView(job) };
}

export async function importProductFiles(userId, { files = [], text = '' } = {}) {
  const ingested = await ingestProductSources({
    files,
    text,
    urls: extractUrlsFromText(text),
    industry: (await getAssistantState(userId)).industry,
    userId,
  });
  const saved = persistCatalogs(userId, ingested.catalogs);
  return {
    catalogs: saved.catalogs,
    profile: saved.profile,
    summary: summarizeCatalogs(saved.catalogs),
    layout: ingested.layout,
  };
}

export { extractFirstUrl };
