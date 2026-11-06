import React, { useMemo } from 'react';
import { Loader2, StickyNote } from 'lucide-react';
import type { SalesClient } from '../shared';
import { buildSalesCardLog } from '../../../../lib/sales-card-log.js';
import { isoToDatetimeLocalOslo, SALES_ACTION_TIMEZONE } from '../../../../lib/sales-next-actions.js';

type LogRow = {
  kind: string;
  id: string;
  name: string;
  text: string;
  at: string;
  formatLabel: string;
};

const HOUR_MS = 60 * 60 * 1000;

function clock(iso = '') {
  const local = isoToDatetimeLocalOslo(iso);
  return local ? local.slice(11, 16) : '';
}

function dayWord(iso: string, nowMs: number) {
  const key = isoToDatetimeLocalOslo(iso).slice(0, 10);
  if (!key) return '';
  const today = isoToDatetimeLocalOslo(new Date(nowMs).toISOString()).slice(0, 10);
  if (key === today) return 'i dag';
  if (key === isoToDatetimeLocalOslo(new Date(nowMs + 24 * HOUR_MS).toISOString()).slice(0, 10)) return 'i morgen';
  if (key === isoToDatetimeLocalOslo(new Date(nowMs - 24 * HOUR_MS).toISOString()).slice(0, 10)) return 'i går';
  return new Intl.DateTimeFormat('nb-NO', {
    timeZone: SALES_ACTION_TIMEZONE,
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
}

function logWhen(iso: string, nowMs: number) {
  if (!iso) return 'uten tid';
  const time = clock(iso);
  const day = dayWord(iso, nowMs);
  return [day, time].filter(Boolean).join(' ');
}

const KIND_LABEL: Record<string, string> = {
  note: 'Notat',
  action: 'Handling',
  meeting: 'Møte',
  playbook: 'Steg',
};

type Props = {
  client: SalesClient;
  nowMs?: number;
  draft: string;
  saving: boolean;
  onDraft: (value: string) => void;
  onAdd: () => void;
};

export function ClientSalesLog({
  client,
  nowMs = Date.now(),
  draft,
  saving,
  onDraft,
  onAdd,
}: Props) {
  const rows = useMemo(
    () => buildSalesCardLog(client, nowMs) as LogRow[],
    [client, nowMs],
  );
  const canAdd = Boolean(draft.trim()) && !saving;

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-2.5 space-y-2 h-full min-h-0 flex flex-col">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
        <StickyNote size={12} />
        Logg
      </div>
      <textarea
        rows={2}
        maxLength={2000}
        value={draft}
        placeholder="Skriv et notat…"
        onChange={(event) => onDraft(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            if (canAdd) onAdd();
          }
        }}
        className="w-full px-2.5 py-2 rounded-lg bg-[#1a1a1a] border border-white/10 text-sm text-gray-200 placeholder:text-gray-500 resize-y"
      />
      <button
        type="button"
        onClick={onAdd}
        disabled={!canAdd}
        className="self-end inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[#FF5B00] text-white text-[11px] hover:bg-[#e55200] disabled:opacity-50"
      >
        {saving ? <Loader2 size={11} className="animate-spin" /> : null}
        {saving ? 'Lagrer…' : 'Legg til'}
      </button>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-1.5 max-h-[min(28rem,55dvh)]">
        {rows.length === 0 ? (
          <p className="text-xs text-gray-500">Ingen notater eller handlinger ennå.</p>
        ) : rows.map((row) => (
          <div key={row.id} className="rounded-lg border border-white/10 bg-black/30 px-2.5 py-2">
            <div className="flex items-baseline justify-between gap-2">
              <div className="min-w-0 text-sm text-white truncate">{row.name}</div>
              <div className="shrink-0 text-[11px] tabular-nums text-gray-400">{logWhen(row.at, nowMs)}</div>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] uppercase tracking-wide text-gray-500">
              <span>{KIND_LABEL[row.kind] || row.kind}</span>
              {row.formatLabel ? <span>{row.formatLabel}</span> : null}
            </div>
            {row.text ? (
              <p className="mt-1 text-[12px] text-gray-300 whitespace-pre-wrap break-words">{row.text}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
