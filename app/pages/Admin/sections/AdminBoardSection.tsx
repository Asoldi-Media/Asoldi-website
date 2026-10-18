import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronDown, Filter, Inbox, Loader2, Mail, Phone, Search, UserRound, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { API, authHeaders, salesAuthHeaders, type SalesClient } from '../shared';
import { expireFatCookies } from '../../../lib/expire-fat-cookies';
import { formatActionFormatLabel, SALES_ACTION_TIMEZONE } from '../../../../lib/sales-next-actions.js';
import { getWorkshopAction, workshopInvitesClient } from '../../../../lib/workshop-action-shared.js';
import {
  clientMatchesAdminBoardFilters,
  filterAdminBoardClients,
  getAdminNextAction,
} from '../../../../lib/workshop-booking.js';
import {
  adminGoalFilledCount,
  workshopGoalHeld,
} from '../../../../lib/workshop-goal-timeline.js';
import {
  ADMIN_FOCUS_CATEGORIES,
  defaultAdminFocusCategory,
  groupAdminFocusQueues,
  normalizeAdminFocusCategory,
} from '../../../../lib/admin-focus-board.js';
import {
  buildClientSearchHaystack,
  matchesClientSearchQuery,
  normalizeClientSearchText,
} from '../clientSearch';
import { AdminRequestInbox } from './AdminRequestInbox';
import { WorkshopAdminActionRow } from './WorkshopAdminActionRow';
import { WebsiteDueField } from './WebsiteDueField';
import { WorkshopNeedsPanel } from './WorkshopNeedsPanel';
import { InboxBotPanel } from './InboxBotPanel';
import { SalesCalendarWeek } from './SalesCalendarWeek';
import {
  FocusBoardShell,
  FocusHeaderPopup,
  FocusStatusChip,
  focusSince,
  focusWhen,
  useHeaderBarHeight,
  type FocusRequest,
  type FocusStatus,
} from './FocusBoardShell';
import { ClientNotesFeed, clientFeedMessages } from './ClientNotesFeed';

const OfferReviewSection = lazy(() =>
  import('./OfferReviewSection').then((m) => ({ default: m.OfferReviewSection }))
);

type HeaderPanel = 'filter' | 'calendar' | 'requests' | null;

type AdminFocusEntry = {
  id: string;
  name: string;
  client: SalesClient;
  category: string;
  dueAt: string;
  overdue: boolean;
};

const EMPTY_TEXT: Record<string, string> = {
  unbooked: 'Alle signerte kunder har workshop-tid.',
  workshop: 'Ingen workshops er booket.',
  informasjon: 'Ingen venter på informasjon.',
  iteration: 'Ingen venter på iterasjon.',
  done: 'Ingen kunder er ferdige ennå.',
  unlisted: 'Ingen usignerte kunder uten workshop.',
};

function formatWhen(value = '') {
  if (!value) return 'Tid ikke satt';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nb-NO', { timeZone: SALES_ACTION_TIMEZONE });
}

function adminStatus(entry: AdminFocusEntry, nowMs: number): FocusStatus {
  const { client, category, dueAt, overdue } = entry;
  if (category === 'done') return { text: 'Ferdig', tone: 'green' };
  if (category === 'unlisted') return { text: 'Kontrakt ikke signert', tone: 'muted' };
  if (category === 'unbooked') {
    const signedFor = client.contractSignedAt ? focusSince(String(client.contractSignedAt), nowMs) : '';
    return { text: signedFor ? `Sett workshop-tid · signert for ${signedFor} siden` : 'Sett workshop-tid', tone: 'warn' };
  }
  if (!dueAt) return { text: 'Sett neste handling', tone: 'warn' };
  const action = getAdminNextAction(client);
  const label = action && Date.parse(action.dueAt) === Date.parse(dueAt) ? action.name : 'Leveringsfrist';
  if (overdue) return { text: `${label} · forfalt ${focusSince(dueAt, nowMs) || 'nå'}`, tone: 'red' };
  const whenText = focusWhen(dueAt, nowMs);
  return { text: `${label} ${whenText}`, tone: whenText.startsWith('i dag') ? 'green' : 'muted' };
}

