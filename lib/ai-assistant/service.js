import * as clientPortal from '../../data/client-portal.js';
import { mergeImportedCatalogs, summarizeCatalogs } from '../client-product-catalog.js';
import { applyMakerBundleToPortal } from '../maker-bundle-sync.js';
import { runProductAssistantTurn, buildOpeningState, extractFirstUrl } from './chat.js';
import { createAssistantJob, getAssistantJob, publicJobView, updateAssistantJob } from './jobs.js';
import { extractUrlsFromText, ingestProductSources, shouldIngestSources } from './products-ingest.js';
import { siteHostLabel } from './site-urls.js';

function bankOf(userId) {
  return clientPortal.getClientProfileByUserId(userId)?.clientDataBank || {};
}

function persistCatalogs(userId, catalogs) {
  const current = bankOf(userId);
  const profileNow = clientPortal.getClientProfileByUserId(userId);
  const merged = mergeImportedCatalogs(current.productCatalogs || [], catalogs);
  const profile = clientPortal.setClientDataBank(userId, {
    ...current,
    productCatalogs: merged,
  }, { businessId: profileNow?.businessId });
  return { profile, catalogs: profile?.clientDataBank?.productCatalogs || merged };
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

function formatIngestDoneMessage({ catalogs = [], urls = [] } = {}) {
  const summary = summarizeCatalogs(catalogs);
  const host = siteHostLabel(urls[0] || '');
  const names = firstProductNames(catalogs);
  const sample = names.length ? ` Blant annet ${names.join(', ')}.` : '';
  if (!summary.productCount) {
    return host
      ? `Jeg gikk gjennom ${host}, men fant ingen tydelige produkter eller priser. Last opp en prisliste, eller skriv produktene her.`
      : 'Jeg fant ingen produkter i det du sendte. Last opp en fil, lim inn en nettside, eller skriv listen her.';
  }
  const catWord = summary.categoryCount === 1 ? 'kategori' : 'kategorier';
  return host
    ? `Jeg har gått gjennom ${host} og lagt inn ${summary.productCount} produkter i ${summary.categoryCount} ${catWord}.${sample}`
    : `Ferdig. Jeg har lagt inn ${summary.productCount} produkter i ${summary.categoryCount} ${catWord}.${sample}`;
}

function startingIngestMessage({ files = [], urls = [], text = '' } = {}) {
  const host = siteHostLabel(urls[0] || '');
  if (host && !files.length) {
    return `Jeg går gjennom hele ${host} nå — ikke bare én underside — og henter det som ser ut som produkter, pakker og priser.`;
  }
  if (files.length || urls.length) {
    return 'Jeg leser alle kildene dine sammen — filer, lenker og det du skrev — og bygger én produktkatalog.';
  }
  return 'Jeg leser teksten og legger produktene inn i katalogen.';
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
    const result = await ingestProductSources({
      files,
      text,
      urls,
      userId,
      industry: bank?.businessCard?.industry || '',
      layoutHint: summarizeCatalogs(bank.productCatalogs || []).layout || '',
      businessName: bank?.businessCard?.companyName || '',
      onProgress: (progress) => updateAssistantJob(jobId, { progress }),
    });
    const saved = persistCatalogs(userId, result.catalogs);
    const summary = summarizeCatalogs(saved.catalogs);
    const assistantMessage = formatIngestDoneMessage({ catalogs: saved.catalogs, urls });
    updateAssistantJob(jobId, {
      status: 'done',
      catalog: saved.catalogs[0] || null,
      catalogs: saved.catalogs,
      assistantMessage,
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

export async function handleAssistantChat(userId, { text = '', messages = [], files = [] } = {}) {
  const state = await getAssistantState(userId);
  const industry = state.industry || '';
  const layout = state.layout || '';
  const urls = extractUrlsFromText(text);

  if (shouldIngestSources({ files, urls, text })) {
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
  };
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
