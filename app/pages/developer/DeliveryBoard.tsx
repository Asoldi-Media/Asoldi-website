import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DeliveryAlertsBanner } from './board/DeliveryAlertsBanner';
import { DeliveryCard } from './DeliveryCard';
import {
  FALLBACK_LANE,
  LANES,
  applyBoardStatus,
  groupBoard,
  partitionBoard,
  tierOf,
  type BoardParts,
} from './board/lanes';
import type { BoardItem, BoardSnapshot } from './board/types';
import { boardFetch, readBoardJson, useBoardPoll } from './board/useBoardPoll';

type Props = {
  snapshot?: BoardSnapshot | null;
  poll?: boolean;
  pageHostname?: string;
  viewerAccountKey?: string;
  onLogout?: () => void;
};

function allItems(parts: BoardParts): BoardItem[] {
  return [...parts.development, ...parts.preview, ...parts.ssu];
}

/** Lanes, filters and the separate SSU section. One poll covers the whole board. */
export function DeliveryBoard({ snapshot = null, poll, pageHostname, viewerAccountKey, onLogout }: Props) {
  const live = poll ?? snapshot == null;
  const [parts, setParts] = useState<BoardParts>(() => partitionBoard(snapshot));
  const [alerts, setAlerts] = useState(snapshot?.alerts || []);
  const [ownerKey, setOwnerKey] = useState(viewerAccountKey || snapshot?.viewer?.accountKey || '');
  const [mine, setMine] = useState(false);
  const [tier, setTier] = useState('');
  const [blockedOnly, setBlockedOnly] = useState(false);
  const [error, setError] = useState('');
  const sinceRef = useRef(Number(snapshot?.rev) || 0);

  useEffect(() => {
    if (snapshot) return undefined;
    let active = true;
    void boardFetch('/admin/development').then(async (response) => {
      if (!active) return;
      const body = await readBoardJson<BoardSnapshot>(response);
      if (!response.ok || !body) {
        setError('Kunne ikke hente tavlen.');
        return;
      }
      setParts(partitionBoard(body));
      setAlerts(Array.isArray(body.alerts) ? body.alerts : []);
      if (body.viewer?.accountKey && !viewerAccountKey) setOwnerKey(body.viewer.accountKey);
      if (typeof body.rev === 'number') sinceRef.current = body.rev;
    }).catch(() => {
      if (active) setError('Kunne ikke hente tavlen.');
    });
    return () => {
      active = false;
    };
  }, [snapshot, viewerAccountKey]);

  useBoardPoll({
    enabled: live,
    sinceRef,
    onStatus: (body) => {
      setParts((current) => applyBoardStatus(current, body));
      if (Array.isArray(body.alerts)) setAlerts(body.alerts);
      if (typeof body.rev === 'number') sinceRef.current = body.rev;
      setError('');
    },
    onError: () => setError('Kunne ikke oppdatere tavlen.'),
  });

  const grouped = useMemo(
    () => groupBoard(parts, { mine, tier, blocked: blockedOnly, ownerKey }),
    [parts, mine, tier, blockedOnly, ownerKey],
  );
  const tiers = [...new Set(allItems(parts).map(tierOf).filter(Boolean))].sort();
  const shown = [...grouped.lanes.values()].reduce((sum, list) => sum + list.length, 0) + grouped.ssu.length;
  const total = allItems(parts).length;
  const hostname = pageHostname ?? (typeof window !== 'undefined' ? window.location.hostname : '');

  return (
    <div data-testid="delivery-board" className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pb-6">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-testid="board-filter-mine" aria-pressed={mine} onClick={() => setMine((value) => !value)} className={`rounded-lg px-3 py-1.5 text-xs ${mine ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-gray-200'}`}>Mine</button>
        <label className="text-xs text-gray-300">
          Tier
          <select data-testid="board-filter-tier" value={tier} onChange={(event) => setTier(event.target.value)} className="ml-2 rounded bg-[#1a1a1a] border border-white/15 px-2 py-1 text-xs text-white">
            <option value="">Alle</option>
            {tiers.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <button type="button" data-testid="board-filter-blocked" aria-pressed={blockedOnly} onClick={() => setBlockedOnly((value) => !value)} className={`rounded-lg px-3 py-1.5 text-xs ${blockedOnly ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-gray-200'}`}>Blokkert</button>
        <span className="text-[11px] text-gray-500">Viser {shown} av {total} kort</span>
        {onLogout ? (
          <button type="button" onClick={onLogout} className="ml-auto rounded-lg bg-white/10 px-3 py-1.5 text-xs text-gray-200">Logg ut</button>
        ) : null}
      </div>
      {error ? <p className="text-xs text-red-300">{error}</p> : null}
      <DeliveryAlertsBanner alerts={alerts} items={allItems(parts)} />
      <div className="grid gap-3">
        {LANES.map((lane) => (
          <section key={lane.key} data-testid={`board-lane-${lane.key}`} className="rounded-xl border border-white/10 p-3 space-y-2">
            <h2 className="text-sm font-medium text-white">{lane.title}</h2>
            {(grouped.lanes.get(lane.key) || []).map((item) => (
              <DeliveryCard key={item.id} item={item} pageHostname={hostname} />
            ))}
          </section>
        ))}
        {(grouped.lanes.get(FALLBACK_LANE.key) || []).length ? (
          <section data-testid={`board-lane-${FALLBACK_LANE.key}`} className="rounded-xl border border-amber-700/40 p-3 space-y-2">
            <h2 className="text-sm font-medium text-white">{FALLBACK_LANE.title}</h2>
            {(grouped.lanes.get(FALLBACK_LANE.key) || []).map((item) => (
              <DeliveryCard key={item.id} item={item} pageHostname={hostname} />
            ))}
          </section>
        ) : null}
      </div>
      <section data-testid="ssu-section" className="rounded-xl border border-white/10 p-3 space-y-2">
        <h2 className="text-sm font-medium text-white">SSU</h2>
        {grouped.ssu.length ? grouped.ssu.map((item) => (
          <DeliveryCard key={item.id} item={item} pageHostname={hostname} />
        )) : <p className="text-xs text-gray-500">Ingen SSU-kort (0 av {parts.ssu.length}).</p>}
      </section>
    </div>
  );
}