function phoneDigits(client: SalesClient) {
  return String(client.contactPhone || '').replace(/[^\d+]/g, '');
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
  businessName: string;
  lastSnippet: string;
  lastKindLabel: string;
  unreadForAdmin: number;
  updatedAt: string;
};

type InboxMailboxStatus = {
  mailbox: string;
  configured: boolean;
  ok: boolean;
  reason: string;
};

function inboxMailboxLabel(mailbox = '') {
  const email = String(mailbox || '').toLowerCase();
  if (email.startsWith('damian@')) return 'Damian';
  if (email.startsWith('alexander@')) return 'Alexander';
  return email;
}

function inboxMailboxLine(row: InboxMailboxStatus) {
  const name = inboxMailboxLabel(row.mailbox);
  if (!row.configured) return `${name} IMAP mangler`;
  if (row.ok) return `${name} IMAP OK`;
  return `${name} IMAP ${row.reason || 'feil'}`;
}

/** Website due, inbox bot, workshop needs, faktura, e-post and the developer summary. */
function AdminCardDetails({
  client,
  onClient,
  showRequests,
}: {
  client: SalesClient;
  onClient: (client: SalesClient) => void;
  showRequests: boolean;
}) {
  const navigate = useNavigate();
  const action = getWorkshopAction(client);
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

  function openDeskEmail(template: string) {
    navigate(`/sales/email?clientId=${encodeURIComponent(client.id)}&template=${encodeURIComponent(template)}&from=admin`);
  }

  return (
    <div className="space-y-3">
      <WebsiteDueField
        salesClientId={client.id}
        variant="card"
        authHeaders={salesAuthHeaders()}
      />
      <InboxBotPanel client={client} />
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
              onClick={() => openDeskEmail('workshop')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
            >
              Workshop-e-post
            </button>
          ) : null}
          {showIterationMail ? (
            <button
              type="button"
              onClick={() => openDeskEmail('iteration')}
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
              onClick={() => openDeskEmail(kind)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
            >
              <Mail size={13} />
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
      {showRequests ? <AdminRequestInbox salesClientId={client.id} /> : null}
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
  );
}

function NextActionLine({ client }: { client: SalesClient }) {
  const nextAction = getAdminNextAction(client);
  return (
    <div className="flex items-center gap-2 min-w-0">
      <AdminGoalProgressIcon filled={adminGoalFilledCount(client)} />
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
  );
}

/** Compact card for the Vis alle kunder grid. Same tools as before. */
function AdminBoardCard({
  client,
  peeked,
  onPeek,
  onOpen,
  onClient,
  thread,
}: {
  client: SalesClient;
  peeked: boolean;
  onPeek: () => void;
  onOpen: () => void;
  onClient: (client: SalesClient) => void;
  thread?: ThreadSummary;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article className={`rounded-2xl border bg-[#2a2a2a] border-white/10 flex flex-col min-w-0 ${peeked ? 'p-3 sm:p-4 gap-3' : 'p-2.5 gap-1'}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-white font-semibold text-sm sm:text-base truncate flex-1">
            {client.businessName || 'Uten navn'}
          </h3>
          <button
            type="button"
            onClick={onOpen}
            className="shrink-0 text-[11px] text-[#FF5B00] hover:underline"
            title="Vis kunden på tavla"
          >
            Vis på tavla
          </button>
        </div>
        {(client.contactPerson || client.contactEmail) ? (
          <p className="text-xs text-gray-400 truncate mt-0.5">
            {[client.contactPerson, client.contactEmail].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        <div className={peeked ? 'mt-1.5' : 'mt-1'}>
          <NextActionLine client={client} />
        </div>
        {thread?.unreadForAdmin ? (
          <p className="mt-0.5 text-[11px] text-amber-300">{thread.lastKindLabel || 'Åpen forespørsel'}</p>
        ) : null}
        {(client.inboxBot?.pendingContracts || 0) > 0 ? (
          <p className="mt-0.5 text-[11px] text-amber-300">Kontrakt mottatt</p>
        ) : null}
        {peeked ? null : (
          <button
            type="button"
            onClick={onPeek}
            className="mt-0.5 mx-auto p-0.5 rounded text-gray-400 hover:text-white block"
            title="Vis mer på dette kortet"
            aria-label="Vis mer på dette kortet"
          >
            <ChevronDown size={14} />
          </button>
        )}
      </div>

      {peeked ? (
        <>
          <div data-admin-card-actions>
            <WorkshopAdminActionRow client={client} onClient={onClient} />
          </div>
          <div className="flex items-center justify-between gap-2 mt-auto pt-1">
            <button
              type="button"
              onClick={() => setExpanded((prev) => !prev)}
              className="text-xs text-[#FF5B00] hover:underline"
            >
              {expanded ? 'Hide details' : 'Details & tools'}
            </button>
            <button
              type="button"
              onClick={onPeek}
              className="p-1 rounded-full bg-white/10 text-gray-300 hover:text-white"
              title="Vis mindre"
              aria-label="Vis mindre"
            >
              <ChevronDown size={16} className="rotate-180" />
            </button>
          </div>
          {expanded ? (
            <div className="border-t border-white/10 pt-3">
              <AdminCardDetails client={client} onClient={onClient} showRequests />
            </div>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

/** Focused client: card on the left, requests + notes + log on the right. */
function AdminFocusCard({
  entry,
  pager,
  nowMs,
  thread,
  onClient,
}: {
  entry: AdminFocusEntry;
  pager: React.ReactNode;
  nowMs: number;
  thread?: ThreadSummary;
  onClient: (client: SalesClient) => void;
}) {
  const { client } = entry;
  const [detailsOpen, setDetailsOpen] = useState(true);
  const phone = phoneDigits(client);
  const messages = useMemo(() => clientFeedMessages(client as unknown as Record<string, unknown>), [client]);
  const signedAt = String(client.contractSignedAt || '').trim();

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <div className="space-y-3 min-w-0">
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg sm:text-xl font-semibold text-white truncate">{client.businessName || 'Uten navn'}</h2>
                <FocusStatusChip status={adminStatus(entry, nowMs)} />
                {thread?.unreadForAdmin ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded border text-[11px] border-amber-500/40 bg-amber-500/15 text-amber-200">
                    {thread.lastKindLabel || 'Åpen forespørsel'}
                  </span>
                ) : null}
                {(client.inboxBot?.pendingContracts || 0) > 0 ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded border text-[11px] border-amber-500/40 bg-amber-500/15 text-amber-200">
                    Kontrakt mottatt
                  </span>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
                {client.contactPerson ? (
                  <span className="inline-flex items-center gap-1"><UserRound size={12} />{client.contactPerson}</span>
                ) : null}
                {client.contactPhone ? (
                  <a href={`tel:${phone}`} className="inline-flex items-center gap-1 hover:text-white"><Phone size={12} />{client.contactPhone}</a>
                ) : null}
                {client.contactEmail ? (
                  <a href={`mailto:${client.contactEmail}`} className="inline-flex items-center gap-1 hover:text-white min-w-0 truncate">
                    <Mail size={12} />{client.contactEmail}
                  </a>
                ) : null}
              </div>
              {signedAt ? (
                <div className="mt-1 text-xs text-gray-300">Kontrakt signert {focusWhen(signedAt, nowMs)}</div>
              ) : null}
              <div className="mt-1.5">
                <NextActionLine client={client} />
              </div>
            </div>
            {pager}
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-black/20 p-2.5" data-admin-card-actions>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Handlinger</div>
          <WorkshopAdminActionRow client={client} onClient={onClient} />
        </div>

        <div className="rounded-xl border border-white/10 bg-black/20 p-2.5">
          <button
            type="button"
            onClick={() => setDetailsOpen((open) => !open)}
            className="w-full flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400 hover:text-white"
            aria-expanded={detailsOpen}
          >
            Details & tools
            <ChevronDown size={14} className={`transition-transform ${detailsOpen ? 'rotate-180' : ''}`} />
          </button>
          {detailsOpen ? (
            <div className="mt-2.5">
              <AdminCardDetails client={client} onClient={onClient} showRequests={false} />
            </div>
          ) : null}
        </div>
      </div>

      <div className="min-w-0">
        <ClientNotesFeed
          salesClientId={client.id}
          authHeaders={authHeaders()}
          messages={messages}
          unread={thread?.unreadForAdmin || 0}
        />
      </div>
    </div>
  );
}

export function AdminBoardSection() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [clients, setClients] = useState<SalesClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [searchInput, setSearchInput] = useState('');
  const [formatFilter, setFormatFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [whenFilter, setWhenFilter] = useState('');
  const [onlyWithRequests, setOnlyWithRequests] = useState(false);
  /** null = follow the board tab; '' = every client; a tab id = that tab only. */
  const [listCategoryOverride, setListCategoryOverride] = useState<string | null>(null);
  const [showAllClients, setShowAllClients] = useState(false);
  const [threadMap, setThreadMap] = useState<Record<string, ThreadSummary>>({});
  const [inboxPendingContracts, setInboxPendingContracts] = useState(0);
  const [inboxMailboxes, setInboxMailboxes] = useState<InboxMailboxStatus[]>([]);
  const [headerPanel, setHeaderPanel] = useState<HeaderPanel>(null);
  const [peekCardIds, setPeekCardIds] = useState<Record<string, boolean>>({});
  const [focusRequest, setFocusRequest] = useState<FocusRequest>(null);
  const headerShellRef = useRef<HTMLElement | null>(null);
  const headerBarPx = useHeaderBarHeight(headerShellRef);
  const autoCategoryRef = useRef('');

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!headerPanel) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHeaderPanel(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [headerPanel]);

  const loadClients = useCallback(async () => {
    const data = await request('/admin/sales');
    const next = Array.isArray(data.clients) ? data.clients as SalesClient[] : [];
    setClients(next);
    setInboxPendingContracts(Number(data.inboxPendingContracts) || next.reduce((sum, client) => sum + (client.inboxBot?.pendingContracts || 0), 0));
  }, []);

  const loadInboxStatus = useCallback(async () => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10000);
    try {
      const data = await request('/admin/inbox-bot/status', { signal: controller.signal });
      const list = Array.isArray(data.mailboxes) ? (data.mailboxes as InboxMailboxStatus[]) : [];
      setInboxMailboxes(list);
    } catch {
      // Board still loads without IMAP status.
    } finally {
      window.clearTimeout(timer);
    }
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
          businessName: String(row.businessName || ''),
          lastSnippet: String(row.lastSnippet || ''),
          lastKindLabel: String(row.lastKindLabel || ''),
          unreadForAdmin: Number(row.unreadForAdmin) || 0,
          updatedAt: String(row.updatedAt || ''),
        };
      }
      setThreadMap(next);
    } catch {
      // Keep the board even if the request list is unavailable.
    }
  }, []);

  useEffect(() => {
    void loadInboxStatus();
  }, [loadInboxStatus]);

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
    const timer = window.setInterval(() => {
      void loadThreads();
    }, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadClients, loadThreads]);

  const boardClients = useMemo(() => filterAdminBoardClients(clients), [clients]);
  const queues = useMemo(
    () => groupAdminFocusQueues(boardClients, nowMs) as Record<string, AdminFocusEntry[]>,
    [boardClients, nowMs],
  );
  if (!autoCategoryRef.current && boardClients.length) {
    autoCategoryRef.current = defaultAdminFocusCategory(queues);
  }
  const activeCategory = normalizeAdminFocusCategory(searchParams.get('kategori'))
    || autoCategoryRef.current
    || ADMIN_FOCUS_CATEGORIES[0].id;
  const effectiveListCategory = listCategoryOverride === null ? activeCategory : listCategoryOverride;
  const categoryFilterTouched = listCategoryOverride !== null && listCategoryOverride !== activeCategory;

  function setCategory(id: string) {
    const next = new URLSearchParams(searchParams);
    next.set('kategori', id);
    setSearchParams(next, { replace: true });
    setListCategoryOverride(null);
  }

  const searchQuery = normalizeClientSearchText(searchInput);
  const hasActiveFilters = Boolean(
    searchQuery || formatFilter || statusFilter || whenFilter || onlyWithRequests || categoryFilterTouched
  );
  const listClients = useMemo(() => {
    const ordered = ADMIN_FOCUS_CATEGORIES
      .filter((meta) => !effectiveListCategory || meta.id === effectiveListCategory)
      .flatMap((meta) => queues[meta.id] || [])
      .map((entry) => entry.client);
    return ordered.filter((client) => {
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
        format: formatFilter,
        status: statusFilter,
        when: whenFilter,
      }, nowMs);
    });
  }, [queues, effectiveListCategory, onlyWithRequests, threadMap, searchQuery, formatFilter, statusFilter, whenFilter, nowMs]);
  const allClientsOpen = showAllClients || hasActiveFilters;
  const requestThreads = useMemo(
    () => (Object.values(threadMap) as ThreadSummary[])
      .filter((row) => row.unreadForAdmin || row.lastKindLabel)
      .sort((a, b) => (b.unreadForAdmin - a.unreadForAdmin) || String(b.updatedAt).localeCompare(String(a.updatedAt))),
    [threadMap],
  );
  const unreadRequests = requestThreads.reduce((sum, row) => sum + row.unreadForAdmin, 0);

  function replaceClient(next: SalesClient) {
    setClients((prev) => prev.map((entry) => (entry.id === next.id ? next : entry)));
  }

  function toggleHeaderPanel(panel: HeaderPanel) {
    setHeaderPanel((current) => (current === panel ? null : panel));
  }

  function showOnBoard(clientId: string) {
    setFocusRequest({ id: clientId, nonce: Date.now() });
    setHeaderPanel(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function clearFilters() {
    setSearchInput('');
    setFormatFilter('');
    setStatusFilter('');
    setWhenFilter('');
    setOnlyWithRequests(false);
    setListCategoryOverride(null);
  }

  const headerButton = (panel: HeaderPanel) => `inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs sm:text-sm ${
    headerPanel === panel ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
  }`;

  return (
    <div className="sales-clients-surface min-h-screen bg-[#1a1a1a] text-white">
      <header ref={headerShellRef} className="sales-sticky-header sticky top-0 z-[90] border-b border-white/10 bg-[#161616] shadow-sm">
        <div className="max-w-[1440px] mx-auto px-3 sm:px-5 py-2.5 flex items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 shrink-0">
            <img src="/media/Untitled-1.png" alt="Asoldi" className="h-8 sm:h-9 w-auto shrink-0" />
            <div className="min-w-0">
              <h1 className="text-sm sm:text-base font-semibold leading-tight truncate">Adminterminal</h1>
              <p className="mt-0.5 text-[11px] sm:text-xs text-gray-300">
                Website ({boardClients.length})
                {inboxPendingContracts ? (
                  <span className="text-amber-300"> · Kontrakt ({inboxPendingContracts})</span>
                ) : null}
                {inboxMailboxes.length ? (
                  <span className={inboxMailboxes.every((row) => row.ok) ? 'text-gray-300' : 'text-amber-300'}>
                    {' · '}Innboks: {inboxMailboxes.map(inboxMailboxLine).join(' · ')}
                  </span>
                ) : null}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1 sm:gap-1.5 min-w-0 flex-1 overflow-x-auto">
            <button type="button" onClick={() => toggleHeaderPanel('filter')} className={headerButton('filter')} aria-expanded={headerPanel === 'filter'}>
              <Filter size={14} />
              <span className="hidden sm:inline">Filter</span>
              {hasActiveFilters ? <span className="h-1.5 w-1.5 rounded-full bg-white sm:bg-orange-200" /> : null}
            </button>
            <button type="button" onClick={() => toggleHeaderPanel('calendar')} className={headerButton('calendar')} aria-expanded={headerPanel === 'calendar'}>
              <Calendar size={14} />
              <span className="hidden sm:inline">Calendar</span>
            </button>
            <button type="button" onClick={() => toggleHeaderPanel('requests')} className={headerButton('requests')} aria-expanded={headerPanel === 'requests'}>
              <Inbox size={14} />
              <span className="hidden sm:inline">Forespørsler</span>
              {unreadRequests ? (
                <span className="px-1.5 rounded bg-white text-[#FF5B00] text-[10px] font-semibold tabular-nums">{unreadRequests}</span>
              ) : requestThreads.length ? <span className="h-1.5 w-1.5 rounded-full bg-white sm:bg-orange-200" /> : null}
            </button>
          </div>
        </div>
      </header>

      <FocusHeaderPopup
        open={headerPanel === 'filter'}
        top={headerBarPx}
        label="Filter"
        hint={`Filter ligger over tavla og styrer Alle kunder. Lukk med Filter, utenfor, eller Escape.${hasActiveFilters ? ` Viser ${listClients.length}.` : ''}`}
        onClose={() => setHeaderPanel(null)}
      >
        <form onSubmit={(event) => event.preventDefault()} className="rounded-xl border border-white/10 bg-black/20 p-2.5 sm:p-3 space-y-2.5">
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
                onClick={clearFilters}
                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15"
              >
                <X size={14} />
                Clear
              </button>
            ) : null}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            <select
              aria-label="Kategori"
              value={effectiveListCategory}
              onChange={(event) => setListCategoryOverride(event.target.value)}
              className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
            >
              <option value="">Alle kategorier</option>
              {ADMIN_FOCUS_CATEGORIES.map((meta) => (
                <option key={meta.id} value={meta.id}>{meta.label} ({(queues[meta.id] || []).length})</option>
              ))}
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
          <label className="inline-flex items-center gap-2 rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyWithRequests}
              onChange={(event) => setOnlyWithRequests(event.target.checked)}
              className="h-4 w-4 accent-[#FF5B00]"
            />
            Bare kort med forespørsel
          </label>
        </form>
      </FocusHeaderPopup>

      <FocusHeaderPopup
        open={headerPanel === 'calendar'}
        top={headerBarPx}
        wide
        label="Calendar"
        hint="Kalenderen ligger over tavla. Lukk med Calendar, utenfor, eller Escape."
        onClose={() => setHeaderPanel(null)}
      >
        <SalesCalendarWeek
          combined
          ownerLabel="alle selgere"
          isOwnCalendar
          onConnect={() => {}}
        />
      </FocusHeaderPopup>

      <FocusHeaderPopup
        open={headerPanel === 'requests'}
        top={headerBarPx}
        label="Forespørsler"
        hint="Velg en forespørsel for å vise kunden på tavla. Svar i feeden til høyre på kortet."
        onClose={() => setHeaderPanel(null)}
      >
        {requestThreads.length === 0 ? (
          <p className="text-sm text-gray-500">Ingen åpne forespørsler.</p>
        ) : (
          <ul className="space-y-1.5">
            {requestThreads.map((row) => {
              const client = clients.find((entry) => entry.id === row.salesClientId);
              const onBoard = boardClients.some((entry) => entry.id === row.salesClientId);
              return (
                <li key={row.salesClientId}>
                  <button
                    type="button"
                    disabled={!onBoard}
                    onClick={() => showOnBoard(row.salesClientId)}
                    title={onBoard ? 'Vis kunden på tavla' : 'Kunden er ikke på admin-tavla'}
                    className="w-full text-left rounded-xl border border-white/10 bg-black/20 px-3 py-2 hover:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm text-white truncate">{client?.businessName || row.businessName || row.salesClientId}</span>
                      {row.unreadForAdmin > 0 ? (
                        <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-[#FF5B00] text-white">{row.unreadForAdmin}</span>
                      ) : (
                        <span className="text-[11px] text-gray-500">{row.updatedAt ? focusWhen(row.updatedAt, nowMs) : ''}</span>
                      )}
                    </span>
                    <span className="block text-[11px] text-amber-300 truncate mt-0.5">{row.lastKindLabel || 'Åpen forespørsel'}</span>
                    {row.lastSnippet ? <span className="block text-[11px] text-gray-400 truncate">{row.lastSnippet}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </FocusHeaderPopup>

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
        ) : boardClients.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-8">
            Ingen aktive nettside-kunder på admin-tavlen. MyPhoner-vinnere og manuelt lagt til kunder vises her og blir på Sales.
          </p>
        ) : (
          <div className="flex flex-col gap-3" style={{ minHeight: `calc(100dvh - ${headerBarPx}px - 2rem)` }}>
            <FocusBoardShell<AdminFocusEntry>
              ariaLabel="Admintavle"
              categories={ADMIN_FOCUS_CATEGORIES}
              queues={queues}
              active={activeCategory}
              onCategory={setCategory}
              nowMs={nowMs}
              statusFor={(entry) => adminStatus(entry, nowMs)}
              detailFor={(entry) => (
                <>
                  {entry.client.contactPerson ? <span>{entry.client.contactPerson}</span> : null}
                  {entry.client.contactPhone ? <span>{entry.client.contactPhone}</span> : null}
                  {threadMap[entry.id]?.unreadForAdmin ? <span className="text-amber-300">Forespørsel</span> : null}
                </>
              )}
              emptyText={(id) => EMPTY_TEXT[id] || 'Ingen kunder her.'}
              focusRequest={focusRequest}
              renderCard={(entry, pager) => (
                <AdminFocusCard
                  entry={entry}
                  pager={pager}
                  nowMs={nowMs}
                  thread={threadMap[entry.id]}
                  onClient={replaceClient}
                />
              )}
            />
            <div className="mt-auto flex justify-center pt-1">
              <button
                type="button"
                onClick={() => {
                  if (allClientsOpen) {
                    setShowAllClients(false);
                    return;
                  }
                  setShowAllClients(true);
                  setListCategoryOverride(null);
                }}
                disabled={hasActiveFilters}
                aria-expanded={allClientsOpen}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-white/10 text-sm text-white hover:bg-white/15 disabled:opacity-60"
                title={hasActiveFilters ? 'Listen er åpen fordi søk eller filter er på' : undefined}
              >
                {allClientsOpen ? 'Skjul alle kunder' : `Vis alle kunder (${listClients.length})`}
                <ChevronDown size={15} className={`transition-transform ${allClientsOpen ? 'rotate-180' : ''}`} />
              </button>
            </div>
          </div>
        )}

        {allClientsOpen && boardClients.length > 0 ? (
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <div>
                <h2 className="text-sm font-semibold text-white">Alle kunder</h2>
                <p className="text-[11px] text-gray-400">
                  {effectiveListCategory
                    ? `${ADMIN_FOCUS_CATEGORIES.find((meta) => meta.id === effectiveListCategory)?.label || 'Kategori'} · ${listClients.length} kunder. Fjern kategorifilteret i Filter for å se alle.`
                    : 'Hele listen. Søk og filtrer med Filter øverst.'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHeaderPanel('filter')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs ${
                  hasActiveFilters ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
                }`}
              >
                <Search size={13} />
                {hasActiveFilters ? 'Filter er på' : 'Søk og filter'}
              </button>
            </div>
            {listClients.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-6">Ingen kunder matcher filteret.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
                {listClients.map((client) => (
                  <AdminBoardCard
                    key={client.id}
                    client={client}
                    peeked={Boolean(peekCardIds[client.id])}
                    onPeek={() => setPeekCardIds((prev) => ({ ...prev, [client.id]: !prev[client.id] }))}
                    onOpen={() => showOnBoard(client.id)}
                    onClient={replaceClient}
                    thread={threadMap[client.id]}
                  />
                ))}
              </div>
            )}
          </section>
        ) : null}

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
