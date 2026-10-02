import React, { useEffect, useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, FileText, Loader2, Pencil } from 'lucide-react';
import {
  API,
  developmentAuthHeaders,
  type DevelopmentItem,
} from '../Admin/shared';
import { MakerRunTools } from './MakerRunTools';
import { DeveloperRequestThread } from './DeveloperRequestThread';
import { DeveloperAuthImage, DeveloperClientBrief, DeveloperMediaLibrary, type BriefMediaFile, type MaterialDot } from './DeveloperClientBrief';
import { enqueueMakerQueue, fetchMakerRunStatus, openLanguageLock, saveMakerRunDomain } from './makerQueue';
import { summarizeMaterialDots } from '../../../lib/client-material-dots.js';
import {
  DEVELOPER_PROGRESS_CHIPS,
  chipStepReady,
  developerCardTimeline,
  developerMediaLibraryView,
  developerSummaryView,
  makerCustomEditUrl,
  makerCustomPreviewPath,
  makerStepPreviewPath,
  normalizeDeveloperQa,
  pipelineStatusFromMakerRun,
  resolveDeveloperProgressClick,
} from '../../../lib/developer-card.js';
import { LOCAL_EDITOR_ORIGIN, editorMakerOrigin, makerUnreachableIsLocal } from '../../../lib/maker-editor-origin.js';
import {
  buildMakerRunUrl,
  normalizeMakerDashboardDraftUrl,
  resolveOpenInMakerUrl,
} from '../sales/websiteMaker';

const CARD_SELECTED = 'border-[#FF5B00] ring-2 ring-[#FF5B00]/25';

const DEVELOPMENT_STEPS: { key: keyof DevelopmentItem['development']; label: string }[] = [
  { key: 'hostingerEnvironmentSetup', label: 'Hostinger environment sat opp' },
  { key: 'githubRepoPushed', label: 'GitHub repo pushed' },
  { key: 'v1Ferdig', label: 'V1 ferdig' },
  { key: 'nettsideFerdig', label: 'Nettside ferdig' },
];

type MediaFile = {
  fileName: string;
  source?: string;
  url?: string;
  mime?: string;
  bytes?: number;
  field?: string;
  index?: number;
  bundleId?: string;
};

type QueueItemLike = {
  runId?: unknown;
  target?: unknown;
  status?: unknown;
};

type Props = {
  item: DevelopmentItem;
  kind: 'preview' | 'deployment';
  busyKey: string | null;
  selected: boolean;
  websiteMakerBaseUrl: string;
  queueItems?: QueueItemLike[];
  requestLabel?: string;
  onToggleSelected: () => void;
  onCardClick: (event: React.MouseEvent<HTMLElement>) => void;
  onToggleStep: (item: DevelopmentItem, key: keyof DevelopmentItem['development']) => void;
  onReload: () => Promise<void> | void;
  onClientUpdated?: (client: Record<string, unknown> | null | undefined) => void;
  onError: (message: string) => void;
  onNotice?: (message: string) => void;
};

function chipClass(kind: 'grey' | 'disabled' | 'ready' | 'idle') {
  if (kind === 'grey' || kind === 'disabled') {
    return 'px-2 py-1 rounded-md text-[11px] border bg-black/20 border-white/10 text-gray-500 cursor-not-allowed';
  }
  if (kind === 'ready') {
    return 'px-2 py-1 rounded-md text-[11px] border bg-green-900/40 border-green-600/40 text-green-300 hover:border-[#FF5B00]/40';
  }
  return 'px-2 py-1 rounded-md text-[11px] border bg-white/10 border-white/10 text-white hover:bg-white/15';
}

