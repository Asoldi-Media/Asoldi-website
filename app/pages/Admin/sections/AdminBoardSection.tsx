import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronDown, Filter, Inbox, Loader2, Mail, Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { API, authHeaders, salesAuthHeaders, type SalesClient } from '../shared';
import { expireFatCookies } from '../../../lib/expire-fat-cookies';
import { formatActionFormatLabel, SALES_ACTION_TIMEZONE } from '../../../../lib/sales-next-actions.js';
import { getWorkshopAction, workshopInvitesClient } from '../../../../lib/workshop-action-shared.js';
import {
  clientMatchesAdminBoardFilters,
  filterAdminBoardClients,
  getAdminNextAction,
  groupAdminBoardClients,
} from '../../../../lib/workshop-booking.js';
import {
  adminGoalFilledCount,
  workshopGoalHeld,
} from '../../../../lib/workshop-goal-timeline.js';
import {
  buildClientSearchHaystack,
  matchesClientSearchQuery,
  normalizeClientSearchText,
} from '../clientSearch';
import { AdminRequestInbox } from './AdminRequestInbox';
import { WorkshopAdminActionRow } from './WorkshopAdminActionRow';
import { WebsiteDueField } from './WebsiteDueField';
import { WorkshopNeedsPanel } from './WorkshopNeedsPanel';
import { SalesCalendarWeek } from './SalesCalendarWeek';

const OfferReviewSection = lazy(() =>
  import('./OfferReviewSection').then((m) => ({ default: m.OfferReviewSection }))
);

const COMPACT_PREVIEW = 6;
type HeaderPanel = 'filter' | 'calendar' | 'requests' | null;
type BucketId = 'unbooked' | 'ranked' | 'unlisted';
type BucketTone = 'assign' | 'upcoming' | 'none';

const BUCKETS: { id: BucketId; title: string; hint: string; tone: BucketTone }[] = [
  {
    id: 'unbooked',
    title: 'Ingen workshop avtalt',
    hint: 'Kontrakt signert, men workshop-tid er ikke satt. Ingenting skjer før workshopen er booket.',
    tone: 'assign',
  },
  {
    id: 'ranked',
    title: 'Leveringsfrist',
    hint: 'Workshop er satt. Mest urgent øverst — frist eller neste handling, det som kommer først.',
    tone: 'upcoming',
  },
  {
    id: 'unlisted',
    title: 'Ikke listet ennå',
    hint: 'Ingen workshop og kontrakt er ikke signert.',
    tone: 'none',
  },
];

function bucketToneClass(tone: BucketTone) {
  if (tone === 'assign') return 'border-orange-300 bg-orange-50 text-orange-950';
  if (tone === 'upcoming') return 'border-emerald-200 bg-emerald-50 text-emerald-900';
  return 'border-neutral-200 bg-neutral-50 text-neutral-700';
}

function formatWhen(value = '') {
  if (!value) return 'Tid ikke satt';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nb-NO', { timeZone: SALES_ACTION_TIMEZONE });
}

function AdminGoalProgressIcon({ filled }: { filled: number }) {
  const count = Math.max(0, Math.min(3, filled));
  return (
    <span
      className="inline-flex h-[1em] w-[1.1em] flex-col justify-center gap-px shrink-0 self-center text-sm"
      title={`${count} av 3`}
      aria-label={`${count} av 3 mål`}
    >
      {[2, 1, 0].map((level) => {
        const on = count > level;
        return (
          <span
            key={level}
            className={`block min-h-0 flex-1 rounded-full ${
              on ? 'bg-[#FF5B00]' : 'bg-neutral-500'
            }`}
          />
        );
      })}
    </span>
  );
}

