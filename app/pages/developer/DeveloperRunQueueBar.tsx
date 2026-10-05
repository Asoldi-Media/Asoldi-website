import React, { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { makerUnreachableIsLocal } from '../../../lib/maker-editor-origin.js';
import { developmentAuthHeaders } from '../Admin/shared';
import { DeveloperLanguageLockPopup } from './DeveloperLanguageLockPopup';
import {
  CLICKABLE_QUEUE_TARGETS,
  GREY_QUEUE_TARGETS,
  cancelMakerQueueItem,
  enqueueMakerQueue,
  fetchMakerRunStatus,
  openLanguageLock,
  registerLanguageLockOpener,
} from './makerQueue';

export type QueueSelectedClient = {
  id: string;
  salesClientId: string;
  runId: string;
  businessName: string;
};

type QueueItem = {
  id: string;
  runId: string;
  salesClientId?: string;
  target: string;
  status: string;
  waitReason?: string | null;
  error?: string | null;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
};

type RunStatus = {
  step1Ready?: boolean;
  languageLocked?: boolean;
  generateTextReady?: boolean;
  hasDomain?: boolean;
};

type Props = {
  websiteMakerBaseUrl: string;
  selectedClients: QueueSelectedClient[];
  visibleCount: number;
  allVisibleSelected: boolean;
  items?: Array<Record<string, unknown>>;
  memory?: Record<string, unknown> | null;
  onRefreshQueue?: () => Promise<void> | void;
  onToggleSelectAll: () => void;
  onClearSelection: () => void;
  onError: (message: string) => void;
  onNotice?: (message: string) => void;
  embedded?: boolean;
  hideSelection?: boolean;
};

const WAIT_REASON_LABEL: Record<string, string> = {
  'heap-budget': 'Venter: heap-budsjett',
  'os-memory': 'Venter: lite ledig minne',
  'run-busy': 'Venter: samme run kjører',
};

const STATUS_LABEL: Record<string, string> = {
  queued: 'I kø',
  running: 'Kjører',
  finished: 'Ferdig',
  failed: 'Feilet',
  cancelled: 'Avbrutt',
};

function targetLabel(target: string) {
  const all = [...CLICKABLE_QUEUE_TARGETS, ...GREY_QUEUE_TARGETS];
  return all.find((entry) => entry.target === target)?.label || target;
}

function chipClass(active: boolean, disabled: boolean) {
  if (disabled) return 'px-2 py-1 rounded-md text-[11px] border bg-black/20 border-white/10 text-gray-500 cursor-not-allowed';
  if (active) return 'px-2 py-1 rounded-md text-[11px] border bg-[#FF5B00] border-[#FF5B00] text-white';
  return 'px-2 py-1 rounded-md text-[11px] border bg-white/10 border-white/10 text-white hover:bg-white/15';
}

function asQueueItems(raw: Array<Record<string, unknown>> | undefined): QueueItem[] {
  return (Array.isArray(raw) ? raw : []).map((item) => ({
    id: String(item.id || ''),
    runId: String(item.runId || ''),
    salesClientId: String(item.salesClientId || ''),
    target: String(item.target || ''),
    status: String(item.status || ''),
    waitReason: item.waitReason == null ? null : String(item.waitReason),
    error: item.error == null ? null : String(item.error),
    createdAt: item.createdAt ? String(item.createdAt) : '',
    startedAt: item.startedAt ? String(item.startedAt) : '',
    finishedAt: item.finishedAt ? String(item.finishedAt) : '',
  }));
}

export function DeveloperRunQueueBar({
  websiteMakerBaseUrl,
  selectedClients,
  visibleCount,
  allVisibleSelected,
  items: itemsProp,
  memory: memoryProp,
  onRefreshQueue,
  onToggleSelectAll,
  onClearSelection,
  onError,
  onNotice,
  embedded = false,
  hideSelection = false,
}: Props) {
  const [target, setTarget] = useState('1');
  const [busy, setBusy] = useState(false);
  const [langOpen, setLangOpen] = useState<null | { runId: string; businessName: string }>(null);
  const [runStatus, setRunStatus] = useState<Record<string, RunStatus>>({});
  const [localEditorNote, setLocalEditorNote] = useState(false);
  const selectedRunKey = selectedClients.map((client) => client.runId).filter(Boolean).sort().join('|');
  const selectedCount = selectedClients.length;
  const selectedWithRun = selectedClients.filter((client) => client.runId);
  const items = asQueueItems(itemsProp);
  const memory = memoryProp && typeof memoryProp === 'object' ? memoryProp : null;

  useEffect(() => {
    registerLanguageLockOpener((input) => {
      setLangOpen({ runId: input.runId, businessName: input.businessName || '' });
    });
    return () => registerLanguageLockOpener(null);
  }, []);

  useEffect(() => {
    const runIds = selectedRunKey ? selectedRunKey.split('|').filter(Boolean).slice(0, 20) : [];
    if (!runIds.length || !websiteMakerBaseUrl) {
      setRunStatus({});
      return;
    }
    let cancelled = false;
    const headers = developmentAuthHeaders();
    void Promise.all(
      runIds.map(async (runId) => {
        try {
          const data = await fetchMakerRunStatus(websiteMakerBaseUrl, runId, headers) as RunStatus & { runId?: string };
          return [runId, data] as const;
        } catch {
          return [runId, {}] as const;
        }
      })
    ).then((entries) => {
      if (cancelled) return;
      setRunStatus(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedRunKey, websiteMakerBaseUrl]);

  const statuses = useMemo(
    () => selectedWithRun.map((client) => runStatus[client.runId] || {}),
    [runStatus, selectedWithRun]
  );
  const step1Ready = statuses.length > 0 && statuses.every((status) => status.step1Ready);
  const languageLocked = statuses.length > 0 && statuses.every((status) => status.languageLocked);
  const hasDomain = statuses.length > 0 && statuses.every((status) => status.hasDomain);
  const langClient = selectedWithRun.length === 1 ? selectedWithRun[0] : null;
  const langDisabledReason = !langClient
    ? 'Velg én klient med et Maker-run for å låse språk.'
    : !runStatus[langClient.runId]?.step1Ready
      ? 'Run Step 1 first, then detect & lock the website language'
      : '';
  const step15DisabledReason = !selectedWithRun.length
    ? ''
    : !step1Ready
      ? 'Requires Step 1 success first'
      : !languageLocked
        ? 'Detect & lock the website language first'
        : '';
  const seoDisabledReason = !selectedWithRun.length
    ? ''
    : !hasDomain
      ? 'Set a website domain before Step 4 SEO'
      : '';

  function clickableDisabled(clickTarget: string) {
    if (clickTarget === '1.5') return Boolean(step15DisabledReason);
    if (clickTarget === '3') return Boolean(seoDisabledReason);
    return false;
  }

  async function runSelected() {
    if (!selectedClients.length) {
      onError('Velg minst én klient.');
      return;
    }
    if (clickableDisabled(target)) {
      onError(target === '1.5' ? step15DisabledReason : seoDisabledReason);
      return;
    }
    setBusy(true);
    onError('');
    try {
      const linked = selectedClients.filter((client) => client.runId);
      const missing = selectedClients.filter((client) => !client.runId);
      const data = await enqueueMakerQueue({
        websiteMakerBaseUrl,
        salesClientIds: linked.map((client) => client.salesClientId).filter(Boolean),
        runIds: linked.map((client) => client.runId),
        untilTarget: target,
      }) as { failures?: { salesClientId?: string; error?: string }[]; skipped?: { error?: string }[]; added?: unknown[] };
      const failures = [
        ...missing.map((client) => ({
          salesClientId: client.salesClientId,
          error: 'No Website Maker run is linked.',
        })),
        ...(Array.isArray(data.failures) ? data.failures : []),
      ];
      const skippedErrors = (Array.isArray(data.skipped) ? data.skipped : [])
        .map((entry) => String(entry.error || '').trim())
        .filter(Boolean);
      if (failures.length) {
        onError(failures.map((entry) => entry.error || 'No Website Maker run is linked.').join(' | '));
      } else if (skippedErrors.length && !(Array.isArray(data.added) && data.added.length)) {
        onError(skippedErrors[0]);
      } else {
        onNotice?.(`Køet ${targetLabel(target)} for ${selectedClients.length} klient(er). Ekstra jobber venter til RAM tillater det.`);
      }
      await onRefreshQueue?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Kunne ikke legge i kø.';
      if (makerUnreachableIsLocal(message)) {
        setLocalEditorNote(true);
        onError(message);
      } else {
        onError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function cancelItem(itemId: string) {
    try {
      await cancelMakerQueueItem(websiteMakerBaseUrl, itemId, developmentAuthHeaders());
      await onRefreshQueue?.();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke avbryte.');
    }
  }

  const waitHint = memory?.waitReason ? WAIT_REASON_LABEL[String(memory.waitReason)] || String(memory.waitReason) : '';

  return (
    <div className={embedded ? 'space-y-3 pt-2 border-t border-white/10' : 'rounded-2xl bg-[#2a2a2a] border border-white/10 p-4 space-y-3'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-gray-200 uppercase tracking-wide">Maker-kø</div>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Kjør valgte klienter til og med det steget. Bare så mange jobber som RAM tåler kjører samtidig; resten venter.
          </p>
          {localEditorNote ? (
            <p className="text-[11px] text-gray-400 mt-1">
              Start Docker Maker on port 3000 (127.0.0.1:3000).
            </p>
          ) : null}
        </div>
        {!hideSelection && (
          <label className="inline-flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              disabled={!visibleCount}
              onChange={onToggleSelectAll}
              className="h-4 w-4 accent-[#FF5B00]"
            />
            Velg alle
            <span className="text-xs text-gray-400">
              {selectedCount ? `${selectedCount} valgt` : `${visibleCount} synlige`}
            </span>
          </label>
        )}
        {!hideSelection && selectedCount > 0 && (
          <button type="button" onClick={onClearSelection} className="text-xs text-gray-400 hover:text-white">
            Nullstill
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {CLICKABLE_QUEUE_TARGETS.map((entry) => {
          const disabled = clickableDisabled(entry.target);
          const title =
            entry.target === '1.5' && step15DisabledReason
              ? step15DisabledReason
              : entry.target === '3' && seoDisabledReason
                ? seoDisabledReason
                : '';
          return (
            <button
              key={entry.target}
              type="button"
              disabled={disabled}
              title={title}
              onClick={() => setTarget(entry.target)}
              className={chipClass(target === entry.target, disabled)}
            >
              {entry.label}
            </button>
          );
        })}
        <button
          type="button"
          disabled={Boolean(langDisabledReason)}
          title={langDisabledReason}
          onClick={() => {
            if (!langClient) return;
            openLanguageLock({
              runId: langClient.runId,
              websiteMakerBaseUrl,
              businessName: langClient.businessName,
            });
          }}
          className={chipClass(false, Boolean(langDisabledReason))}
        >
          Lang
        </button>
        {GREY_QUEUE_TARGETS.map((entry) => (
          <button
            key={entry.target}
            type="button"
            disabled
            title="CMS setup and beyond"
            className={chipClass(false, true)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void runSelected()}
          disabled={busy || !selectedCount}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm hover:bg-[#e55200] disabled:opacity-50"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : null}
          Kjør {targetLabel(target)} for valgte
        </button>
        {waitHint ? <span className="text-xs text-amber-300">{waitHint}</span> : null}
        {memory?.allowed != null ? (
          <span className="text-[11px] text-gray-500">
            Plasser: {String(memory.activeCount || 0)}/{String(memory.allowed)} · ledig OS {String(memory.osFreeMb ?? '—')} MB
          </span>
        ) : null}
      </div>

      <div className="space-y-1.5 max-h-48 overflow-auto">
        {items.length === 0 ? (
          <p className="text-xs text-gray-500">Ingen jobber i køen ennå.</p>
        ) : (
          items.slice(0, 40).map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-2 text-xs text-gray-300">
              <span className="truncate">
                <span className="text-gray-500">{STATUS_LABEL[item.status] || item.status}</span>
                {' · '}
                {targetLabel(item.target)}
                {' · '}
                {item.runId.slice(0, 8)}
                {item.waitReason ? ` · ${WAIT_REASON_LABEL[item.waitReason] || item.waitReason}` : ''}
                {item.error ? ` · ${item.error}` : ''}
              </span>
              {item.status === 'queued' ? (
                <button
                  type="button"
                  onClick={() => void cancelItem(item.id)}
                  className="shrink-0 text-gray-400 hover:text-white"
                >
                  Avbryt
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>

      {langOpen ? (
        <DeveloperLanguageLockPopup
          runId={langOpen.runId}
          websiteMakerBaseUrl={websiteMakerBaseUrl}
          businessName={langOpen.businessName}
          authHeaders={developmentAuthHeaders()}
          onClose={() => setLangOpen(null)}
          onChanged={() => {
            const runIds = selectedRunKey ? selectedRunKey.split('|').filter(Boolean) : [];
            const headers = developmentAuthHeaders();
            void Promise.all(
              runIds.map(async (runId) => {
                try {
                  return [runId, await fetchMakerRunStatus(websiteMakerBaseUrl, runId, headers)] as const;
                } catch {
                  return [runId, {}] as const;
                }
              })
            ).then((entries) => setRunStatus(Object.fromEntries(entries)));
          }}
        />
      ) : null}
    </div>
  );
}
