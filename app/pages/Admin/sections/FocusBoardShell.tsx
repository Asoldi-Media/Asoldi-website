import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { SALES_ACTION_TIMEZONE, isoToDatetimeLocalOslo } from '../../../../lib/sales-next-actions.js';

export type FocusShellCategory = { id: string; label: string; hint: string };

export type FocusShellEntry = {
  id: string;
  name: string;
  category: string;
  dueAt: string;
  overdue: boolean;
};

export type FocusTone = 'red' | 'warn' | 'green' | 'muted';
export type FocusStatus = { text: string; tone: FocusTone };
export type FocusRequest = { id: string; nonce: number } | null;

export const FOCUS_TONE_CLASS: Record<FocusTone, string> = {
  red: 'bg-red-500/15 border-red-500/40 text-red-200',
  warn: 'bg-amber-500/15 border-amber-500/40 text-amber-200',
  green: 'bg-green-900/40 border-green-600/40 text-green-300',
  muted: 'bg-white/5 border-white/15 text-gray-300',
};

const HOUR_MS = 60 * 60 * 1000;

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

export function focusWhen(iso: string, nowMs: number) {
  if (!iso) return '';
  return [dayWord(iso, nowMs), clock(iso)].filter(Boolean).join(' ');
}

export function focusSince(iso: string, nowMs: number) {
  const ms = nowMs - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} t`;
  return `${Math.floor(hours / 24)} d`;
}

function untilText(ms: number) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} t ${rest} min` : `${hours} t`;
}

/** Tab clock: red "forfalt 2 d" for the most recent late client, else the next time in the tab. */
function tabClock(rows: FocusShellEntry[], nowMs: number) {
  let lateMs: number | null = null;
  let nextMs: number | null = null;
  for (const row of rows) {
    const ms = Date.parse(row.dueAt);
    if (!Number.isFinite(ms)) continue;
    if (row.overdue) lateMs = lateMs == null ? ms : Math.max(lateMs, ms);
    else if (ms >= nowMs) nextMs = nextMs == null ? ms : Math.min(nextMs, ms);
  }
  if (lateMs != null) {
    return { late: true, text: `forfalt ${focusSince(new Date(lateMs).toISOString(), nowMs) || 'nå'}` };
  }
  if (nextMs != null) {
    const iso = new Date(nextMs).toISOString();
    return { late: false, text: dayWord(iso, nowMs) === 'i dag' ? `om ${untilText(nextMs - nowMs)}` : focusWhen(iso, nowMs) };
  }
  return null;
}

export function FocusStatusChip({ status }: { status: FocusStatus }) {
  return (
    <span className={`inline-flex shrink-0 items-center px-2 py-0.5 rounded border text-[11px] ${FOCUS_TONE_CLASS[status.tone]}`}>
      {status.text}
    </span>
  );
}

/** Measures the sticky header bar so popups open right under it. */
/** Bottom edge of the header bar in the viewport. Not its height: inside the admin layout the header starts below the top. */
export function useHeaderBarHeight(headerRef: React.RefObject<HTMLElement | null>) {
  const [bottom, setBottom] = useState(64);
  useEffect(() => {
    const bar = headerRef.current?.firstElementChild;
    if (!(bar instanceof HTMLElement)) return undefined;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setBottom(Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) || 64);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(bar);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [headerRef]);
  return bottom;
}

