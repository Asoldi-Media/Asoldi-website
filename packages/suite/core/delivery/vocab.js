// Shared delivery vocabulary: service ids, tier service matrix, job kinds, blocking and
// warning codes, delivery stages, gate line ids, email kinds, automation modes and settings keys.
//
// The hub and the Maker import this one file (the Maker through its vendored lib/suite copy),
// so the two sides can never drift. It is pure: no imports, no I/O.
//
// APPEND-ONLY. Never rename or remove an id; stored data, other repos and contracts refer to
// them. Add new ids at the end of a list and bump VOCAB_VERSION.
//
// Owner decisions applied here (2026-10-23):
// - Blog on every tier: `blog` is part of every tier, and `site` implies `blog` for custom plans.
//   Auto-written posts (WS6 feature `blog.autoPosts`; older name `blog.localPosts`) belong to the
//   `seo` service (tier 2+).
// - The backlink network is a service of its own (`backlinks`), on by default for tier 2+.
// - Cancellation stops hub services. There is no standalone mode: no id in this file
//   may describe one, and `thirdpartyhost` never means a CMS that runs without the hub.
// - No owner approval queues: automation modes are `shadow` (internal pre-release stage:
//   computed and recorded, never sent) and `auto` (runs, with runtime guards that pause a kind).
// - Soft budgets never block. Only a runaway (more than 5x expected) or a detected loop stops work.

export const VOCAB_VERSION = 2;

function freezeList(list) {
  return Object.freeze(list.map((item) => (item && typeof item === 'object' ? Object.freeze({ ...item }) : item)));
}

// ---------------------------------------------------------------- services

export const SERVICE_CATALOG = freezeList([
  { id: 'site', legacyFlags: ['users'], sellable: true },
  { id: 'changes', legacyFlags: [], sellable: true },
  { id: 'seo', legacyFlags: ['analytics'], sellable: true },
  { id: 'social', legacyFlags: ['socialSync'], sellable: true },
  { id: 'email', legacyFlags: ['emailMarketing'], sellable: true },
  { id: 'blog', legacyFlags: ['blog'], sellable: true },
  { id: 'ecom', legacyFlags: ['ecommerce', 'general'], sellable: true },
  { id: 'dashboard', legacyFlags: ['analytics'], sellable: true },
  { id: 'multilingual', legacyFlags: [], sellable: true },
  { id: 'unlimited', legacyFlags: [], sellable: true },
  { id: 'catalog', legacyFlags: ['ecommerce'], sellable: false },
  { id: 'booking', legacyFlags: [], sellable: false },
  { id: 'backlinks', legacyFlags: [], sellable: true },
]);

export const SERVICE_IDS = Object.freeze(SERVICE_CATALOG.map((service) => service.id));

export const SERVICE_ALIASES = Object.freeze({
  shop: 'ecom',
  ecommerce: 'ecom',
  nettbutikk: 'ecom',
  katalog: 'catalog',
  timebestilling: 'booking',
  epost: 'email',
  'e-post': 'email',
  blogg: 'blog',
  backlink: 'backlinks',
  linknetwork: 'backlinks',
  lenkenettverk: 'backlinks',
});

// A service listed on the left always brings the services on the right.
export const IMPLIED_SERVICES = Object.freeze({
  site: Object.freeze(['blog']),
});

// One-time add-ons. `thirdpartyhost` is SEO and change work for a site hosted elsewhere;
// it never turns on a standalone CMS mode.
export const ONE_TIME_ADDON_CATALOG = freezeList([
  { id: 'pos' },
  { id: 'thirdpartyhost' },
]);

export const ONE_TIME_ADDON_IDS = Object.freeze(ONE_TIME_ADDON_CATALOG.map((addon) => addon.id));

export const TIER_IDS = Object.freeze(['tier-1-standard', 'tier-2-seo', 'tier-3-ecommerce', 'custom']);

export const TIER_SERVICES = Object.freeze({
  'tier-1-standard': Object.freeze(['site', 'changes', 'blog']),
  'tier-2-seo': Object.freeze(['site', 'changes', 'blog', 'seo', 'social', 'email', 'backlinks']),
  'tier-3-ecommerce': Object.freeze([
    'site', 'changes', 'blog', 'seo', 'social', 'email', 'backlinks', 'ecom', 'dashboard', 'multilingual',
  ]),
  custom: Object.freeze([]),
});

export const CHANGES_PER_MONTH = 4;

