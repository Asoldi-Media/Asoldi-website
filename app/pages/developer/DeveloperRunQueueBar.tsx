import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { developmentAuthHeaders } from '../Admin/shared';
import { DeveloperLanguageLockPopup } from './DeveloperLanguageLockPopup';
import {
  CLICKABLE_QUEUE_TARGETS,
  GREY_QUEUE_TARGETS,
  cancelMakerQueueItem,
  enqueueMakerQueue,
  fetchMakerQueue,
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
};

type Props = {
  websiteMakerBaseUrl: string;
  selectedClients: QueueSelectedClient[];
  visibleCount: number;
  allVisibleSelected: boolean;
  onToggleSelectAll: () => void;
  onClearSelection: () => void;
  onError: (message: string) => void;
  onNotice?: (message: string) => void;
};

const WAIT_REASON_LABEL: Record<string, string> = {
  'heap-budget': 'Venter: heap-budsjett',
  'os-memory': 'Venter: lite ledig minne',
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

export function DeveloperRunQueueBar({
  websiteMakerBaseUrl,
  selectedClients,
  visibleCount,
  allVisibleSelected,
  onToggleSelectAll,
  onClearSelection,
  onError,
  onNotice,
}: Props) {
  const [target, setTarget] = useState('1');
  const [busy, setBusy] = useState(false);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [memory, setMemory] = useState<Record<string, unknown> | null>(null);
  const [langOpen, setLangOpen] = useState<null | { runId: string; businessName: string }>(null);
  const [runStatus, setRunStatus] = useState<Record<string, RunStatus>>({});
  const selectedRunKey = selectedClients.map((client) => client.runId).filter(Boolean).sort().join('|');
  const selectedCount = selectedClients.length;
  const selectedWithRun = selectedClients.filter((client) => client.runId);

  const refreshQueue = useCallback(async () => {
    if (!websiteMakerBaseUrl) return;
    const data = await fetchMakerQueue(websiteMakerBaseUrl, developmentAuthHeaders()) as { items?: QueueItem[]; memory?: Record<string, unknown> };
    setItems(Array.isArray(data.items) ? data.items : []);
    setMemory(data.memory && typeof data.memory === 'object' ? data.memory : null);
  }, [websiteMakerBaseUrl]);

  useEffect(() => {
    void refreshQueue().catch((error) => onError(error instanceof Error ? error.message : 'Kunne ikke lese køen.'));
    const timer = window.setInterval(() => {
      void refreshQueue().catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [onError, refreshQueue]);

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
  const generateTextReady = statuses.length > 0 && statuses.every((status) => status.generateTextReady);
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
  const step22DisabledReason = !selectedWithRun.length
    ? ''
    : !generateTextReady
      ? 'Requires generate-text first'
      : '';

  function clickableDisabled(clickTarget: string) {
    if (clickTarget === '1.5') return Boolean(step15DisabledReason);
    if (clickTarget === 'inject-media') return Boolean(step22DisabledReason);
    return false;
  }

  async function runSelected() {
    if (!selectedClients.length) {
      onError('Velg minst én klient.');
      return;
    }
    if (clickableDisabled(target)) {
      onError(target === '1.5' ? step15DisabledReason : step22DisabledReason);
      return;
    }
    setBusy(true);
    onError('');
    try {
      const data = await enqueueMakerQueue({
        websiteMakerBaseUrl,
        salesClientIds: selectedClients.map((client) => client.salesClientId).filter(Boolean),
        runIds: selectedClients.filter((client) => !client.salesClientId && client.runId).map((client) => client.runId),
        target,
        authHeaders: developmentAuthHeaders(),
      }) as { failures?: { salesClientId?: string; error?: string }[]; added?: unknown[] };
      const failures = Array.isArray(data.failures) ? data.failures : [];
      if (failures.length) {
        onError(failures.map((entry) => entry.error || 'No Website Maker run is linked.').join(' | '));
      } else {
        onNotice?.(`Køet ${targetLabel(target)} for ${selectedClients.length} klient(er).`);
      }
      await refreshQueue();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke legge i kø.');
    } finally {
      setBusy(false);
    }
  }

  async function cancelItem(itemId: string) {
    try {
      await cancelMakerQueueItem(websiteMakerBaseUrl, itemId, developmentAuthHeaders());
      await refreshQueue();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke avbryte.');
    }
  }

  const waitHint = memory?.waitReason ? WAIT_REASON_LABEL[String(memory.waitReason)] || String(memory.waitReason) : '';

  return (
    <div className="rounded-2xl bg-[#2a2a2a] border border-white/10 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-xs font-semibold text-gray-200 uppercase tracking-wide">Maker-kø</div>
          <p className="text-[11px] text-gray-400 mt-0.5">
            Kjør ett klikkbart steg for valgte klienter. Layout, Maps, steg 2, CMS og SEO vises grå til de slås på.
          </p>
        </div>
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
        {selectedCount > 0 && (
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
              : entry.target === 'inject-media' && step22DisabledReason
                ? step22DisabledReason
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
            title="Ikke klikkbar ennå"
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
