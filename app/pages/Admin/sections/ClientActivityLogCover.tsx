import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { SalesClient, SalesClientMeeting } from '../shared';
import { buildClientActivityLog } from '../../../../lib/sales-activity-log.js';
import { MeetingVideoHover } from './MeetingVideoHover';
import { isDuplicateRow, isPlaceholderRow, realRowWaitingNote } from './firefliesRecording';
import {
  ExcludeMeetingButton,
  MeetingPurposePicker,
  PlaceholderRecordingActions,
  RecordingChip,
} from './MeetingRecordingControls';

type Props = {
  client: SalesClient;
  onClose: () => void;
  /** The client a recording button sent back, so the card behind the log updates too. */
  onClient?: (client: SalesClient) => void;
  /** Admin gets "Ikke denne kunden" on linked recordings. */
  isAdmin?: boolean;
};

/** lib/sales-activity-log.js presentMeeting, plus the placeholder fields newer hubs add. */
type LogMeeting = {
  meetingId: string;
  title: string;
  when: string;
  firefliesUrl: string;
  hasTranscript: boolean;
  hasVideo: boolean;
  purpose: string;
  placeholder?: boolean;
  recordingState?: string;
  recordingMessage?: string;
};

type LogRow = {
  kind: string;
  id: string;
  name: string;
  note: string;
  formatLabel: string;
  doneAt: string;
  at: string;
  meeting: LogMeeting | null;
};

type LogSection = { key: string; label: string; rows: LogRow[] };

function formatWhen(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' });
}