// Feature keys (WS6 feature registry names) that each service must entitle. The WS6 bundles may
// entitle more, never less, with one exception: `blog.autoPosts` (automatic posts) belongs to the
// `seo` service only. The client-written blog is `blog` and `blog.posts` on every tier.
// Version 2: the WS6 registry (website-cms server/feature-tree.json) names automatic posts
// `blog.autoPosts`. Version 1 used the older name `blog.localPosts`, which stays a read alias, and
// mapped `blog.posts` onto `blog`; `blog.posts` is a registry key of its own now.
export const SERVICE_FEATURE_ANCHORS = Object.freeze({
  blog: Object.freeze(['blog']),
  seo: Object.freeze(['blog.autoPosts']),
  backlinks: Object.freeze(['seo.linkNetwork']),
});

// Feature keys only the listed services may entitle (no other service's bundle may carry them).
// Look keys up with exclusiveServicesFor(), which also reads the alias names.
export const SERVICE_EXCLUSIVE_FEATURES = Object.freeze({
  'blog.autoPosts': Object.freeze(['seo']),
});

// Older or alternative names that resolve to a WS6 registry key. They are read, never written; the
// registry's own `aliases` table has the same rows (the hub's cms-feature-tree test checks this).
export const FEATURE_KEY_ALIASES = Object.freeze({
  'blog.localPosts': 'blog.autoPosts',
  'seo.backlinkNetwork': 'seo.linkNetwork',
  'seo.meta': 'seo.contentHead',
});

/** A feature key with its alias names resolved to the WS6 registry key. */
export function canonicalFeatureKey(value) {
  const raw = String(value ?? '').trim();
  return FEATURE_KEY_ALIASES[raw] || raw;
}

/** The services that alone may entitle a feature key (alias names are read too); [] when any may. */
export function exclusiveServicesFor(featureKey) {
  const list = SERVICE_EXCLUSIVE_FEATURES[canonicalFeatureKey(featureKey)];
  return list ? [...list] : [];
}

export const LEGACY_FEATURE_FLAGS = Object.freeze([
  'users', 'analytics', 'ecommerce', 'blog', 'socialSync', 'emailMarketing', 'general',
]);

export function canonicalServiceId(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (SERVICE_IDS.includes(raw)) return raw;
  return SERVICE_ALIASES[raw] || '';
}

export function isServiceId(value) {
  return SERVICE_IDS.includes(String(value ?? ''));
}

/** Known service ids, aliases resolved, de-duplicated, in catalog order. Unknown ids are dropped. */
export function normalizeServices(list) {
  const input = Array.isArray(list) ? list : [];
  const wanted = new Set();
  for (const entry of input) {
    const id = canonicalServiceId(entry);
    if (id) wanted.add(id);
  }
  return SERVICE_IDS.filter((id) => wanted.has(id));
}

/** The entries of `list` that are neither a service id nor an alias. */
export function unknownServices(list) {
  const input = Array.isArray(list) ? list : [];
  return input.map((entry) => String(entry ?? '').trim()).filter((entry) => entry && !canonicalServiceId(entry));
}

/** normalizeServices plus every implied service (site brings blog). */
export function expandServices(list) {
  const base = normalizeServices(list);
  const wanted = new Set(base);
  for (const id of base) {
    for (const implied of IMPLIED_SERVICES[id] || []) wanted.add(implied);
  }
  return SERVICE_IDS.filter((id) => wanted.has(id));
}

export function servicesForTier(tierId) {
  const list = TIER_SERVICES[String(tierId ?? '')];
  return list ? [...list] : [];
}

export function normalizeOneTimeAddOns(list) {
  const input = Array.isArray(list) ? list : [];
  const wanted = new Set(input.map((entry) => String(entry ?? '').trim().toLowerCase()));
  return ONE_TIME_ADDON_IDS.filter((id) => wanted.has(id));
}

/** The 7 legacy CMS flags a set of services turns on. `users` is always on. */
export function legacyFlagsForServices(list) {
  const flags = Object.fromEntries(LEGACY_FEATURE_FLAGS.map((flag) => [flag, flag === 'users']));
  for (const id of expandServices(list)) {
    const service = SERVICE_CATALOG.find((entry) => entry.id === id);
    for (const flag of service?.legacyFlags || []) flags[flag] = true;
  }
  return flags;
}

// ---------------------------------------------------------------- jobs and codes

export const JOB_KINDS = Object.freeze([
  'preview',
  'continue',
  'iteration',
  'change_request',
  'dev_accept',
  'materials_sync',
  'publish',
  'seo.refresh',
  'seo.maintenance',
  'cms-fleet',
  'purge',
]);

