import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Globe,
  Layers,
  Loader2,
  Mail,
  MapPin,
  MessageSquare,
  Pencil,
  Phone,
  NotebookPen,
  Send,
  SkipForward,
  Undo2,
  UserX,
  UserRound,
} from 'lucide-react';
import type { SalesClient, SalesGoalKey, SalesNextAction } from '../shared';
import { SalesGoalTimeline, type SalesFixedRow } from './SalesGoalTimeline';
import {
  defaultSalesFocusCategory,
  getSalesPlaybook,
  groupSalesFocusQueues,
  normalizeSalesFocusCategory,
  salesCategoryClock,
  salesFixedRows,
  salesFocusCategoriesFor,
  salesFocusEntries,
  salesMissedMeeting,
} from '../../../../lib/sales-playbook.js';
import {
  SALES_ACTION_TIMEZONE,
  clientIsSalesWin,
  confirmationSendGaps,
  decorateNextActions,
  isoToDatetimeLocalOslo,
} from '../../../../lib/sales-next-actions.js';

export type SalesFocusCategoryId = 'assign' | 'confirm' | 'reminders' | 'meetingsToday' | 'offer' | 'signature' | 'won';

type StepState = 'done' | 'due' | 'upcoming' | 'overdue' | 'sendNow' | 'waiting';

type FocusEntry = {
  client: SalesClient;
  category: SalesFocusCategoryId;
  stepId: string;
  focusRowId: string;
  state: StepState;
  dueAt: string;
  overdue: boolean;
};

type CategoryMeta = { id: SalesFocusCategoryId; label: string; hint: string };

type FixedRowBase = Omit<SalesFixedRow, 'onToggle' | 'toggleTitle' | 'busy' | 'extras'>;

export type SalesRepOption = { id: string; label: string };

type Props = {
  clients: SalesClient[];
  nowMs: number;
  category: string;
  onCategory: (id: SalesFocusCategoryId) => void;
  isAdmin: boolean;
  salesReps: SalesRepOption[];
  assigningId: string | null;
  progressBusyKey: string | null;
  actionBusyId: string | null;
  sendingMailKey: string | null;
  meetOpeningId: string;
  readUpBusyId: string | null;
  statusBusyId: string | null;
  meetLinkFor: (client: SalesClient) => string;
  previewAvailable: (client: SalesClient) => boolean;
  onEdit: (client: SalesClient) => void;
  onOpenFlow: (client: SalesClient, step: 1 | 2 | 3) => void;
  onReadUp: (client: SalesClient, done: boolean) => void;
  /** noShow / skip move the client to Venter møtebekreftelse; missedCall = Ring for ny møtetid. */
  onMissedStep: (client: SalesClient, step: 'noShow' | 'skip' | 'missedCall', done: boolean) => void;
  onToggleGoal: (client: SalesClient, key: SalesGoalKey, extra?: { fastTrack?: boolean }) => void;
  onMutateAction: (client: SalesClient, body: Record<string, unknown>) => Promise<void>;
  onSendConfirmation: (client: SalesClient) => void;
  onOpenMeet: (client: SalesClient) => void;
  onOpenPreview: (client: SalesClient) => void;
  onAssign: (client: SalesClient, ownerId: string) => void;
  onSecondary: (client: SalesClient) => void;
  onNotSold: (client: SalesClient) => void;
  renderRecording: (client: SalesClient) => React.ReactNode;
  renderNotes: (client: SalesClient) => React.ReactNode;
  /** Sales ops overflow: booking, mail, portal email, calendar/Fireflies, MyPhoner, preview, offer codes. Kundekort page 1 holds links and contact fields. */
  renderDetails: (client: SalesClient) => React.ReactNode;
};

const HOUR_MS = 60 * 60 * 1000;

const EMPTY_TEXT: Record<SalesFocusCategoryId, string> = {
  assign: 'Alle kunder har en selger.',
  confirm: 'Ingen som trenger møtetid.',
  reminders: 'Ingen påminnelser å sende nå. Kunder med møte i morgen dukker opp her fra midnatt.',
  meetingsToday: 'Ingen møter i dag.',
  offer: 'Ingen kunder venter på tilbud.',
  signature: 'Ingen tilbud venter på signering.',
  won: 'Ingen solgte kunder ennå.',
};

const TONE_CLASS = {
  red: 'bg-red-500/15 border-red-500/40 text-red-200',
  warn: 'bg-amber-500/15 border-amber-500/40 text-amber-200',
  green: 'bg-green-900/40 border-green-600/40 text-green-300',
  muted: 'bg-white/5 border-white/15 text-gray-300',
};

const BUTTON = 'inline-flex items-center justify-center gap-1.5 px-3 py-2 min-h-[40px] sm:min-h-0 rounded-lg text-sm disabled:opacity-50';
const HEADER_BUTTON = 'shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 min-h-[36px] sm:min-h-0 rounded-lg bg-white/10 text-xs text-white hover:bg-white/15 disabled:opacity-50';
const ROW_BUTTON = 'shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/10 text-[11px] text-gray-100 hover:bg-white/15 disabled:opacity-50';

