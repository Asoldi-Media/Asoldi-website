import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, Circle, GripVertical, History, Loader2, Pencil, Pin, Plus, Trash2, X } from 'lucide-react';
import type { SalesClient, SalesGoalKey, SalesNextAction, SalesNextActionPreset } from '../shared';
import {
  AFTER_SALE_GOAL,
  ACTION_FORMATS,
  actionAnchorId,
  canReorderAction,
  canStickAction,
  decorateNextActions,
  getVisibleNextActions,
  formatActionFormatLabel,
  formatGoalLabel,
  formatPresetLabel,
  getCurrentGoalKey,
  getGoalActions,
  getSalesGoalKeys,
  GOAL_PRESETS,
  FOLLOW_UP_1M_NOTE,
  isoToDatetimeLocalOslo,
  datetimeLocalOsloToIso,
  defaultAddToCalendar,
  defaultFormatForPreset,
  isRecordedSalesAction,
  presetNeedsMeeting,
  suggestedDueAtForPreset,
  SALES_ACTION_TIMEZONE,
} from '../../../../lib/sales-next-actions.js';
import type { SalesActionFormat } from '../shared';
import { ActionDateTimeInput } from './ActionDateTimeInput';
import { MeetingVideoHover } from './MeetingVideoHover';
import { ClientActivityLogCover } from './ClientActivityLogCover';
import { clientMeetingHover } from '../../../../lib/workshop-record.js';
import { boardRowGoalKey, salesGoalRowCounts } from '../../../../lib/sales-playbook.js';

/** A playbook step with no stored row (Bekreftelse, Les deg opp, Kontrakt signert…). */
export type SalesFixedRow = {
  id: string;
  stepId: string;
  goalKey: string;
  label: string;
  done: boolean;
  doneAt?: string;
  dueAt?: string;
  state: string;
  detail?: string;
  placement: 'start' | 'beforeMeeting' | 'end';
  /** Next row even when rows above it are still open (Ring for ny møtetid under an unheld Møte). */
  lead?: boolean;
  /** Status icon click. Omit when the row can't be checked by hand. */
  onToggle?: () => void;
  toggleTitle?: string;
  busy?: boolean;
  extras?: React.ReactNode;
};

type RowStatus = 'done' | 'overdue' | 'next' | 'later';

/** Board list ends above the screen bottom, leaving room for the preset row and "Vis alle kunder". */
const BOARD_LIST_BOTTOM_RESERVE_PX = 150;
const BOARD_LIST_MIN_PX = 160;
const BOARD_LIST_PEEK_PX = 24;
const NEXT_ROW = 'border-[#FF5B00]/40 bg-[#FF5B00]/[0.07]';

type ListItem =
  | { kind: 'action'; action: SalesNextAction; done: boolean }
  | { kind: 'fixed'; row: SalesFixedRow };

const STATUS_TITLE: Record<RowStatus, string> = {
  done: 'Ferdig',
  overdue: 'Forfalt',
  next: 'Neste',
  later: 'Senere',
};

function RowStatusIcon({ status }: { status: RowStatus }) {
  if (status === 'done') return <CheckCircle2 size={16} className="text-green-400" />;
  if (status === 'overdue') return <AlertTriangle size={16} className="text-red-300" />;
  return <Circle size={16} className={status === 'next' ? 'text-[#FF5B00]/70' : 'text-gray-500'} />;
}

function StatusToggle({ status, busy, disabled, title, onClick }: {
  status: RowStatus;
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const label = title || STATUS_TITLE[status];
  const icon = busy ? <Loader2 size={16} className="animate-spin text-gray-400" /> : <RowStatusIcon status={status} />;
  if (!onClick) {
    return <span className="shrink-0 inline-flex p-0.5" title={label} aria-label={label}>{icon}</span>;
  }
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={status === 'done'}
      aria-label={label}
      title={label}
      disabled={disabled || busy}
      onClick={onClick}
      className="shrink-0 inline-flex p-0.5 rounded-full cursor-pointer hover:bg-white/10 disabled:cursor-default disabled:opacity-50"
    >
      {icon}
    </button>
  );
}

type DraftState = {
  presetKey: SalesNextActionPreset;
  name: string;
  note: string;
  format: SalesActionFormat;
  dueAt: string;
  addToCalendar: boolean;
  sticky: boolean;
  meetingMode: 'online' | 'in-person';
};

type EditState = {
  actionId: string;
  name: string;
  note: string;
  format: SalesActionFormat;
  dueAt: string;
  addToCalendar: boolean;
  sticky: boolean;
  meetingMode: 'online' | 'in-person';
};