export function isJobKind(kind) {
  return JOB_KINDS.includes(String(kind ?? ''));
}

/** Throws for a kind outside JOB_KINDS. enqueueJob and registerJobHandler call this first. */
export function assertJobKind(kind) {
  if (isJobKind(kind)) return String(kind);
  const error = new Error(`Unknown delivery job kind: ${JSON.stringify(kind)}. Allowed: ${JOB_KINDS.join(', ')}`);
  error.code = 'unknown-job-kind';
  throw error;
}

// A job stops with one blocking code. `step-failed` is parametric: `step-failed:<target>`.
export const BLOCKING_CODES = Object.freeze([
  'needs-language',
  'needs-pages',
  'needs-template',
  'needs-confirm',
  'needs-brief-identity',
  'needs-approval',
  'needs-payment-setup',
  'dns-not-switched',
  'run-not-on-host',
  'no-handler',
  'maker-offline',
  'step-failed',
  'dev-agent-failed',
  'budget-runaway',
  'loop-detected',
]);

export const PARAMETRIC_CODES = Object.freeze(['step-failed']);

// Warnings never block. A soft budget reaching 100 % is a warning: work continues.
export const WARNING_CODES = Object.freeze([
  'dev-skipped',
  'seo-deferred-no-domain',
  'cms-review-pending',
  'plan-changed-rerun',
  'budget-soft-limit',
]);

const CODE_PARAM_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** `step-failed:3` -> `step-failed`; plain codes are returned unchanged. */
export function codeBase(code) {
  const raw = String(code ?? '').trim();
  const index = raw.indexOf(':');
  return index === -1 ? raw : raw.slice(0, index);
}

function codeIn(list, code) {
  const raw = String(code ?? '').trim();
  const base = codeBase(raw);
  if (!list.includes(base)) return false;
  if (base === raw) return !PARAMETRIC_CODES.includes(base);
  return PARAMETRIC_CODES.includes(base) && CODE_PARAM_RE.test(raw.slice(base.length + 1));
}

export function isBlockingCode(code) {
  return codeIn(BLOCKING_CODES, code);
}

export function isWarningCode(code) {
  return codeIn(WARNING_CODES, code);
}

// ---------------------------------------------------------------- stages

// Delivery stages in lifecycle order. The stage is always derived (WS8.9 deriveStage).
export const STAGES = Object.freeze([
  'lead',
  'sales_meeting',
  'offer_sent',
  'signed',
  'gathering',
  'workshop_held',
  'gate',
  'developing',
  'dev_review',
  'client_preview',
  'iterating',
  'approved',
  'publishing',
  'live',
  'maintenance',
  'handed_over',
]);

// Overlays are shown on top of the underlying stage.
export const STAGE_OVERLAYS = Object.freeze(['paused', 'cancelled']);

export const STAGE_LABELS_NB = Object.freeze({
  lead: 'Lead',
  sales_meeting: 'Salgsmøte',
  offer_sent: 'Tilbud sendt',
  signed: 'Signert',
  gathering: 'Innsamling',
  workshop_held: 'Workshop holdt',
  gate: 'Klar for utvikling?',
  developing: 'Utvikles',
  dev_review: 'Utviklerkontroll',
  client_preview: 'Kundens forhåndsvisning',
  iterating: 'Iterasjon',
  approved: 'Godkjent av kunden',
  publishing: 'Publiseres',
  live: 'Live',
  maintenance: 'Vedlikehold',
  handed_over: 'Overlevert',
  paused: 'Pauset',
  cancelled: 'Avsluttet',
});

export function isStage(value) {
  return STAGES.includes(String(value ?? ''));
}

export function isStageOverlay(value) {
  return STAGE_OVERLAYS.includes(String(value ?? ''));
}

// After cancellation, these hub services stop at the end of the paid period plus the grace
// period. The published site keeps running until hosting stops; there is no standalone mode.
export const CANCELLATION_EFFECTS = Object.freeze([
  'cms-updates',
  'auto-posts',
  'backlink-network',
  'hub-email',
  'change-requests',
]);

export const CANCELLATION_GRACE_DAYS = 30;

// ---------------------------------------------------------------- gate lines

export const GATE_COLUMNS = Object.freeze(['dev', 'ready']);
export const GATE_LINE_LEVELS = Object.freeze(['required', 'optional']);
export const GATE_LINE_STATUSES = Object.freeze(['have', 'missing', 'waived', 'declined']);
export const GATE_LINE_ORIGINS = Object.freeze(['service', 'page-kind', 'info']);

