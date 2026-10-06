import React from 'react';
import { ExternalLink } from 'lucide-react';
import type { SalesClient } from '../shared';
import { buildClientActivityLog } from '../../../../lib/sales-activity-log.js';
import { MeetingVideoHover } from './MeetingVideoHover';

type Props = {
  client: SalesClient;
  onClose: () => void;
};

function formatWhen(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' });
}

export function ClientActivityLogCover({ client, onClose }: Props) {
  const log = buildClientActivityLog(client);

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
          <div className="font-semibold truncate text-sm sm:text-base">{client.businessName || 'Kunde'}</div>
          <div className="text-[11px] text-gray-400">Logg · handlinger og opptak i kronologisk rekkefølge</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-2 rounded-lg bg-white/10 text-sm text-white hover:bg-white/15"
        >
          Lukk
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto px-3 sm:px-5 py-4">
        <div className="max-w-3xl mx-auto space-y-5">
          {log.sections.length === 0 ? (
            <p className="text-sm text-gray-400">Ingen handlinger eller opptak er logget ennå.</p>
          ) : log.sections.map((section) => (
            <section key={section.key} className="space-y-2">
              <h2 className="text-[11px] uppercase tracking-wide text-gray-400">{section.label}</h2>
              <div className="space-y-2">
                {section.rows.map((row) => {
                  const meeting = row.meeting;
                  const body = (
                    <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 space-y-1.5">
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
                      {meeting ? (
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                          <span className={`px-2 py-1 rounded-md ${
                            meeting.hasTranscript ? 'bg-[#FF5B00]/20 text-white' : 'bg-white/10 text-gray-300'
                          }`}>
                            {meeting.title}{meeting.when ? ` · ${meeting.when}` : ''}
                            {meeting.hasTranscript ? '' : ' · venter på transkript'}
                          </span>
                          <a
                            href={meeting.firefliesUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[#FF5B00] hover:underline"
                            onClick={(event) => event.stopPropagation()}
                          >
                            <ExternalLink size={12} /> Fireflies
                          </a>
                        </div>
                      ) : null}
                    </div>
                  );
                  if (!meeting?.meetingId) return <div key={row.id}>{body}</div>;
                  return (
                    <MeetingVideoHover
                      key={row.id}
                      meetingId={meeting.meetingId}
                      hasVideo={meeting.hasVideo}
                    >
                      {body}
                    </MeetingVideoHover>
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
