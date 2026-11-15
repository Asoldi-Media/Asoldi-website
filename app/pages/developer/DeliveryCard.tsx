import React, { useRef, useState } from 'react';
import { DeveloperSeoPanel } from './DeveloperSeoPanel';
import { approveSeoKeyword, fetchSeoRecord } from './seoRecordApi';
import { authHeaders, developmentAuthHeaders } from '../Admin/shared';
import { BlockingFixActions } from './board/BlockingFixActions';
import { BriefTabs } from './board/BriefTabs';
import { ChangeRequestList } from './board/ChangeRequestList';
import { CursorPromptButton } from './board/CursorPromptButton';
import { DirectiveList } from './board/DirectiveList';
import { GatePanel } from './board/GatePanel';
import { JobPanel } from './board/JobPanel';
import { LegacyChecklist } from './board/LegacyChecklist';
import { StageStepper } from './board/StageStepper';
import {
  clientIdOf,
  dueLabel,
  isBlocked,
  laneForItem,
  makerOrigin,
  servicesOf,
  stageOf,
  tierOf,
} from './board/lanes';
import type { BoardDetail, BoardDirective, BoardItem, CardCache, DevReportResponse } from './board/types';
import { boardFetch, readBoardJson } from './board/useBoardPoll';

type Props = {
  item: BoardItem;
  pageHostname?: string;
  defaultExpanded?: boolean;
  initialCache?: CardCache | null;
};

async function loadCard(item: BoardItem): Promise<CardCache> {
  const id = encodeURIComponent(item.id);
  const [detailResponse, reportResponse] = await Promise.all([
    boardFetch(`/admin/development/${id}/detail`),
    boardFetch(`/admin/development/${id}/dev-report`),
  ]);
  const detailBody = await readBoardJson<{ detail?: BoardDetail }>(detailResponse);
  const report = await readBoardJson<DevReportResponse>(reportResponse);
  const detail = detailResponse.ok && detailBody?.detail ? detailBody.detail : null;
  let directives: BoardDirective[] = [];
  const salesId = clientIdOf(item);
  if (salesId) {
    const briefResponse = await boardFetch(`/admin/development/${encodeURIComponent(salesId)}/brief`);
    const brief = await readBoardJson<{ directives?: BoardDirective[] }>(briefResponse);
    if (briefResponse.ok && Array.isArray(brief?.directives)) directives = brief.directives;
  }
  if (!directives.length && Array.isArray(detail?.brief?.directives)) {
    directives = detail.brief.directives as BoardDirective[];
  }
  return {
    detail,
    report: reportResponse.ok ? report : { report: null },
    directives,
  };
}

/** One client card. Detail routes run the first time the card is opened, then stay cached. */
export function DeliveryCard({ item, pageHostname = '', defaultExpanded = false, initialCache = null }: Props) {
  const [open, setOpen] = useState(defaultExpanded);
  const cache = useRef<CardCache | null>(initialCache);
  const [version, setVersion] = useState(0);
  const [failed, setFailed] = useState(false);
  const clientId = clientIdOf(item);
  const blocked = isBlocked(item);
  const stage = stageOf(item);
  const tier = tierOf(item);
  const services = servicesOf(item);
  const host = item.hostStatus;
  const spend = item.aiSpendSummary;
  const origin = makerOrigin(item.makerPort, pageHostname);
  const runId = String(item.makerRun?.runId || '');
  const makerHref = origin && runId ? `${origin}/run/${encodeURIComponent(runId)}` : '';

  function load() {
    void loadCard(item).then((loaded) => {
      cache.current = loaded;
      setFailed(false);
      setVersion((value) => value + 1);
    }).catch(() => setFailed(true));
  }

  function reveal() {
    const next = !open;
    setOpen(next);
    if (next && !cache.current) load();
  }

  const cached = cache.current;
  const staffHeaders = { ...authHeaders(), ...developmentAuthHeaders() };

  return (
    <article
      data-testid={`delivery-card-${clientId}`}
      data-stage={stage || 'unknown'}
      data-blocked={blocked ? 'true' : 'false'}
      data-lane={laneForItem(item).key}
      className="rounded-xl border border-white/10 bg-[#161616] p-3 space-y-2"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-white">{item.businessName || 'Uten navn'}</h3>
          <p className="text-[11px] text-gray-400">{services.length ? services.join(', ') : 'Ingen tjenester'}</p>
        </div>
        <button type="button" data-testid="card-expand" aria-expanded={open} onClick={reveal} className="rounded-lg bg-white/10 px-2 py-1 text-[11px] text-white">
          {open ? 'Skjul' : 'Vis detaljer'}
        </button>
      </div>
      <div className="flex flex-wrap gap-2 text-[11px]">
        <span data-testid="card-tier" className="rounded bg-[#FF5B00]/20 px-1.5 py-0.5 text-[#ffb088]">{tier || 'Uten tier'}</span>
        <span data-testid="card-stage">{laneForItem(item).title}</span>
        <span data-testid="card-due">{dueLabel(item)}</span>
        <span data-testid="card-owner">{item.developerOwnerId || 'Ingen eier'}</span>
        <span data-testid="card-host">{host ? `${host.hostId || 'vert'} · ${host.online ? 'på' : 'av'}` : 'Ingen vert'}</span>
        <span data-testid="card-spend">{typeof spend?.totalUsd === 'number' ? `${spend.totalUsd.toFixed(2)} USD` : '0.00 USD'}</span>
      </div>
      <StageStepper item={item} />
      {open ? (
        <div className="space-y-3" data-loaded={version}>
          {failed ? <p className="text-[11px] text-red-300">Detaljene kunne ikke hentes.</p> : null}
          <BlockingFixActions item={item} pageHostname={pageHostname} onChanged={() => { cache.current = null; load(); }} />
          <GatePanel item={item} detail={cached?.detail || null} />
          <BriefTabs item={item} detail={cached?.detail || null} />
          <DirectiveList item={item} directives={cached?.directives || []} />
          <JobPanel item={item} detail={cached?.detail || null} report={cached?.report || null} />
          <ChangeRequestList item={item} detail={cached?.detail || null} />
          <CursorPromptButton item={item} />
          <LegacyChecklist item={item} />
          {clientId ? <DeveloperSeoPanel salesClientId={clientId} authHeaders={staffHeaders} canEdit /> : null}
          <button
            type="button"
            data-testid="keywords-approve"
            onClick={() => {
              if (!clientId) return;
              void fetchSeoRecord(clientId, staffHeaders).then(async (answer) => {
                const phrase = answer.record?.agreedKeywords?.find((row) => row.status === 'proposed')?.phrase;
                if (phrase) await approveSeoKeyword(clientId, phrase, staffHeaders);
              }).catch(() => undefined);
            }}
            className="rounded-lg bg-white/10 px-2 py-1 text-[11px] text-white"
          >
            Godkjenn søkeord
          </button>
          {makerHref ? (
            <a data-testid="open-maker" href={makerHref} className="inline-flex text-xs text-[#FF5B00] underline">Åpne Maker</a>
          ) : (
            <button type="button" data-testid="open-maker" disabled className="text-xs text-gray-500">Åpne Maker</button>
          )}
        </div>
      ) : null}
    </article>
  );
}
