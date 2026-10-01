import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronDown, Loader2 } from 'lucide-react';
import { API, salesAuthHeaders, type SalesClient } from '../shared';
import { formatActionFormatLabel, SALES_ACTION_TIMEZONE } from '../../../../lib/sales-next-actions.js';
import { getWorkshopAction } from '../../../../lib/workshop-action.js';
import {
  adminBoardViewerIsDamianMailbox,
  DAMIAN_WORKSHOP_CALENDAR_EMAIL,
  groupAdminBoardClients,
} from '../../../../lib/workshop-booking.js';
import { SalesCalendarWeek } from './SalesCalendarWeek';
import { WorkshopNeedsPanel } from './WorkshopNeedsPanel';
import { AdminRequestInbox } from './AdminRequestInbox';
import { WorkshopAdminActionRow } from './WorkshopAdminActionRow';
import { MeetingVideoHover } from './MeetingVideoHover';
import { clientMeetingHover } from '../../../../lib/workshop-record.js';

const OfferReviewSection = lazy(() =>
  import('./OfferReviewSection').then((m) => ({ default: m.OfferReviewSection }))
);

const COMPACT_PREVIEW = 6;

type BucketId = 'unbooked' | 'recentPastDue' | 'upcoming' | 'pastDue' | 'noTime';
type BucketTone = 'assign' | 'recent' | 'upcoming' | 'past' | 'none';

const BUCKETS: { id: BucketId; title: string; hint: string; tone: BucketTone }[] = [
  {
    id: 'unbooked',
    title: 'Ingen workshop avtalt',
    hint: 'Ingen booket workshop på kundekortet. Tilbudets startdato teller ikke.',
    tone: 'assign',
  },
  {
    id: 'recentPastDue',
    title: 'Forfalt (siste 48 timer)',
    hint: 'Nylig forfalt — vises over listen så du ikke mister dem.',
    tone: 'recent',
  },
  {
    id: 'upcoming',
    title: 'Neste handling',
    hint: 'Kommende workshop, nærmeste først.',
    tone: 'upcoming',
  },
  {
    id: 'pastDue',
    title: 'Forfalt',
    hint: 'Mer enn 48 timer etter avtalt workshop.',
    tone: 'past',
  },
  {
    id: 'noTime',
    title: 'Tid ikke satt',
    hint: 'Workshop er opprettet, men klokkeslett mangler.',
    tone: 'none',
  },
];

function bucketToneClass(tone: BucketTone) {
  if (tone === 'assign') return 'border-orange-300 bg-orange-50 text-orange-950';
  if (tone === 'recent') return 'border-amber-300 bg-amber-50 text-amber-900';
  if (tone === 'upcoming') return 'border-emerald-200 bg-emerald-50 text-emerald-900';
  if (tone === 'past') return 'border-red-200 bg-red-50 text-red-800';
  return 'border-neutral-200 bg-neutral-50 text-neutral-700';
}

function formatWhen(value = '') {
  if (!value) return 'Tid ikke satt';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nb-NO', { timeZone: SALES_ACTION_TIMEZONE });
}