function osloLocal(ms: number) {
  return isoToDatetimeLocalOslo(new Date(ms).toISOString());
}

function clock(iso = '') {
  const local = isoToDatetimeLocalOslo(iso);
  return local ? local.slice(11, 16) : '';
}

function dayWord(iso: string, nowMs: number) {
  const key = isoToDatetimeLocalOslo(iso).slice(0, 10);
  if (!key) return '';
  if (key === osloLocal(nowMs).slice(0, 10)) return 'i dag';
  if (key === osloLocal(nowMs + 24 * HOUR_MS).slice(0, 10)) return 'i morgen';
  if (key === osloLocal(nowMs - 24 * HOUR_MS).slice(0, 10)) return 'i går';
  return new Intl.DateTimeFormat('nb-NO', {
    timeZone: SALES_ACTION_TIMEZONE,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(iso));
}

function when(iso: string, nowMs: number) {
  if (!iso) return '';
  return [dayWord(iso, nowMs), clock(iso)].filter(Boolean).join(' ');
}

function since(iso: string, nowMs: number) {
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} t`;
  return `${Math.floor(hours / 24)} d`;
}

type CategoryClock = { kind: 'until' | 'late' | 'now' | 'at'; atMs: number };

type MissedMeeting = {
  kind: 'noShow' | 'skipped' | 'auto';
  label: string;
  at: string;
  callDueAt: string;
  calledAt: string;
  undoable: boolean;
};

function untilText(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} t ${rest} min` : `${hours} t`;
}

/** Category button time: "om 45 min" to the next meeting, red "forfalt 2 t", or the next action time. */
function clockLabel(value: CategoryClock, nowMs: number) {
  const iso = new Date(value.atMs).toISOString();
  if (value.kind === 'until') {
    return dayWord(iso, nowMs) === 'i dag' ? `om ${untilText(value.atMs - nowMs)}` : when(iso, nowMs);
  }
  if (value.kind === 'late') return `forfalt ${since(iso, nowMs) || 'nå'}`;
  if (value.kind === 'now') return 'pågår';
  return dayWord(iso, nowMs) === 'i dag' ? `kl ${clock(iso)}` : when(iso, nowMs);
}

function meetingModeLabel(client: SalesClient) {
  return client.meetingMode === 'in-person' ? 'IRL' : 'Online';
}

/** Status next to the name. Skip chips that only repeat the open category. */
function entryStatus(entry: FocusEntry, nowMs: number): { text: string; tone: keyof typeof TONE_CLASS } | null {
  const { stepId, state, dueAt } = entry;
  if (!stepId && state === 'done') return { text: 'Ferdig her', tone: 'muted' };
  if (stepId === 'assign') return null;
  if (stepId === 'confirmation') {
    if (state === 'overdue') return { text: `Ikke sendt · ${since(dueAt, nowMs)}`, tone: 'red' };
    return null;
  }
  if (stepId === 'reminder') {
    if (state === 'sendNow') return { text: 'Send nå', tone: 'warn' };
    if (state === 'overdue') return { text: `Ikke sendt · ${since(dueAt, nowMs)}`, tone: 'red' };
    if (state === 'due') return null;
    return dueAt ? { text: `kl ${clock(dueAt)}`, tone: 'muted' } : null;
  }
  const today = dayWord(dueAt, nowMs) === 'i dag';
  if (stepId === 'readUp') {
    return today
      ? { text: `Møte ${clock(dueAt)} · les deg opp`, tone: 'green' }
      : { text: `Møte ${when(dueAt, nowMs)}`, tone: 'muted' };
  }
  if (stepId === 'missedCall') {
    const label = (salesMissedMeeting(entry.client, nowMs) as MissedMeeting | null)?.label || 'Møtet ble ikke holdt';
    if (state === 'waiting') return { text: `${label} · sett ny møtetid`, tone: 'warn' };
    if (state === 'overdue') return { text: `${label} · ring forfalt ${since(dueAt, nowMs)}`, tone: 'red' };
    if (state === 'due') return { text: `${label} · ring nå`, tone: 'warn' };
    return { text: `${label} · ring ${when(dueAt, nowMs)}`, tone: 'warn' };
  }
  if (stepId === 'holdMeeting') {
    const hasTime = Boolean(entry.client.agreedTime && Date.parse(String(entry.client.meetingAt || '')));
    if (!hasTime) {
      if (state === 'overdue') return { text: `Tid ikke satt · ${since(dueAt, nowMs)}`, tone: 'red' };
      return { text: 'Tid ikke satt', tone: 'warn' };
    }
    if (entry.category === 'confirm') {
      return { text: `Møte forfalt · sett ny tid · ${since(dueAt, nowMs)}`, tone: 'red' };
    }
    if (state === 'overdue') return { text: `Marker møtet holdt · ${when(dueAt, nowMs)}`, tone: 'red' };
    if (state === 'due') return { text: 'Møtet pågår', tone: 'green' };
    return today ? { text: `Møte ${clock(dueAt)}`, tone: 'green' } : { text: `Møte ${when(dueAt, nowMs)}`, tone: 'muted' };
  }
  if (stepId === 'sendOffer') {
    const late = dueAt ? since(dueAt, nowMs) : '';
    if (state === 'overdue') return { text: late ? `Forfalt ${late}` : 'Forfalt', tone: 'red' };
    return dueAt ? { text: `Frist ${when(dueAt, nowMs)}`, tone: 'warn' } : null;
  }
  if (stepId === 'signatureFollowUp') {
    if (state === 'overdue') return { text: `Oppfølging forfalt · ${since(dueAt, nowMs)}`, tone: 'red' };
    return { text: `Oppfølging ${when(dueAt, nowMs)}`, tone: 'muted' };
  }
  if (stepId === 'checkup') {
    if (state === 'overdue') return { text: `Checkup forfalt · ${since(dueAt, nowMs)}`, tone: 'red' };
    return { text: `Checkup ${when(dueAt, nowMs)}`, tone: 'muted' };
  }
  if (stepId === 'afterSale') {
    if (!entry.focusRowId) return { text: 'Ingen åpne handlinger', tone: 'muted' };
    const row = (decorateNextActions(entry.client) as SalesNextAction[]).find((action) => action.id === entry.focusRowId);
    const name = row?.name || 'Oppfølging';
    if (state === 'overdue') return { text: `${name} · forfalt ${since(dueAt, nowMs)}`, tone: 'red' };
    if (state === 'due') return { text: `${name} i dag`, tone: 'warn' };
    return { text: `${name} ${when(dueAt, nowMs)}`.trim(), tone: 'muted' };
  }
  return null;
}