// Lines a sold service asks for. `services` lists the service ids that bring the line.
export const GATE_SERVICE_LINES = freezeList([
  { id: 'workshop', services: ['site'] },
  { id: 'logo', services: ['site'] },
  { id: 'business-what', services: ['site'] },
  { id: 'contact', services: ['site'] },
  { id: 'hero-media', services: ['site'] },
  { id: 'opening-hours', services: ['site'] },
  { id: 'domain', services: ['site'] },
  { id: 'client-approval', services: ['site'] },
  { id: 'keywords', services: ['seo'] },
  { id: 'service-area', services: ['seo'] },
  { id: 'google-business', services: ['seo'] },
  { id: 'products', services: ['ecom'] },
  { id: 'seller', services: ['ecom'] },
  { id: 'shipping', services: ['ecom'] },
  { id: 'returns', services: ['ecom'] },
  { id: 'payment', services: ['ecom'] },
  { id: 'catalog-items', services: ['catalog'] },
  { id: 'booking-services', services: ['booking'] },
  { id: 'languages', services: ['multilingual'] },
]);

// Lines a page in the run's page plan asks for, on any tier. `pageKinds` are taxonomy v2 kinds.
export const GATE_PAGE_KIND_LINES = freezeList([
  { id: 'menu-items', pageKinds: ['menu'] },
  { id: 'project-images', pageKinds: ['portfolio', 'projects'] },
  { id: 'staff', pageKinds: ['team'] },
  { id: 'price-list', pageKinds: ['pricing'] },
  { id: 'booking-services', pageKinds: ['booking'] },
  { id: 'blog-topics', pageKinds: ['blog-index'] },
  { id: 'services-list', pageKinds: ['services', 'service-detail'] },
]);

// Developer-only lines. They never block and are never sent to the client.
export const GATE_INFO_LINES = Object.freeze(['step1Qa', 'needs-hard', 'dpa-missing', 'plan-changed-rerun']);

export const GATE_LINE_IDS = Object.freeze([
  ...new Set([
    ...GATE_SERVICE_LINES.map((line) => line.id),
    ...GATE_PAGE_KIND_LINES.map((line) => line.id),
  ]),
]);

export function isGateLineId(value) {
  return GATE_LINE_IDS.includes(String(value ?? ''));
}

// ---------------------------------------------------------------- emails and automation

// `sender`: `scheduling` mails ask the client for a time or for material and go out from the
// client's rep (replies reach a mailbox the inbox bot reads); `service` mails go out from the
// service sender. `legacy` kinds already sent automatically before this vocabulary existed.
export const EMAIL_KINDS = freezeList([
  { id: 'preWorkshop', sender: 'scheduling', legacy: true },
  { id: 'workshopReminders', sender: 'scheduling', legacy: true },
  { id: 'postWorkshop', sender: 'scheduling', legacy: false },
  { id: 'dataReminder', sender: 'scheduling', legacy: false },
  { id: 'previewReady', sender: 'scheduling', legacy: false },
  { id: 'stagingReady', sender: 'service', legacy: false },
  { id: 'siteLive', sender: 'service', legacy: false },
  { id: 'changeRequestAck', sender: 'service', legacy: false },
  { id: 'changeRequestDone', sender: 'service', legacy: false },
  { id: 'nurture', sender: 'scheduling', legacy: false },
  { id: 'dpaSigning', sender: 'service', legacy: false },
]);

export const EMAIL_KIND_IDS = Object.freeze(EMAIL_KINDS.map((kind) => kind.id));

export function isEmailKind(value) {
  return EMAIL_KIND_IDS.includes(String(value ?? ''));
}

// Stored modes. `shadow` computes and records what would happen and sends nothing; it is the
// internal pre-release stage. `auto` runs, guarded. There is no approval queue.
export const AUTOMATION_MODES = Object.freeze(['shadow', 'auto']);

// Effective state of a switch after enabled, runtime-guard pauses and env overrides.
export const EFFECTIVE_MODES = Object.freeze(['off', 'shadow', 'paused', 'auto']);

// Older plan text and callers may still say approve or manual; both mean shadow.
export const MODE_ALIASES = Object.freeze({ approve: 'shadow', manual: 'shadow' });

export function normalizeAutomationMode(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (AUTOMATION_MODES.includes(raw)) return raw;
  return MODE_ALIASES[raw] || '';
}