type Props = {
  client: SalesClient;
  progressBusyKey: string | null;
  actionBusy: boolean;
  onMutateAction: (body: Record<string, unknown>) => Promise<void>;
  /** Sold clients: actions only, no møte/tilbud/kontrakt checkpoints. */
  variant?: 'active' | 'win';
  /**
   * Focus board: playbook steps listed with the stored rows. Passing this also shows the current
   * goal's done rows, done/total on the goal chips, and the full list without the scroll cap.
   */
  fixedRows?: SalesFixedRow[];
  /** Extra buttons under a stored row (Møtelenke / Åpne preview on the Møte row). */
  renderRowExtras?: (action: SalesNextAction) => React.ReactNode;
  /** Row the selected focus category points to. */
  focusRowId?: string;
  nowMs?: number;
};

function toDateTimeLocal(value = '') {
  return isoToDatetimeLocalOslo(value);
}

function toIsoDateTime(value = '') {
  return datetimeLocalOsloToIso(value);
}

function formatWhen(value = '') {
  if (!value) return 'Tid ikke satt';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nb-NO', { timeZone: SALES_ACTION_TIMEZONE });
}

function clusterFreeId(action: SalesNextAction, actions: SalesNextAction[]) {
  if (canReorderAction(action)) return action.id;
  return actionAnchorId(action, actions) || action.id;
}

function moveFreeId(freeIds: string[], dragId: string, targetId: string, before: boolean) {
  if (!dragId || !targetId || dragId === targetId) return freeIds;
  const next = freeIds.filter((id) => id !== dragId);
  let index = next.indexOf(targetId);
  if (index < 0) return freeIds;
  if (!before) index += 1;
  next.splice(index, 0, dragId);
  return next;
}

