import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, CheckCircle2, ExternalLink, FileText, Loader2, Pencil } from 'lucide-react';
import {
  API,
  developmentAuthHeaders,
  type DeveloperOwnerOption,
  type DevelopmentItem,
} from '../Admin/shared';
import { MakerRunTools } from './MakerRunTools';
import { DeveloperGoalTimeline } from './DeveloperGoalTimeline';
import { DeveloperRequestThread } from './DeveloperRequestThread';
import { DeveloperAuthImage, DeveloperClientBrief, DeveloperMediaLibrary, type BriefMediaFile, type MaterialDot } from './DeveloperClientBrief';
import { enqueueMakerQueue, ensureLocalMaker, fetchMakerRunStatus, findMakerRunBySalesClientId, openLanguageLock, saveMakerRunDomain } from './makerQueue';
import { createSalesMakerRun } from './MakerRunTools';
import { summarizeMaterialDots } from '../../../lib/client-material-dots.js';
import {
  DEVELOPER_PROGRESS_CHIPS,
  developerCardTimeline,
  developerMediaLibraryView,
  developerSummaryView,
  makerCustomEditUrl,
  makerCustomPreviewPath,
  developerChipVisual,
  chipLiveProgress,
  draftPhaseView,
  makerHandoffFromLiveRun,
  makerHandoffNeedsPersist,
  makerHandoffSignature,
  makerLatestPreviewPath,
  makerStepPreviewPath,
  mergeDeveloperPipelineStatus,
  normalizeDeveloperQa,
  pipelineStatusFromMakerRun,
  resolveDeveloperProgressClick,
  resolveLatestMakerPreviewStep,
  scoreMakerRunProgress,
} from '../../../lib/developer-card.js';
import { LOCAL_EDITOR_ORIGIN, editorMakerOrigin, makerUnreachableIsLocal } from '../../../lib/maker-editor-origin.js';
import {
  buildMakerRunUrl,
  normalizeMakerDashboardDraftUrl,
  resolveOpenInMakerUrl,
} from '../sales/websiteMaker';
import { DEVELOPER_PREVIEW_GOAL_KEYS, DEVELOPER_WIN_GOAL_KEYS } from '../../../lib/developer-goals.js';
import { developerOwnerDisplayName, sameDeveloperOwner } from '../../../lib/developer-assignment.js';

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
  kind: 'preview' | 'deployment' | 'developer';
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
  canWork?: boolean;
  isAdmin?: boolean;
  viewerAccountKey?: string;
  developers?: DeveloperOwnerOption[];
  assignBusy?: boolean;
  onAssign?: (developerOwnerId: string) => void;
  onAcceptHandoff?: () => void;
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
  canWork = false,
  isAdmin = false,
  viewerAccountKey = '',
  developers = [],
  assignBusy = false,
  onAssign,
  onAcceptHandoff,
}: Props) {
  const isDevelopmentList = kind === 'deployment';
  const goalKeys = isDevelopmentList ? DEVELOPER_WIN_GOAL_KEYS : DEVELOPER_PREVIEW_GOAL_KEYS;
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
  const liveRunId = String(liveStatus?.runId || makerRunId).trim();
  const [chipMenu, setChipMenu] = useState('');
  const [domainDraft, setDomainDraft] = useState('');
  const [savingDomain, setSavingDomain] = useState(false);
  const [goalBusy, setGoalBusy] = useState('');
  const [assignOwnerId, setAssignOwnerId] = useState('');
  const [bundleBusy, setBundleBusy] = useState('');
  const lastSyncedHandoffRef = useRef('');
  const makerRunRef = useRef(item.makerRun);
  const onClientUpdatedRef = useRef(onClientUpdated);
  makerRunRef.current = item.makerRun;
  onClientUpdatedRef.current = onClientUpdated;

  useEffect(() => {
    setQa(normalizeDeveloperQa(item.developerQa));
  }, [item.developerQa]);

  useEffect(() => {
    lastSyncedHandoffRef.current = '';
  }, [item.id, makerRunId]);

  const persistedStatus = useMemo(
    () => pipelineStatusFromMakerRun(item.makerRun || {}),
    [item.makerRun]
  );
  const status = mergeDeveloperPipelineStatus(persistedStatus, liveStatus);
  const draft = draftPhaseView({
    makerRun: item.makerRun || {},
    liveRun: (liveStatus?.run && typeof liveStatus.run === 'object' ? liveStatus.run : null) as Record<string, unknown> | null,
  });
  const chipStatus = { ...status, draftInjected: draft.injected };
  const languageCode = String(
    (liveStatus?.finalizedLanguage && typeof liveStatus.finalizedLanguage === 'object'
      ? (liveStatus.finalizedLanguage as { code?: string }).code
      : '')
    || item.makerRun?.language?.code
    || ''
  ).trim();
  const ownQueueSignature = useMemo(() => (
    queueItems
      .filter((row) => String(row.runId || '').trim() === makerRunId)
      .map((row) => `${String(row.target || '')}:${String(row.status || '')}`)
      .join('|')
  ), [queueItems, makerRunId]);

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
    let cancelled = false;
    async function persistLiveRun(runId: string, data: Record<string, unknown>) {
      setLiveStatus(data);
      const handoff = makerHandoffFromLiveRun(data.run || {});
      const signature = makerHandoffSignature(runId, handoff);
      if (lastSyncedHandoffRef.current === signature) return;
      if (!makerHandoffNeedsPersist(makerRunRef.current || {}, runId, handoff)) {
        lastSyncedHandoffRef.current = signature;
        return;
      }
      try {
        const response = await fetch(`${API}/admin/development/${encodeURIComponent(item.id)}/sync-maker-run`, {
          method: 'POST',
          headers: { ...developmentAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId, handoff }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) return;
        lastSyncedHandoffRef.current = signature;
        if (!cancelled && body.client && onClientUpdatedRef.current) {
          onClientUpdatedRef.current(body.client);
        }
      } catch {
        // Chips already show the live Maker run; sales persist retries on the next sync.
      }
    }
    async function syncMakerRun() {
      const found = salesClientId
        ? await findMakerRunBySalesClientId(salesClientId, item.businessName).catch(() => null)
        : null;
      const foundId = String(found?.runId || '').trim();
      const foundScore = Number(found?.progressScore) || 0;
      const linkedScore = scoreMakerRunProgress(makerRunRef.current || {});
      let runId = makerRunId;
      if (foundId) {
        if (!runId) runId = foundId;
        else if (foundId !== runId && foundScore > linkedScore) runId = foundId;
      }
      if (!runId || !websiteMakerBaseUrl) {
        if (!cancelled) setLiveStatus(null);
        return;
      }
      try {
        const data = await fetchMakerRunStatus(websiteMakerBaseUrl, runId, developmentAuthHeaders());
        if (cancelled) return;
        await persistLiveRun(runId, data as Record<string, unknown>);
      } catch {
        if (foundId && foundId !== runId) {
          try {
            const data = await fetchMakerRunStatus(websiteMakerBaseUrl, foundId, developmentAuthHeaders());
            if (cancelled) return;
            await persistLiveRun(foundId, data as Record<string, unknown>);
          } catch {
            // Keep the last live chips, or the stored sales copy if this was the first fetch.
          }
        }
      }
    }
    void syncMakerRun();
    function onVisible() {
      if (document.visibilityState === 'visible') void syncMakerRun();
    }
    function onLanguage() {
      void syncMakerRun();
    }
    const queueBusy = ownQueueSignature.includes(':running') || ownQueueSignature.includes(':queued');
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void syncMakerRun();
    }, queueBusy ? 2000 : 8000);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('asoldi-maker-language', onLanguage);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('asoldi-maker-language', onLanguage);
    };
  }, [makerRunId, salesClientId, websiteMakerBaseUrl, item.id, item.businessName, ownQueueSignature]);

  const editorBase = editorMakerOrigin(websiteMakerBaseUrl) || LOCAL_EDITOR_ORIGIN;
  const customEditUrl = makerCustomEditUrl(editorBase, liveRunId);
  const customPreviewPath = makerCustomPreviewPath(liveRunId, item.makerRun?.customSite || null);
  const customPreviewUrl = customPreviewPath
    ? `${editorBase}${customPreviewPath}`
    : '';
  const latestPreviewStep = resolveLatestMakerPreviewStep(status);
  const makerPreviewHref = liveRunId && latestPreviewStep
    ? `${editorBase}${makerLatestPreviewPath(liveRunId, latestPreviewStep)}`
    : '';
  const makerDashboardUrl = resolveOpenInMakerUrl({
    baseUrl: editorBase,
    runId: liveRunId,
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

  function chipQueueState(target: string) {
    const rows = queueItems.filter((entry) => (
      String(entry.runId || '') === liveRunId && String(entry.target || '') === target
    ));
    if (rows.some((entry) => entry.status === 'running')) return 'running';
    if (rows.some((entry) => entry.status === 'queued')) return 'queued';
    return '';
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
    if (!liveRunId) {
      onError('No Website Maker run is linked to this client yet.');
      return;
    }
    const fallbackUrl = makerDashboardUrl || buildMakerRunUrl(editorBase, liveRunId, 'dashboard');
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
        body: JSON.stringify({ websiteMakerBaseUrl: editorBase, runId: liveRunId }),
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

  async function openDraftPhase() {
    setEnqueueBusy('draft');
    setChipMenu('');
    onError('');
    try {
      try {
        await ensureLocalMaker();
      } catch {
        // asoldi.com often cannot ping 127.0.0.1; create-run still opens Maker.
      }
      let runId = liveRunId;
      if (!runId) {
        const created = await createSalesMakerRun({
          salesClientId,
          businessName: item.businessName,
          websiteMakerBaseUrl: editorBase,
          authHeaders: developmentAuthHeaders(),
        });
        runId = created.runId;
        if (created.client && onClientUpdated) onClientUpdated(created.client);
        else await onReload();
      }
      if (!runId) {
        onError('Website Creator åpnet ikke et kjøringsutkast.');
        return;
      }
      const url = buildMakerRunUrl(editorBase, runId, draft.injected ? 'dashboard' : 'intake');
      if (!url) {
        onError('Kunne ikke åpne Website Creator.');
        return;
      }
      window.open(url, '_blank');
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke åpne Website Creator.');
    } finally {
      setEnqueueBusy('');
    }
  }

  async function enqueueTarget(chip: (typeof DEVELOPER_PROGRESS_CHIPS)[number], mode: 'until' | 'rerun') {
    if (!chipStatus.draftInjected) {
      onError('Fullfør draftfasen først. Velg mal og kundedata, og injiser i klientkjøringen.');
      return;
    }
    setEnqueueBusy(chip.id);
    setChipMenu('');
    onError('');
    try {
      await ensureLocalMaker();
      if (!liveRunId) {
        onError('No Website Maker run is linked to this client yet.');
        return;
      }
      const data = await enqueueMakerQueue({
        websiteMakerBaseUrl,
        salesClientIds: [salesClientId],
        runIds: [liveRunId],
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
    const resolved = resolveDeveloperProgressClick(chip, chipStatus);
    if (resolved.type === 'draft') {
      await openDraftPhase();
      return;
    }
    if (!resolved.enqueue && resolved.type !== 'language' && resolved.type !== 'ready') {
      if (resolved.reason) onError(resolved.reason);
      return;
    }
    if (!liveRunId) {
      onError('No Website Maker run is linked to this client yet.');
      return;
    }
    if (resolved.type === 'language') {
      try {
        await ensureLocalMaker();
      } catch (error) {
        onError(error instanceof Error ? error.message : 'Kunne ikke starte Website Creator.');
        return;
      }
      openLanguageLock({
        runId: liveRunId,
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

  async function openStepPreview(target: string) {
    const path = makerStepPreviewPath(liveRunId, target);
    if (!path) return;
    setChipMenu('');
    try {
      await ensureLocalMaker();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke starte Website Creator.');
      return;
    }
    window.open(`${editorBase}${path}`, '_blank');
  }

  async function toggleGoal(key: string) {
    setGoalBusy(key);
    onError('');
    try {
      const response = await fetch(`${API}/admin/development/${encodeURIComponent(item.id)}/goals`, {
        method: 'PATCH',
        headers: { ...developmentAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Kunne ikke oppdatere målet.');
      if (data.client && onClientUpdated) onClientUpdated(data.client);
      await onReload();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke oppdatere målet.');
    } finally {
      setGoalBusy('');
    }
  }

  async function saveDomain() {
    if (!liveRunId) {
      onError('No Website Maker run is linked to this client yet.');
      return;
    }
    setSavingDomain(true);
    onError('');
    try {
      const data = await saveMakerRunDomain({
        runId: liveRunId,
        websiteDomain: domainDraft,
        salesClientId,
        authHeaders: developmentAuthHeaders(),
      }) as { client?: Record<string, unknown>; hasDomain?: boolean; websiteDomain?: string };
      if (data?.client && onClientUpdated) onClientUpdated(data.client);
      setLiveStatus((prev) => ({ ...(prev || {}), hasDomain: Boolean(data.hasDomain), websiteDomain: data.websiteDomain }));
      onNotice?.(data.hasDomain ? 'Domene lagret på Maker-runet.' : 'Domene fjernet fra Maker-runet.');
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke lagre domenet.');
    } finally {
      setSavingDomain(false);
    }
  }

  async function downloadBundle() {
    const bundleId = String(item.makerRun?.clientBundleId || '').trim();
    if (!bundleId) {
      onError('Ingen kundepakke er knyttet til dette prosjektet på denne maskinen.');
      return;
    }
    setBundleBusy('download');
    onError('');
    try {
      const response = await fetch(`${LOCAL_EDITOR_ORIGIN}/api/client-bundles/${encodeURIComponent(bundleId)}/export`);
      if (!response.ok) throw new Error('Website Creator fant ikke kundepakken.');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${item.businessName || 'client'}-bundle.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke laste ned kundepakken.');
    } finally {
      setBundleBusy('');
    }
  }

  async function importBundle(file: File) {
    setBundleBusy('import');
    onError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch(`${LOCAL_EDITOR_ORIGIN}/api/client-bundles/import`, { method: 'POST', body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || data.message || 'Kunne ikke importere kundepakken.');
      const bundleId = String(data.client?.id || '').trim();
      if (!bundleId) throw new Error('Importen manglet en kundepakke.');
      if (liveRunId) {
        await fetch(`${LOCAL_EDITOR_ORIGIN}/api/runs/${encodeURIComponent(liveRunId)}/save-intake`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientBundleId: bundleId }),
        });
      }
      const synced = await fetch(`${API}/admin/development/${encodeURIComponent(item.id)}/bundle`, {
        method: 'POST',
        headers: { ...developmentAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientBundleId: bundleId }),
      });
      if (!synced.ok) {
        const body = await synced.json().catch(() => ({}));
        throw new Error(body.message || 'Pakken ble importert, men ikke knyttet til kunden.');
      }
      onNotice?.('Kundepakken er importert.');
      await onReload();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke importere kundepakken.');
    } finally {
      setBundleBusy('');
    }
  }

  async function deleteMedia(file: BriefMediaFile) {
    if (!canWork) return;
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
    return developerChipVisual(chip, chipStatus, resolved);
  }

  function renderProgressChips() {
    const liveRun = liveStatus?.run && typeof liveStatus.run === 'object' ? liveStatus.run : null;
    return (
      <div className="flex flex-wrap gap-1.5">
        {DEVELOPER_PROGRESS_CHIPS.map((chip) => {
          const resolved = resolveDeveloperProgressClick(chip, chipStatus);
          const visual = chipVisual(chip, resolved);
          const queueState = chip.target ? chipQueueState(chip.target) : '';
          const live = chipLiveProgress(chip, liveRun);
          const starting = enqueueBusy === chip.id;
          const active = starting || queueState === 'running' || queueState === 'queued' || live.running;
          const clickable = canWork && (resolved.type === 'enqueue' || resolved.type === 'enqueue-until' || resolved.type === 'language' || resolved.type === 'ready' || resolved.type === 'draft');
          const visualClass = visual === 'ready' ? 'ready' : (clickable ? visual : 'grey');
          const label = chip.id === 'lang' && languageCode
            ? `Lang ${languageCode}`
            : chip.label;
          const title = starting
            ? 'Starter Website Creator…'
            : queueState === 'running' || live.running
              ? 'Kjører'
              : queueState === 'queued'
                ? 'I kø'
                : (resolved.reason || chip.label);
          return (
            <div key={chip.id} className="relative group">
              <button
                type="button"
                disabled={!clickable || starting}
                title={chip.id === 'draft' ? 'Åpne Website Creator' : title}
                onClick={() => void onProgressClick(chip.id)}
                className={`${chipClass(visualClass)} relative overflow-hidden`}
              >
                {active ? (
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 h-1 bg-black/20">
                    <span
                      className={`absolute inset-y-0 left-0 bg-[#FF5B00] ${live.pct == null ? 'asoldi-chip-slide w-1/3' : ''}`}
                      style={live.pct == null ? undefined : { width: `${live.pct}%` }}
                    />
                  </span>
                ) : null}
                {active ? <Loader2 size={11} className="inline mr-1 animate-spin" /> : null}
                {label}
              </button>
              {chip.id === 'draft' ? (
                <div className="hidden group-hover:block absolute z-30 mt-1 min-w-[210px] rounded-lg border border-white/10 bg-[#1a1a1a] p-2 shadow-lg">
                  <p className="mb-1.5 text-[11px] text-gray-400">Draftfase</p>
                  <p className="flex items-center gap-2 text-[11px] text-white">
                    <span className={`h-2 w-2 rounded-full ${draft.templateLocked ? 'bg-green-500' : 'bg-red-500'}`} />
                    Mal låst
                  </p>
                  <p className="mt-1 flex items-center gap-2 text-[11px] text-white">
                    <span className={`h-2 w-2 rounded-full ${draft.clientDataReady ? 'bg-green-500' : 'bg-red-500'}`} />
                    Quick Fill og media
                  </p>
                </div>
              ) : null}
              {chipMenu === chip.id && resolved.type === 'ready' ? (
                <div className="absolute z-20 mt-1 min-w-[120px] rounded-lg border border-white/10 bg-[#1a1a1a] p-1 shadow-lg">
                  <button
                    type="button"
                    onClick={() => void openStepPreview(chip.target)}
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
      <div className="min-w-0 space-y-3">
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
          {isAdmin && item.developerOwnerId ? (
            <span className="shrink-0 px-2 py-0.5 rounded text-[11px] border border-white/10 text-gray-300">
              {developerOwnerDisplayName(item.developerOwnerId, developers)}
            </span>
          ) : null}
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

      {isDevelopmentList && (
        <div className="flex flex-wrap gap-1.5">
          {DEVELOPMENT_STEPS.map((step) => {
            const done = Boolean(item.development?.[step.key]);
            return (
              <button
                key={step.key}
                type="button"
                disabled={!canWork || busyKey === `${item.id}:${step.key}`}
                onClick={() => { if (canWork) onToggleStep(item, step.key); }}
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
          <DeveloperGoalTimeline
            goals={item.developerGoals}
            goalKeys={goalKeys}
            busyKey={goalBusy ? `goals:${item.id}:${goalBusy}` : null}
            itemId={item.id}
            onToggle={(key) => void toggleGoal(key)}
          />
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
                  className="h-10 w-10 rounded-md overflow-hidden border border-white/10"
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
                  +{hiddenImages}
                </button>
              ) : null}
            </div>
          </div>
          <div
            className="rounded-xl bg-black/20 border border-white/10 p-4 min-h-[112px] space-y-3"
            onClick={(event) => event.stopPropagation()}
          >
            <span className="text-[11px] uppercase tracking-wide text-gray-500">Make website</span>
            <p className="text-[11px] text-gray-400">Importer nytt eller velg eksisterende template</p>
            {!canWork && item.developerHandoff?.status === 'waiting-upload' && sameDeveloperOwner(item.developerHandoff.fromOwnerId, viewerAccountKey) && (
              <p className="text-[11px] text-amber-200">Website Creator på denne maskinen sender prosjektet til den nye utvikleren.</p>
            )}
            {!canWork && item.developerHandoff?.status === 'waiting-upload' && sameDeveloperOwner(item.developerOwnerId, viewerAccountKey) && (
              <p className="text-[11px] text-amber-200">Venter på at forrige datamaskin sender prosjektet.</p>
            )}
            {!canWork && item.developerHandoff?.status === 'ready' && sameDeveloperOwner(item.developerOwnerId, viewerAccountKey) && (
              <button
                type="button"
                disabled={assignBusy}
                onClick={() => onAcceptHandoff?.()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF5B00] text-white text-xs hover:bg-[#e55200] disabled:opacity-50"
              >
                {assignBusy ? <Loader2 size={13} className="animate-spin" /> : null}
                Ta imot prosjektet
              </button>
            )}
            {!canWork && item.developerOwnerId && !sameDeveloperOwner(item.developerOwnerId, viewerAccountKey) && item.developerHandoff?.status !== 'waiting-upload' && (
              <p className="text-[11px] text-gray-400">En annen utvikler jobber med denne kunden.</p>
            )}
            {isAdmin && (
              <div className="flex flex-wrap items-center gap-2" onClick={(event) => event.stopPropagation()}>
                <select
                  value={assignOwnerId}
                  disabled={assignBusy}
                  onChange={(event) => setAssignOwnerId(event.target.value)}
                  className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-xs px-2 py-1.5"
                >
                  <option value="">{item.developerOwnerId ? 'Bytt utvikler…' : 'Velg utvikler…'}</option>
                  {developers.map((owner) => (
                    <option key={owner.accountKey} value={owner.accountKey}>
                      {owner.name || owner.username}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={assignBusy || !assignOwnerId}
                  onClick={() => onAssign?.(assignOwnerId)}
                  className="px-2 py-1.5 rounded-lg bg-[#FF5B00] text-white text-xs hover:bg-[#e55200] disabled:opacity-50"
                >
                  Tildel
                </button>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {canWork && (
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
                businessName={item.businessName}
              />
              )}
              <button
                type="button"
                onClick={() => void openInMaker()}
                disabled={!canWork || !liveRunId || openingMaker}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs disabled:opacity-50 ${
                  liveRunId
                    ? 'bg-[#FF5B00] text-white hover:bg-[#e55200]'
                    : 'bg-white/10 text-white hover:bg-white/15'
                }`}
              >
                {openingMaker ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />}
                Open in maker
              </button>
              <button
                type="button"
                onClick={() => makerPreviewHref && window.open(makerPreviewHref, '_blank')}
                disabled={!canWork || !liveRunId || !makerPreviewHref}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
              >
                <ExternalLink size={13} />
                Maker preview
              </button>
              {item.publicPreviewUrl ? (
                <button
                  type="button"
                  onClick={() => window.open(item.publicPreviewUrl, '_blank')}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
                >
                  <ExternalLink size={13} />
                  Live preview
                </button>
              ) : null}
              {(canWork || isAdmin) && (
                <button
                  type="button"
                  disabled={bundleBusy === 'download'}
                  onClick={() => void downloadBundle()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
                >
                  {bundleBusy === 'download' ? <Loader2 size={13} className="animate-spin" /> : null}
                  Last ned kundepakke
                </button>
              )}
              {canWork && (
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 cursor-pointer">
                  {bundleBusy === 'import' ? <Loader2 size={13} className="animate-spin" /> : null}
                  Importer kundepakke
                  <input
                    type="file"
                    accept=".zip,application/zip"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void importBundle(file);
                    }}
                  />
                </label>
              )}
            </div>
            {renderProgressChips()}
            {isDevelopmentList && (
              <>
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
                    disabled={!canWork || !liveRunId || savingDomain}
                    className="px-3 py-2 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
                  >
                    {savingDomain ? <Loader2 size={13} className="inline animate-spin" /> : null}
                    Lagre domene
                  </button>
                </div>
                <p className="text-[11px] text-gray-500">Steg 4 SEO er av til et domene er lagret på runet.</p>
              </>
            )}
          </div>
          {isDevelopmentList ? (
            <div onClick={(event) => event.stopPropagation()}>
              <DeveloperRequestThread
                salesClientId={salesClientId}
                makerRunId={liveRunId}
                websiteMakerBaseUrl={websiteMakerBaseUrl}
                authHeaders={developmentAuthHeaders()}
                extraMessages={iterationMessages}
              />
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-xs text-gray-500">No sales client linked — maker tools need a sales client.</p>
      )}
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
              allowCreate={canWork && Boolean(liveRunId)}
              allowLink={canWork}
              variant="tools"
              businessName={item.businessName}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!canWork || !liveRunId || !customEditUrl}
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
