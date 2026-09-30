import React from 'react';
import { Calendar, ChevronLeft, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';
import {
  groupCalendarEventsByOsloDay,
  isoToDatetimeLocalOslo,
  osloWallClockToIso,
} from '../../../../lib/sales-next-actions.js';

export type SalesCalendarEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  meetLink?: string;
  htmlLink?: string;
};

type Props = {
  days: string[];
  events: SalesCalendarEvent[];
  loading: boolean;
  connected: boolean;
  googleEmail: string;
  ownerLabel: string;
  isOwnCalendar: boolean;
  weekOffset: number;
  message: string;
  error: string;
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onThisWeek: () => void;
  onConnect: () => void;
};

function formatDayHeading(ymd = '') {
  const [year, month, day] = String(ymd).split('-').map((part) => Number(part));
  if (!year || !month || !day) return ymd;
  const iso = osloWallClockToIso(year, month, day, 12, 0);
  return new Date(iso).toLocaleDateString('nb-NO', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Oslo',
  });
}

function formatWeekLabel(days: string[] = []) {
  if (!days.length) return '';
  const first = formatDayHeading(days[0]);
  const last = formatDayHeading(days[days.length - 1]);
  return `${first} – ${last}`;
}

function formatEventWhen(event: SalesCalendarEvent) {
  if (event.allDay) return 'Hele dagen';
  const start = isoToDatetimeLocalOslo(event.start);
  const end = isoToDatetimeLocalOslo(event.end);
  const startTime = start.slice(11, 16);
  const endTime = end.slice(11, 16);
  if (startTime && endTime) return `${startTime}–${endTime}`;
  return startTime || '';
}

function todayYmd() {
  return isoToDatetimeLocalOslo(new Date().toISOString()).slice(0, 10);
}

export function SalesCalendarWeek({
  days,
  events,
  loading,
  connected,
  googleEmail,
  ownerLabel,
  isOwnCalendar,
  weekOffset,
  message,
  error,
  onPrevWeek,
  onNextWeek,
  onThisWeek,
  onConnect,
}: Props) {
  const grouped = groupCalendarEventsByOsloDay(events, days);
  const today = todayYmd();
  const title = isOwnCalendar ? 'Din kalender' : `Kalender for ${ownerLabel}`;

  return (
    <div className="rounded-xl border border-white/10 overflow-hidden bg-black/20">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 border-b border-white/10">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white truncate">{title}</p>
          <p className="text-[11px] text-gray-400 truncate">
            {googleEmail ? googleEmail : 'Sales ser møtedetaljer her. Meeting bookers ser fortsatt bare opptatt.'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onPrevWeek}
            className="p-2 rounded-lg bg-white/10 text-white hover:bg-white/15"
            aria-label="Forrige uke"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={onThisWeek}
            disabled={weekOffset === 0}
            className="px-2.5 py-1.5 rounded-lg bg-white/10 text-xs text-white hover:bg-white/15 disabled:opacity-40"
          >
            Denne uken
          </button>
          <button
            type="button"
            onClick={onNextWeek}
            className="p-2 rounded-lg bg-white/10 text-white hover:bg-white/15"
            aria-label="Neste uke"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <p className="px-3 py-2 text-xs text-gray-300 border-b border-white/10">{formatWeekLabel(days)}</p>
      {error ? (
        <div className="px-3 py-3 text-sm text-red-300">{error}</div>
      ) : loading ? (
        <div className="px-3 py-10 flex items-center justify-center gap-2 text-sm text-gray-300">
          <Loader2 size={16} className="animate-spin" />
          Henter kalender…
        </div>
      ) : !connected ? (
        <div className="p-4 text-sm text-gray-300 space-y-3">
          <p>{message || 'Koble Google Calendar for å se ukeplanen her.'}</p>
          {isOwnCalendar ? (
            <button
              type="button"
              onClick={onConnect}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm"
            >
              <Calendar size={14} />
              Koble Google Calendar
            </button>
          ) : null}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-px bg-white/10">
          {grouped.map((column) => {
            const isToday = column.date === today;
            return (
              <div key={column.date} className={`min-h-[180px] bg-[#1f1f1f] p-2 ${isToday ? 'ring-1 ring-inset ring-[#FF5B00]/70' : ''}`}>
                <p className={`text-[11px] font-medium mb-2 ${isToday ? 'text-[#FF5B00]' : 'text-gray-400'}`}>
                  {formatDayHeading(column.date)}
                </p>
                <div className="space-y-1.5">
                  {column.events.length ? column.events.map((event) => (
                    <div
                      key={event.id || `${event.start}-${event.summary}`}
                      className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5"
                    >
                      <p className="text-[10px] text-[#FF5B00] font-medium">{formatEventWhen(event)}</p>
                      <p className="text-xs text-white leading-snug">{event.summary}</p>
                      {event.location ? (
                        <p className="mt-0.5 text-[10px] text-gray-400 truncate">{event.location}</p>
                      ) : null}
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {event.meetLink ? (
                          <a
                            href={event.meetLink}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[10px] text-sky-300 hover:text-white"
                          >
                            <ExternalLink size={10} />
                            Meet
                          </a>
                        ) : null}
                        {event.htmlLink ? (
                          <a
                            href={event.htmlLink}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[10px] text-gray-400 hover:text-white"
                          >
                            Google
                          </a>
                        ) : null}
                      </div>
                    </div>
                  )) : (
                    <p className="text-[11px] text-gray-500">Ingen avtaler</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
