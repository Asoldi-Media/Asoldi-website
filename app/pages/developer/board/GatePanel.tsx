import React, { useState } from 'react';
import type { BoardDetail, BoardGate, BoardItem, GateLine } from './types';
import { clientIdOf } from './lanes';
import { boardFetch, readBoardJson } from './useBoardPoll';

function linesOf(gate: BoardGate | null | undefined): GateLine[] {
  return gate && Array.isArray(gate.lines) ? gate.lines : [];
}

function groupName(line: GateLine): string {
  return String(line.group || 'Annet');
}

/** Grouped gate lines, a waive menu, the optional start approval, and the readiness lines. */
export function GatePanel({ item, detail, onUpdated }: { item: BoardItem; detail: BoardDetail | null; onUpdated?: () => void }) {
  const gate = detail?.gate || item.delivery?.gate || null;
  const lines = linesOf(gate);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const groups = new Map<string, GateLine[]>();
  for (const line of lines) {
    const name = groupName(line);
    const list = groups.get(name) || [];
    list.push(line);
    groups.set(name, list);
  }
  const salesId = clientIdOf(item);

  async function waive(lineId: string, option: string) {
    if (!salesId) return;
    setBusy(true);
    setError('');
    try {
      const response = await boardFetch(`/admin/delivery/gate/${encodeURIComponent(salesId)}/waivers/${encodeURIComponent(lineId)}`, {
        method: option ? 'PUT' : 'DELETE',
        body: option ? JSON.stringify({ option }) : undefined,
      });
      if (!response.ok) setError('Fraskrivelsen ble ikke lagret.');
      else onUpdated?.();
    } catch {
      setError('Fraskrivelsen ble ikke lagret.');
    } finally {
      setBusy(false);
    }
  }

  async function approveStart() {
    if (!salesId) return;
    setBusy(true);
    setError('');
    try {
      const response = await boardFetch(`/admin/delivery/gate/${encodeURIComponent(salesId)}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approve: true }),
      });
      const body = await readBoardJson<{ message?: string }>(response);
      if (!response.ok) setError(body?.message && body.message.length < 160 ? body.message : 'Godkjenningen ble ikke lagret.');
      else onUpdated?.();
    } catch {
      setError('Godkjenningen ble ikke lagret.');
    } finally {
      setBusy(false);
    }
  }

  const missingDev = Array.isArray(gate?.missingDev) ? gate.missingDev : [];
  const missingReady = Array.isArray(gate?.missingReady) ? gate.missingReady : [];

  return (
    <section data-testid="gate-panel" className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-white">Port</h3>
        <div className="text-right">
          <button
            type="button"
            data-testid="gate-approve-start"
            disabled={busy || !salesId}
            onClick={() => void approveStart()}
            className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white hover:bg-white/10 disabled:opacity-50"
          >
            Godkjenn start
          </button>
          <p className="mt-1 max-w-xs text-[10px] text-gray-500">Valgfri overstyring. Porten flytter kunden videre uten klikk når automatisk godkjenning er på.</p>
        </div>
      </div>
      <div className="text-xs text-gray-300 space-y-1">
        <p>Klar for utvikling: {gate?.devComplete ? 'ja' : 'nei'} ({missingDev.length} av {lines.length || missingDev.length} mangler)</p>
        <p>Klar for publisering: {gate?.readyComplete || gate?.passed ? 'ja' : 'nei'} ({missingReady.length} mangler)</p>
        {missingDev.length ? <p>Mangler før start: {missingDev.join(', ')}</p> : null}
        {missingReady.length ? <p>Mangler før publisering: {missingReady.join(', ')}</p> : null}
      </div>
      {[...groups.entries()].map(([name, rows]) => (
        <div key={name}>
          <h4 className="mb-1 text-[11px] uppercase tracking-wide text-gray-500">{name}</h4>
          <ul className="space-y-1">
            {rows.map((line) => (
              <li key={line.id} className="flex flex-wrap items-center gap-2 text-xs text-gray-200">
                <span className="min-w-0 flex-1">{line.label || line.askText || line.id}</span>
                <span className="text-gray-400">{line.status || ''}</span>
                <select
                  aria-label={`Fraskriv ${line.label || line.id}`}
                  disabled={busy}
                  value={line.waiver?.option || ''}
                  onChange={(event) => void waive(line.id, event.target.value)}
                  className="rounded bg-[#1a1a1a] border border-white/15 px-1 py-0.5 text-[11px]"
                >
                  <option value="">Ikke fraskrevet</option>
                  {(line.waiveOptions || []).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {Array.isArray(gate?.info) && gate.info.length ? (
        <ul className="text-[11px] text-gray-400">
          {gate.info.map((row) => (
            <li key={row.id}>{row.id}{row.detail ? `: ${row.detail}` : ''}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
    </section>
  );
}
