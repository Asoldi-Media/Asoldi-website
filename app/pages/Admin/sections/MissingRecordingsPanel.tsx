import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ExternalLink, MicOff } from 'lucide-react';
import { isMissingRoute, listMissingFirefliesRecordings, type MissingRecordingRow } from '../../sales/emailApi';
import type { SalesClient } from '../shared';
import { recordingWhen, slotKindLabel } from './firefliesRecording';
import { PlaceholderRecordingActions, RecordingChip } from './MeetingRecordingControls';

const REFRESH_MS = 5 * 60_000;

function rowKey(row: MissingRecordingRow) {
  return `${row.clientId}|${row.meetingId || row.slotKey}`;
}

/**
 * "Møter uten opptak": booked meetings of the last 60 days that ended with no recording and that nobody has
 * marked yet (GET /api/admin/fireflies/missing-recordings; admin sees all, a rep their own clients).
 * Hidden while the list is empty, and on a hub that does not have the route.
 */
export function MissingRecordingsPanel({ active = true, nowMs, refreshKey = 0, onOpenClient, onClient }: {
  active?: boolean;
  nowMs: number;
  /** Bump to read the list again (after a rep changed a recording somewhere else). */
  refreshKey?: number;
  onOpenClient: (row: MissingRecordingRow) => void;
  onClient?: (client: SalesClient) => void;
}) {
  const [rows, setRows] = useState<MissingRecordingRow[]>([]);
  const [open, setOpen] = useState(false);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const data = await listMissingFirefliesRecordings();
      setRows(Array.isArray(data.rows) ? data.rows.filter((row) => row && row.clientId) : []);
    } catch (error) {
      // An older hub has no list (so none is shown). Anything else, such as a proxy page while the hub
      // restarts, keeps the last list until the next try: the list must never vanish for good on one bad answer.
      if (isMissingRoute(error)) setRows([]);
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, load, refreshKey]);

  if (!rows.length) return null;

  return (
    <div className="relative rounded-2xl border border-red-500/40 bg-red-900/30 p-3 sm:p-4">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 text-left"
      >
        <span className="inline-flex items-center gap-2 text-sm font-medium text-red-200">
          <MicOff size={16} />
          Møter uten opptak
          <span className="inline-flex min-w-6 h-6 items-center justify-center rounded-full bg-red-500 text-white text-xs font-semibold px-1.5">
            {rows.length}
          </span>
        </span>
        <ChevronDown size={16} className={`text-red-200 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open ? (
        <div className="mt-3 rounded-xl border border-white/10 bg-[#1a1a1a] overflow-hidden">
          <p className="px-3 pt-2.5 text-[11px] text-gray-400">
            Fireflies leverte ikke noe opptak fra disse møtene. Har noen tatt det opp selv, lim inn lenken under Bytt opptak i Tilbud. Ble møtet holdt uten opptak, marker det.
          </p>
          {rows.map((row) => (
            <div key={rowKey(row)} className="px-3 py-2.5 border-b border-white/5 last:border-b-0 space-y-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-white">{row.businessName || 'Uten navn'}</span>
                <span className="text-[11px] text-gray-400">
                  {[slotKindLabel(row.kind), recordingWhen(row.startedAt, nowMs)].filter(Boolean).join(' · ')}
                </span>
                <RecordingChip state={row.state} />
              </div>
              {row.message ? <p className="text-[11px] text-gray-400">{row.message}</p> : null}
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onOpenClient(row)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/10 text-[11px] text-gray-100 hover:bg-white/15"
                >
                  <ExternalLink size={11} />
                  Åpne kunde
                </button>
                <PlaceholderRecordingActions
                  clientId={row.clientId}
                  meetingId={row.meetingId}
                  slotKey={row.slotKey}
                  state={row.state}
                  onClient={onClient}
                  onDone={(state) => {
                    if (state === 'declined') setRows((current) => current.filter((item) => rowKey(item) !== rowKey(row)));
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