export function ClientActivityLogCover({ client, onClose, onClient, isAdmin = false }: Props) {
  // A button's answer shows here at once, also when nothing above passes the client back down.
  const [fresh, setFresh] = useState<SalesClient | null>(null);
  const [showDuplicates, setShowDuplicates] = useState(false);
  useEffect(() => setFresh(null), [client]);
  const current = fresh && fresh.id === client.id ? fresh : client;
  // Copies come along as rows of their own, so "Vis duplikater" can show them.
  const log = useMemo(() => buildClientActivityLog(current, { includeDuplicates: true }) as { sections: LogSection[] }, [current]);
  const rowsById = useMemo(() => {
    const map = new Map<string, SalesClientMeeting>();
    for (const row of Array.isArray(current.meetings) ? current.meetings : []) map.set(row.meetingId, row);
    return map;
  }, [current]);

  function applyClient(next: SalesClient) {
    setFresh(next);
    onClient?.(next);
  }

  function isDuplicateMeetingRow(row: LogRow) {
    return row.kind === 'meeting' && Boolean(row.meeting) && isDuplicateRow(rowsById.get(row.meeting.meetingId));
  }

  const duplicateCount = log.sections.reduce((sum, section) => sum + section.rows.filter(isDuplicateMeetingRow).length, 0);
  const sections = log.sections
    .map((section) => ({ ...section, rows: showDuplicates ? section.rows : section.rows.filter((row) => !isDuplicateMeetingRow(row)) }))
    .filter((section) => section.rows.length);

  function meetingBlock(meeting: LogMeeting) {
    const row = rowsById.get(meeting.meetingId) || null;
    if (meeting.placeholder || isPlaceholderRow(row || { meetingId: meeting.meetingId })) {
      // A booked meeting that stands in for its recording: say what happened, with no Fireflies link to follow.
      const state = meeting.recordingState || row?.recording?.state || '';
      const message = meeting.recordingMessage || row?.recording?.message || '';
      return (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="px-2 py-1 rounded-md bg-white/10 text-gray-300">
              {meeting.title}{meeting.when ? ` · ${meeting.when}` : ''}
            </span>
            {state ? <RecordingChip state={state} /> : <span className="text-gray-400">Ingen opptak koblet ennå</span>}
            <PlaceholderRecordingActions clientId={current.id} meetingId={meeting.meetingId} state={state} onClient={applyClient} />
          </div>
          {message ? <p className="text-[11px] text-gray-400">{message}</p> : null}
        </div>
      );
    }
    return (
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className={`px-2 py-1 rounded-md ${
          meeting.hasTranscript ? 'bg-[#FF5B00]/20 text-white' : 'bg-white/10 text-gray-300'
        }`}>
          {meeting.title}{meeting.when ? ` · ${meeting.when}` : ''}
          {meeting.hasTranscript ? '' : ` · ${realRowWaitingNote(row || meeting, current.meetings || []) || 'venter på transkript'}`}
        </span>
        {isDuplicateRow(row) ? (
          <span className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] text-gray-400" title="Kortere eller tom kopi av et annet opptak av samme møte">duplikat</span>
        ) : null}
        {meeting.firefliesUrl ? (
          <a
            href={meeting.firefliesUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[#FF5B00] hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            <ExternalLink size={12} /> Fireflies
          </a>
        ) : null}
        <MeetingPurposePicker
          clientId={current.id}
          meetingId={meeting.meetingId}
          purpose={row?.purpose || meeting.purpose}
          onClient={applyClient}
        />
        {isAdmin ? (
          <ExcludeMeetingButton
            clientId={current.id}
            meetingId={meeting.meetingId}
            title={meeting.title}
            businessName={current.businessName}
            onClient={applyClient}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex flex-col bg-[#1a1a1a] text-white"
      role="dialog"
      aria-modal="true"
      aria-label="Kundelogg"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="shrink-0 border-b border-white/10 px-3 sm:px-5 py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold truncate text-sm sm:text-base">{current.businessName || 'Kunde'}</div>
          <div className="text-[11px] text-gray-400">Logg · handlinger og opptak i kronologisk rekkefølge</div>
        </div>
        <div className="flex items-center gap-2">
          {duplicateCount > 0 ? (
            <button
              type="button"
              onClick={() => setShowDuplicates((value) => !value)}
              className="px-3 py-2 rounded-lg bg-white/10 text-xs text-gray-200 hover:bg-white/15"
              title="Kortere eller tomme kopier av opptak av samme møte"
            >
              {showDuplicates ? 'Skjul duplikater' : `Vis duplikater (${duplicateCount})`}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-lg bg-white/10 text-sm text-white hover:bg-white/15"
          >
            Lukk
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-3 sm:px-5 py-4">
        <div className="max-w-3xl mx-auto space-y-5">
          {sections.length === 0 ? (
            <p className="text-sm text-gray-400">Ingen handlinger eller opptak er logget ennå.</p>
          ) : sections.map((section) => (
            <section key={section.key} className="space-y-2">
              <h2 className="text-[11px] uppercase tracking-wide text-gray-400">{section.label}</h2>
              <div className="space-y-2">
                {section.rows.map((row) => {
                  const meeting = row.meeting;
                  const placeholder = Boolean(meeting) && (Boolean(meeting.placeholder) || isPlaceholderRow(rowsById.get(meeting.meetingId) || { meetingId: meeting.meetingId }));
                  const body = (
                    <div className={`rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 space-y-1.5 ${isDuplicateMeetingRow(row) ? 'opacity-60' : ''}`}>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm text-white">{row.name}</span>
                        {row.formatLabel ? (
                          <span className="px-1.5 py-0.5 rounded bg-white/10 text-[10px] text-gray-300">{row.formatLabel}</span>
                        ) : null}
                        {row.doneAt ? (
                          <span className="px-1.5 py-0.5 rounded bg-green-900/40 text-[10px] text-green-300">Ferdig</span>
                        ) : null}
                        {row.at ? (
                          <span className="text-[11px] text-gray-400">{formatWhen(row.at)}</span>
                        ) : null}
                      </div>
                      {row.note ? <p className="text-[12px] text-gray-300 whitespace-pre-wrap">{row.note}</p> : null}
                      {meeting ? meetingBlock(meeting) : null}
                    </div>
                  );
                  // A placeholder has no Fireflies record behind it: no hover video and no meeting card.
                  if (!meeting?.meetingId || placeholder) return <div key={row.id}>{body}</div>;
                  return (
                    <React.Fragment key={row.id}>
                      <MeetingVideoHover meetingId={meeting.meetingId} hasVideo={meeting.hasVideo}>
                        {body}
                      </MeetingVideoHover>
                    </React.Fragment>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