function phoneDigits(client: SalesClient) {
  return String(client.contactPhone || '').replace(/[^\d+]/g, '');
}

function ModeChip({ client }: { client: SalesClient }) {
  const irl = client.meetingMode === 'in-person';
  return (
    <span className={`inline-flex shrink-0 items-center px-2 py-0.5 rounded border text-[11px] ${
      irl ? 'border-sky-400/40 bg-sky-500/10 text-sky-100' : 'border-white/15 text-gray-300'
    }`}>
      {meetingModeLabel(client)}
    </span>
  );
}

function StatusChip({ entry, nowMs }: { entry: FocusEntry; nowMs: number }) {
  const status = entryStatus(entry, nowMs);
  if (!status) return null;
  return (
    <span className={`inline-flex shrink-0 items-center px-2 py-0.5 rounded border text-[11px] ${TONE_CLASS[status.tone]}`}>
      {status.text}
    </span>
  );
}

export function SalesFocusBoard(props: Props) {
  const { clients, nowMs, category, onCategory, isAdmin } = props;
  const [focus, setFocus] = useState<Partial<Record<SalesFocusCategoryId, { id: string; index: number }>>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  /** The client stays on screen after leaving the category, so the tick can be seen and undone. */
  const [held, setHeld] = useState<{ category: SalesFocusCategoryId; id: string; note: string } | null>(null);
  const [note, setNote] = useState('');
  const autoCategoryRef = useRef<SalesFocusCategoryId | ''>('');
  const lastFocusRef = useRef<{ category: SalesFocusCategoryId; id: string; name: string; missed: boolean } | null>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [popupLeft, setPopupLeft] = useState(0);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popupRef.current?.contains(target) || tabListRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const categories = salesFocusCategoriesFor({ isAdmin }) as CategoryMeta[];
  const queues = useMemo(
    () => groupSalesFocusQueues(clients, nowMs, { isAdmin }) as Record<SalesFocusCategoryId, FocusEntry[]>,
    [clients, nowMs, isAdmin],
  );
  if (!autoCategoryRef.current && clients.length) {
    autoCategoryRef.current = defaultSalesFocusCategory(queues, { isAdmin }) as SalesFocusCategoryId;
  }
  const active = (normalizeSalesFocusCategory(category, { isAdmin }) || autoCategoryRef.current || categories[0].id) as SalesFocusCategoryId;
  const activeMeta = categories.find((entry) => entry.id === active) || categories[0];

  /** Popup sits under the active category button, kept inside the board. */
  useLayoutEffect(() => {
    if (!menuOpen) return undefined;
    const place = () => {
      const wrap = popupRef.current?.parentElement;
      const tab = tabListRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      const popup = popupRef.current;
      if (!wrap || !tab || !popup) return;
      const wrapRect = wrap.getBoundingClientRect();
      const left = tab.getBoundingClientRect().left - wrapRect.left;
      setPopupLeft(Math.max(0, Math.min(left, wrapRect.width - popup.offsetWidth)));
    };
    place();
    window.addEventListener('resize', place);
    const tabs = tabListRef.current;
    tabs?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('resize', place);
      tabs?.removeEventListener('scroll', place);
    };
  }, [menuOpen, active]);

  const queue = queues[active] || [];
  const stored = focus[active];
  let index = stored ? queue.findIndex((entry) => entry.client.id === stored.id) : 0;
  if (index < 0) index = Math.min(stored?.index ?? 0, queue.length - 1);
  const entry = index >= 0 ? queue[index] || null : null;
  const entryClientId = entry?.client.id || '';

  const heldClient = held && held.category === active
    ? clients.find((client) => client.id === held.id) || null
    : null;
  const heldBackIndex = heldClient ? queue.findIndex((row) => row.client.id === heldClient.id) : -1;
  const heldEntry: FocusEntry | null = heldClient && heldBackIndex < 0
    ? (active === 'assign' || clientIsSalesWin(heldClient)
      ? (salesFocusEntries(heldClient, nowMs, { isAdmin: false })[0] as FocusEntry | undefined) || null
      : null) || {
      client: heldClient,
      category: active,
      stepId: '',
      focusRowId: '',
      state: 'done',
      dueAt: '',
      overdue: false,
    }
    : null;
  const shown = heldEntry || entry;

  /** When the client on screen leaves this category, keep it up and say where it went. */
  useEffect(() => {
    const last = lastFocusRef.current;
    if (last && last.category === active && !queue.some((row) => row.client.id === last.id)) {
      const movedTo = categories
        .filter((meta) => (queues[meta.id] || []).some((row) => row.client.id === last.id))
        .map((meta) => meta.label);
      const moved = clients.find((client) => client.id === last.id);
      const parked = !moved || moved.status === 'not-sold' ? 'Ikke solgt' : '';
      const where = parked
        ? `er flyttet til ${parked}`
        : movedTo.length ? `er flyttet til ${movedTo.join(' og ')}` : `er ferdig i ${activeMeta.label}`;
      const missedNow = Boolean(moved && (salesMissedMeeting(moved, nowMs) as MissedMeeting | null)?.undoable);
      const missedUndone = last.missed && !missedNow;
      if (active === 'assign') {
        // Stay on Tildel selger and show the next unassigned client. Do not follow or toast.
      } else if ((active === 'meetingsToday' && moved?.progression?.meetingHeld) || missedNow || missedUndone || parked) {
        setNote(`${last.name} ${where}.${entry ? ` Neste: ${entry.client.businessName || 'kunde'}.` : ''}`);
      } else {
        setHeld({ category: active, id: last.id, note: `${last.name} ${where}.` });
      }
    }
    lastFocusRef.current = entry
      ? {
        category: active,
        id: entry.client.id,
        name: entry.client.businessName || 'Kunden',
        missed: Boolean((salesMissedMeeting(entry.client, nowMs) as MissedMeeting | null)?.undoable),
      }
      : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queues, active, entryClientId]);

  /** The client on screen stays put when the queue re-sorts; only a tick, the pager or the popup moves on. */
  useEffect(() => {
    if (!entry || stored?.id === entry.client.id) return;
    setFocus((prev) => ({ ...prev, [active]: { id: entry.client.id, index } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, entryClientId]);

  useEffect(() => {
    if (!note) return undefined;
    const timer = window.setTimeout(() => setNote(''), 6000);
    return () => window.clearTimeout(timer);
  }, [note]);

  /** An undo brings the held client back into the queue: focus it there again. */
  useEffect(() => {
    if (!heldClient || heldBackIndex < 0) return;
    setFocus((prev) => ({ ...prev, [active]: { id: heldClient.id, index: heldBackIndex } }));
    setHeld(null);
  }, [heldClient, heldBackIndex, active]);

  useEffect(() => {
    setMenuOpen(false);
    setHeld(null);
    setNote('');
    tabListRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  function focusAt(nextIndex: number) {
    const row = queue[nextIndex];
    if (!row) return;
    setHeld(null);
    setFocus((prev) => ({ ...prev, [active]: { id: row.client.id, index: nextIndex } }));
  }

  const pager = !heldEntry && queue.length > 1 ? (
    <div className="flex items-center gap-1 text-xs text-gray-400">
      <button
        type="button"
        onClick={() => focusAt(index - 1)}
        disabled={index <= 0}
        className="p-1.5 rounded-lg hover:bg-white/10 disabled:opacity-30"
        aria-label="Forrige kunde"
      >
        <ChevronLeft size={16} />
      </button>
      <span className="tabular-nums">{index + 1} av {queue.length}</span>
      <button
        type="button"
        onClick={() => focusAt(index + 1)}
        disabled={index >= queue.length - 1}
        className="p-1.5 rounded-lg hover:bg-white/10 disabled:opacity-30"
        aria-label="Neste kunde"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  ) : null;

  return (
    <section className="rounded-2xl bg-[#2a2a2a] border border-white/10 p-3 sm:p-4 space-y-3" aria-label="Salgstavle">
      <div className="relative">
        <div ref={tabListRef} className="flex gap-2 overflow-x-auto pb-0.5" role="tablist">
          {categories.map((meta) => {
            const id = meta.id;
            const rows = queues[id] || [];
            const selected = id === active;
            const clock = salesCategoryClock(rows, id, nowMs) as CategoryClock | null;
            const clockText = clock ? clockLabel(clock, nowMs) : '';
            const clockLate = clock?.kind === 'late';
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-expanded={selected ? menuOpen : undefined}
                onClick={() => (selected ? setMenuOpen((open) => !open) : onCategory(id))}
                title={selected ? (menuOpen ? 'Skjul neste kunder' : 'Vis neste kunder') : meta.hint}
                className={`relative shrink-0 min-w-[8.5rem] sm:min-w-0 sm:flex-1 cursor-pointer rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  selected
                    ? 'bg-[#FF5B00] border-[#FF5B00] text-white'
                    : 'bg-black/20 border-white/10 text-gray-200 hover:bg-white/10'
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-lg font-semibold tabular-nums leading-none">{rows.length}</span>
                  {clockText ? (
                    <span
                      className={`min-w-0 truncate text-[11px] tabular-nums leading-none ${
                        clockLate
                          ? (selected ? 'font-semibold text-white' : 'font-medium text-red-300')
                          : (selected ? 'text-white/85' : 'text-gray-400')
                      }`}
                      title={clockLate ? 'Noe er forfalt' : 'Neste handling'}
                    >
                      {clockText}
                    </span>
                  ) : null}
                  {selected && rows.length ? (
                    <ChevronDown size={15} className={`ml-auto shrink-0 transition-transform duration-300 ${menuOpen ? 'rotate-180' : ''}`} />
                  ) : null}
                </span>
                <span className="mt-1 block text-[12px] font-medium leading-tight">{meta.label}</span>
              </button>
            );
          })}
        </div>

        <div
          ref={popupRef}
          role="dialog"
          aria-label={`Neste kunder i ${activeMeta.label}`}
          inert={!(menuOpen && queue.length)}
          style={{ left: popupLeft }}
          className={`absolute top-full z-30 mt-2 w-[min(26rem,100%)] transition duration-200 ease-out ${
            menuOpen && queue.length ? 'opacity-100 translate-y-0' : 'pointer-events-none opacity-0 -translate-y-1'
          }`}
        >
            <div className="rounded-xl border border-[#FF5B00]/40 bg-[#2a2a2a] shadow-2xl shadow-black/30 overflow-hidden">
              <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                <span>Neste kunder i {activeMeta.label} · {queue.length}</span>
                <span className="font-normal normal-case tracking-normal">Velg en kunde</span>
              </div>
              <ul className="sales-action-scroll max-h-[min(24rem,60dvh)] overflow-y-auto overscroll-contain divide-y divide-white/5">
                {queue.map((row, rowIndex) => {
                  const current = !heldEntry && rowIndex === index;
                  return (
                  <li key={row.client.id}>
                    <button
                      type="button"
                      aria-current={current ? 'true' : undefined}
                      title={current ? 'Vises nå' : 'Vis denne kunden'}
                      onClick={() => {
                        focusAt(rowIndex);
                        setMenuOpen(false);
                      }}
                      className={`w-full cursor-pointer text-left px-3 py-2.5 border-l-2 transition-colors hover:bg-white/10 ${
                        current ? 'border-[#FF5B00] bg-white/5' : 'border-transparent'
                      }`}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                        <span className="min-w-0 truncate text-sm font-medium text-white">
                          {row.client.businessName || 'Uten navn'}
                        </span>
                        <span className="flex items-center gap-2">
                          <ModeChip client={row.client} />
                          <StatusChip entry={row} nowMs={nowMs} />
                          {current ? null : <ChevronRight size={14} className="text-gray-500" />}
                        </span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-gray-400">
                        {row.client.contactPhone ? <span>{row.client.contactPhone}</span> : null}
                        {row.client.contactEmail ? (
                          <span className="truncate">
                            {row.client.contactEmail}
                            {row.client.contactEmailError?.message ? (
                              <span className="ml-1 text-red-400">kom ikke fram</span>
                            ) : null}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  </li>
                  );
                })}
              </ul>
            </div>
        </div>
      </div>

      {heldEntry && held ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-green-600/40 bg-green-900/40 px-3 py-2 text-sm text-green-300">
          <span>{held.note}{heldEntry.category === active ? ' Angre med haken under.' : ''}</span>
          <button
            type="button"
            onClick={() => setHeld(null)}
            className="shrink-0 inline-flex items-center gap-1 cursor-pointer rounded-lg bg-[#FF5B00] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#e55200]"
          >
            {entry ? <>Neste: {entry.client.businessName || 'kunde'}</> : 'Lukk'}
            <ChevronRight size={14} />
          </button>
        </div>
      ) : note ? (
        <div role="status" className="rounded-xl border border-green-600/40 bg-green-900/40 px-3 py-2 text-sm text-green-300">
          {note}
        </div>
      ) : null}

      {shown ? (
        <React.Fragment key={`${active}:${shown.client.id}`}>
          <FocusCard {...props} entry={shown} pager={pager} />
        </React.Fragment>
      ) : (
        <div className="rounded-xl border border-dashed border-white/15 px-4 py-8 text-center">
          <CheckCircle2 size={22} className="mx-auto text-green-400" />
          <p className="mt-2 text-sm text-gray-200">{EMPTY_TEXT[active]}</p>
          <p className="mt-1 text-xs text-gray-500">{activeMeta.hint}</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {categories.filter((meta) => meta.id !== active && (queues[meta.id] || []).length).map((meta) => (
              <button
                key={meta.id}
                type="button"
                onClick={() => onCategory(meta.id)}
                className="px-3 py-1.5 rounded-lg bg-white/10 text-xs text-gray-100 hover:bg-white/15"
              >
                {meta.label} ({(queues[meta.id] || []).length})
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

type FocusCardProps = Props & { entry: FocusEntry; pager: React.ReactNode };

function FocusCard(props: FocusCardProps) {
  const {
    entry,
    pager,
    nowMs,
    progressBusyKey,
    actionBusyId,
    sendingMailKey,
    meetOpeningId,
    readUpBusyId,
    statusBusyId,
    meetLinkFor,
    previewAvailable,
    onEdit,
    onOpenFlow,
    onReadUp,
    onMissedStep,
    onToggleGoal,
    onMutateAction,
    onSendConfirmation,
    onOpenMeet,
    onOpenPreview,
    onSecondary,
    onNotSold,
    renderNotes,
    renderDetails,
  } = props;
  const { client } = entry;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const isAssign = entry.category === 'assign';
  const isWon = entry.category === 'won';
  const meetingAt = (getSalesPlaybook(client, nowMs) as { meetingAt: string }).meetingAt;
  const irl = client.meetingMode === 'in-person';
  const place = String(client.meetingPlace || client.businessAddress || '').trim();
  const mapHref = irl && place ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(place)}` : '';
  const phone = phoneDigits(client);
  const meetLink = meetLinkFor(client);
  const meetOpening = meetOpeningId === client.id;
  const actionBusy = actionBusyId === client.id;
  const hasPreview = previewAvailable(client);
  const name = client.businessName || 'kunden';
  const signedAt = String(client.contractSignedAt || '').trim();
  const missed = salesMissedMeeting(client, nowMs) as MissedMeeting | null;
  const missedBusy = readUpBusyId === client.id;
  const meetingOpen = !missed && (entry.category === 'reminders' || entry.category === 'meetingsToday');

  const markNoShow = () => {
    const ok = window.confirm(`Marker at ${name} ikke møtte opp? Kunden flyttes til Venter møtebekreftelse og får en ringeoppgave i morgen kl 10.`);
    if (ok) onMissedStep(client, 'noShow', true);
  };

  const toggleGoal = (key: SalesGoalKey) => {
    if (key === 'contractSigned' && !client.progression?.contractSigned) {
      const ok = window.confirm(`Marker kontrakt signert for ${name}? Kunden flyttes til Solgt, får e-posten før workshop, og oppfølging om 1 måned settes opp.`);
      if (!ok) return;
    }
    onToggleGoal(client, key);
  };

  const fixedRows = useMemo<SalesFixedRow[]>(() => {
    const gaps = confirmationSendGaps(client) as string[];
    const hasNotes = Boolean(client.progression?.offerSent) || (salesFixedRows(client, nowMs) as FixedRowBase[])
      .some((row) => row.stepId === 'productNotes' && row.done);
    return (salesFixedRows(client, nowMs) as FixedRowBase[]).map((row): SalesFixedRow => {
      if (row.stepId === 'confirmation') {
        if (row.done || row.state === 'waiting') return row;
        if (gaps.length) {
          return {
            ...row,
            extras: <button type="button" onClick={() => onEdit(client)} className={ROW_BUTTON}>Fyll inn</button>,
          };
        }
        const busy = sendingMailKey === `${client.id}:thank-you`;
        return {
          ...row,
          busy,
          toggleTitle: 'Send bekreftelse til kunden',
          onToggle: () => onSendConfirmation(client),
          extras: (
            <button type="button" onClick={() => onSendConfirmation(client)} disabled={busy} className={ROW_BUTTON}>
              <Send size={11} />
              {busy ? 'Sender…' : 'Send'}
            </button>
          ),
        };
      }
      if (row.stepId === 'readUp') {
        return {
          ...row,
          busy: readUpBusyId === client.id,
          toggleTitle: row.done ? 'Lest. Klikk for å angre.' : 'Marker som lest',
          onToggle: () => onReadUp(client, !row.done),
          extras: (
            <button type="button" onClick={() => onOpenFlow(client, 1)} className={ROW_BUTTON}>
              <FileText size={11} />
              {row.done ? 'Åpne' : 'Les deg opp'}
            </button>
          ),
        };
      }
      if (row.stepId === 'missedCall') {
        return {
          ...row,
          lead: true,
          busy: missedBusy,
          toggleTitle: row.done ? 'Ringt. Klikk for å angre.' : 'Marker at du har ringt kunden',
          onToggle: () => onMissedStep(client, 'missedCall', !row.done),
          extras: phone && !row.done ? (
            <>
              <a href={`tel:${phone}`} className={ROW_BUTTON}><Phone size={11} />Ring</a>
              <a href={`sms:${phone}`} className={ROW_BUTTON}><MessageSquare size={11} />SMS</a>
            </>
          ) : null,
        };
      }
      if (row.stepId === 'productNotes') {
        return {
          ...row,
          toggleTitle: row.done ? 'Produktnotater er skrevet' : 'Skriv produktnotater',
          onToggle: row.done ? undefined : () => onOpenFlow(client, 2),
          extras: <button type="button" onClick={() => onOpenFlow(client, 2)} className={ROW_BUTTON}>Åpne</button>,
        };
      }
      if (row.stepId === 'sendOffer') {
        const held = Boolean(client.progression?.meetingHeld);
        return {
          ...row,
          busy: progressBusyKey === `${client.id}:offerSent`,
          toggleTitle: row.done ? 'Tilbud sendt. Klikk for å angre.' : 'Marker tilbudet som sendt',
          onToggle: held ? () => toggleGoal('offerSent') : undefined,
          extras: held && !row.done ? (
            <button type="button" onClick={() => onOpenFlow(client, hasNotes ? 3 : 2)} className={ROW_BUTTON}>
              <Send size={11} />
              Klargjør tilbud
            </button>
          ) : null,
        };
      }
      if (row.stepId === 'contractSigned') {
        const sent = Boolean(client.progression?.offerSent);
        return {
          ...row,
          busy: progressBusyKey === `${client.id}:contractSigned`,
          toggleTitle: row.done ? 'Kontrakt signert. Klikk for å angre.' : 'Marker kontrakt signert. Kunden flyttes til Solgt.',
          onToggle: sent ? () => toggleGoal('contractSigned') : undefined,
          extras: sent ? <button type="button" onClick={() => onOpenFlow(client, 3)} className={ROW_BUTTON}>Åpne tilbud</button> : null,
        };
      }
      return row;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, nowMs, sendingMailKey, readUpBusyId, progressBusyKey, phone]);

  function rowExtras(action: SalesNextAction) {
    if (action.presetKey === 'meeting') {
      const meetingMs = Date.parse(meetingAt || '');
      const canMarkNoShow = entry.category === 'meetingsToday' && !missed && Number.isFinite(meetingMs) && nowMs >= meetingMs;
      return (
        <>
          {canMarkNoShow ? (
            <button type="button" onClick={markNoShow} disabled={missedBusy} className={ROW_BUTTON} title="Kunden kom ikke. Flytt til Venter møtebekreftelse med en ringeoppgave i morgen kl 10.">
              <UserX size={11} />
              Møtte ikke opp
            </button>
          ) : null}
          {missed ? null : irl ? (
            mapHref ? (
              <a href={mapHref} target="_blank" rel="noreferrer" className={ROW_BUTTON}>
                <MapPin size={11} />
                Vis i kart
              </a>
            ) : null
          ) : (
            <button
              type="button"
              onClick={() => onOpenMeet(client)}
              disabled={!meetLink || meetOpening}
              className={ROW_BUTTON}
              title={meetLink
                ? 'Åpne Google Meet. Selgeren som eier kunden er vert; kunden har samme lenke.'
                : 'Ingen Meet-lenke ennå. Den lages når bekreftelsen sendes.'}
            >
              {meetOpening ? <Loader2 size={11} className="animate-spin" /> : <ExternalLink size={11} />}
              Møtelenke
            </button>
          )}
          <button
            type="button"
            onClick={() => onOpenPreview(client)}
            className={ROW_BUTTON}
            title={hasPreview ? 'Åpne nettside-preview i ny fane' : 'Ingen preview publisert ennå'}
          >
            <Globe size={11} />
            Åpne preview
          </button>
          <button
            type="button"
            onClick={() => onOpenFlow(client, 2)}
            className={ROW_BUTTON}
            title="Åpne produktnotater (side 2 etter Kundekort)"
          >
            <NotebookPen size={11} />
            Notater
          </button>
        </>
      );
    }
    const callRow = action.presetKey === 'contractCheckup' || action.presetKey === 'signatureFollowUp' || action.presetKey === 'checkup3mnd';
    if (callRow && phone && !action.doneAt) {
      return (
        <>
          <a href={`tel:${phone}`} className={ROW_BUTTON}><Phone size={11} />Ring</a>
          <a href={`sms:${phone}`} className={ROW_BUTTON}><MessageSquare size={11} />SMS</a>
        </>
      );
    }
    return null;
  }

  const status = entryStatus(entry, nowMs);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <div className="space-y-3 min-w-0">
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg sm:text-xl font-semibold text-white truncate">{client.businessName || 'Uten navn'}</h2>
                <ModeChip client={client} />
                {status ? (
                  <span className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] ${TONE_CLASS[status.tone]}`}>{status.text}</span>
                ) : null}
                {client.status === 'secondary' ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded border text-[11px] border-white/15 text-gray-300">Sekundær</span>
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
                  <span className="inline-flex items-center gap-1 min-w-0 truncate">
                    <a href={`mailto:${client.contactEmail}`} className="inline-flex items-center gap-1 hover:text-white min-w-0 truncate">
                      <Mail size={12} />{client.contactEmail}
                    </a>
                    {client.contactEmailError?.message ? (
                      <span className="text-red-400 shrink-0" title={client.contactEmailError.message}>kom ikke fram</span>
                    ) : null}
                  </span>
                ) : null}
              </div>
              {isWon && signedAt ? (
                <div className="mt-1 text-xs text-gray-300">Kontrakt signert {when(signedAt, nowMs)}</div>
              ) : meetingAt ? (
                <div className="mt-1 text-xs text-gray-300">
                  Møte {when(meetingAt, nowMs)} · {irl ? 'IRL' : 'Online'}{irl && place ? ` · ${place}` : ''}
                  {missed ? <span className="text-amber-200"> · {missed.label} {when(missed.at, nowMs)}</span> : null}
                </div>
              ) : null}
            </div>
            {pager}
          </div>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <button type="button" onClick={() => onEdit(client)} className={HEADER_BUTTON}>
              <Pencil size={13} />
              Rediger
            </button>
            {!isWon ? (
              <>
                <button
                  type="button"
                  onClick={() => onSecondary(client)}
                  disabled={statusBusyId === `secondary:${client.id}`}
                  className={HEADER_BUTTON}
                  title="Marker kunden som Sekundær. Kunden blir i samme flyt."
                >
                  {statusBusyId === `secondary:${client.id}` ? <Loader2 size={13} className="animate-spin" /> : <Layers size={13} />}
                  Sekundær
                </button>
                <button
                  type="button"
                  onClick={() => onNotSold(client)}
                  disabled={statusBusyId === `not-sold:${client.id}`}
                  className={HEADER_BUTTON}
                  title="Arkiver kunden som ikke solgt"
                >
                  {statusBusyId === `not-sold:${client.id}` ? <Loader2 size={13} className="animate-spin" /> : <Archive size={13} />}
                  Ikke solgt
                </button>
                {meetingOpen ? (
                  <button
                    type="button"
                    onClick={() => onMissedStep(client, 'skip', true)}
                    disabled={missedBusy}
                    className={HEADER_BUTTON}
                    title="Hopp over møtet. Kunden flyttes til Venter møtebekreftelse med en ringeoppgave i morgen kl 10. Skriv grunnen i Notater."
                  >
                    {missedBusy ? <Loader2 size={13} className="animate-spin" /> : <SkipForward size={13} />}
                    Skip
                  </button>
                ) : null}
                {missed?.undoable && entry.category === 'confirm' ? (
                  <button
                    type="button"
                    onClick={() => onMissedStep(client, missed.kind === 'noShow' ? 'noShow' : 'skip', false)}
                    disabled={missedBusy}
                    className={HEADER_BUTTON}
                    title={`Angre «${missed.label}». Kunden går tilbake dit den var.`}
                  >
                    {missedBusy ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
                    Angre {missed.label.toLowerCase()}
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        {isAssign ? (
          <AssignPanel {...props} />
        ) : (
          <div className="rounded-xl border border-white/10 bg-black/20 p-2.5">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-gray-400">Handlinger</div>
            <SalesGoalTimeline
              client={client}
              nowMs={nowMs}
              variant={isWon ? 'win' : 'active'}
              progressBusyKey={progressBusyKey}
              actionBusy={actionBusy}
              onToggleGoal={(key) => toggleGoal(key)}
              onMutateAction={(body) => onMutateAction(client, body)}
              fixedRows={isWon ? [] : fixedRows}
              renderRowExtras={rowExtras}
              focusRowId={entry.focusRowId}
            />
          </div>
        )}

        <div className="rounded-xl border border-white/10 bg-black/20 p-2.5">
          <button
            type="button"
            onClick={() => setDetailsOpen((open) => !open)}
            aria-expanded={detailsOpen}
            className="w-full flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400 hover:text-white"
          >
            Details & tools
            <ChevronDown size={14} className={`transition-transform ${detailsOpen ? 'rotate-180' : ''}`} />
          </button>
          {detailsOpen ? <div className="mt-2">{renderDetails(client)}</div> : null}
        </div>
      </div>

      <div className="space-y-3 min-w-0">
        {renderNotes(client)}
      </div>
    </div>
  );
}

function AssignPanel({ entry, salesReps, assigningId, onAssign, renderRecording }: FocusCardProps) {
  const { client } = entry;
  const busy = assigningId === client.id;
  return (
    <div className="rounded-xl border border-[#FF5B00]/50 bg-[#FF5B00]/5 p-3 space-y-3">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#ff8a4d]">Tildel selger</div>
      {renderRecording(client)}
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Selger"
          defaultValue=""
          disabled={busy}
          onChange={(event) => {
            const ownerId = event.target.value;
            if (ownerId) onAssign(client, ownerId);
          }}
          className="min-w-0 flex-1 rounded-lg bg-[#161616] border border-white/10 text-white text-sm px-2.5 py-2 disabled:opacity-50"
        >
          <option value="">{busy ? 'Tildeler…' : 'Velg selger…'}</option>
          {salesReps.map((rep) => (
            <option key={rep.id} value={rep.id}>{rep.label}</option>
          ))}
        </select>
      </div>
      {!salesReps.length ? <p className="text-xs text-gray-400">Ingen selgere å velge. Legg til en selger under Admin først.</p> : null}
    </div>
  );
}
