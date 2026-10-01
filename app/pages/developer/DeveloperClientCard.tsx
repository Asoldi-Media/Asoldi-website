import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, ExternalLink, Loader2, Pencil } from 'lucide-react';
import {
  API,
  developmentAuthHeaders,
  type DevelopmentItem,
} from '../Admin/shared';
import { MakerRunTools } from './MakerRunTools';
import { DeveloperRequestThread } from './DeveloperRequestThread';
import { enqueueMakerQueue, fetchMakerRunStatus, openLanguageLock } from './makerQueue';
import {
  DEVELOPER_PROGRESS_CHIPS,
  DEVELOPER_QA_LABELS,
  developerMaterialsView,
  developerMediaLibraryView,
  developerSummaryView,
  makerCustomEditUrl,
  makerCustomPreviewPath,
  normalizeDeveloperQa,
  pipelineStatusFromMakerRun,
  resolveDeveloperProgressClick,
} from '../../../lib/developer-card.js';
import {
  buildMakerRunUrl,
  getPublicClientPreviewUrl,
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
};

type Props = {
  item: DevelopmentItem;
  kind: 'preview' | 'deployment';
  busyKey: string | null;
  selected: boolean;
  websiteMakerBaseUrl: string;
  setWebsiteMakerBaseUrl: (value: string) => void;
  onToggleSelected: () => void;
  onCardClick: (event: React.MouseEvent<HTMLElement>) => void;
  onToggleStep: (item: DevelopmentItem, key: keyof DevelopmentItem['development']) => void;
  onReload: () => Promise<void> | void;
  onClientUpdated?: (client: Record<string, unknown> | null | undefined) => void;
  onError: (message: string) => void;
  onNotice?: (message: string) => void;
};