/** Header Filter / Calendar / Forespørsler popup over the board, same as Sales. Escape is handled by the page. */
export function FocusHeaderPopup({
  open,
  top,
  wide = false,
  label,
  hint,
  onClose,
  children,
}: {
  open: boolean;
  top: number;
  wide?: boolean;
  label: string;
  hint: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-[80] flex items-start justify-center px-3 sm:px-6 pb-6 pt-3" style={{ top }}>
      <button type="button" className="absolute inset-0 bg-black/45" aria-label="Lukk" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`relative z-10 w-full overflow-hidden rounded-2xl border border-white/10 bg-[#1f1f1f] shadow-2xl ${wide ? 'max-w-[1100px]' : 'max-w-3xl'}`}
      >
        <div className="max-h-[min(80dvh,44rem)] overflow-y-auto overscroll-contain px-3 sm:px-5 py-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <p className="text-[11px] text-gray-400">{hint}</p>
            <button type="button" onClick={onClose} className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-white">
              <X size={12} /> Lukk
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

type Props<T extends FocusShellEntry> = {
  ariaLabel: string;
  categories: FocusShellCategory[];
  queues: Record<string, T[]>;
  active: string;
  onCategory: (id: string) => void;
  nowMs: number;
  statusFor: (entry: T) => FocusStatus;
  detailFor?: (entry: T) => React.ReactNode;
  renderCard: (entry: T, pager: React.ReactNode) => React.ReactNode;
  emptyText: (categoryId: string) => string;
  /** Show this client wherever it is (request popup, full list). */
  focusRequest?: FocusRequest;
};

/** Sales-style board: tabs with count + clock, Neste kunder popup, one focused client with a pager. */
export function FocusBoardShell<T extends FocusShellEntry>(props: Props<T>) {
  const { ariaLabel, categories, queues, active, onCategory, nowMs, statusFor, detailFor, renderCard, emptyText, focusRequest } = props;
  const [focus, setFocus] = useState<Record<string, { id: string; index: number }>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  /** The client stays on screen after leaving the tab, so the tick can be seen and undone. */
  const [held, setHeld] = useState<{ category: string; id: string; note: string } | null>(null);
  const [note, setNote] = useState('');
  const lastFocusRef = useRef<{ category: string; id: string; name: string } | null>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [popupLeft, setPopupLeft] = useState(0);

  const activeMeta = categories.find((row) => row.id === active) || categories[0];

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
  let index = stored ? queue.findIndex((row) => row.id === stored.id) : 0;
  if (index < 0) index = Math.min(stored?.index ?? 0, queue.length - 1);
  const entry = index >= 0 ? queue[index] || null : null;
  const entryId = entry?.id || '';

  function findAnywhere(id: string): T | null {
    for (const meta of categories) {
      const row = (queues[meta.id] || []).find((candidate) => candidate.id === id);
      if (row) return row;
    }
    return null;
  }

  const heldBackIndex = held && held.category === active ? queue.findIndex((row) => row.id === held.id) : -1;
  const heldEntry = held && held.category === active && heldBackIndex < 0 ? findAnywhere(held.id) : null;
  const shown = heldEntry || entry;

  /** When the client on screen leaves this tab, keep it up and say where it went. */
  useEffect(() => {
    const last = lastFocusRef.current;
    if (last && last.category === active && !queue.some((row) => row.id === last.id)) {
      const moved = findAnywhere(last.id);
      const movedLabel = moved ? categories.find((meta) => meta.id === moved.category)?.label || '' : '';
      if (moved && movedLabel) {
        setHeld({ category: active, id: last.id, note: `${last.name} er flyttet til ${movedLabel}.` });
      } else {
        setNote(`${last.name} er ferdig i ${activeMeta?.label || 'denne fanen'}.${entry ? ` Neste: ${entry.name || 'kunde'}.` : ''}`);
      }
    }
    lastFocusRef.current = entry ? { category: active, id: entry.id, name: entry.name || 'Kunden' } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queues, active, entryId]);

  /** The client on screen stays put when the queue re-sorts; only a tick, the pager or the popup moves on. */
  useEffect(() => {
    if (!entry || stored?.id === entry.id) return;
    setFocus((prev) => ({ ...prev, [active]: { id: entry.id, index } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, entryId]);

  useEffect(() => {
    if (!note) return undefined;
    const timer = window.setTimeout(() => setNote(''), 6000);
    return () => window.clearTimeout(timer);
  }, [note]);

  /** An undo brings the held client back into the tab: focus it there again. */
  useEffect(() => {
    if (!held || held.category !== active || heldBackIndex < 0) return;
    setFocus((prev) => ({ ...prev, [active]: { id: held.id, index: heldBackIndex } }));
    setHeld(null);
  }, [held, heldBackIndex, active]);

  useEffect(() => {
    setMenuOpen(false);
    setHeld(null);
    setNote('');
    tabListRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  useEffect(() => {
    if (!focusRequest?.id) return;
    const row = findAnywhere(focusRequest.id);
    if (!row) return;
    const rowIndex = (queues[row.category] || []).findIndex((candidate) => candidate.id === row.id);
    lastFocusRef.current = { category: row.category, id: row.id, name: row.name || 'Kunden' };
    setFocus((prev) => ({ ...prev, [row.category]: { id: row.id, index: rowIndex } }));
    setHeld(null);
    if (row.category !== active) onCategory(row.category);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  function focusAt(nextIndex: number) {
    const row = queue[nextIndex];
    if (!row) return;
    setHeld(null);
    setFocus((prev) => ({ ...prev, [active]: { id: row.id, index: nextIndex } }));
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
    <section className="rounded-2xl bg-[#2a2a2a] border border-white/10 p-3 sm:p-4 space-y-3" aria-label={ariaLabel}>
      <div className="relative">
        <div ref={tabListRef} className="flex gap-2 overflow-x-auto pb-0.5" role="tablist">
          {categories.map((meta) => {
            const rows = queues[meta.id] || [];
            const selected = meta.id === active;
            const tab = tabClock(rows, nowMs);
            return (
              <button
                key={meta.id}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-expanded={selected ? menuOpen : undefined}
                onClick={() => (selected ? setMenuOpen((open) => !open) : onCategory(meta.id))}
                title={selected ? (menuOpen ? 'Skjul neste kunder' : 'Vis neste kunder') : meta.hint}
                className={`relative shrink-0 min-w-[8.5rem] sm:min-w-0 sm:flex-1 cursor-pointer rounded-xl border px-3 py-2.5 text-left transition-colors ${
                  selected
                    ? 'bg-[#FF5B00] border-[#FF5B00] text-white'
                    : 'bg-black/20 border-white/10 text-gray-200 hover:bg-white/10'
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="text-lg font-semibold tabular-nums leading-none">{rows.length}</span>
                  {tab ? (
                    <span
                      className={`min-w-0 truncate text-[11px] tabular-nums leading-none ${
                        tab.late
                          ? (selected ? 'font-semibold text-white' : 'font-medium text-red-300')
                          : (selected ? 'text-white/85' : 'text-gray-400')
                      }`}
                      title={tab.late ? 'Noe er forfalt' : 'Neste frist'}
                    >
                      {tab.text}
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
          aria-label={`Neste kunder i ${activeMeta?.label || ''}`}
          inert={!(menuOpen && queue.length)}
          style={{ left: popupLeft }}
          className={`absolute top-full z-30 mt-2 w-[min(26rem,100%)] transition duration-200 ease-out ${
            menuOpen && queue.length ? 'opacity-100 translate-y-0' : 'pointer-events-none opacity-0 -translate-y-1'
          }`}
        >
          <div className="rounded-xl border border-[#FF5B00]/40 bg-[#2a2a2a] shadow-2xl shadow-black/30 overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
              <span>Neste kunder i {activeMeta?.label} · {queue.length}</span>
              <span className="font-normal normal-case tracking-normal">Velg en kunde</span>
            </div>
            <ul className="sales-action-scroll max-h-[min(24rem,60dvh)] overflow-y-auto overscroll-contain divide-y divide-white/5">
              {queue.map((row, rowIndex) => {
                const current = !heldEntry && rowIndex === index;
                return (
                  <li key={row.id}>
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
                        <span className="min-w-0 truncate text-sm font-medium text-white">{row.name || 'Uten navn'}</span>
                        <span className="flex items-center gap-2">
                          <FocusStatusChip status={statusFor(row)} />
                          {current ? null : <ChevronRight size={14} className="text-gray-500" />}
                        </span>
                      </div>
                      {detailFor ? (
                        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-gray-400">{detailFor(row)}</div>
                      ) : null}
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
          <span>{held.note} Angre med haken under.</span>
          <button
            type="button"
            onClick={() => setHeld(null)}
            className="shrink-0 inline-flex items-center gap-1 cursor-pointer rounded-lg bg-[#FF5B00] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#e55200]"
          >
            {entry ? <>Neste: {entry.name || 'kunde'}</> : 'Lukk'}
            <ChevronRight size={14} />
          </button>
        </div>
      ) : note ? (
        <div role="status" className="rounded-xl border border-green-600/40 bg-green-900/40 px-3 py-2 text-sm text-green-300">
          {note}
        </div>
      ) : null}

      {shown ? (
        <React.Fragment key={`${active}:${shown.id}`}>
          {renderCard(shown, pager)}
        </React.Fragment>
      ) : (
        <div className="rounded-xl border border-dashed border-white/15 px-4 py-8 text-center">
          <CheckCircle2 size={22} className="mx-auto text-green-400" />
          <p className="mt-2 text-sm text-gray-200">{emptyText(active)}</p>
          <p className="mt-1 text-xs text-gray-500">{activeMeta?.hint}</p>
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
