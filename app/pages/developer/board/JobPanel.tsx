import React, { useState } from 'react';
import type { BoardDetail, BoardGate, BoardItem, BoardJob, DevReportResponse } from './types';
import { boardFetch, readBoardJson } from './useBoardPoll';
import { DevReportPanel } from './DevReportPanel';

function currentJob(item: BoardItem, detail: BoardDetail | null): BoardJob | null {
  if (item.delivery?.job) return item.delivery.job;
  const jobs = detail?.jobs;
  return Array.isArray(jobs) && jobs.length ? jobs[0] : null;
}

/** Job status and the optional overrides. The dev report sits under the job. */
export function JobPanel({
  item,
  detail,
  report,
  onChanged,
}: {
  item: BoardItem;
  detail: BoardDetail | null;
  report: DevReportResponse | null;
  onChanged?: () => void;
}) {
  const job = currentJob(item, detail);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const gate: BoardGate | null = detail?.gate || item.delivery?.gate || null;

  async function act(path: string, body?: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const response = await boardFetch(path, body ? { method: 'POST', body: JSON.stringify(body) } : { method: 'POST' });
      const payload = await readBoardJson<{ message?: string; code?: string }>(response);
      if (!response.ok) setError(payload?.message && payload.message.length < 160 ? payload.message : 'Handlingen ble ikke utført.');
      else onChanged?.();
    } catch {
      setError('Handlingen ble ikke utført.');
    } finally {
      setBusy(false);
    }
  }

  const log = Array.isArray(job?.logTail) ? job.logTail.slice(-20) : [];
  const warnings = Array.isArray(job?.warnings) ? job.warnings : [];

  return (
    <section data-testid="job-panel" className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-2 text-xs text-gray-200">
      <h3 className="text-sm font-medium text-white">Jobb</h3>
      <p>Status: {job?.status || 'ingen'}{job?.kind ? ` · ${job.kind}` : ''}</p>
      <p>Vert: {job?.hostId || item.hostStatus?.hostId || 'ingen'}{item.hostStatus ? ` · ${item.hostStatus.online ? 'på' : 'av'}` : ''}</p>
      <p>Fremdrift: {typeof job?.progress === 'number' ? `${job.progress} %` : 'ikke rapportert'}</p>
      <div>
        <div className="text-[11px] uppercase tracking-wide text-gray-500">Logg</div>
        {log.length ? <pre className="whitespace-pre-wrap text-[11px] text-gray-400">{log.join('\n')}</pre> : <p className="text-gray-500">Ingen logg (0 linjer).</p>}
      </div>
      <p>Advarsler: {warnings.length ? warnings.join(', ') : '0 av 0'}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="job-retry" disabled={busy || !job?.id} onClick={() => job?.id && void act(`/admin/delivery/jobs/${encodeURIComponent(job.id)}/retry`)} className="rounded-lg bg-white/10 px-2 py-1 disabled:opacity-50">Prøv igjen</button>
        <button type="button" data-testid="job-cancel" disabled={busy || !job?.id} onClick={() => job?.id && void act(`/admin/delivery/jobs/${encodeURIComponent(job.id)}/cancel`)} className="rounded-lg bg-white/10 px-2 py-1 disabled:opacity-50">Avbryt</button>
      </div>
      <p className="text-[10px] text-gray-500">Kjør nå og godkjenn og send preview mangler jobbtype i backend (bare preview kan settes i kø av admin). Rapporten kan flytte kunden videre uten klikk når automatisk godkjenning er på.</p>
      {error ? <p className="text-red-300">{error}</p> : null}
      <DevReportPanel itemId={item.id} response={report} gate={gate} />
    </section>
  );
}