function formatRankTime(value = '') {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('nb-NO', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatWhen(value = '') {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('nb-NO', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

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
  setWebsiteMakerBaseUrl,
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
  const rankLabel = formatRankTime(item.rankAt || item.nextActionAt || item.meetingAt || '');
  const summary = developerSummaryView(item.workshop);
  const [qa, setQa] = useState(() => normalizeDeveloperQa(item.developerQa));
  const [materials, setMaterials] = useState(() => developerMaterialsView({}));
  const [media, setMedia] = useState<{ fromClient: MediaFile[]; fromMaker: MediaFile[]; makerError: string }>({
    fromClient: [],
    fromMaker: [],
    makerError: '',
  });
  const [enqueueBusy, setEnqueueBusy] = useState('');
  const [openingMaker, setOpeningMaker] = useState(false);
  const [liveStatus, setLiveStatus] = useState<Record<string, unknown> | null>(null);

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
        setMaterials(developerMaterialsView(data));
      })
      .catch(() => {
        setMaterials(developerMaterialsView({}));
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
  }, [item.id, salesClientId, websiteMakerBaseUrl, makerRunId]);

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
  }, [makerRunId, websiteMakerBaseUrl]);

  const customEditUrl = makerCustomEditUrl(websiteMakerBaseUrl, makerRunId);
  const customPreviewPath = makerCustomPreviewPath(makerRunId, item.makerRun?.customSite || null);
  const customPreviewUrl = customPreviewPath
    ? `${String(websiteMakerBaseUrl || '').replace(/\/+$/, '')}${customPreviewPath}`
    : '';
  const publicPreviewUrl = getPublicClientPreviewUrl({
    id: salesClientId,
    websiteImport: item.websiteImport,
  });
  const makerDashboardUrl = resolveOpenInMakerUrl({
    baseUrl: websiteMakerBaseUrl,
    runId: makerRunId,
    storedDashboardUrl: normalizeMakerDashboardDraftUrl(String(item.makerRun?.dashboardUrl || '').trim()),
    intakeStatus: String(item.makerRun?.intakeStatus || ''),
    latestReadyStep: String(item.makerRun?.latestReadyStep || ''),
  });
  const domainMark = materials.binaries.find((row) => row.key === 'domain')?.mark || 'none';

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
    const fallbackUrl = makerDashboardUrl || buildMakerRunUrl(websiteMakerBaseUrl, makerRunId, 'dashboard');
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
        body: JSON.stringify({ websiteMakerBaseUrl, runId: makerRunId }),
      }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || 'Opened Maker, but the stored link could not be refreshed.');
        return payload;
      });
      if (data?.client && onClientUpdated) onClientUpdated(data.client as Record<string, unknown>);
      else await onReload();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Opened Maker, but the stored link could not be refreshed.');
    } finally {
      setOpeningMaker(false);
    }
  }

  async function onProgressClick(chipId: string) {
    const chip = DEVELOPER_PROGRESS_CHIPS.find((row) => row.id === chipId);
    if (!chip) return;
    const resolved = resolveDeveloperProgressClick(chip, status);
    if (!resolved.enqueue && resolved.type !== 'language') {
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
    setEnqueueBusy(chip.id);
    onError('');
    try {
      await enqueueMakerQueue({
        websiteMakerBaseUrl,
        salesClientIds: [salesClientId],
        target: resolved.target,
        authHeaders: developmentAuthHeaders(),
      });
      onNotice?.(`Køet ${chip.label}.`);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke legge i kø.');
    } finally {
      setEnqueueBusy('');
    }
  }

  const openAuthedMedia = useCallback(async (url = '') => {
    if (!url) return;
    try {
      const response = await fetch(url, { headers: developmentAuthHeaders() });
      if (!response.ok) throw new Error('Kunne ikke åpne filen.');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      window.open(objectUrl, '_blank');
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke åpne filen.');
    }
  }, [onError]);

  function chipVisual(chip: (typeof DEVELOPER_PROGRESS_CHIPS)[number], resolved: ReturnType<typeof resolveDeveloperProgressClick>) {
    if (chip.kind === 'grey' || resolved.type === 'disabled' || resolved.type === 'noop') return 'grey';
    if (chip.id === 'lang') return status.languageLocked ? 'ready' : 'idle';
    if (chip.id === '1') return status.step1Ready ? 'ready' : 'idle';
    if (chip.id === '1.5') return status.step15Ready ? 'ready' : 'idle';
    if (chip.id === '2.1') return status.generateTextReady ? 'ready' : 'idle';
    if (chip.id === '2.2') return status.injectMediaReady ? 'ready' : 'idle';
    return 'idle';
  }

  return (
    <div
      onClick={onCardClick}
      className={`rounded-2xl bg-[#2a2a2a] border p-4 flex flex-col gap-3 cursor-pointer ${
        selected ? `hover:bg-[#323232] ${CARD_SELECTED}` : 'border-white/10 hover:bg-[#323232]'
      }`}
    >
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
          <span
            className={`shrink-0 px-2 py-0.5 rounded text-[11px] border ${
              kind === 'preview'
                ? 'bg-amber-900/30 border-amber-700/30 text-amber-300'
                : 'bg-sky-900/30 border-sky-700/30 text-sky-300'
            }`}
          >
            {kind === 'preview' ? 'Preview website' : 'Deployment'}
          </span>
        </div>
        {contact && <p className="mt-1 text-xs text-gray-400 truncate">{contact}</p>}
        {rankLabel && (
          <p className="mt-1 text-xs text-sky-300 inline-flex items-center gap-1.5">
            <CalendarClock size={12} />
            {item.nextActionAt ? `${item.nextActionName || 'Neste handling'}: ` : 'Møte: '}
            {rankLabel}
          </p>
        )}
        <p className="mt-1 text-xs text-gray-400 inline-flex items-center gap-1.5">
          {domainMark === 'green' ? (
            <span className="inline-block h-2 w-2 rounded-full bg-green-400" title="Domene er satt" />
          ) : null}
          {domainMark === 'green' ? 'Domene satt' : 'Ingen domene ennå'}
          {item.siteKey ? ` · ${item.siteKey}` : ''}
          {item.industry ? ` · ${item.industry}` : ''}
        </p>
      </div>

      {item.notes ? (
        <p className="text-sm text-gray-300 whitespace-pre-wrap">{item.notes}</p>
      ) : null}

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
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!makerRunId || !customEditUrl}
              onClick={() => customEditUrl && window.open(customEditUrl, '_blank')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF5B00] text-white text-xs hover:bg-[#e55200] disabled:opacity-50"
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
            <button
              type="button"
              onClick={() => window.open(publicPreviewUrl, '_blank')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
              title={publicPreviewUrl}
            >
              <ExternalLink size={13} />
              Open preview
            </button>
            <button
              type="button"
              onClick={() => void openInMaker()}
              disabled={!makerRunId || openingMaker}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
            >
              {openingMaker ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />}
              Open in maker
            </button>
          </div>

          <details className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-gray-200">
            <summary className="cursor-pointer text-white font-medium">Tools & details</summary>
            <div className="mt-3">
              <MakerRunTools
                salesClientId={salesClientId}
                client={{ id: salesClientId, makerRun: item.makerRun, websiteImport: item.websiteImport }}
                websiteMakerBaseUrl={websiteMakerBaseUrl}
                setWebsiteMakerBaseUrl={setWebsiteMakerBaseUrl}
                authHeaders={developmentAuthHeaders()}
                onReload={onReload}
                onClientUpdated={onClientUpdated}
                onError={onError}
                onNotice={onNotice}
                allowCreate
                allowLink
                variant="tools"
              />
            </div>
          </details>

          <section className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-2">
            <h4 className="text-xs font-semibold text-gray-200 uppercase tracking-wide">Client summary</h4>
            {summary.ready ? (
              <div className="space-y-2 text-sm text-gray-300">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">Intro</div>
                  <p className="whitespace-pre-wrap">{summary.intro}</p>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">Voice</div>
                  <p className="whitespace-pre-wrap">{summary.voice}</p>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">What they want</div>
                  <p className="whitespace-pre-wrap">{summary.whatTheyWant}</p>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">Functionality</div>
                  <p className="whitespace-pre-wrap">{summary.functionality}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-400">{summary.message}</p>
            )}
          </section>

          <section className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-2">
            <h4 className="text-xs font-semibold text-gray-200 uppercase tracking-wide">QA</h4>
            {(['textOk', 'mediaOk', 'responsiveOk'] as const).map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(qa[key])}
                  onChange={(event) => void patchQa(key, event.target.checked)}
                  className="h-4 w-4 accent-[#FF5B00]"
                />
                {DEVELOPER_QA_LABELS[key]}
              </label>
            ))}
            <div>
              <div className="text-[11px] uppercase tracking-wide text-gray-500">Functionality</div>
              <p className="text-sm text-gray-300 whitespace-pre-wrap">
                {summary.ready ? summary.functionality : summary.message}
              </p>
            </div>
          </section>

          <section className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-2">
            <h4 className="text-xs font-semibold text-gray-200 uppercase tracking-wide">Materialer</h4>
            <div className="flex flex-wrap gap-2 text-xs">
              {materials.binaries.map((row) => (
                <span
                  key={row.key}
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border ${
                    row.mark === 'green'
                      ? 'border-green-600/40 bg-green-900/30 text-green-300'
                      : row.mark === 'red'
                        ? 'border-red-700/40 bg-red-900/20 text-red-300'
                        : 'border-white/10 bg-black/20 text-gray-400'
                  }`}
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      row.mark === 'green' ? 'bg-green-400' : row.mark === 'red' ? 'bg-red-400' : 'bg-gray-600'
                    }`}
                  />
                  {row.label}
                </span>
              ))}
              {materials.counts.map((row) => (
                <span key={row.key} className="px-2 py-1 rounded-md border border-white/10 bg-black/20 text-gray-300 tabular-nums">
                  {row.label}: {row.value}
                </span>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-2">
            <h4 className="text-xs font-semibold text-gray-200 uppercase tracking-wide">Pipeline</h4>
            <div className="flex flex-wrap gap-1.5">
              {DEVELOPER_PROGRESS_CHIPS.map((chip) => {
                const resolved = resolveDeveloperProgressClick(chip, status);
                const visual = chipVisual(chip, resolved);
                const clickable = resolved.type === 'enqueue' || resolved.type === 'language';
                return (
                  <button
                    key={chip.id}
                    type="button"
                    disabled={!clickable || enqueueBusy === chip.id}
                    title={resolved.reason || chip.label}
                    onClick={() => void onProgressClick(chip.id)}
                    className={chipClass(clickable ? visual : 'grey')}
                  >
                    {enqueueBusy === chip.id ? <Loader2 size={11} className="inline mr-1 animate-spin" /> : null}
                    {chip.label}
                  </button>
                );
              })}
            </div>
          </section>

          <section className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-3">
            <h4 className="text-xs font-semibold text-gray-200 uppercase tracking-wide">Mediebibliotek</h4>
            <div>
              <h5 className="text-sm font-medium text-white">Fra kunden</h5>
              {media.fromClient.length ? (
                <ul className="mt-1 space-y-1 text-xs text-gray-300">
                  {media.fromClient.map((file) => (
                    <li key={`client-${file.fileName}`}>
                      <button
                        type="button"
                        onClick={() => void openAuthedMedia(file.url)}
                        className="text-left hover:text-white underline-offset-2 hover:underline"
                      >
                        {file.fileName}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-gray-500">Ingen filer i Kundedata ennå.</p>
              )}
            </div>
            <div>
              <h5 className="text-sm font-medium text-white">Fra Website Maker</h5>
              {media.makerError ? (
                <p className="mt-1 text-xs text-red-300">{media.makerError}</p>
              ) : media.fromMaker.length ? (
                <ul className="mt-1 space-y-1 text-xs text-gray-300">
                  {media.fromMaker.map((file) => (
                    <li key={`maker-${file.source}-${file.field}-${file.fileName}`}>
                      <button
                        type="button"
                        onClick={() => void openAuthedMedia(file.url)}
                        className="text-left hover:text-white underline-offset-2 hover:underline"
                      >
                        {file.fileName}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-xs text-gray-500">Ingen Maker-filer ennå.</p>
              )}
            </div>
          </section>

          <section className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-2">
            <h4 className="text-xs font-semibold text-gray-200 uppercase tracking-wide">Iterert</h4>
            {item.hasIterationMeeting && item.iterationTranscript ? (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500">Transkript</div>
                <p className="text-sm text-gray-300 whitespace-pre-wrap">{item.iterationTranscript}</p>
              </div>
            ) : null}
            {(item.iterationLog || []).length ? (
              <ul className="space-y-1.5">
                {(item.iterationLog || []).map((entry) => {
                  const done = Boolean(entry.doneAt);
                  return (
                    <li
                      key={entry.id}
                      className={`text-sm ${done ? 'text-gray-500' : 'text-gray-300'}`}
                    >
                      {done ? <CheckCircle2 size={12} className="inline mr-1 text-green-400" /> : null}
                      <span className="text-[11px] text-gray-500 mr-2">{formatWhen(entry.at)}</span>
                      {entry.text}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-xs text-gray-500">Ingen iterasjonsnotater ennå.</p>
            )}
          </section>

          <DeveloperRequestThread
            salesClientId={salesClientId}
            makerRunId={makerRunId}
            websiteMakerBaseUrl={websiteMakerBaseUrl}
            authHeaders={developmentAuthHeaders()}
          />
        </>
      ) : (
        <p className="text-xs text-gray-500">No sales client linked — maker tools need a sales client.</p>
      )}
    </div>
  );
}
