import React, { useEffect, useMemo, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import {
  groupCalendarEventsByOsloDay,
  isoToDatetimeLocalOslo,
  layoutTimedCalendarEvents,
  osloMinutesFromMidnight,
  salesCalendarHourSpan,
} from '../../../../lib/sales-next-actions.js';
import { API, salesAuthHeaders } from '../shared';

const HOUR_HEIGHT = 42;
const WEEKDAY_LABELS = ['Man.', 'Tir.', 'Ons.', 'Tor.', 'Fre.', 'Lør.', 'Søn.'];

export type SalesCalendarWeekEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay?: boolean;
  location?: string;
  meetLink?: string;
  htmlLink?: string;
  ownerEmail?: string;
  ownerAccountKey?: string;
};

type Props = {
  ownerId?: string;
  workshopCalendar?: boolean;
  ownerLabel: string;
  isOwnCalendar: boolean;
  refreshKey?: string;
  onConnect: () => void;
};

function formatOsloClock(value = '', allDay = false) {
  if (allDay) return 'Hele dagen';
  const local = isoToDatetimeLocalOslo(value);
  const match = String(local).match(/T(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : '';
}

function formatDayHeading(date = '') {
  const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return date;
  return String(Number(match[3]));
}

function formatWeekTitle(days: string[]) {
  if (!days.length) return '';
  const start = days[0];
  const end = days[days.length - 1];
  const fmt = (value: string) => {
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return value;
    const months = ['jan.', 'feb.', 'mars', 'apr.', 'mai', 'juni', 'juli', 'aug.', 'sep.', 'okt.', 'nov.', 'des.'];
    return `${Number(match[3])}. ${months[Number(match[2]) - 1]}`;
  };
  const year = String(end).slice(0, 4);
  return `${fmt(start)} – ${fmt(end)} ${year}`;
}

function ownerShort(email = '') {
  const local = String(email).split('@')[0] || '';
  if (!local) return '';
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function eventTone(summary = '') {
  return /^asoldi\s*·/i.test(String(summary || '').trim())
    ? 'bg-[#2563eb] hover:bg-[#1d4ed8] text-white'
    : 'bg-[#7c3aed] hover:bg-[#6d28d9] text-white';
}

async function fetchWeek(query: URLSearchParams) {
  const response = await fetch(`${API}/admin/sales/google/events?${query.toString()}`, {
    headers: salesAuthHeaders(),
  });
  const data = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    throw new Error(String((data as { message?: string }).message || `Kalenderfeil (${response.status})`));
  }
  return data as {
    connected?: boolean;
    googleEmail?: string;
    googleEmails?: string[];
    accountKey?: string;
    message?: string;
    warnings?: string[];
    events?: SalesCalendarWeekEvent[];
    days?: string[];
    isOwnCalendar?: boolean;
  };
}

export function SalesCalendarWeek({
  ownerId = '',
  workshopCalendar = false,
  ownerLabel,
  isOwnCalendar,
  refreshKey = '',
  onConnect,
}: Props) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [googleEmail, setGoogleEmail] = useState('');
  const [googleEmails, setGoogleEmails] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [events, setEvents] = useState<SalesCalendarWeekEvent[]>([]);
  const [days, setDays] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState('');

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    params.set('weekOffset', String(weekOffset));
    if (workshopCalendar) params.set('workshopCalendar', '1');
    else if (ownerId) params.set('ownerId', ownerId);
    setLoading(true);
    setError('');
    void fetchWeek(params)
      .then((data) => {
        if (cancelled) return;
        setConnected(Boolean(data.connected));
        setGoogleEmail(String(data.googleEmail || ''));
        setGoogleEmails(Array.isArray(data.googleEmails) ? data.googleEmails.map(String) : []);
        setMessage(String(data.message || ''));
        setWarnings(Array.isArray(data.warnings) ? data.warnings.map(String) : []);
        setEvents(Array.isArray(data.events) ? data.events : []);
        setDays(Array.isArray(data.days) ? data.days : []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Kunne ikke hente kalender');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerId, workshopCalendar, weekOffset, refreshKey]);

  const todayKey = isoToDatetimeLocalOslo(new Date().toISOString()).slice(0, 10);
  const span = useMemo(() => salesCalendarHourSpan(events), [events]);
  const hours = useMemo(() => {
    const rows = [];
    for (let hour = span.startHour; hour < span.endHour; hour += 1) rows.push(hour);
    return rows;
  }, [span.endHour, span.startHour]);
  const grouped = useMemo(() => groupCalendarEventsByOsloDay(events, days), [days, events]);
  const showOwner = googleEmails.length > 1;
  const emailsLabel = googleEmails.length ? googleEmails.join(', ') : googleEmail;
  const title = isOwnCalendar && !ownerId && !workshopCalendar
    ? 'Din kalender'
    : `Kalender for ${ownerLabel}`;
  const selected = events.find((event, index) => `${event.ownerAccountKey || ''}:${event.id || index}` === selectedKey) || null;

  return (
    <div className="rounded-xl border border-white/10 overflow-hidden bg-black/20">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 border-b border-white/10">
        <div className="min-w-0">
          <p className="text-sm font-medium text-white truncate">{title}</p>
          <p className="text-[11px] text-gray-400 truncate">
            {emailsLabel || 'Møter og handlinger fra den koblede Google-kalenderen, med navn.'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setWeekOffset((value) => value - 1)}
            className="p-1.5 rounded-lg bg-white/10 text-white hover:bg-white/15"
            aria-label="Forrige uke"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            onClick={() => setWeekOffset(0)}
            className="px-2 py-1 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
          >
            I dag
          </button>
          <button
            type="button"
            onClick={() => setWeekOffset((value) => value + 1)}
            className="p-1.5 rounded-lg bg-white/10 text-white hover:bg-white/15"
            aria-label="Neste uke"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      {error ? (
        <div className="px-3 py-3 text-sm text-red-300">{error}</div>
      ) : loading ? (
        <div className="px-3 py-10 flex items-center justify-center gap-2 text-sm text-gray-300">
          <Loader2 size={16} className="animate-spin" />
          Henter kalender…
        </div>
      ) : !connected ? (
        <div className="p-4 text-sm text-gray-300 space-y-3">
          <p>{message || 'Koble Google Calendar for å se ukekalenderen her.'}</p>
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
        <div className="bg-white text-gray-900">
          {warnings.length || message ? (
            <p className="px-3 py-2 text-[11px] text-amber-800 bg-amber-50 border-b border-amber-100">
              {[message, ...warnings].filter(Boolean).join(' ')}
            </p>
          ) : null}
          <div className="px-3 py-2 text-sm font-medium text-gray-800 border-b border-gray-200">
            {formatWeekTitle(days)}
          </div>
          <div className="overflow-x-auto">
            <div className="min-w-[960px]">
              <div
                className="grid border-b border-gray-200"
                style={{ gridTemplateColumns: `56px repeat(${Math.max(days.length, 1)}, minmax(0, 1fr))` }}
              >
                <div className="border-r border-gray-200" />
                {grouped.map((day, index) => {
                  const allDay = day.events.filter((event) => event.allDay);
                  const isToday = day.date === todayKey;
                  return (
                    <div key={day.date} className={`px-1 py-2 border-r border-gray-200 last:border-r-0 ${isToday ? 'bg-blue-50/60' : ''}`}>
                      <p className={`text-[11px] uppercase tracking-wide ${isToday ? 'text-blue-700' : 'text-gray-500'}`}>
                        {WEEKDAY_LABELS[index] || ''}
                      </p>
                      <p className={`text-lg font-semibold leading-none ${isToday ? 'text-blue-800' : 'text-gray-900'}`}>
                        {formatDayHeading(day.date)}
                      </p>
                      {allDay.length ? (
                        <div className="mt-1 space-y-0.5">
                          {allDay.map((event) => (
                            <p key={`${event.ownerAccountKey}:${event.id}`} className="text-[10px] truncate text-violet-800">
                              {event.summary}
                            </p>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <div
                className="grid relative"
                style={{
                  gridTemplateColumns: `56px repeat(${Math.max(days.length, 1)}, minmax(0, 1fr))`,
                  height: hours.length * HOUR_HEIGHT,
                }}
              >
                <div className="relative border-r border-gray-200">
                  {hours.map((hour) => (
                    <div
                      key={hour}
                      className="absolute right-1 text-[10px] text-gray-400"
                      style={{ top: (hour - span.startHour) * HOUR_HEIGHT - 6 }}
                    >
                      {String(hour).padStart(2, '0')}:00
                    </div>
                  ))}
                </div>
                {grouped.map((day) => {
                  const layout = layoutTimedCalendarEvents(day.events, {
                    startHour: span.startHour,
                    hourHeight: HOUR_HEIGHT,
                  });
                  const isToday = day.date === todayKey;
                  const nowMin = osloMinutesFromMidnight(new Date().toISOString());
                  return (
                    <div
                      key={day.date}
                      className={`relative border-r border-gray-200 last:border-r-0 ${isToday ? 'bg-blue-50/40' : ''}`}
                    >
                      {hours.map((hour) => (
                        <div
                          key={hour}
                          className="absolute left-0 right-0 border-t border-gray-100"
                          style={{ top: (hour - span.startHour) * HOUR_HEIGHT, height: HOUR_HEIGHT }}
                        />
                      ))}
                      {isToday && nowMin != null && nowMin >= span.startHour * 60 && nowMin <= span.endHour * 60 ? (
                        <div
                          className="absolute left-0 right-0 z-10 border-t-2 border-red-500"
                          style={{ top: ((nowMin - span.startHour * 60) / 60) * HOUR_HEIGHT }}
                        />
                      ) : null}
                      {layout.map((block) => {
                        const event = block.event as SalesCalendarWeekEvent;
                        const key = `${event.ownerAccountKey || ''}:${event.id}`;
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => setSelectedKey(key === selectedKey ? '' : key)}
                            className={`absolute z-[1] overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11px] leading-tight shadow-sm ${eventTone(event.summary)}`}
                            style={{
                              top: block.top,
                              height: block.height,
                              left: `calc(${block.leftPct}% + 2px)`,
                              width: `calc(${block.widthPct}% - 4px)`,
                            }}
                            title={event.summary}
                          >
                            <span className="block font-medium truncate">{event.summary}</span>
                            <span className="block opacity-90 truncate">
                              {formatOsloClock(event.start, Boolean(event.allDay))}
                              {showOwner && event.ownerEmail ? ` · ${ownerShort(event.ownerEmail)}` : ''}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {selected ? (
            <div className="border-t border-gray-200 px-3 py-2 text-sm text-gray-800">
              <p className="font-medium">{selected.summary}</p>
              <p className="text-xs text-gray-500">
                {formatOsloClock(selected.start, Boolean(selected.allDay))}
                {selected.end ? `–${formatOsloClock(selected.end, Boolean(selected.allDay))}` : ''}
                {selected.ownerEmail ? ` · ${selected.ownerEmail}` : ''}
              </p>
              {selected.location ? <p className="text-xs text-gray-600 truncate">{selected.location}</p> : null}
              {selected.meetLink ? (
                <a
                  href={selected.meetLink}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-blue-700 hover:underline"
                >
                  {selected.meetLink}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