export function SalesGoalTimeline({
  client,
  progressBusyKey,
  actionBusy,
  onMutateAction,
  variant = 'active',
  fixedRows,
  renderRowExtras,
  focusRowId = '',
  nowMs = Date.now(),
}: Props) {
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; before: boolean } | null>(null);
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const actionListRef = useRef<HTMLDivElement | null>(null);
  const [actionListMaxPx, setActionListMaxPx] = useState<number | null>(null);
  const [boardOverflow, setBoardOverflow] = useState(false);
  const [boardMaxPx, setBoardMaxPx] = useState<number | null>(null);
  const [viewedGoal, setViewedGoal] = useState<SalesGoalKey | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const isWin = variant === 'win';
  const currentGoal = (isWin ? AFTER_SALE_GOAL : getCurrentGoalKey(client)) as SalesGoalKey | 'afterSale' | '';
  const visibleGoals = getSalesGoalKeys(client.product) as SalesGoalKey[];
  const displayGoal = (viewedGoal && visibleGoals.includes(viewedGoal) ? viewedGoal : currentGoal) as SalesGoalKey | 'afterSale' | '';
  const viewingCurrent = displayGoal === currentGoal;
  const canCreateActions = Boolean(displayGoal) && (isWin || viewingCurrent);
  const boardMode = Array.isArray(fixedRows);
  const currentActions = useMemo(
    () => (
      viewingCurrent || isWin
        ? getVisibleNextActions(client)
        : getGoalActions(client, displayGoal)
    ) as SalesNextAction[],
    [client, displayGoal, isWin, viewingCurrent],
  );
  const listItems = useMemo<ListItem[]>(() => {
    const open: ListItem[] = currentActions.map((action) => ({ kind: 'action', action, done: false }));
    const done: ListItem[] = (decorateNextActions(client) as SalesNextAction[])
      .filter((action) => action.doneAt && action.presetKey !== 'sendOffer' && boardRowGoalKey(action) === displayGoal)
      .sort((a, b) => String(a.doneAt).localeCompare(String(b.doneAt)))
      .map((action) => ({ kind: 'action', action, done: true }));
    if (!boardMode) return viewingCurrent || !displayGoal ? open : [...done, ...open];
    if (!displayGoal) return open;
    const goalFixed = (fixedRows || []).filter((row) => row.goalKey === displayGoal);
    const fixedAt = (placement: SalesFixedRow['placement']): ListItem[] => goalFixed
      .filter((row) => row.placement === placement)
      .map((row) => ({ kind: 'fixed', row }));
    const beforeMeeting = fixedAt('beforeMeeting');
    const meetingIndex = open.findIndex((item) => item.kind === 'action' && item.action.presetKey === 'meeting');
    const middle = meetingIndex < 0
      ? [...open, ...beforeMeeting]
      : [...open.slice(0, meetingIndex), ...beforeMeeting, ...open.slice(meetingIndex)];
    return [...fixedAt('start'), ...done, ...middle, ...fixedAt('end')];
  }, [boardMode, client, currentActions, displayGoal, fixedRows, viewingCurrent]);
  const goalCounts = useMemo(
    () => (boardMode ? salesGoalRowCounts(client, nowMs) as Record<string, { done: number; total: number }> : {}),
    [boardMode, client, nowMs],
  );
  const nextItemKey = (() => {
    const noTimeMeeting = listItems.find((entry) => (
      entry.kind === 'action'
      && entry.action.presetKey === 'meeting'
      && !entry.done
      && !entry.action.dueAt
    ));
    if (noTimeMeeting) return noTimeMeeting.action.id;
    const item = listItems.find((entry) => entry.kind === 'fixed' && entry.row.lead && !entry.row.done)
      || listItems.find((entry) => (entry.kind === 'fixed' ? !entry.row.done : !entry.done));
    if (!item) return '';
    return item.kind === 'fixed' ? item.row.id : item.action.id;
  })();
  const salesHover = clientMeetingHover(client, 'sales');
  const presets = canCreateActions && displayGoal ? (GOAL_PRESETS[displayGoal] || []) : [];
  const hasMeeting = Boolean(client.agreedTime && client.meetingAt);
  const capActionList = !boardMode && currentActions.length > 1 && !edit;

  function actionStatus(action: SalesNextAction, done: boolean): RowStatus {
    if (done) return 'done';
    const dueMs = Date.parse(action.dueAt || '');
    if (Number.isFinite(dueMs) && dueMs < nowMs) return 'overdue';
    return viewingCurrent && action.id === nextItemKey ? 'next' : 'later';
  }

  function fixedStatus(row: SalesFixedRow): RowStatus {
    if (row.done) return 'done';
    if (row.state === 'overdue') return 'overdue';
    return viewingCurrent && row.id === nextItemKey ? 'next' : 'later';
  }

  const isNextRow = (id: string) => viewingCurrent && Boolean(nextItemKey) && id === nextItemKey;

  const listCapped = boardMode ? boardOverflow : Boolean(actionListMaxPx);

  const scrollTargetId = boardMode && viewingCurrent ? nextItemKey : '';

  useLayoutEffect(() => {
    const root = actionListRef.current;
    if (!root || !boardMode) {
      setBoardOverflow(false);
      return;
    }
    const measure = () => {
      const pageTop = root.getBoundingClientRect().top + window.scrollY;
      const max = Math.max(BOARD_LIST_MIN_PX, Math.floor(window.innerHeight - pageTop - BOARD_LIST_BOTTOM_RESERVE_PX));
      setBoardMaxPx((prev) => (prev === max ? prev : max));
      setBoardOverflow(root.scrollHeight > Math.min(max, root.clientHeight) + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(document.body);
    if (root.firstElementChild) observer.observe(root.firstElementChild);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [boardMode, listItems.length]);

  /** Long lists scroll inside the box; the next action sits at the top with a peek of the row above. */
  useLayoutEffect(() => {
    const root = actionListRef.current;
    if (!root || !scrollTargetId) return;
    const row = root.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(scrollTargetId)}"]`);
    if (!row) return;
    root.scrollTop += row.getBoundingClientRect().top - root.getBoundingClientRect().top - BOARD_LIST_PEEK_PX;
  }, [scrollTargetId, listItems.length, boardMaxPx]);

  useLayoutEffect(() => {
    const root = actionListRef.current;
    if (!root || !capActionList) {
      setActionListMaxPx(null);
      return;
    }
    const measure = () => {
      const rows = root.querySelectorAll<HTMLElement>('[data-action-row]');
      const first = rows[0];
      const second = rows[1];
      if (!first || !second) return;
      const gap = parseFloat(window.getComputedStyle(second).marginTop) || 0;
      const next = Math.ceil(first.getBoundingClientRect().height + gap + second.getBoundingClientRect().height / 2);
      setActionListMaxPx((prev) => (prev === next ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    root.querySelectorAll('[data-action-row]').forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [capActionList, currentActions]);

  useEffect(() => {
    setViewedGoal(null);
  }, [client.id]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const node = event.target;
      if (!(node instanceof Element)) return;
      if (node.closest('[data-sales-client-overlay]')) return;
      const card = timelineRootRef.current?.closest('[data-sales-client-card]');
      if (!card || card.contains(node)) return;
      setViewedGoal(null);
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [client.id]);

  function showGoal(key: SalesGoalKey) {
    setDraft(null);
    setEdit(null);
    setViewedGoal(key === currentGoal ? null : key);
  }

  function startPreset(presetKey: SalesNextActionPreset) {
    if (presetNeedsMeeting(presetKey) && !hasMeeting) return;
    const suggested = suggestedDueAtForPreset(presetKey, client);
    setEdit(null);
    setDraft({
      presetKey,
      name: formatPresetLabel(presetKey) === 'Custom' ? '' : formatPresetLabel(presetKey),
      note: presetKey === 'oppfolging1mnd' ? FOLLOW_UP_1M_NOTE : '',
      format: defaultFormatForPreset(presetKey) as SalesActionFormat,
      dueAt: toDateTimeLocal(suggested),
      addToCalendar: defaultAddToCalendar(presetKey, client),
      sticky: false,
      meetingMode: client.meetingMode === 'in-person' ? 'in-person' : 'online',
    });
  }

  async function confirmDraft() {
    if (!draft || !currentGoal) return;
    await onMutateAction({
      op: 'create',
      goalKey: currentGoal,
      presetKey: draft.presetKey,
      name: draft.name,
      note: draft.note,
      format: draft.format,
      dueAt: toIsoDateTime(draft.dueAt),
      addToCalendar: draft.addToCalendar,
      sticky: draft.sticky,
      ...(draft.presetKey === 'meeting' ? { meetingMode: draft.meetingMode } : {}),
    });
    setDraft(null);
  }

  async function saveEdit() {
    if (!edit) return;
    const meeting = client.nextActions.find((action) => action.id === edit.actionId);
    await onMutateAction({
      op: 'update',
      id: edit.actionId,
      name: edit.name,
      note: edit.note,
      format: edit.format,
      dueAt: toIsoDateTime(edit.dueAt),
      addToCalendar: edit.addToCalendar,
      sticky: edit.sticky,
      ...(meeting?.presetKey === 'meeting' ? { meetingMode: edit.meetingMode } : {}),
    });
    setEdit(null);
  }

  async function dropAction(target: SalesNextAction, before: boolean, dragId = draggingId) {
    if (!dragId || !currentGoal) return;
    const targetId = clusterFreeId(target, currentActions);
    const freeIds = currentActions
      .filter((action) => action.goalKey === currentGoal && canReorderAction(action))
      .map((action) => action.id);
    const nextIds = moveFreeId(freeIds, dragId, targetId, before);
    setDraggingId(null);
    setDropHint(null);
    if (nextIds.join('\0') === freeIds.join('\0')) return;
    await onMutateAction({ op: 'reorder', goalKey: currentGoal, orderedIds: nextIds });
  }

  function formatControls(
    value: {
      format: SalesActionFormat;
      addToCalendar: boolean;
      presetKey?: string;
      meetingMode?: 'online' | 'in-person';
      sticky?: boolean;
    },
    onChange: (patch: Partial<Pick<DraftState, 'format' | 'addToCalendar' | 'meetingMode' | 'sticky'>>) => void,
  ) {
    const calendarLocked = value.presetKey === 'meeting';
    const showMeetingMode = value.presetKey === 'meeting';
    const recordedWhenOn = isRecordedSalesAction({
      presetKey: value.presetKey,
      format: value.format,
      addToCalendar: true,
      meetingMode: value.meetingMode,
    });
    const calendarTitle = recordedWhenOn
      ? 'Google Kalender · Meet + Fireflies. Kunden får ikke e-post.'
      : '15 min i Google Kalender';
    return (
      <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
        {showMeetingMode ? (
          <select
            aria-label="Møteform"
            value={value.meetingMode === 'in-person' ? 'in-person' : 'online'}
            onChange={(event) => onChange({ meetingMode: event.target.value as 'online' | 'in-person' })}
            className={`min-w-0 flex-1 rounded-md border text-xs font-semibold px-2 py-1.5 ${
              value.meetingMode === 'in-person'
                ? 'bg-[#FF5B00] border-[#FF5B00] text-white'
                : 'bg-sky-500 border-sky-500 text-white'
            }`}
          >
            <option value="online">Online</option>
            <option value="in-person">IRL</option>
          </select>
        ) : (
          <select
            aria-label="Format"
            value={value.format}
            onChange={(event) => onChange({ format: event.target.value as SalesActionFormat })}
            className="min-w-0 flex-1 rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
          >
            {ACTION_FORMATS.map((format) => (
              <option key={format} value={format}>{formatActionFormatLabel(format)}</option>
            ))}
          </select>
        )}
        <span title={calendarTitle} className="shrink-0 text-gray-300">
          <CalendarDays size={15} />
        </span>
        <button
          type="button"
          role="switch"
          aria-label={calendarTitle}
          aria-checked={value.addToCalendar}
          disabled={calendarLocked}
          onClick={() => onChange({ addToCalendar: !value.addToCalendar })}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-70 ${
            value.addToCalendar ? 'bg-[#FF5B00]' : 'bg-white/20'
          }`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${value.addToCalendar ? 'ml-4' : 'ml-1'}`} />
        </button>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-gray-300">
          <input
            type="checkbox"
            checked={Boolean(value.sticky)}
            onChange={(event) => onChange({ sticky: event.target.checked })}
          />
          Sticky
        </label>
      </div>
    );
  }

  return (
    <div ref={timelineRootRef} className="space-y-2" onClick={(event) => event.stopPropagation()}>
      {!isWin && (
      <div className="flex flex-wrap items-center gap-1.5">
        {visibleGoals.map((key) => {
          const done = Boolean(client.progression?.[key]);
          const busy = progressBusyKey === `${client.id}:${key}`;
          const isCurrent = key === currentGoal;
          const isViewed = key === displayGoal;
          return (
            <button
              key={key}
              type="button"
              aria-current={isViewed ? 'step' : undefined}
              onClick={() => showGoal(key)}
              title={
                isCurrent
                  ? (isViewed ? 'Nåværende mål' : 'Tilbake til nåværende mål')
                  : `Vis handlingene i ${formatGoalLabel(key)}`
              }
              className={`px-2 py-1 rounded-md text-[11px] border transition-colors ${
                isCurrent
                  ? 'bg-[#FF5B00]/15 border-[#FF5B00] text-white'
                  : done
                    ? `bg-green-900/40 border-green-600/40 text-green-300 hover:border-green-500/50 ${isViewed ? 'ring-1 ring-white/40' : ''}`
                    : `bg-black/20 border-white/10 text-gray-300 hover:border-white/20 ${isViewed ? 'ring-1 ring-white/40' : ''}`
              }`}
            >
              {busy ? <Loader2 size={11} className="inline mr-1 animate-spin" /> : done ? <CheckCircle2 size={11} className="inline mr-1" /> : null}
              {formatGoalLabel(key)}
              {goalCounts[key]?.total ? (
                <span className="ml-1 tabular-nums opacity-80">{goalCounts[key].done}/{goalCounts[key].total}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      )}

      {displayGoal ? (
        <div className="rounded-xl border border-white/10 bg-black/20 p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setLogOpen(true)}
              className="text-left text-[11px] text-gray-400 hover:text-gray-200"
              title="Åpne logg over alle handlinger og opptak"
            >
              {isWin ? (boardMode ? 'Etter salg' : 'Neste handling') : (
                <>{boardMode ? 'Handlinger i' : 'Neste handling i'} <span className="text-gray-200">{formatGoalLabel(displayGoal)}</span></>
              )}
            </button>
            <button
              type="button"
              onClick={() => setLogOpen(true)}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-white/10 text-[10px] text-gray-200 hover:bg-white/15"
              title="Åpne logg"
            >
              <History size={11} />
              Logg
            </button>
          </div>

          {listItems.length > 0 && (
          <div className="relative">
          <div
            ref={actionListRef}
            style={boardMode ? (boardMaxPx ? { maxHeight: boardMaxPx } : undefined) : actionListMaxPx ? { maxHeight: actionListMaxPx } : undefined}
            className={boardMode || actionListMaxPx ? 'sales-action-scroll overflow-y-auto overscroll-contain pr-1.5' : undefined}
          >
          <div className={listCapped ? 'space-y-2 pb-6' : 'space-y-2'}>
          {listItems.map((item) => {
            if (item.kind === 'fixed') {
              const fixed = item.row;
              const status = fixedStatus(fixed);
              const sub = fixed.detail || (!fixed.done && fixed.dueAt ? formatWhen(fixed.dueAt) : fixed.doneAt ? `Ferdig ${formatWhen(fixed.doneAt)}` : '');
              return (
                <div
                  key={fixed.id}
                  data-action-row
                  data-row-id={fixed.id}
                  className={`rounded-lg border px-2 py-1.5 ${
                    fixed.done ? 'border-white/5 bg-black/10' : isNextRow(fixed.id) ? NEXT_ROW : 'border-white/10 bg-black/30'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusToggle
                      status={status}
                      busy={fixed.busy}
                      title={fixed.toggleTitle}
                      onClick={fixed.onToggle}
                    />
                    <span className="shrink-0 w-4" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className={`text-xs truncate ${fixed.done ? 'text-gray-400 line-through decoration-white/20' : 'text-white'}`}>{fixed.label}</div>
                      {sub ? <div className={`text-[11px] truncate ${status === 'overdue' ? 'text-red-300' : 'text-gray-400'}`}>{sub}</div> : null}
                    </div>
                    {fixed.extras ? <div className="shrink-0 flex flex-wrap justify-end gap-1.5">{fixed.extras}</div> : null}
                  </div>
                </div>
              );
            }
            const currentAction = item.action;
            if (item.done) {
              return (
                <div key={currentAction.id} data-action-row data-row-id={currentAction.id} className="rounded-lg border border-white/5 bg-black/10 px-2 py-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusToggle
                      status="done"
                      disabled={actionBusy}
                      title="Ferdig. Klikk for å angre."
                      onClick={() => void onMutateAction({ op: 'uncomplete', id: currentAction.id })}
                    />
                    <span className="shrink-0 w-4" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-gray-400 truncate line-through decoration-white/20">{currentAction.name}</div>
                      <div className="text-[11px] text-gray-500 truncate">Ferdig {formatWhen(currentAction.doneAt || '')}</div>
                    </div>
                  </div>
                </div>
              );
            }
            const status = actionStatus(currentAction, false);
            const extras = renderRowExtras ? renderRowExtras(currentAction) : null;
            const clusterId = clusterFreeId(currentAction, currentActions);
            const inDragCluster = Boolean(draggingId && (currentAction.id === draggingId || clusterId === draggingId));
            const dropOnCluster = Boolean(dropHint && dropHint.id === clusterId);
            const row = (
            <div
              key={currentAction.id}
              data-action-row
              data-row-id={currentAction.id}
              onDragOver={(event) => {
                if (!draggingId) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const rect = event.currentTarget.getBoundingClientRect();
                const before = (event.clientY - rect.top) < rect.height / 2;
                setDropHint((prev) => (prev?.id === clusterId && prev.before === before ? prev : { id: clusterId, before }));
              }}
              onDrop={(event) => {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                const before = (event.clientY - rect.top) < rect.height / 2;
                const dragId = event.dataTransfer.getData('text/plain') || draggingId;
                void dropAction(currentAction, before, dragId);
              }}
              className={`rounded-lg border px-2 py-1.5 ${
                inDragCluster ? 'opacity-60' : ''
              } ${
                dropOnCluster ? 'ring-1 ring-[#FF5B00]' : ''
              } ${
                isNextRow(currentAction.id)
                  ? `${NEXT_ROW} hover:bg-[#FF5B00]/10`
                  : currentAction.addToCalendar && currentAction.dueAt
                    ? 'border-sky-400/50 bg-black/30 shadow-[0_0_0_3px_rgba(56,189,248,0.08)] hover:bg-[#3a3a3a]'
                    : 'border-white/10 bg-black/30 hover:bg-[#3a3a3a]'
              }`}
            >
              {edit?.actionId === currentAction.id ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className="text-[10px] text-gray-400 uppercase tracking-wide">
                    Navn
                    <input
                      value={edit.name}
                      onChange={(event) => setEdit((prev) => prev ? { ...prev, name: event.target.value } : prev)}
                      className="mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
                    />
                  </label>
                  <label className="text-[10px] text-gray-400 uppercase tracking-wide">
                    {currentAction.presetKey === 'meeting' ? 'Møtetid' : 'Tid for neste handling'}
                    <ActionDateTimeInput
                      value={edit.dueAt}
                      nowMs={nowMs}
                      ariaLabel={currentAction.presetKey === 'meeting' ? 'Møtetid' : 'Tid for neste handling'}
                      onChange={(dueAt) => setEdit((prev) => prev ? { ...prev, dueAt } : prev)}
                    />
                  </label>
                  <label className="sm:col-span-2 text-[10px] text-gray-400 uppercase tracking-wide">
                    Notat til handlingen
                    <textarea
                      value={edit.note}
                      onChange={(event) => setEdit((prev) => prev ? { ...prev, note: event.target.value } : prev)}
                      rows={2}
                      placeholder="F.eks. ringer etter lunsj, vil ha pris på 5 sider"
                      className="mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5 resize-y"
                    />
                  </label>
                  {formatControls(
                    {
                      format: edit.format,
                      addToCalendar: edit.addToCalendar,
                      presetKey: currentAction.presetKey,
                      meetingMode: edit.meetingMode,
                      sticky: edit.sticky,
                    },
                    (patch) => setEdit((prev) => prev ? { ...prev, ...patch } : prev),
                  )}
                  <div className="sm:col-span-2 flex gap-2">
                    <button
                      type="button"
                      disabled={actionBusy || !edit.name.trim() || !edit.dueAt}
                      onClick={() => void saveEdit()}
                      className="px-2 py-1 rounded-md bg-[#FF5B00] text-white text-[11px] disabled:opacity-50"
                    >
                      Lagre
                    </button>
                    <button
                      type="button"
                      onClick={() => setEdit(null)}
                      className="px-2 py-1 rounded-md bg-white/10 text-gray-200 text-[11px]"
                    >
                      Avbryt
                    </button>
                  </div>
                </div>
              ) : (
                <>
                <div className="flex items-center gap-2 min-w-0">
                  <StatusToggle
                    status={status}
                    disabled={actionBusy}
                    title={currentAction.presetKey === 'meeting' ? 'Marker møtet som holdt' : 'Marker som ferdig'}
                    onClick={() => void onMutateAction({ op: 'complete', id: currentAction.id })}
                  />
                  {canReorderAction(currentAction) && currentAction.goalKey === currentGoal ? (
                    <button
                      type="button"
                      draggable
                      aria-label="Flytt handling"
                      disabled={actionBusy}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', currentAction.id);
                        const rowEl = event.currentTarget.closest('[data-action-row]');
                        if (rowEl instanceof HTMLElement) event.dataTransfer.setDragImage(rowEl, 16, 16);
                        setDraggingId(currentAction.id);
                      }}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDropHint(null);
                      }}
                      className="shrink-0 p-0.5 rounded text-gray-500 hover:text-white cursor-grab active:cursor-grabbing disabled:opacity-40"
                      title="Dra for å endre rekkefølge. Sticky-handlinger blir med."
                    >
                      <GripVertical size={12} />
                    </button>
                  ) : (
                    <span className="shrink-0 w-4" aria-hidden="true" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-white truncate">
                      {currentAction.name}
                      {currentAction.presetKey === 'meeting' ? null : currentAction.format ? (
                        <span className="ml-1.5 text-[10px] uppercase tracking-wide text-gray-400">{formatActionFormatLabel(currentAction.format)}</span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-gray-400 truncate">{formatWhen(currentAction.dueAt)}</div>
                    {currentAction.note ? (
                      <div className="mt-0.5 text-[11px] text-gray-300 whitespace-pre-wrap break-words">{currentAction.note}</div>
                    ) : null}
                  </div>
                  {currentAction.presetKey === 'meeting' ? (
                    <select
                      aria-label="Møteform"
                      disabled={actionBusy}
                      value={client.meetingMode === 'in-person' ? 'in-person' : 'online'}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => void onMutateAction({
                        op: 'update',
                        id: currentAction.id,
                        meetingMode: event.target.value,
                      })}
                      className={`shrink-0 w-[6.5rem] rounded-md border text-[11px] font-semibold px-1.5 py-1 ${
                        client.meetingMode === 'in-person'
                          ? 'bg-[#FF5B00] border-[#FF5B00] text-white'
                          : 'bg-sky-500 border-sky-500 text-white'
                      }`}
                      title="Bytt Online/IRL. Bekreftelse sendes ikke før kunden har en selger."
                    >
                      <option value="online">Online</option>
                      <option value="in-person">IRL</option>
                    </select>
                  ) : null}
                  {currentAction.addToCalendar ? (
                    <span title="I Google Kalender" className="shrink-0 text-sky-300">
                      <CalendarDays size={12} />
                    </span>
                  ) : null}
                  {canStickAction(currentAction) ? (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={Boolean(currentAction.sticky)}
                      aria-label="Sticky"
                      disabled={actionBusy}
                      onClick={() => void onMutateAction({
                        op: 'update',
                        id: currentAction.id,
                        sticky: !currentAction.sticky,
                      })}
                      className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] ${
                        currentAction.sticky
                          ? 'border-sky-400/60 text-sky-200 bg-sky-400/10'
                          : 'border-white/15 text-gray-300 hover:text-white hover:border-white/30'
                      }`}
                      title={currentAction.sticky
                        ? 'Sticky: følger handlingen under. Klikk for å løsne.'
                        : 'Sticky: behold avstanden til handlingen under når den flyttes'}
                    >
                      <Pin size={11} fill={currentAction.sticky ? 'currentColor' : 'none'} />
                      Sticky
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setEdit({
                      actionId: currentAction.id,
                      name: currentAction.name,
                      note: currentAction.note || '',
                      format: (currentAction.format || defaultFormatForPreset(currentAction.presetKey)) as SalesActionFormat,
                      dueAt: toDateTimeLocal(currentAction.dueAt),
                      addToCalendar: Boolean(currentAction.addToCalendar) || currentAction.presetKey === 'meeting',
                      sticky: Boolean(currentAction.sticky),
                      meetingMode: client.meetingMode === 'in-person' ? 'in-person' : 'online',
                    })}
                    className="shrink-0 p-1 rounded text-gray-400 hover:text-white"
                    title={currentAction.presetKey === 'meeting' ? 'Endre møtetid' : 'Endre navn eller tid'}
                  >
                    <Pencil size={12} />
                  </button>
                  {currentAction.presetKey !== 'meeting' && (
                    <button
                      type="button"
                      disabled={actionBusy}
                      onClick={() => void onMutateAction({ op: 'delete', id: currentAction.id })}
                      className="shrink-0 p-1 rounded text-gray-500 hover:text-red-300"
                      title="Fjern handling"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
                {extras ? <div className="mt-1.5 ml-12 flex flex-wrap gap-1.5">{extras}</div> : null}
                </>
              )}
            </div>
            );
            return currentAction.presetKey === 'meeting' ? (
              <MeetingVideoHover key={currentAction.id} meetingId={salesHover.meetingId} hasVideo={salesHover.hasVideo}>
                {row}
              </MeetingVideoHover>
            ) : row;
          })}
          </div>
          </div>
          {listCapped ? (
            <div className="pointer-events-none absolute bottom-0 left-0 right-2 h-4 bg-gradient-to-t from-[#f3f4f6] to-transparent" />
          ) : null}
          </div>
          )}

          {canCreateActions && draft ? (
            <div className="rounded-lg border border-white/10 bg-black/10 p-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="text-[10px] text-gray-400 uppercase tracking-wide">
                Navn
                <input
                  value={draft.name}
                  onChange={(event) => setDraft((prev) => prev ? { ...prev, name: event.target.value } : prev)}
                  placeholder="F.eks. Ring"
                  className="mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
                />
              </label>
              <label className="text-[10px] text-gray-400 uppercase tracking-wide">
                Tid for neste handling
                <ActionDateTimeInput
                  value={draft.dueAt}
                  nowMs={nowMs}
                  ariaLabel="Tid for neste handling"
                  onChange={(dueAt) => setDraft((prev) => prev ? { ...prev, dueAt } : prev)}
                />
              </label>
              <label className="sm:col-span-2 text-[10px] text-gray-400 uppercase tracking-wide">
                Notat til handlingen
                <textarea
                  value={draft.note}
                  onChange={(event) => setDraft((prev) => prev ? { ...prev, note: event.target.value } : prev)}
                  rows={2}
                  placeholder="Valgfritt. Spesifikk kontekst for denne handlingen."
                  className="mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5 resize-y"
                />
              </label>
              {formatControls(
                {
                  format: draft.format,
                  addToCalendar: draft.addToCalendar,
                  presetKey: draft.presetKey,
                  meetingMode: draft.meetingMode,
                  sticky: draft.sticky,
                },
                (patch) => setDraft((prev) => prev ? { ...prev, ...patch } : prev),
              )}
              <div className="sm:col-span-2 flex gap-2">
                <button
                  type="button"
                  disabled={actionBusy || !draft.name.trim() || !draft.dueAt}
                  onClick={() => void confirmDraft()}
                  className="px-2 py-1 rounded-md bg-[#FF5B00] text-white text-[11px] disabled:opacity-50"
                >
                  Sett handling
                </button>
                <button
                  type="button"
                  onClick={() => setDraft(null)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/10 text-gray-200 text-[11px]"
                >
                  <X size={11} />
                  Avbryt
                </button>
              </div>
            </div>
          ) : canCreateActions ? (
            <div className="flex flex-wrap gap-1.5">
              {presets.map((presetKey: SalesNextActionPreset) => {
                const needsMeeting = presetNeedsMeeting(presetKey) && !hasMeeting;
                return (
                  <button
                    key={presetKey}
                    type="button"
                    disabled={needsMeeting || actionBusy}
                    onClick={() => startPreset(presetKey)}
                    title={needsMeeting ? 'Sett møtetiden på møtehandlingen først' : 'Legg til handlingen. Møtet blir stående.'}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-white/10 bg-white/5 text-gray-200 hover:border-white/20 disabled:opacity-40"
                  >
                    <Plus size={11} />
                    {formatPresetLabel(presetKey)}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {logOpen ? (
        <ClientActivityLogCover client={client} onClose={() => setLogOpen(false)} />
      ) : null}
    </div>
  );
}
