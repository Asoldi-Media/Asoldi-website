import React from 'react';
import { API } from '../../Admin/shared';
import type { BoardGate, DevPayload, DevReportResponse } from './types';

function gateText(gate: BoardGate | null | undefined): string {
  if (!gate) return 'Ingen port';
  if (Array.isArray(gate.lines)) {
    const open = gate.lines.filter((line) => line.status && line.status !== 'have' && line.status !== 'waived').length;
    return `${gate.lines.length} linjer, ${open} åpne`;
  }
  if (typeof gate.lines === 'number') return `${gate.open ?? 0} av ${gate.lines} linjer åpne`;
  if (gate.status) return gate.status;
  return 'Ingen port';
}

function thumbSrc(itemId: string, sessionId: string, shot: string): string {
  return `${API}/admin/development/${encodeURIComponent(itemId)}/dev-report/shots/${encodeURIComponent(sessionId)}/${encodeURIComponent(shot)}`;
}

/** The stored dev report. The quality block is always labelled as a proposal. */
export function DevReportPanel({
  itemId,
  response,
  gate,
}: {
  itemId: string;
  response: DevReportResponse | null;
  gate?: BoardGate | null;
}) {
  const dev: DevPayload | null = response?.report?.dev || null;
  if (!dev) {
    return (
      <section data-testid="dev-report-panel" className="rounded-xl border border-white/10 bg-black/20 p-3">
        <h3 className="text-sm font-medium text-white">Utviklerrapport</h3>
        <p className="mt-2 text-xs text-gray-500">Ingen rapport ennå.</p>
      </section>
    );
  }
  const counts = dev.counts || {};
  const tasks = Number(counts.tasks) || 0;
  const proposal = dev.qaProposal;
  return (
    <section data-testid="dev-report-panel" className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-2 text-xs text-gray-200">
      <h3 className="text-sm font-medium text-white">Utviklerrapport</h3>
      <p>Steg: {dev.status || 'ukjent'}{dev.kind ? ` · ${dev.kind}` : ''}</p>
      <p>Port: {gateText(gate)}</p>
      <p>Brief: {dev.briefHash || 'ingen'}</p>
      <p>
        Oppgaver: {Number(counts.done) || 0} av {tasks} ferdige
        {` · trenger menneske ${Number(counts.needsHuman) || 0} · feilet ${Number(counts.failed) || 0} · tilbakestilt ${Number(counts.reverted) || 0}`}
      </p>
      <p>
        Kontroll før: harde {dev.auditBefore?.hard ?? 0}, myke {dev.auditBefore?.soft ?? 0}. Etter: harde {dev.auditAfter?.hard ?? 0}, myke {dev.auditAfter?.soft ?? 0}.
      </p>
      {Array.isArray(dev.directives) && dev.directives.length ? (
        <ul className="space-y-0.5">
          {dev.directives.map((row) => (
            <li key={row.id}>{row.id}: {row.status || 'ukjent'}</li>
          ))}
        </ul>
      ) : (
        <p>Direktiver i rapporten: 0 av 0.</p>
      )}
      {Array.isArray(dev.questions) && dev.questions.length ? (
        <ul className="space-y-0.5">
          {dev.questions.map((row) => (
            <li key={row.id || row.text}>{row.text}</li>
          ))}
        </ul>
      ) : null}
      <div className="rounded-lg border border-sky-700/40 bg-sky-950/30 p-2" aria-label="Forslag">
        <div className="font-medium text-sky-100">Forslag</div>
        <p>Dette er et forslag, ikke en beslutning.</p>
        {proposal ? (
          <p>
            Tekst {proposal.textOk ? 'ok' : 'ikke ok'} · media {proposal.mediaOk ? 'ok' : 'ikke ok'} · responsiv {proposal.responsiveOk ? 'ok' : 'ikke ok'}
            {proposal.evidence ? ` · ${proposal.evidence}` : ''}
          </p>
        ) : (
          <p>Ingen forslag i rapporten (0 av 0).</p>
        )}
      </div>
      {dev.sessionId && Array.isArray(dev.thumbs) && dev.thumbs.length ? (
        <div className="flex flex-wrap gap-2">
          {dev.thumbs.map((thumb) => (
            <span key={`${thumb.taskId}-${thumb.before}-${thumb.after}`} className="flex gap-1">
              {thumb.before ? <img alt="Før" className="h-16 w-auto rounded" src={thumbSrc(itemId, dev.sessionId || '', thumb.before)} /> : null}
              {thumb.after ? <img alt="Etter" className="h-16 w-auto rounded" src={thumbSrc(itemId, dev.sessionId || '', thumb.after)} /> : null}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