async function request(path: string, init?: RequestInit) {
  expireFatCookies();
  const headers: Record<string, string> = {
    ...salesAuthHeaders(),
    ...(init?.headers as Record<string, string> || {}),
  };
  if (init?.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${API}${path}`, { ...init, headers, cache: 'no-store' });
  const data = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    throw new Error(String((data as { message?: string }).message || `Request failed (${response.status})`));
  }
  return data as Record<string, unknown>;
}

type ThreadSummary = {
  salesClientId: string;
  lastSnippet: string;
  lastKindLabel: string;
  unreadForAdmin: number;
};

function AdminBoardCard({
  client,
  compact,
  peeked,
  onPeek,
  onClient,
  thread,
}: {
  client: SalesClient;
  compact: boolean;
  peeked: boolean;
  onPeek: () => void;
  onClient: (client: SalesClient) => void;
  thread?: ThreadSummary;
}) {
  const navigate = useNavigate();
  const action = getWorkshopAction(client);
  const nextAction = getAdminNextAction(client);
  const [expanded, setExpanded] = useState(false);
  const [showMail, setShowMail] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const held = workshopGoalHeld(client);
  const summary = client.workshop?.summary;
  const iteration = client.workshop?.iterationMeeting;
  const showWorkshopMail = workshopInvitesClient(action);
  const showIterationMail = held && iteration?.format === 'mote' && Boolean(iteration?.dueAt);
  const showCompact = compact && !peeked;
  const goalFilled = adminGoalFilledCount(client);

  async function sendInvoice() {
    setBusy('invoice');
    setError('');
    try {
      const response = await fetch(`${API}/admin/sales/${encodeURIComponent(client.id)}/workshop/invoice-request`, {
        method: 'POST',
        headers: { ...salesAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String((data as { message?: string }).message || 'Kunne ikke sende fakturaforespørsel.'));
      if ((data as { client?: SalesClient }).client) onClient((data as { client: SalesClient }).client);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke sende fakturaforespørsel.');
    } finally {
      setBusy('');
    }
  }

  async function sendDeskMail(kind: string) {
    setBusy(kind);
    setError('');
    try {
      const data = await request(`/admin/sales/${encodeURIComponent(client.id)}/workshop/desk-email`, {
        method: 'POST',
        body: JSON.stringify({ kind }),
      });
      if ((data as { client?: SalesClient }).client) onClient((data as { client: SalesClient }).client);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke sende e-posten.');
    } finally {
      setBusy('');
    }
  }

  return (
    <article className={`rounded-2xl border bg-[#2a2a2a] border-white/10 flex flex-col min-w-0 ${showCompact ? 'p-2.5 gap-1' : 'p-3 sm:p-4 gap-3'}`}>
      <div className="min-w-0">
        <h3 className="text-white font-semibold text-sm sm:text-base truncate">
          {client.businessName || 'Uten navn'}
        </h3>
        {(client.contactPerson || client.contactEmail) ? (
          <p className={`text-xs text-gray-400 truncate ${showCompact ? 'mt-0.5' : 'mt-0.5'}`}>
            {[client.contactPerson, client.contactEmail].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        <div className={`flex items-center gap-2 min-w-0 ${showCompact ? 'mt-1' : 'mt-1.5'}`}>
          <AdminGoalProgressIcon filled={goalFilled} />
          {nextAction?.name ? (
            <>
              <span className="truncate text-sm text-gray-100">{nextAction.name}</span>
              {formatActionFormatLabel(nextAction.format) ? (
                <span className="shrink-0 text-sm text-gray-300">{formatActionFormatLabel(nextAction.format)}</span>
              ) : null}
              {nextAction.addToCalendar ? (
                <span className="shrink-0 px-1.5 py-px rounded border border-sky-400/30 bg-sky-400/10 text-[11px] uppercase tracking-wide font-semibold text-sky-200">
                  Kalender
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-sm text-red-400">sett neste handling</span>
          )}
        </div>
        {thread?.unreadForAdmin ? (
          <p className="mt-0.5 text-[11px] text-amber-300">{thread.lastKindLabel || 'Åpen forespørsel'}</p>
        ) : null}
        {showCompact ? (
          <button
            type="button"
            onClick={onPeek}
            className="mt-0.5 mx-auto p-0.5 rounded text-gray-400 hover:text-white"
            title="Vis mer på dette kortet"
            aria-label="Vis mer på dette kortet"
          >
            <ChevronDown size={14} />
          </button>
        ) : null}
      </div>

      {showCompact ? null : (
        <>
          <div data-admin-card-actions>
            <WorkshopAdminActionRow client={client} onClient={onClient} />
          </div>

          <div className="flex items-center justify-between gap-2 mt-auto pt-1">
            <button
              type="button"
              onClick={() => {
                setExpanded((prev) => !prev);
                if (expanded) setShowMail(false);
              }}
              className="text-xs text-[#FF5B00] hover:underline"
            >
              {expanded ? 'Hide details' : 'Details & tools'}
            </button>
            {compact && peeked ? (
              <button
                type="button"
                onClick={onPeek}
                className="p-1 rounded-full bg-white/10 text-gray-300 hover:text-white"
                title="Vis mindre"
                aria-label="Vis mindre"
              >
                <ChevronDown size={16} className="rotate-180" />
              </button>
            ) : null}
          </div>

          {expanded ? (
            <div className="space-y-3 border-t border-white/10 pt-3">
              <WebsiteDueField
                salesClientId={client.id}
                variant="card"
                authHeaders={salesAuthHeaders()}
              />
              <WorkshopNeedsPanel clientId={client.id} />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy === 'invoice'}
                  onClick={() => void sendInvoice()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
                >
                  {busy === 'invoice' ? <Loader2 size={13} className="animate-spin" /> : null}
                  Send faktura
                </button>
                <button
                  type="button"
                  onClick={() => setShowMail((prev) => !prev)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs ${
                    showMail ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
                  }`}
                >
                  <Mail size={13} />
                  {showMail ? 'Skjul e-posthandlinger' : 'Vis e-posthandlinger'}
                </button>
              </div>
              {showMail ? (
                <div className="flex flex-wrap items-center gap-2 rounded-xl bg-black/20 border border-white/10 p-3">
                  {showWorkshopMail ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/sales/email?clientId=${encodeURIComponent(client.id)}&template=workshop`)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
                    >
                      Workshop-e-post
                    </button>
                  ) : null}
                  {showIterationMail ? (
                    <button
                      type="button"
                      onClick={() => navigate(`/sales/email?clientId=${encodeURIComponent(client.id)}&template=iteration`)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
                    >
                      Iterasjonsmøte-e-post
                    </button>
                  ) : null}
                  {([
                    ['workshop-reminder-3d', 'Workshop 3 dager'],
                    ['workshop-reminder-24h', 'Workshop 24 timer'],
                    ['data-innsamling-1', 'Datainnsamling'],
                    ['data-innsamling-2', 'Datainnsamling påminnelse'],
                  ] as const).map(([kind, label]) => (
                    <button
                      key={kind}
                      type="button"
                      disabled={Boolean(busy)}
                      onClick={() => void sendDeskMail(kind)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
                    >
                      {busy === kind ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
                      {label}
                    </button>
                  ))}
                  <p className="w-full text-[11px] text-gray-500">
                    Datainnsamling sendes manuelt når behovslisten tilsier det — aldri automatisk. Workshop-påminnelser autosendes ikke ennå.
                  </p>
                </div>
              ) : null}
              <ul className="space-y-1 text-[11px] text-gray-400">
                <li>Meet: {action?.meetLink || '—'}</li>
                <li>Workshop sendt: {action?.confirmationSentAt ? formatWhen(action.confirmationSentAt) : 'Nei'}</li>
                <li>Iterasjon Meet: {iteration?.meetLink || '—'}</li>
                <li>Iterasjon sendt: {iteration?.confirmationSentAt ? formatWhen(iteration.confirmationSentAt) : 'Nei'}</li>
              </ul>
              <AdminRequestInbox salesClientId={client.id} />
              {held && summary ? (
                <div className="rounded-lg border border-white/10 bg-black/20 p-2 space-y-1.5 text-[11px] text-gray-300">
                  <div className="text-gray-400">Utviklersammendrag</div>
                  <div><span className="text-gray-500">Intro. </span>{summary.intro}</div>
                  <div><span className="text-gray-500">Voice. </span>{summary.voice}</div>
                  <div><span className="text-gray-500">What they want. </span>{summary.whatTheyWant}</div>
                  <div><span className="text-gray-500">Functionality. </span>{summary.functionality}</div>
                </div>
              ) : null}
              {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}

export function AdminBoardSection() {
  const [clients, setClients] = useState<SalesClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [collapsedBuckets, setCollapsedBuckets] = useState<Record<string, boolean>>({});
  const [searchInput, setSearchInput] = useState('');
  const [bucketFilter, setBucketFilter] = useState('');
  const [formatFilter, setFormatFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [whenFilter, setWhenFilter] = useState('');
  const [onlyWithRequests, setOnlyWithRequests] = useState(false);
  const [threadMap, setThreadMap] = useState<Record<string, ThreadSummary>>({});
  const [headerPanel, setHeaderPanel] = useState<HeaderPanel>(null);
  const [peekCardIds, setPeekCardIds] = useState<Record<string, boolean>>({});
  const headerShellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    function onPointer(event: MouseEvent) {
      const target = event.target as Node | null;
      if (target && headerShellRef.current?.contains(target)) return;
      setHeaderPanel(null);
    }
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, []);

  const loadClients = useCallback(async () => {
    const data = await request('/admin/sales');
    const next = Array.isArray(data.clients) ? data.clients as SalesClient[] : [];
    setClients(next);
  }, []);

  const loadThreads = useCallback(async () => {
    try {
      const response = await fetch(`${API}/admin/dev-requests`, { headers: authHeaders() });
      const data = await response.json().catch(() => ({} as { threads?: ThreadSummary[] }));
      if (!response.ok) return;
      const next: Record<string, ThreadSummary> = {};
      for (const row of Array.isArray(data.threads) ? data.threads : []) {
        const id = String(row.salesClientId || '').trim();
        if (!id) continue;
        next[id] = {
          salesClientId: id,
          lastSnippet: String(row.lastSnippet || ''),
          lastKindLabel: String(row.lastKindLabel || ''),
          unreadForAdmin: Number(row.unreadForAdmin) || 0,
        };
      }
      setThreadMap(next);
    } catch {
      // Keep the board even if the request list is unavailable.
    }
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([loadClients(), loadThreads()])
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Kunne ikke hente kunder');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadClients, loadThreads]);

  const searchQuery = normalizeClientSearchText(searchInput);
  const hasActiveFilters = Boolean(
    searchQuery || bucketFilter || formatFilter || statusFilter || whenFilter || onlyWithRequests
  );
  const boardClients = useMemo(() => filterAdminBoardClients(clients), [clients]);
  const visibleClients = useMemo(() => {
    return boardClients.filter((client) => {
      if (onlyWithRequests && !threadMap[client.id]) return false;
      if (searchQuery) {
        const haystack = buildClientSearchHaystack([
          client.businessName,
          client.contactPerson,
          client.contactEmail,
          client.websiteEmail,
          client.contactPhone,
          client.meetingPlace,
          client.industry,
          client.notes,
        ]);
        if (!matchesClientSearchQuery(haystack, searchQuery)) return false;
      }
      return clientMatchesAdminBoardFilters(client, {
        bucket: bucketFilter,
        format: formatFilter,
        status: statusFilter,
        when: whenFilter,
      }, nowMs);
    });
  }, [boardClients, onlyWithRequests, threadMap, searchQuery, bucketFilter, formatFilter, statusFilter, whenFilter, nowMs]);
  const groups = useMemo(() => groupAdminBoardClients(visibleClients, nowMs), [visibleClients, nowMs]);
  const requestThreads = useMemo(() => Object.values(threadMap).filter((row) => row.unreadForAdmin || row.lastKindLabel), [threadMap]);

  function replaceClient(next: SalesClient) {
    setClients((prev) => prev.map((entry) => (entry.id === next.id ? next : entry)));
  }

  function toggleBucket(id: string) {
    setCollapsedBuckets((prev) => ({ ...prev, [id]: prev[id] === false }));
  }

  function toggleHeaderPanel(panel: HeaderPanel) {
    setHeaderPanel((current) => (current === panel ? null : panel));
  }

  return (
    <div className="sales-clients-surface min-h-screen bg-[#1a1a1a] text-white">
      <header ref={headerShellRef} className="sales-sticky-header sticky top-0 z-[70] border-b border-white/10 bg-[#161616] shadow-sm">
        <div className="max-w-[1440px] mx-auto px-3 sm:px-5 py-2.5 flex items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 shrink-0">
            <img src="/media/Untitled-1.png" alt="Asoldi" className="h-8 sm:h-9 w-auto shrink-0" />
            <div className="min-w-0">
              <h1 className="text-sm sm:text-base font-semibold leading-tight truncate">Adminterminal</h1>
              <p className="mt-0.5 text-[11px] sm:text-xs text-gray-300">Website ({boardClients.length})</p>
            </div>
          </div>

          <div className="flex items-center gap-1 sm:gap-1.5 min-w-0 flex-1 overflow-x-auto">
            <button
              type="button"
              onClick={() => toggleHeaderPanel('filter')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs sm:text-sm ${
                headerPanel === 'filter' ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
              }`}
              aria-expanded={headerPanel === 'filter'}
            >
              <Filter size={14} />
              <span className="hidden sm:inline">Filter</span>
              {hasActiveFilters ? <span className="h-1.5 w-1.5 rounded-full bg-white sm:bg-orange-200" /> : null}
              <ChevronDown size={12} className={`hidden sm:block transition-transform ${headerPanel === 'filter' ? 'rotate-180' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => toggleHeaderPanel('calendar')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs sm:text-sm ${
                headerPanel === 'calendar' ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
              }`}
              aria-expanded={headerPanel === 'calendar'}
            >
              <Calendar size={14} />
              <span className="hidden sm:inline">Calendar</span>
              <ChevronDown size={12} className={`hidden sm:block transition-transform ${headerPanel === 'calendar' ? 'rotate-180' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => toggleHeaderPanel('requests')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs sm:text-sm ${
                headerPanel === 'requests' ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
              }`}
              aria-expanded={headerPanel === 'requests'}
            >
              <Inbox size={14} />
              <span className="hidden sm:inline">Forespørsler</span>
              {requestThreads.length ? <span className="h-1.5 w-1.5 rounded-full bg-white sm:bg-orange-200" /> : null}
              <ChevronDown size={12} className={`hidden sm:block transition-transform ${headerPanel === 'requests' ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>

        {headerPanel === 'filter' && (
          <div className="border-t border-white/10 bg-[#1a1a1a]">
            <div className="max-w-[1440px] mx-auto px-3 sm:px-5 py-3">
              <form onSubmit={(event) => event.preventDefault()} className="rounded-xl border border-white/10 bg-black/20 p-2.5 sm:p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-gray-400">
                    Lukk: klikk Filter igjen, klikk under, eller scroll.
                    {hasActiveFilters ? ` Viser ${visibleClients.length}.` : ''}
                  </p>
                  <button type="button" onClick={() => setHeaderPanel(null)} className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-white">
                    <X size={12} /> Lukk
                  </button>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  <div className="relative flex-1">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      value={searchInput}
                      onChange={(event) => setSearchInput(event.target.value)}
                      placeholder="Bedrift, kontakt, e-post eller sted"
                      className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm"
                    />
                  </div>
                  {hasActiveFilters ? (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchInput('');
                        setBucketFilter('');
                        setFormatFilter('');
                        setStatusFilter('');
                        setWhenFilter('');
                        setOnlyWithRequests(false);
                      }}
                      className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15"
                    >
                      <X size={14} />
                      Clear
                    </button>
                  ) : null}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  <select aria-label="Gruppe" value={bucketFilter} onChange={(event) => setBucketFilter(event.target.value)} className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2">
                    <option value="">Alle grupper</option>
                    <option value="unbooked">Ingen workshop avtalt</option>
                    <option value="ranked">Leveringsfrist</option>
                    <option value="unlisted">Ikke listet ennå</option>
                  </select>
                  <select aria-label="Format" value={formatFilter} onChange={(event) => setFormatFilter(event.target.value)} className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2">
                    <option value="">Alle format</option>
                    <option value="mote">Møte</option>
                    <option value="sms">SMS</option>
                    <option value="ring">Ring</option>
                    <option value="sms-ring">SMS/ring</option>
                  </select>
                  <select aria-label="Status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2">
                    <option value="">Alle statuser</option>
                    <option value="confirmed">Bekreftet</option>
                    <option value="draft">Kladd</option>
                    <option value="held">Workshop ferdig</option>
                    <option value="not-held">Ikke hatt workshop</option>
                  </select>
                  <select aria-label="Tid" value={whenFilter} onChange={(event) => setWhenFilter(event.target.value)} className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2">
                    <option value="">Alle tider</option>
                    <option value="today">I dag</option>
                    <option value="week">Denne uken</option>
                    <option value="overdue">Forfalt</option>
                  </select>
                </div>
              </form>
            </div>
          </div>
        )}

        {headerPanel === 'calendar' && (
          <div className="border-t border-white/10 bg-[#1a1a1a]">
            <div className="max-w-[1440px] mx-auto px-3 sm:px-5 py-3">
              <SalesCalendarWeek
                workshopCalendar
                ownerLabel="Damian"
                isOwnCalendar
                onConnect={() => {}}
              />
            </div>
          </div>
        )}

        {headerPanel === 'requests' && (
          <div className="border-t border-white/10 bg-[#1a1a1a]">
            <div className="max-w-[1440px] mx-auto px-3 sm:px-5 py-3 space-y-2">
              <label className="inline-flex items-center gap-2 rounded-lg bg-black/20 border border-white/10 text-white text-sm px-3 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={onlyWithRequests}
                  onChange={(event) => setOnlyWithRequests(event.target.checked)}
                  className="h-4 w-4 accent-[#FF5B00]"
                />
                Bare kort med forespørsel
              </label>
              {requestThreads.length === 0 ? (
                <p className="text-sm text-gray-500">Ingen åpne forespørsler.</p>
              ) : (
                <ul className="space-y-1">
                  {requestThreads.map((row) => {
                    const client = clients.find((entry) => entry.id === row.salesClientId);
                    return (
                      <li key={row.salesClientId} className="text-sm text-gray-200">
                        <span className="font-medium">{client?.businessName || row.salesClientId}</span>
                        <span className="text-gray-400"> · {row.lastKindLabel || 'Åpen forespørsel'}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </header>

      <div className="max-w-[1440px] mx-auto px-3 sm:px-6 py-4 space-y-3 sm:space-y-4">
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
            {hasActiveFilters
              ? 'Ingen kunder matcher søket.'
              : 'Ingen aktive nettside-kunder på admin-tavlen. MyPhoner-vinnere og manuelt lagt til kunder vises her og blir på Sales.'}
          </p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
            {BUCKETS.filter((bucket) => (groups[bucket.id] || []).length).map((bucket, index) => {
              const list = groups[bucket.id] || [];
              const collapsed = hasActiveFilters ? false : collapsedBuckets[bucket.id] !== false;
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
                        {list.length > COMPACT_PREVIEW && !hasActiveFilters ? (
                          <span className="text-xs font-medium opacity-80">
                            {collapsed ? 'Vis alle' : 'Vis færre'}
                          </span>
                        ) : null}
                        <ChevronDown size={16} className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                      </span>
                    </span>
                  </button>
                  {visible.map((client) => (
                    <AdminBoardCard
                      key={client.id}
                      client={client}
                      compact
                      peeked={Boolean(peekCardIds[client.id])}
                      onPeek={() => setPeekCardIds((prev) => ({ ...prev, [client.id]: !prev[client.id] }))}
                      onClient={replaceClient}
                      thread={threadMap[client.id]}
                    />
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
    </div>
  );
}
