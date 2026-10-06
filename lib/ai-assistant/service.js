import * as clientPortal from '../../data/client-portal.js';
import { PRODUCT_IMPORT_CAP, capCatalogsToProductLimit, mergeImportedCatalogs, summarizeCatalogs } from '../client-product-catalog.js';
import { applyMakerBundleToPortal } from '../maker-bundle-sync.js';
import { runProductAssistantTurn, buildOpeningState, extractFirstUrl } from './chat.js';
import { applyNoteToBank, interpretLooseNote } from './gather.js';
import {
  INTAKE_STEPS,
  awaitingMore,
  businessLabel,
  chapterHasContent,
  doneMessage,
  hasAffiliations,
  hasListedTeam,
  isAffirmativeOnly,
  isDecline,
  isNoMore,
  mediaFileCount,
  moreQuestion,
  navigationTarget,
  nextIntakeStep,
  parseAffiliationsAnswer,
  parseOpeningHoursAnswer,
  parseStaffAnswer,
  promptFor,
  questionFor,
  sideWrite,
  withIntakeFlag,
} from './intake.js';
import { createAssistantJob, getAssistantJob, publicJobView, updateAssistantJob } from './jobs.js';
import { ingestProductSources, shouldIngestSources } from './products-ingest.js';
import { isMediaAssetSource, partitionAssistantFiles, sniffSourceKind } from './source-kind.js';
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
  mediaCount = 0,
  documentCount = 0,
  truncated = false,
  dropped = 0,
} = {}) {
  const summary = summarizeCatalogs(catalogs);
  const names = firstProductNames(catalogs);
  const sample = names.length ? ` Blant annet ${names.join(', ')}.` : '';
  const capBit = truncated
    ? ` Jeg stoppet på ${PRODUCT_IMPORT_CAP} produkter${dropped ? ` (hoppet over ${dropped})` : ''}. Større kataloger lastes inn uten AI.`
    : '';
  const mediaBit = mediaCount
    ? ` ${mediaCount === 1 ? '1 bilde/video er lagt i mediabiblioteket.' : `${mediaCount} bilder/video er lagt i mediabiblioteket.`}`
    : '';
  if (!summary.productCount && mediaCount && !documentCount) {
    return `Jeg har lagt inn ${mediaCount === 1 ? 'bildet/videoen' : `${mediaCount} mediafiler`} i biblioteket.`;
  }
  if (!summary.productCount) {
    return 'Jeg fant ingen produkter i det du sendte. Last opp et dokument, eller skriv listen her.';
  }
  const catWord = summary.categoryCount === 1 ? 'kategori' : 'kategorier';
  return `Ferdig. Jeg har lagt inn ${summary.productCount} produkter i ${summary.categoryCount} ${catWord}.${sample}${mediaBit}${capBit}`;
}

