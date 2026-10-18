import React, { useMemo, useState } from 'react';
import { buildClientActivityLog } from '../../../../lib/sales-activity-log.js';
import {
  RequestThreadPanel,
  type ExtraMessage,
  type RequestAuthHeaders,
  type ThreadFeedGroup,
  type ThreadKindFilter,
} from '../../developer/DeveloperRequestThread';

type LogRow = {
  id: string;
  name: string;
  note: string;
  formatLabel: string;
  doneAt: string;
  at: string;
  meeting: { title: string; when: string; hasTranscript: boolean } | null;
};

type LogSection = { key: string; label: string; rows: LogRow[] };

const CHIPS: Array<{ id: ThreadKindFilter; label: string }> = [
  { id: 'all', label: 'Alle' },
  { id: 'request', label: 'Forespørsler' },
  { id: 'iteration', label: 'Iterasjon' },
  { id: 'workshop', label: 'Workshop' },
  { id: 'log', label: 'Logg' },
];

function groupFor(sectionKey: string): ThreadFeedGroup {
  if (sectionKey === 'workshop') return 'workshop';
  if (sectionKey === 'iteration') return 'iteration';
  return 'log';
}

/** Workshop notes, iteration log and the action/meeting log as read-only feed rows. */
export function clientFeedMessages(
  logSource: Record<string, unknown>,
  transcript?: { text: string; at: string },
): ExtraMessage[] {
  const log = buildClientActivityLog(logSource) as { sections: LogSection[] };
  const rows: ExtraMessage[] = [];
  for (const section of log.sections) {
    const group = groupFor(section.key);
    for (const row of section.rows) {
      const tags = [row.formatLabel, row.doneAt ? 'ferdig' : ''].filter(Boolean).join(', ');
      const meeting = row.meeting
        ? `${row.meeting.title}${row.meeting.when ? ` · ${row.meeting.when}` : ''}${row.meeting.hasTranscript ? '' : ' · venter på transkript'}`
        : '';
      rows.push({
        id: `log-${row.id}`,
        at: row.at,
        group,
        authorLabel: `${group === 'log' ? `${section.label} · ` : ''}${row.name}${tags ? ` (${tags})` : ''}`,
        text: [row.note, meeting].filter(Boolean).join('\n'),
      });
    }
  }
  if (transcript?.text) {
    rows.push({ id: 'iteration-transcript', at: transcript.at, group: 'iteration', authorLabel: 'Transkript', text: transcript.text });
  }
  return rows;
}

type Props = {
  salesClientId: string;
  authHeaders: RequestAuthHeaders;
  messages: ExtraMessage[];
  unread?: number;
  makerRunId?: string;
  websiteMakerBaseUrl?: string;
  allowCommit?: boolean;
};

/** Right column on the admin and developer focus cards: requests (reply + files) and every note in one feed. */
export function ClientNotesFeed({
  salesClientId,
  authHeaders,
  messages,
  unread = 0,
  makerRunId = '',
  websiteMakerBaseUrl = '',
  allowCommit = false,
}: Props) {
  const [filter, setFilter] = useState<ThreadKindFilter>('all');
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const message of messages) out[message.group || 'iteration'] = (out[message.group || 'iteration'] || 0) + 1;
    return out;
  }, [messages]);
  if (!salesClientId) return null;

  return (
    <div className="rounded-xl border border-white/10 bg-black/20 p-2.5 space-y-2 h-full flex flex-col" onClick={(event) => event.stopPropagation()}>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Forespørsler, notater og logg</div>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Vis i feeden">
        {CHIPS.map((chip) => {
          const selected = filter === chip.id;
          const count = chip.id === 'all' || chip.id === 'request' ? 0 : counts[chip.id] || 0;
          return (
            <button
              key={chip.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setFilter(chip.id)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border ${
                selected
                  ? 'bg-[#FF5B00] border-[#FF5B00] text-white'
                  : 'bg-white/5 border-white/10 text-gray-300 hover:bg-white/10'
              }`}
            >
              {chip.label}
              {count ? <span className="tabular-nums opacity-75">{count}</span> : null}
              {chip.id === 'request' && unread > 0 ? (
                <span className="px-1 rounded bg-white text-[#FF5B00] text-[10px] font-semibold tabular-nums">{unread}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0">
        <RequestThreadPanel
          salesClientId={salesClientId}
          makerRunId={makerRunId}
          websiteMakerBaseUrl={websiteMakerBaseUrl}
          authHeaders={authHeaders}
          allowCommit={allowCommit}
          layout="side"
          heading=""
          extraMessages={messages}
          kindFilter={filter}
        />
      </div>
    </div>
  );
}