// Stable names for automation settings paths (dotted paths in automation-settings.json).
// Per-email-kind fields live at `emails.<kind>.<field>` (see emailSettingsPath).
export const SETTINGS_KEYS = Object.freeze({
  pilotClientIds: 'pilotClientIds',
  preWorkshopLines: 'emails.preWorkshop.lines',
  postWorkshopDelayMinutes: 'emails.postWorkshop.delayMinutes',
  dataReminderAfterDays: 'emails.dataReminder.afterDays',
  dataReminderMax: 'emails.dataReminder.max',
  nurtureCadenceDays: 'emails.nurture.cadenceDays',
  senderScheduling: 'sender.scheduling',
  senderServiceAccountKey: 'sender.service.accountKey',
  senderServiceReplyTo: 'sender.service.replyTo',
  inboxMailboxes: 'inbox.mailboxes',
  inboxAutoActions: 'inbox.autoActions',
  inboxAutoReply: 'inbox.autoReply',
  inboxPrefilter: 'inbox.prefilter',
  inboxInternalDomains: 'inbox.internalDomains',
  inboxInternalSenders: 'inbox.internalSenders',
  firefliesCandidateRanker: 'fireflies.candidateRanker.enabled',
  firefliesCandidateMinScore: 'fireflies.candidateRanker.candidateMinScore',
  firefliesAutoLink: 'fireflies.autoLink.enabled',
  firefliesRequireExactAttendeeEmail: 'fireflies.autoLink.requireExactAttendeeEmail',
  firefliesSlotWindowMinutes: 'fireflies.autoLink.slotWindowMinutes',
  autoQueue: 'development.autoQueue',
  directivesForAutoDev: 'development.directivesForAutoDev',
  defaultHostId: 'development.defaultHostId',
  requireConfirmForCustom: 'development.requireConfirmForCustom',
  previewJobs: 'development.previewJobs',
  seoJobs: 'development.seoJobs',
  publishStagingMode: 'publish.staging.mode',
  publishStagingTiers: 'publish.staging.tiers',
  publishProductionMode: 'publish.production.mode',
  changeRequestsEnforce: 'changeRequests.enforce',
  changeRequestsSlaWorkDays: 'changeRequests.slaWorkDays',
  changeRequestsCountAt: 'changeRequests.countAt',
  oneTimeMultiplier: 'pricing.oneTimeMultiplier',
  oneTimeMinExMva: 'pricing.oneTimeMinExMva',
  oneTimeMonths: 'pricing.oneTimeMonths',
  paymentGraceDays: 'lifecycle.paymentGraceDays',
  cancellationGraceDays: 'lifecycle.cancellationGraceDays',
  promotionAuto: 'promotion.auto',
  guardErrorRatePct: 'guards.errorRatePct',
  guardBounceRatePct: 'guards.bounceRatePct',
  guardComplaintsMax: 'guards.complaintsMax',
  guardVolumeSpikeFactor: 'guards.volumeSpikeFactor',
  guardWindowHours: 'guards.windowHours',
  guardMinSample: 'guards.minSample',
  retentionLeadMonths: 'retention.leadMonths',
  retentionAfterContractMonths: 'retention.afterContractMonths',
  retentionBriefOldVersionsDays: 'retention.briefOldVersionsDays',
  retentionChangeRequestsMonths: 'retention.changeRequestsMonths',
  retentionNurtureProofYears: 'retention.nurtureProofYears',
  retentionInboxSkipLogDays: 'retention.inboxSkipLogDays',
  storageBudgetFiles: 'storage.budgetFiles',
  storageBudgetMb: 'storage.budgetMb',
  alertsTo: 'alerts.to',
  alertsHostOfflineHours: 'alerts.hostOfflineHours',
  alertsJobBlockedHours: 'alerts.jobBlockedHours',
  alertsDigestAt: 'alerts.digestAt',
});

export const EMAIL_SETTINGS_FIELDS = Object.freeze(['enabled', 'mode', 'paused']);

export function emailSettingsPath(kind, field) {
  return `emails.${kind}.${field}`;
}

// Switches that may only run in `auto` once the pre-release suite (golden, safe-mode outbox
// snapshots, canary) has passed for them. Legacy kinds are exempt: they already ran.
export const RELEASE_GATED_SWITCHES = Object.freeze([
  ...EMAIL_KINDS.filter((kind) => !kind.legacy).map((kind) => `emails.${kind.id}`),
  'emails.preWorkshop.gate',
  'development.autoQueue',
  'publish.staging',
  'publish.production',
]);