function startingIngestMessage({ files = [] } = {}) {
  const parts = partitionAssistantFiles(files);
  if (parts.documents.length && parts.media.length) {
    return `Jeg leser ${parts.documents.length === 1 ? 'dokumentet' : `${parts.documents.length} dokumenter`} som tekst, og lagrer ${parts.media.length === 1 ? 'bildet/videoen' : `${parts.media.length} mediafiler`} separat.`;
  }
  if (parts.documents.length) {
    return `Jeg leser ${parts.documents.length === 1 ? 'dokumentet' : `${parts.documents.length} dokumenter`} som tekst — ikke som bilde — og bygger katalogen.`;
  }
  if (parts.media.length) {
    return `Jeg lagrer ${parts.media.length === 1 ? 'bildet/videoen' : `${parts.media.length} mediafiler`} og sjekker om det også er en synlig prisliste der.`;
  }
  if (files.length) {
    return 'Jeg leser filene og det du skrev, og bygger én produktkatalog.';
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

async function runUnifiedIngestJob(jobId, userId, { files = [], text = '' } = {}) {
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
      mediaCount: mediaSaved.urls.length,
      documentCount: split.documents.length,
      truncated: Boolean(saved.truncated || result.truncated),
      dropped: Number(saved.dropped || result.dropped || 0),
    });
    let currentStep = 'products';
    if (mediaSaved.urls.length) saveIntakeFlag(userId, 'media', 'more');
    if (summary.productCount) {
      const profile = saveIntakeFlag(userId, 'products', 'more');
      const name = businessLabel(profile?.clientDataBank || {}, profile);
      const follow = moreQuestion('products', name);
      if (follow && !assistantMessage.includes(follow)) assistantMessage = `${assistantMessage}\n\n${follow}`;
      currentStep = 'products';
    }
    updateAssistantJob(jobId, {
      status: 'done',
      catalog: saved.catalogs[0] || null,
      catalogs: saved.catalogs,
      assistantMessage,
      redirectTo: '',
      currentStep,
      nextAction: 'wait',
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
  let next = withIntakeFlag(current, step, status);
  if (status === 'done' || status === 'skipped') {
    next = {
      ...next,
      assistantIntake: { ...(next.assistantIntake || {}), focus: '' },
    };
  }
  return clientPortal.setClientDataBank(userId, next, {
    businessId: profileNow?.businessId,
  });
}

function setAssistantFocus(userId, step) {
  const current = bankOf(userId);
  const focus = INTAKE_STEPS.includes(step) ? step : '';
  return patchClientBank(userId, {
    ...current,
    assistantIntake: { ...(current.assistantIntake || {}), focus },
  });
}

function patchClientBank(userId, nextBank) {
  const profileNow = clientPortal.getClientProfileByUserId(userId);
  return clientPortal.setClientDataBank(userId, nextBank, { businessId: profileNow?.businessId });
}

function replyAfter(userId, profile, prefix = '', { revisit = false } = {}) {
  const bank = profile?.clientDataBank || bankOf(userId);
  const name = businessLabel(bank, profile);
  const step = nextIntakeStep(bank);
  const follow = promptFor(step, name, bank, { revisit });
  return {
    assistantMessage: [prefix, follow].filter(Boolean).join('\n\n'),
    nextAction: step === 'done' ? 'done' : 'wait',
    redirectTo: '',
    currentStep: step,
    composer: step === 'hours' ? 'hours' : '',
    profile,
    summary: summarizeCatalogs(bank.productCatalogs || []),
  };
}

function openChapter(userId, step) {
  const profile = setAssistantFocus(userId, step);
  const bank = profile?.clientDataBank || {};
  return replyAfter(userId, profile, '', { revisit: chapterHasContent(bank, step) });
}

function chatEnvelope(state, extra = {}) {
  const currentStep = extra.currentStep || nextIntakeStep(state.profile?.clientDataBank || {});
  return {
    profile: state.profile,
    summary: state.summary,
    ...extra,
    currentStep,
    composer: extra.composer ?? (currentStep === 'hours' ? 'hours' : ''),
  };
}

function beginIngest(userId, state, { files = [], text = '', layout = '' } = {}) {
  const job = createAssistantJob(userId, 'ingest');
  setTimeout(() => {
    void runUnifiedIngestJob(job.id, userId, { files, text });
  }, 10);
  return {
    assistantMessage: startingIngestMessage({ files, text }),
    nextAction: 'ingest',
    jobId: job.id,
    layout,
    profile: state.profile,
    summary: state.summary,
  };
}

function commitSideWrite(userId, diverted) {
  const current = bankOf(userId);
  if (diverted.kind === 'hours') {
    const profile = patchClientBank(userId, withIntakeFlag({
      ...current,
      openingHours: {
        ...(current.openingHours || {}),
        status: diverted.parsed.status,
        days: diverted.parsed.days,
      },
    }, 'hours', 'done'));
    const prefix = diverted.parsed.status === 'always'
      ? 'Jeg satte dere som åpne hele tiden.'
      : diverted.parsed.status === 'not-relevant'
        ? 'Jeg merket åpningstider som ikke relevant.'
        : 'Åpningstidene er lagret.';
    return replyAfter(userId, profile, prefix);
  }
  if (diverted.kind === 'staff') {
    const staff = [...(current.staff || [])];
    for (const person of diverted.parsed.people) {
      staff.push({
        id: '',
        title: person.title,
        name: person.name,
        phone: person.phone,
        email: person.email,
        imageUrl: '',
      });
    }
    const profile = patchClientBank(userId, withIntakeFlag({ ...current, staff }, 'staff', 'more'));
    const count = diverted.parsed.people.length;
    return replyAfter(userId, profile, count === 1 ? 'Personen er med.' : `${count} personer er med.`);
  }
  if (diverted.kind === 'affiliations') {
    const affiliations = [...(current.affiliations || [])];
    for (const category of diverted.parsed.categories) {
      const hit = affiliations.find((row) => String(row.categoryName || '').toLowerCase() === category.categoryName.toLowerCase());
      if (hit) hit.items = [...(hit.items || []), ...category.items];
      else affiliations.push(category);
    }
    const profile = patchClientBank(userId, withIntakeFlag({ ...current, affiliations }, 'affiliations', 'more'));
    return replyAfter(userId, profile, 'Partnerne er med.');
  }
  return null;
}

async function tryLoose(userId, text) {
  const bank = bankOf(userId);
  const note = await interpretLooseNote(text, bank);
  if (!note) return null;
  const next = applyNoteToBank(bank, note);
  let flagged = next;
  if (note.hoursText && next.openingHours?.status) flagged = withIntakeFlag(flagged, 'hours', 'done');
  if (note.people.length) flagged = withIntakeFlag(flagged, 'staff', 'more');
  if (note.partners.length) flagged = withIntakeFlag(flagged, 'affiliations', 'more');
  if (note.chapter) {
    flagged = {
      ...flagged,
      assistantIntake: { ...(flagged.assistantIntake || {}), focus: note.chapter },
    };
  }
  const changed = note.hoursText || note.people.length || note.partners.length || Object.keys(note.fields).length;
  const profile = changed || note.chapter ? patchClientBank(userId, flagged) : null;
  if (note.productText) {
    const state = await getAssistantState(userId);
    const started = beginIngest(userId, { ...state, profile: profile || state.profile }, { text: note.productText });
    return {
      ...started,
      assistantMessage: [note.reply, started.assistantMessage].filter(Boolean).join('\n\n'),
      profile: profile || started.profile,
    };
  }
  if (!profile) return null;
  const revisit = Boolean(note.chapter && chapterHasContent(profile.clientDataBank || {}, note.chapter));
  return replyAfter(userId, profile, note.reply, { revisit });
}

async function orLoose(userId, text, fallback) {
  const loose = await tryLoose(userId, text);
  return loose || fallback;
}

export async function handleAssistantChat(userId, { text = '', messages = [], files = [], focusStep = '' } = {}) {
  const state = await getAssistantState(userId);
  const industry = state.industry || '';
  const layout = state.layout || '';
  const bank = state.profile?.clientDataBank || {};
  const step = nextIntakeStep(bank);
  const name = businessLabel(bank, state.profile);
  const trimmed = String(text || '').trim();
  const pricedLine = /\d+\s*(?:kr|,-|nok)\b/i.test(trimmed);
  const parts = partitionAssistantFiles(files);
  const asked = INTAKE_STEPS.includes(String(focusStep || '')) ? String(focusStep) : '';

  if (asked && !trimmed && !files.length) {
    return openChapter(userId, asked);
  }

  if (parts.documents.length) {
    return beginIngest(userId, state, { files, text: trimmed, layout });
  }

  const destination = !files.length ? navigationTarget(trimmed) : '';
  if (destination) return openChapter(userId, destination);

  const diverted = !files.length ? sideWrite(trimmed, step) : null;
  if (diverted) {
    const saved = commitSideWrite(userId, diverted);
    if (saved) return saved;
  }

  if (step === 'done') {
    const loose = trimmed ? await tryLoose(userId, trimmed) : null;
    if (loose) return loose;
    return chatEnvelope(state, {
      assistantMessage: trimmed
        ? 'Jeg la ikke inn det som en endring. Skriv det konkret, for eksempel åpningstider eller en ansatt, eller velg et steg.'
        : doneMessage(name),
      nextAction: 'done',
      redirectTo: '',
      currentStep: 'done',
    });
  }

  if (step !== 'products') {
    return handleIntakeAnswer(userId, state, { step, name, text: trimmed, files });
  }

  if (isNoMore(trimmed) && !files.length) {
    const hasProducts = summarizeCatalogs(bank.productCatalogs || []).productCount > 0;
    return replyAfter(userId, saveIntakeFlag(userId, 'products', hasProducts ? 'done' : 'skipped'));
  }

  if (awaitingMore(bank, 'products') && isAffirmativeOnly(trimmed) && !files.length) {
    return chatEnvelope(state, {
      assistantMessage: 'Send det neste dokumentet, eller si at det er alt.',
      nextAction: 'wait',
      currentStep: 'products',
    });
  }

  if (shouldIngestSources({ files, text }) || pricedLine) {
    return beginIngest(userId, state, { files, text: trimmed, layout });
  }

  if (/åpning|ansatt|adresse|logo|farge|historie|partner|åpent|døgn|tone|målgruppe/i.test(trimmed)) {
    const loose = await tryLoose(userId, trimmed);
    if (loose) return loose;
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

  if (turn.nextAction === 'ingest_text' && text) {
    return {
      ...beginIngest(userId, state, { files, text: trimmed, layout }),
      assistantMessage: turn.assistantMessage || startingIngestMessage({ files, text: trimmed }),
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
    if (isNoMore(text) && !parts.media.length) {
      const hasMedia = mediaFileCount(bankOf(userId)) > 0;
      return replyAfter(userId, saveIntakeFlag(userId, 'media', hasMedia ? 'done' : 'skipped'));
    }
    if (isAffirmativeOnly(text) && !parts.media.length) {
      return chatEnvelope(state, {
        assistantMessage: awaitingMore(bankOf(userId), 'media')
          ? 'Last opp de neste, eller si at det er nok.'
          : questionFor('media', name),
        nextAction: 'wait',
        currentStep: 'media',
      });
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
      const count = saved.urls.length;
      const profile = saveIntakeFlag(userId, 'media', count ? 'more' : 'skipped');
      const prefix = count
        ? (count === 1 ? 'Bildet eller videoen er med.' : `${count} filer er med.`)
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
    if (isNoMore(text) && !files.length) {
      const hasTeam = hasListedTeam(bankOf(userId));
      return replyAfter(userId, saveIntakeFlag(userId, 'staff', hasTeam ? 'done' : 'skipped'));
    }
    const parsed = parseStaffAnswer(text);
    if (parsed.action === 'skip') {
      return replyAfter(userId, saveIntakeFlag(userId, 'staff', hasListedTeam(bankOf(userId)) ? 'done' : 'skipped'));
    }
    if (parsed.action === 'details') {
      return chatEnvelope(state, {
        assistantMessage: questionFor('staffDetails', name),
        nextAction: 'wait',
        currentStep: 'staff',
      });
    }
    if (parsed.action !== 'save') {
      return orLoose(userId, text, chatEnvelope(state, {
        assistantMessage: 'Skriv én person per linje: navn, tittel, telefon, e-post. Eller si at det ikke er aktuelt.',
        nextAction: 'wait',
        currentStep: 'staff',
      }));
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
    const profile = patchClientBank(userId, withIntakeFlag({ ...current, staff }, 'staff', 'more'));
    const count = parsed.people.length;
    return replyAfter(userId, profile, count === 1 ? 'Personen er med.' : `${count} personer er med.`);
  }

  if (step === 'hours') {
    const parsed = parseOpeningHoursAnswer(text);
    if (parsed.action === 'unclear') {
      return orLoose(userId, text, chatEnvelope(state, {
        assistantMessage: 'Fyll ut feltene under, eller skriv fritt i chatten. Si åpningstidene fra mandag til søndag, at dere er åpne hele tiden, eller at det ikke er relevant.',
        nextAction: 'wait',
        currentStep: 'hours',
      }));
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
      ? 'Jeg satte dere som åpne hele tiden.'
      : parsed.status === 'not-relevant'
        ? 'Jeg merket åpningstider som ikke relevant.'
        : 'Åpningstidene er lagret.';
    return replyAfter(userId, profile, prefix);
  }

  if (step === 'affiliations') {
    if (isNoMore(text)) {
      const hasPartners = hasAffiliations(bankOf(userId));
      return replyAfter(userId, saveIntakeFlag(userId, 'affiliations', hasPartners ? 'done' : 'skipped'));
    }
    const parsed = parseAffiliationsAnswer(text);
    if (parsed.action === 'skip') {
      return replyAfter(userId, saveIntakeFlag(userId, 'affiliations', hasAffiliations(bankOf(userId)) ? 'done' : 'skipped'));
    }
    if (parsed.action === 'details') {
      return chatEnvelope(state, {
        assistantMessage: questionFor('affiliationDetails', name),
        nextAction: 'wait',
        currentStep: 'affiliations',
      });
    }
    if (parsed.action !== 'save') {
      return orLoose(userId, text, chatEnvelope(state, {
        assistantMessage: 'Skriv partnerne, gjerne med gruppenavn foran. For eksempel «Sponsorer: Navn, Navn».',
        nextAction: 'wait',
        currentStep: 'affiliations',
      }));
    }
    const current = bankOf(userId);
    const affiliations = [...(current.affiliations || [])];
    for (const category of parsed.categories) {
      const hit = affiliations.find((row) => String(row.categoryName || '').toLowerCase() === category.categoryName.toLowerCase());
      if (hit) hit.items = [...(hit.items || []), ...category.items];
      else affiliations.push(category);
    }
    const profile = patchClientBank(userId, withIntakeFlag({ ...current, affiliations }, 'affiliations', 'more'));
    return replyAfter(userId, profile, 'Partnerne er med.');
  }

  return replyAfter(userId, state.profile);
}

export async function importProductFiles(userId, { files = [], text = '' } = {}) {
  const ingested = await ingestProductSources({
    files,
    text,
    industry: (await getAssistantState(userId)).industry,
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