async function request(path: string, init?: RequestInit) {
  const headers: Record<string, string> = {
    ...salesAuthHeaders(),
    ...(init?.headers as Record<string, string> || {}),
  };
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${API}${path}`, { ...init, headers });
  const data = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    throw new Error(String((data as { message?: string }).message || `Request failed (${response.status})`));
  }
  return data as Record<string, unknown>;
}

function AdminBoardCard({
  client,
  onClient,
}: {
  client: SalesClient;
  onClient: (client: SalesClient) => void;
}) {
  const action = getWorkshopAction(client);
  const onCalendar = Boolean(action?.addToCalendar);
  const hover = clientMeetingHover(client, 'workshop');

  return (
    <article className="rounded-2xl border bg-[#2a2a2a] border-white/10 p-3 sm:p-4 flex flex-col gap-3 min-w-0">
      <div className="min-w-0">
        <h3 className="text-white font-semibold text-sm sm:text-base truncate">
          {client.businessName || 'Uten navn'}
        </h3>
        {(client.contactPerson || client.contactEmail) ? (
          <p className="mt-0.5 text-xs text-gray-400 truncate">
            {[client.contactPerson, client.contactEmail].filter(Boolean).join(' · ')}
          </p>
        ) : null}
      </div>

      {action ? (
        <MeetingVideoHover meetingId={hover.meetingId} hasVideo={hover.hasVideo}>
          <div
            className={`rounded-xl border bg-black/20 p-2.5 ${
              onCalendar ? 'border-sky-400/40' : 'border-white/10'
            }`}
          >
            <div className="flex items-start gap-2 min-w-0">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-white truncate">
                  {action.name || 'Workshop'}
                  {action.format ? (
                    <span className="ml-1.5 text-[10px] uppercase tracking-wide text-gray-400">
                      {formatActionFormatLabel(action.format)}
                    </span>
                  ) : null}
                </div>
                <div className="text-[11px] text-gray-400 truncate">{formatWhen(action.dueAt)}</div>
              </div>
              {onCalendar ? (
                <span title="I Google Kalender" className="shrink-0 text-sky-300">
                  <CalendarDays size={12} />
                </span>
              ) : null}
            </div>
          </div>
        </MeetingVideoHover>
      ) : (
        <p className="text-[11px] text-gray-500">Ingen workshop avtalt.</p>
      )}

      <div data-admin-card-actions>
        <WorkshopAdminActionRow client={client} onClient={onClient} />
      </div>

      <WorkshopNeedsPanel clientId={client.id} />
      <AdminRequestInbox salesClientId={client.id} />
    </article>
  );
}

export function AdminBoardSection() {
  const [clients, setClients] = useState<SalesClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [collapsedBuckets, setCollapsedBuckets] = useState<Record<string, boolean>>({});
  const [calendarOpen, setCalendarOpen] = useState(true);
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [calendarError, setCalendarError] = useState('');
  const [calendarConnecting, setCalendarConnecting] = useState(false);
  const [viewer, setViewer] = useState({ accountKey: '', username: '' });
  const [calendarWeek, setCalendarWeek] = useState({
    connected: false,
    embedUrl: '',
    googleEmail: '',
    accountKey: '',
    message: '',
    shareWarning: '',
    isOwnCalendar: false,
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const loadClients = useCallback(async () => {
    const data = await request('/admin/sales');
    const next = Array.isArray(data.clients) ? data.clients as SalesClient[] : [];
    setClients(next);
    const calendar = data.calendar && typeof data.calendar === 'object'
      ? data.calendar as { loginAccountKey?: string; loginUsername?: string }
      : {};
    setViewer({
      accountKey: String(calendar.loginAccountKey || ''),
      username: String(calendar.loginUsername || ''),
    });
  }, []);

  const loadCalendar = useCallback(async () => {
    setCalendarLoading(true);
    setCalendarError('');
    try {
      const data = await request('/admin/sales/google/embed?workshopCalendar=1');
      setCalendarWeek({
        connected: Boolean(data.connected),
        embedUrl: String(data.embedUrl || ''),
        googleEmail: String(data.googleEmail || DAMIAN_WORKSHOP_CALENDAR_EMAIL),
        accountKey: String(data.accountKey || ''),
        message: String(data.message || ''),
        shareWarning: String(data.shareWarning || ''),
        isOwnCalendar: Boolean(data.isOwnCalendar),
      });
    } catch (err) {
      setCalendarError(err instanceof Error ? err.message : 'Kunne ikke hente kalender');
    } finally {
      setCalendarLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadClients()
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Kunne ikke hente kunder');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadClients]);

  useEffect(() => {
    if (!calendarOpen) return undefined;
    void loadCalendar();
    return undefined;
  }, [calendarOpen, loadCalendar]);

  const groups = useMemo(() => groupAdminBoardClients(clients, nowMs), [clients, nowMs]);
  const isOwnCalendar = calendarWeek.isOwnCalendar
    || adminBoardViewerIsDamianMailbox(viewer);

  function replaceClient(next: SalesClient) {
    setClients((prev) => prev.map((entry) => (entry.id === next.id ? next : entry)));
  }

  async function connectDamianCalendar() {
    if (!isOwnCalendar) return;
    setCalendarError('');
    try {
      const data = await request('/admin/sales/google/auth-url');
      const popup = window.open(String(data.authUrl || ''), 'asoldi-google-calendar', 'width=560,height=760');
      if (!popup) {
        setCalendarError('Popup blocked. Please allow popups and try again.');
        return;
      }
      setCalendarConnecting(true);
      let tries = 0;
      const timer = window.setInterval(() => {
        tries += 1;
        void request('/admin/sales/google/embed?workshopCalendar=1')
          .then((embed) => {
            const connected = Boolean(embed.connected);
            setCalendarWeek({
              connected,
              embedUrl: String(embed.embedUrl || ''),
              googleEmail: String(embed.googleEmail || DAMIAN_WORKSHOP_CALENDAR_EMAIL),
              accountKey: String(embed.accountKey || ''),
              message: String(embed.message || ''),
              shareWarning: String(embed.shareWarning || ''),
              isOwnCalendar: Boolean(embed.isOwnCalendar),
            });
            if (connected || tries >= 30) {
              window.clearInterval(timer);
              setCalendarConnecting(false);
            }
          })
          .catch(() => {
            if (tries >= 30) {
              window.clearInterval(timer);
              setCalendarConnecting(false);
            }
          });
      }, 2000);
    } catch (err) {
      setCalendarConnecting(false);
      setCalendarError(err instanceof Error ? err.message : 'Kunne ikke starte Google-innlogging');
    }
  }

  function toggleBucket(id: string) {
    setCollapsedBuckets((prev) => ({ ...prev, [id]: prev[id] === false }));
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-white/10 bg-[#2a2a2a] overflow-hidden">
        <button
          type="button"
          onClick={() => setCalendarOpen((open) => !open)}
          className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left"
          aria-expanded={calendarOpen}
        >
          <span className="text-sm font-semibold text-white">Kalender for {DAMIAN_WORKSHOP_CALENDAR_EMAIL}</span>
          <ChevronDown size={16} className={`text-gray-400 transition-transform ${calendarOpen ? '' : '-rotate-90'}`} />
        </button>
        {calendarOpen ? (
          <div className="border-t border-white/10">
            <SalesCalendarWeek
              embedUrl={calendarWeek.embedUrl}
              loading={calendarLoading || calendarConnecting}
              connected={calendarWeek.connected}
              googleEmail={calendarWeek.googleEmail || DAMIAN_WORKSHOP_CALENDAR_EMAIL}
              ownerLabel={DAMIAN_WORKSHOP_CALENDAR_EMAIL}
              isOwnCalendar={isOwnCalendar}
              message={calendarWeek.message}
              error={calendarError}
              shareWarning={calendarWeek.shareWarning}
              onConnect={() => { void connectDamianCalendar(); }}
            />
          </div>
        ) : null}
      </div>

      <AdminRequestInbox />

      {error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 text-red-300 px-3 py-2.5 text-sm">
          {error}
        </div>
      ) : null}

      {loading && clients.length === 0 ? (
        <div className="min-h-[180px] flex items-center justify-center text-gray-400">
          <Loader2 className="animate-spin mr-2" size={18} /> Laster admin-tavle…
        </div>
      ) : !BUCKETS.some((bucket) => (groups[bucket.id] || []).length) ? (
        <p className="text-sm text-gray-500 text-center py-8">
          Ingen aktive nettside-kunder på admin-tavlen. MyPhoner-vinnere og manuelt lagt til kunder vises her og blir på Sales.
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
          {BUCKETS.filter((bucket) => (groups[bucket.id] || []).length).map((bucket, index) => {
            const list = groups[bucket.id] || [];
            const collapsed = collapsedBuckets[bucket.id] !== false;
            const visible = collapsed ? list.slice(0, COMPACT_PREVIEW) : list;
            return (
              <React.Fragment key={bucket.id}>
                {index > 0 ? (
                  <div
                    className="md:col-span-2 lg:col-span-3 h-px bg-gradient-to-r from-transparent via-neutral-400/70 to-transparent"
                    aria-hidden="true"
                  />
                ) : null}
                <button
                  type="button"
                  onClick={() => toggleBucket(bucket.id)}
                  className={`md:col-span-2 lg:col-span-3 rounded-xl border px-3 py-2.5 text-left ${bucketToneClass(bucket.tone)}`}
                  aria-expanded={!collapsed}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span>
                      <span className="block text-sm font-semibold">{bucket.title}</span>
                      <span className="block text-[11px] opacity-80 mt-0.5">{bucket.hint}</span>
                    </span>
                    <span className="inline-flex items-center gap-2 shrink-0">
                      <span className="text-sm font-semibold tabular-nums">{list.length}</span>
                      {list.length > COMPACT_PREVIEW ? (
                        <span className="text-xs font-medium opacity-80">
                          {collapsed ? 'Vis alle' : 'Vis færre'}
                        </span>
                      ) : null}
                      <ChevronDown size={16} className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                    </span>
                  </span>
                </button>
                {visible.map((client) => (
                  <AdminBoardCard key={client.id} client={client} onClient={replaceClient} />
                ))}
              </React.Fragment>
            );
          })}
        </div>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-white">Tilbud</h2>
        <Suspense fallback={<p className="text-sm text-gray-400">Laster tilbud…</p>}>
          <OfferReviewSection hideHeader />
        </Suspense>
      </section>
    </div>
  );
}