export function DeveloperClientCard({
  item,
  kind,
  busyKey,
  selected,
  websiteMakerBaseUrl,
  queueItems = [],
  requestLabel = '',
  onToggleSelected,
  onCardClick,
  onToggleStep,
  onReload,
  onClientUpdated,
  onError,
  onNotice,
}: Props) {
  const contact = [item.contactPerson, item.contactPhone, item.contactEmail].filter(Boolean).join(' · ');
  const salesClientId = String(item.salesClientId || '').trim();
  const makerRunId = String(item.makerRun?.runId || '').trim();
  const timeline = developerCardTimeline(item, kind);
  const summary = developerSummaryView(item.workshop);
  const [qa, setQa] = useState(() => normalizeDeveloperQa(item.developerQa));
  const [dots, setDots] = useState<MaterialDot[]>([]);
  const [domainCard, setDomainCard] = useState<{ hostname: string; statusLabel: string; present: boolean }>({
    hostname: '',
    statusLabel: '',
    present: false,
  });
  const [briefOpen, setBriefOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [mediaReload, setMediaReload] = useState(0);
  const [deletingMedia, setDeletingMedia] = useState('');
  const [media, setMedia] = useState<{ fromClient: MediaFile[]; fromMaker: MediaFile[]; makerError: string }>({
    fromClient: [],
    fromMaker: [],
    makerError: '',
  });
  const [enqueueBusy, setEnqueueBusy] = useState('');
  const [openingMaker, setOpeningMaker] = useState(false);
  const [liveStatus, setLiveStatus] = useState<Record<string, unknown> | null>(null);
  const [actionPage, setActionPage] = useState(1);
  const [chipMenu, setChipMenu] = useState('');
  const [domainDraft, setDomainDraft] = useState('');
  const [savingDomain, setSavingDomain] = useState(false);

  useEffect(() => {
    setQa(normalizeDeveloperQa(item.developerQa));
  }, [item.developerQa]);

  const persistedStatus = useMemo(
    () => pipelineStatusFromMakerRun(item.makerRun || {}),
    [item.makerRun]
  );
  const status = {
    step1Ready: Boolean(liveStatus?.step1Ready ?? persistedStatus.step1Ready),
    step15Ready: Boolean(liveStatus?.step15Ready ?? persistedStatus.step15Ready),
    languageLocked: Boolean(liveStatus?.languageLocked ?? persistedStatus.languageLocked),
    generateTextReady: Boolean(liveStatus?.generateTextReady ?? persistedStatus.generateTextReady),
    injectMediaReady: Boolean(liveStatus?.injectMediaReady ?? persistedStatus.injectMediaReady),
    layoutReady: Boolean(liveStatus?.layoutReady ?? persistedStatus.layoutReady),
    mapsReady: Boolean(liveStatus?.mapsReady ?? persistedStatus.mapsReady),
    seoReady: Boolean(liveStatus?.seoReady ?? persistedStatus.seoReady),
    hasDomain: Boolean(liveStatus?.hasDomain ?? persistedStatus.hasDomain),
  };

  useEffect(() => {
    if (!salesClientId) return;
    const url = new URL(
      `${API}/admin/development/${encodeURIComponent(item.id)}/workshop-needs`,
      window.location.origin
    );
    url.searchParams.set('websiteMakerBaseUrl', websiteMakerBaseUrl);
    void fetch(`${url.pathname}${url.search}`, { headers: developmentAuthHeaders() })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || 'Kunne ikke laste materialer.');
        setDots(Array.isArray(data.dots) ? data.dots : []);
        const card = data.domainCard && typeof data.domainCard === 'object' ? data.domainCard : {};
        setDomainCard({
          hostname: String(card.hostname || '').trim(),
          statusLabel: String(card.statusLabel || '').trim(),
          present: Boolean(card.present),
        });
      })
      .catch(() => {
        setDots([]);
      });
  }, [item.id, salesClientId, websiteMakerBaseUrl]);

  useEffect(() => {
    if (!salesClientId) return;
    const url = new URL(
      `${API}/admin/development/${encodeURIComponent(item.id)}/media`,
      window.location.origin
    );
    url.searchParams.set('websiteMakerBaseUrl', websiteMakerBaseUrl);
    void fetch(`${url.pathname}${url.search}`, { headers: developmentAuthHeaders() })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setMedia((prev) => developerMediaLibraryView({
            fromClient: Array.isArray(data.fromClient) ? data.fromClient : prev.fromClient,
            fromMaker: [],
            makerError: String(data.makerError || data.message || 'Kunne ikke lese mediabiblioteket.'),
          }));
          return;
        }
        setMedia(developerMediaLibraryView(data));
      })
      .catch((error) => {
        setMedia((prev) => developerMediaLibraryView({
          fromClient: prev.fromClient,
          fromMaker: [],
          makerError: error instanceof Error ? error.message : 'Kunne ikke lese mediabiblioteket.',
        }));
      });
  }, [item.id, salesClientId, websiteMakerBaseUrl, makerRunId, mediaReload]);

  useEffect(() => {
    if (!makerRunId || !websiteMakerBaseUrl) {
      setLiveStatus(null);
      return;
    }
    let cancelled = false;
    void fetchMakerRunStatus(websiteMakerBaseUrl, makerRunId, developmentAuthHeaders())
      .then((data) => {
        if (!cancelled) setLiveStatus(data as Record<string, unknown>);
      })
      .catch(() => {
        if (!cancelled) setLiveStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [makerRunId, websiteMakerBaseUrl, queueItems]);

  const editorBase = editorMakerOrigin(websiteMakerBaseUrl) || LOCAL_EDITOR_ORIGIN;
  const customEditUrl = makerCustomEditUrl(editorBase, makerRunId);
  const customPreviewPath = makerCustomPreviewPath(makerRunId, item.makerRun?.customSite || null);
  const customPreviewUrl = customPreviewPath
    ? `${editorBase}${customPreviewPath}`
    : '';
  const makerDashboardUrl = resolveOpenInMakerUrl({
    baseUrl: editorBase,
    runId: makerRunId,
    storedDashboardUrl: normalizeMakerDashboardDraftUrl(String(item.makerRun?.dashboardUrl || '').trim()),
    intakeStatus: String(item.makerRun?.intakeStatus || ''),
    latestReadyStep: String(item.makerRun?.latestReadyStep || ''),
  });
  const makerHostname = String(
    liveStatus?.websiteDomain
    || item.makerRun?.productionDomain
    || item.makerRun?.websiteDomain
    || ''
  ).trim();
  const domainView = domainCard.present
    ? domainCard
    : { hostname: makerHostname, statusLabel: '', present: Boolean(makerHostname) };

  useEffect(() => {
    setDomainDraft(domainView.hostname || makerHostname);
  }, [domainView.hostname, makerHostname]);

  const dotSummary = summarizeMaterialDots(dots);
  const workshopHeld = summary.ready || Boolean(item.workshopHeldAt);
  const shortDescription = (summary.ready ? summary.intro : item.notes || '').replace(/\s+/g, ' ').trim();
  const libraryFiles: BriefMediaFile[] = [
    ...media.fromClient.map((file) => ({ ...file, source: file.source || 'client' })),
    ...media.fromMaker.map((file) => ({ ...file, source: file.source || 'run' })),
  ];
  const imageFiles = libraryFiles.filter((file) => (
    String(file.mime || '').startsWith('image/')
    || /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file.fileName || '')
  ));
  const previewImages = imageFiles.slice(0, 6);
  const hiddenImages = Math.max(0, imageFiles.length - previewImages.length);
  const iterationMessages = [
    ...(item.iterationTranscript
      ? [{
          id: 'iteration-transcript',
          at: item.workshopHeldAt || item.rankAt || '',
          authorLabel: 'Transkript',
          text: item.iterationTranscript,
        }]
      : []),
    ...(item.iterationLog || []).map((entry) => ({
      id: `iteration-${entry.id}`,
      at: entry.at || '',
      authorLabel: entry.doneAt ? 'Iterasjon, ferdig' : 'Iterasjon',
      text: entry.text || '',
    })),
  ];

  function chipQueued(target: string) {
    return queueItems.some((entry) => (
      String(entry.runId || '') === makerRunId
      && String(entry.target || '') === target
      && (entry.status === 'queued' || entry.status === 'running')
    ));
  }

  async function patchQa(key: 'textOk' | 'mediaOk' | 'responsiveOk', value: boolean) {
    const next = { ...qa, [key]: value };
    setQa(next);
    try {
      const response = await fetch(`${API}/admin/development/${encodeURIComponent(item.id)}/developer-qa`, {
        method: 'PATCH',
        headers: { ...developmentAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Kunne ikke lagre sjekklisten.');
      if (data.client && onClientUpdated) onClientUpdated(data.client as Record<string, unknown>);
    } catch (error) {
      setQa(normalizeDeveloperQa(item.developerQa));
      onError(error instanceof Error ? error.message : 'Kunne ikke lagre sjekklisten.');
    }
  }

  async function openInMaker() {
    if (!makerRunId) {
      onError('No Website Maker run is linked to this client yet.');
      return;
    }
    const fallbackUrl = makerDashboardUrl || buildMakerRunUrl(editorBase, makerRunId, 'dashboard');
    if (!fallbackUrl) {
      onError('Could not resolve Website Maker URL for this client.');
      return;
    }
    window.open(fallbackUrl, '_blank');
    setOpeningMaker(true);
    try {
      const data = await fetch(`${API}/admin/sales/${encodeURIComponent(salesClientId)}/refresh-maker-handoff`, {
        method: 'POST',
        headers: { ...developmentAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteMakerBaseUrl: editorBase, runId: makerRunId }),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || 'Opened Maker, but the stored link could not be refreshed.');
        return payload;
      });
      if (data?.client && onClientUpdated) onClientUpdated(data.client as Record<string, unknown>);
      else await onReload();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Opened Maker, but the stored link could not be refreshed.';
      if (!makerUnreachableIsLocal(message)) onError(message);
    } finally {
      setOpeningMaker(false);
    }
  }

  async function enqueueTarget(chip: (typeof DEVELOPER_PROGRESS_CHIPS)[number], mode: 'until' | 'rerun') {
    if (!makerRunId) {
      onError('No Website Maker run is linked to this client yet.');
      return;
    }
    setEnqueueBusy(chip.id);
    setChipMenu('');
    onError('');
    try {
      const data = await enqueueMakerQueue({
        websiteMakerBaseUrl,
        salesClientIds: [salesClientId],
        runIds: [makerRunId],
        ...(mode === 'until' ? { untilTarget: chip.target } : { target: chip.target }),
      }) as { skipped?: { error?: string }[]; added?: unknown[] };
      const skipped = (Array.isArray(data.skipped) ? data.skipped : [])
        .map((entry) => String(entry.error || '').trim())
        .filter(Boolean);
      if (Array.isArray(data.added) && data.added.length) {
        onNotice?.(`Køet ${chip.label}.`);
      }
      if (skipped.length) onError(skipped[0]);
      if (!skipped.length && !(Array.isArray(data.added) && data.added.length)) {
        onNotice?.(`${chip.label} er allerede klar.`);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke legge i kø.');
    } finally {
      setEnqueueBusy('');
    }
  }

  async function onProgressClick(chipId: string) {
    const chip = DEVELOPER_PROGRESS_CHIPS.find((row) => row.id === chipId);
    if (!chip) return;
    const resolved = resolveDeveloperProgressClick(chip, status);
    if (!resolved.enqueue && resolved.type !== 'language' && resolved.type !== 'ready') {
      if (resolved.reason) onError(resolved.reason);
      return;
    }
    if (!makerRunId) {
      onError('No Website Maker run is linked to this client yet.');
      return;
    }
    if (resolved.type === 'language') {
      openLanguageLock({
        runId: makerRunId,
        websiteMakerBaseUrl,
        businessName: item.businessName,
      });
      return;
    }
    if (resolved.type === 'ready') {
      setChipMenu((current) => (current === chip.id ? '' : chip.id));
      return;
    }
    await enqueueTarget(chip, 'until');
  }

  function openStepPreview(target: string) {
    const path = makerStepPreviewPath(makerRunId, target);
    if (!path) return;
    window.open(`${editorBase}${path}`, '_blank');
    setChipMenu('');
  }

  async function saveDomain() {
    if (!makerRunId) {
      onError('No Website Maker run is linked to this client yet.');
      return;
    }
    setSavingDomain(true);
    onError('');
    try {
      const data = await saveMakerRunDomain({
        runId: makerRunId,
        websiteDomain: domainDraft,
        salesClientId,
        authHeaders: developmentAuthHeaders(),
      });
      if (data?.client && onClientUpdated) onClientUpdated(data.client as Record<string, unknown>);
      setLiveStatus((prev) => ({ ...(prev || {}), hasDomain: Boolean(data.hasDomain), websiteDomain: data.websiteDomain }));
      onNotice?.(data.hasDomain ? 'Domene lagret på Maker-runet.' : 'Domene fjernet fra Maker-runet.');
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke lagre domenet.');
    } finally {
      setSavingDomain(false);
    }
  }

  async function deleteMedia(file: BriefMediaFile) {
    if (!window.confirm(`Slette ${file.fileName || 'filen'}?`)) return;
    const key = `${file.source}-${file.field || ''}-${file.index ?? ''}-${file.fileName}`;
    setDeletingMedia(key);
    onError('');
    try {
      const makerFile = file.source === 'run' || file.source === 'bundle';
      const response = makerFile
        ? await fetch(`${API}/admin/development/${encodeURIComponent(item.id)}/media/maker`, {
            method: 'DELETE',
            headers: { ...developmentAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
              source: file.source,
              field: file.field,
              index: file.index,
              bundleId: file.bundleId,
              websiteMakerBaseUrl,
            }),
          })
        : await fetch(String(file.url || ''), { method: 'DELETE', headers: developmentAuthHeaders() });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Kunne ikke slette filen.');
      setMediaReload((value) => value + 1);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke slette filen.');
    } finally {
      setDeletingMedia('');
    }
  }

  function chipVisual(chip: (typeof DEVELOPER_PROGRESS_CHIPS)[number], resolved: ReturnType<typeof resolveDeveloperProgressClick>) {
    if (chip.kind === 'grey' || resolved.type === 'disabled' || resolved.type === 'noop') return 'grey';
    if (chipStepReady(chip, status)) return 'ready';
    return 'idle';
  }

  function renderProgressChips() {
    return (
      <div className="flex flex-wrap gap-1.5">
        {DEVELOPER_PROGRESS_CHIPS.map((chip) => {
          const resolved = resolveDeveloperProgressClick(chip, status);
          const visual = chipVisual(chip, resolved);
          const queued = Boolean(chip.target && chipQueued(chip.target));
          const clickable = resolved.type === 'enqueue' || resolved.type === 'enqueue-until' || resolved.type === 'language' || resolved.type === 'ready';
          return (
            <div key={chip.id} className="relative">
              <button
                type="button"
                disabled={!clickable || enqueueBusy === chip.id}
                title={resolved.reason || chip.label}
                onClick={() => void onProgressClick(chip.id)}
                className={chipClass(clickable ? visual : 'grey')}
              >
                {enqueueBusy === chip.id || queued ? <Loader2 size={11} className="inline mr-1 animate-spin" /> : null}
                {chip.label}
              </button>
              {chipMenu === chip.id && resolved.type === 'ready' ? (
                <div className="absolute z-20 mt-1 min-w-[120px] rounded-lg border border-white/10 bg-[#1a1a1a] p-1 shadow-lg">
                  <button
                    type="button"
                    onClick={() => openStepPreview(chip.target)}
                    className="block w-full text-left px-2 py-1 rounded text-[11px] text-white hover:bg-white/10"
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    onClick={() => void enqueueTarget(chip, 'rerun')}
                    className="block w-full text-left px-2 py-1 rounded text-[11px] text-white hover:bg-white/10"
                  >
                    Run
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div
      onClick={onCardClick}
      className={`rounded-2xl bg-[#2a2a2a] border p-4 flex flex-col gap-3 cursor-pointer ${
        selected ? `hover:bg-[#323232] ${CARD_SELECTED}` : 'border-white/10 hover:bg-[#323232]'
      }`}
    >
      <div className="flex flex-col xl:flex-row gap-4">
        <div className="min-w-0 flex-1 space-y-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            onClick={(event) => event.stopPropagation()}
            aria-label={`Select ${item.businessName || 'client'}`}
            className="h-4 w-4 shrink-0 accent-[#FF5B00] cursor-pointer"
          />
          <h3 className="text-white font-semibold truncate">{item.businessName}</h3>
          {requestLabel ? (
            <span className="shrink-0 px-2 py-0.5 rounded text-[11px] border bg-amber-900/30 border-amber-700/30 text-amber-300">
              {requestLabel}
            </span>
          ) : null}
        </div>
        {contact && <p className="mt-1 text-xs text-gray-400 truncate">{contact}</p>}
        {shortDescription ? (
          <p className="mt-1 text-xs text-gray-400 line-clamp-2">{shortDescription}</p>
        ) : null}
        {timeline.label ? (
          <p className={`mt-1 text-xs flex items-center gap-1.5 ${
            timeline.tone === 'overdue' ? 'text-red-300' : timeline.tone === 'live' ? 'text-sky-300' : 'text-gray-400'
          }`}
          >
            <CalendarClock size={12} />
            {timeline.label}
          </p>
        ) : null}
        {salesClientId ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setBriefOpen(true);
            }}
            className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
          >
            <FileText size={13} />
            Prosjektdokument
          </button>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] border ${
              domainView.present
                ? 'bg-green-900/40 border-green-600/40 text-green-300'
                : 'bg-black/20 border-white/10 text-gray-400'
            }`}
          >
            {domainView.present ? domainView.hostname : 'Ingen domene'}
            {domainView.present && domainView.statusLabel ? ` · ${domainView.statusLabel}` : ''}
          </span>
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] border ${
              workshopHeld
                ? 'bg-green-900/40 border-green-600/40 text-green-300'
                : 'bg-red-900/30 border-red-700/40 text-red-300'
            }`}
          >
            {workshopHeld ? 'Workshop holdt' : 'Workshop ikke holdt'}
          </span>
          {item.industry ? (
            <span className="text-[11px] text-gray-500">{item.industry}</span>
          ) : null}
        </div>
      </div>
      </div>

      {kind === 'deployment' && (
        <div className="flex flex-wrap gap-1.5">
          {DEVELOPMENT_STEPS.map((step) => {
            const done = Boolean(item.development?.[step.key]);
            return (
              <button
                key={step.key}
                type="button"
                disabled={busyKey === `${item.id}:${step.key}`}
                onClick={() => onToggleStep(item, step.key)}
                className={`px-2 py-1 rounded-md text-[11px] border transition-colors hover:border-[#FF5B00]/40 disabled:opacity-60 ${
                  done
                    ? 'bg-green-900/40 border-green-600/40 text-green-300'
                    : 'bg-black/20 border-white/10 text-gray-400'
                }`}
              >
                {done ? <CheckCircle2 size={11} className="inline mr-1" /> : null}
                {step.label}
              </button>
            );
          })}
        </div>
      )}

      {salesClientId ? (
        <>
          <div
            className="rounded-xl bg-black/20 border border-white/10 p-4 min-h-[112px] space-y-3"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] uppercase tracking-wide text-gray-500">
                {actionPage === 1 ? 'Template og klientdata' : 'Make website'}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={actionPage === 1}
                  onClick={() => setActionPage(1)}
                  className="p-1 rounded text-gray-400 hover:text-white disabled:opacity-30"
                  aria-label="Forrige side"
                >
                  <ChevronLeft size={14} />
                </button>
                <span className="text-[11px] text-gray-400 tabular-nums">{actionPage} / 2</span>
                <button
                  type="button"
                  disabled={actionPage === 2}
                  onClick={() => setActionPage(2)}
                  className="p-1 rounded text-gray-400 hover:text-white disabled:opacity-30"
                  aria-label="Neste side"
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
            {actionPage === 1 ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="w-full text-[11px] text-gray-400">Importer nytt eller velg eksisterende template</p>
                <MakerRunTools
                  salesClientId={salesClientId}
                  client={{ id: salesClientId, makerRun: item.makerRun, websiteImport: item.websiteImport }}
                  websiteMakerBaseUrl={websiteMakerBaseUrl}
                  authHeaders={developmentAuthHeaders()}
                  onReload={onReload}
                  onClientUpdated={onClientUpdated}
                  onError={onError}
                  onNotice={onNotice}
                  allowCreate
                  allowLink={false}
                  variant="create"
                />
                <button
                  type="button"
                  onClick={() => void openInMaker()}
                  disabled={!makerRunId || openingMaker}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs disabled:opacity-50 ${
                    makerRunId
                      ? 'bg-[#FF5B00] text-white hover:bg-[#e55200]'
                      : 'bg-white/10 text-white hover:bg-white/15'
                  }`}
                >
                  {openingMaker ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />}
                  Open in maker
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {renderProgressChips()}
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    value={domainDraft}
                    onChange={(event) => setDomainDraft(event.target.value)}
                    placeholder="nettsted.no"
                    className="flex-1 px-3 py-2 rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => void saveDomain()}
                    disabled={!makerRunId || savingDomain}
                    className="px-3 py-2 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
                  >
                    {savingDomain ? <Loader2 size={13} className="inline animate-spin" /> : null}
                    Lagre domene
                  </button>
                </div>
                <p className="text-[11px] text-gray-500">Steg 4 SEO er av til et domene er lagret på runet.</p>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-3" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              onClick={() => setBriefOpen(true)}
              className="text-left"
            >
              <span className="block text-[11px] uppercase tracking-wide text-gray-500">Datapunkter</span>
              <span className="text-sm text-white tabular-nums">
                {dotSummary.total ? (
                  <>
                    <span className="text-green-300">{dotSummary.filled}</span>
                    /{dotSummary.total}
                  </>
                ) : '–'}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setBriefOpen(true)}
              className="text-left"
            >
              <span className="block text-[11px] uppercase tracking-wide text-gray-500">Mediefiler</span>
              <span className="text-sm text-white tabular-nums">{libraryFiles.length}</span>
            </button>
            <div className="flex items-center gap-1.5">
              {previewImages.map((file) => (
                <button
                  key={`${file.source}-${file.field || ''}-${file.fileName}`}
                  type="button"
                  onClick={() => setBriefOpen(true)}
                  className="h-12 w-12 rounded-md overflow-hidden border border-white/10"
                >
                  <DeveloperAuthImage
                    url={file.url}
                    authHeaders={developmentAuthHeaders()}
                    alt={file.fileName}
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
              {hiddenImages > 0 ? (
                <button
                  type="button"
                  onClick={() => setLibraryOpen(true)}
                  className="text-xs text-gray-300 underline-offset-2 hover:underline"
                >
                  vis {hiddenImages} mer
                </button>
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <p className="text-xs text-gray-500">No sales client linked — maker tools need a sales client.</p>
      )}
        </div>
        {salesClientId ? (
          <aside className="w-full xl:w-[340px] shrink-0" onClick={(event) => event.stopPropagation()}>
            <DeveloperRequestThread
              salesClientId={salesClientId}
              makerRunId={makerRunId}
              websiteMakerBaseUrl={websiteMakerBaseUrl}
              authHeaders={developmentAuthHeaders()}
              extraMessages={iterationMessages}
            />
          </aside>
        ) : null}
      </div>
      {salesClientId ? (
        <details className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-gray-200" onClick={(event) => event.stopPropagation()}>
          <summary className="cursor-pointer text-white font-medium">Tools & details</summary>
          <div className="mt-3">
            <MakerRunTools
              salesClientId={salesClientId}
              client={{ id: salesClientId, makerRun: item.makerRun, websiteImport: item.websiteImport }}
              websiteMakerBaseUrl={websiteMakerBaseUrl}
              authHeaders={developmentAuthHeaders()}
              onReload={onReload}
              onClientUpdated={onClientUpdated}
              onError={onError}
              onNotice={onNotice}
              allowCreate={Boolean(makerRunId)}
              allowLink
              variant="tools"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!makerRunId || !customEditUrl}
                onClick={() => customEditUrl && window.open(customEditUrl, '_blank')}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
              >
                <Pencil size={13} />
                Custom edit
              </button>
              {customPreviewUrl ? (
                <button
                  type="button"
                  onClick={() => window.open(customPreviewUrl, '_blank')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
                >
                  <ExternalLink size={13} />
                  Custom site
                </button>
              ) : null}
            </div>
          </div>
        </details>
      ) : null}
      <DeveloperClientBrief
        open={briefOpen}
        onClose={() => setBriefOpen(false)}
        summary={summary}
        qa={qa}
        onToggleQa={(key, value) => void patchQa(key, value)}
        files={libraryFiles}
        authHeaders={developmentAuthHeaders()}
        dots={dots}
        onOpenLibrary={() => setLibraryOpen(true)}
      />
      <DeveloperMediaLibrary
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        files={libraryFiles}
        authHeaders={developmentAuthHeaders()}
        deletingKey={deletingMedia}
        onDelete={(file) => void deleteMedia(file)}
      />
    </div>
  );
}
