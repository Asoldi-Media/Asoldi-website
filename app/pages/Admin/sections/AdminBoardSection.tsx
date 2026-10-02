import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Loader2, Mail, Search, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { API, authHeaders, salesAuthHeaders, type SalesClient } from '../shared';
import { expireFatCookies } from '../../../lib/expire-fat-cookies';
import { SALES_ACTION_TIMEZONE } from '../../../../lib/sales-next-actions.js';
import { getWorkshopAction, workshopInvitesClient } from '../../../../lib/workshop-action-shared.js';
import {
  clientMatchesAdminBoardFilters,
  filterAdminBoardClients,
  groupAdminBoardClients,
} from '../../../../lib/workshop-booking.js';
import {
  buildClientSearchHaystack,
  matchesClientSearchQuery,
  normalizeClientSearchText,
} from '../clientSearch';
import { AdminRequestInbox } from './AdminRequestInbox';
import { WorkshopAdminActionRow } from './WorkshopAdminActionRow';
import { workshopGoalHeld } from '../../../../lib/workshop-goal-timeline.js';

const OfferReviewSection = lazy(() =>
  import('./OfferReviewSection').then((m) => ({ default: m.OfferReviewSection }))
);

const COMPACT_PREVIEW = 6;

type BucketId = 'unbooked' | 'recentPastDue' | 'upcoming' | 'pastDue' | 'noTime' | 'done';
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
    hint: 'Kommende handlinger, nærmeste først.',
    tone: 'upcoming',
  },
  {
    id: 'pastDue',
    title: 'Forfalt',
    hint: 'Mer enn 48 timer etter avtalt handling.',
    tone: 'past',
  },
  {
    id: 'noTime',
    title: 'Tid ikke satt',
    hint: 'Neste handling mangler klokkeslett.',
    tone: 'none',
  },
  {
    id: 'done',
    title: 'Ferdig',
    hint: 'Ha workshop og Iterert er merket.',
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
  onClient,
  thread,
}: {
  client: SalesClient;
  onClient: (client: SalesClient) => void;
  thread?: ThreadSummary;
}) {
  const navigate = useNavigate();
  const action = getWorkshopAction(client);
  const [expanded, setExpanded] = useState(false);
  const [showMail, setShowMail] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const held = workshopGoalHeld(client);
  const summary = client.workshop?.summary;
  const iteration = client.workshop?.iterationMeeting;
  const showWorkshopMail = workshopInvitesClient(action);
  const showIterationMail = held && iteration?.format === 'mote' && Boolean(iteration?.dueAt);

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

      {thread?.lastKindLabel ? (
        <p className="text-[11px] text-amber-300">{thread.lastKindLabel}</p>
      ) : thread ? (
        <p className="text-[11px] text-sky-300">Åpen forespørsel</p>
      ) : null}

      <div data-admin-card-actions>
        <WorkshopAdminActionRow client={client} onClient={onClient} />
      </div>

      <AdminRequestInbox salesClientId={client.id} />

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
      </div>

      {expanded ? (
        <div className="space-y-3 border-t border-white/10 pt-3">
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
            {(showWorkshopMail || showIterationMail) ? (
              <button
                type="button"
                onClick={() => setShowMail((prev) => !prev)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs ${
                  showMail ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
                }`}
              >
                <Mail size={13} />
                {showMail ? 'Skjul e-postmaler' : 'Vis e-postmaler'}
              </button>
            ) : (
              <p className="text-[11px] text-gray-500">E-postmal vises når format er Møte med kalender på.</p>
            )}
          </div>
          {showMail && (showWorkshopMail || showIterationMail) ? (
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
            </div>
          ) : null}
          <ul className="space-y-1 text-[11px] text-gray-400">
            <li>Meet: {action?.meetLink || '—'}</li>
            <li>Workshop sendt: {action?.confirmationSentAt ? formatWhen(action.confirmationSentAt) : 'Nei'}</li>
            <li>Iterasjon Meet: {iteration?.meetLink || '—'}</li>
            <li>Iterasjon sendt: {iteration?.confirmationSentAt ? formatWhen(iteration.confirmationSentAt) : 'Nei'}</li>
          </ul>
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

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
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

  function replaceClient(next: SalesClient) {
    setClients((prev) => prev.map((entry) => (entry.id === next.id ? next : entry)));
  }

  function toggleBucket(id: string) {
    setCollapsedBuckets((prev) => ({ ...prev, [id]: prev[id] === false }));
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={(event) => event.preventDefault()}
        className="rounded-2xl bg-[#2a2a2a] border border-white/10 p-4 space-y-3"
      >
        <label className="text-xs font-semibold text-gray-200 uppercase tracking-wide">Search and filter</label>
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
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
          <select
            aria-label="Gruppe"
            value={bucketFilter}
            onChange={(event) => setBucketFilter(event.target.value)}
            className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
          >
            <option value="">Alle grupper</option>
            <option value="unbooked">Ingen workshop avtalt</option>
            <option value="upcoming">Neste handling</option>
            <option value="recentPastDue">Forfalt (siste 48 timer)</option>
            <option value="pastDue">Forfalt</option>
            <option value="noTime">Tid ikke satt</option>
            <option value="done">Ferdig</option>
          </select>
          <select
            aria-label="Format"
            value={formatFilter}
            onChange={(event) => setFormatFilter(event.target.value)}
            className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
          >
            <option value="">Alle format</option>
            <option value="mote">Møte</option>
            <option value="sms">SMS</option>
            <option value="ring">Ring</option>
            <option value="sms-ring">SMS/ring</option>
          </select>
          <select
            aria-label="Status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
          >
            <option value="">Alle statuser</option>
            <option value="confirmed">Bekreftet</option>
            <option value="draft">Kladd</option>
            <option value="held">Ha workshop ferdig</option>
            <option value="not-held">Ikke hatt workshop</option>
          </select>
          <select
            aria-label="Tid"
            value={whenFilter}
            onChange={(event) => setWhenFilter(event.target.value)}
            className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
          >
            <option value="">Alle tider</option>
            <option value="today">I dag</option>
            <option value="week">Denne uken</option>
            <option value="overdue">Forfalt</option>
          </select>
          <label className="inline-flex items-center gap-2 rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyWithRequests}
              onChange={(event) => setOnlyWithRequests(event.target.checked)}
              className="h-4 w-4 accent-[#FF5B00]"
            />
            Med forespørsel
          </label>
        </div>
        {hasActiveFilters ? (
          <p className="text-xs text-gray-500">
            {visibleClients.length} av {boardClients.length} kundekort
          </p>
        ) : null}
      </form>

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
  );
}
