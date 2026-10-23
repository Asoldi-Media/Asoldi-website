import React, { useState } from 'react';
import type { SalesClient, SalesClientMeeting } from '../shared';
import { isDuplicateRow, isPlaceholderRow, realRowWaitingNote, visibleMeetingRows } from './firefliesRecording';
import {
  ExcludeMeetingButton,
  MeetingPurposePicker,
  PlaceholderRecordingActions,
  RecordingChip,
} from './MeetingRecordingControls';

function rowStartMs(row: SalesClientMeeting) {
  const ms = Date.parse(row.startedAt || row.linkedAt || '');
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The client's recordings and the booked meetings still without one, newest first, with the activity log's
 * buttons: "Marker uten opptak" / "Angre" on a booked meeting, the purpose picker on a recording, and admin's
 * "Ikke denne kunden". For boards whose meeting log is read-only text (the admin board, where workshops and
 * iterations are held).
 */
export function ClientRecordingsPanel({ client, onClient, isAdmin = false }: {
  client: SalesClient;
  onClient?: (client: SalesClient) => void;
  isAdmin?: boolean;
}) {
  const [showDuplicates, setShowDuplicates] = useState(false);
  const rows = Array.isArray(client.meetings) ? client.meetings : [];
  if (!rows.length) return null;
  const shown = visibleMeetingRows(rows, { showDuplicates }).sort((a, b) => rowStartMs(b) - rowStartMs(a));
  const duplicates = rows.filter((row) => isDuplicateRow(row)).length;

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-2.5 space-y-2" data-client-recordings>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Opptak</div>
        {duplicates ? (
          <button
            type="button"
            onClick={() => setShowDuplicates((value) => !value)}
            className="px-2 py-1 rounded-md bg-white/10 text-[11px] text-gray-300 hover:bg-white/15"
            title="Kortere eller tomme kopier av opptak av samme møte"
          >
            {showDuplicates ? 'Skjul duplikater' : `Vis duplikater (${duplicates})`}
          </button>
        ) : null}
      </div>
      <ul className="space-y-1.5">
        {shown.map((row) => {
          const placeholder = isPlaceholderRow(row);
          const state = row.recording?.state || '';
          return (
            <li key={row.meetingId} className={`space-y-1 ${isDuplicateRow(row) ? 'opacity-60' : ''}`}>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-gray-200">{row.title || 'Møte'}{row.when ? ` · ${row.when}` : ''}</span>
                {placeholder ? (
                  <>
                    {state ? <RecordingChip state={state} message={row.recording?.message} /> : <span className="text-gray-400">Ingen opptak koblet ennå</span>}
                    <PlaceholderRecordingActions clientId={client.id} meetingId={row.meetingId} state={state} onClient={onClient} />
                  </>
                ) : (
                  <>
                    {row.hasTranscript ? null : <span className="text-gray-400">{realRowWaitingNote(row, rows)}</span>}
                    {isDuplicateRow(row) ? (
                      <span className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] text-gray-400">duplikat</span>
                    ) : null}
                    <MeetingPurposePicker clientId={client.id} meetingId={row.meetingId} purpose={row.purpose || ''} onClient={onClient} />
                    {isAdmin ? (
                      <ExcludeMeetingButton
                        clientId={client.id}
                        meetingId={row.meetingId}
                        title={row.title}
                        businessName={client.businessName}
                        onClient={onClient}
                      />
                    ) : null}
                  </>
                )}
              </div>
              {placeholder && row.recording?.message ? <p className="text-[11px] text-gray-400">{row.recording.message}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
