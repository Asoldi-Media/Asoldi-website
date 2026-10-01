import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, CheckCircle2, ChevronsDown, ChevronsUp, Loader2, Pencil, Pin, Plus, Trash2, X } from 'lucide-react';
import type { SalesClient, SalesGoalKey, SalesNextAction, SalesNextActionPreset } from '../shared';
import {
  AFTER_SALE_GOAL,
  ACTION_FORMATS,
  actionFollowsNeighbor,
  canStickAction,
  formatActionFormatLabel,
  formatGoalLabel,
  formatPresetLabel,
  getCurrentGoalKey,
  getFutureGoalKeys,
  getGoalActions,
  getRemainingGoalCount,
  getSalesGoalKeys,
  getVisibleGoalKeys,
  GOAL_PRESETS,
  FOLLOW_UP_1M_NOTE,
  isoToDatetimeLocalOslo,
  datetimeLocalOsloToIso,
  defaultAddToCalendar,
  defaultFormatForPreset,
  presetNeedsMeeting,
  suggestedDueAtForPreset,
  SALES_ACTION_TIMEZONE,
} from '../../../../lib/sales-next-actions.js';
import type { SalesActionFormat } from '../shared';
import { MeetingVideoHover } from './MeetingVideoHover';
import { clientMeetingHover } from '../../../../lib/workshop-record.js';

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
  meetingMode: 'online' | 'in-person';
};

type Props = {
  client: SalesClient;
  progressBusyKey: string | null;
  actionBusy: boolean;
  onToggleGoal: (key: SalesGoalKey, extra?: { fastTrack?: boolean }) => void;
  onMutateAction: (body: Record<string, unknown>) => Promise<void>;
  /** Sold clients: actions only, no møte/tilbud/kontrakt checkpoints. */
  variant?: 'active' | 'win';
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

export function SalesGoalTimeline({
  client,
  progressBusyKey,
  actionBusy,
  onToggleGoal,
  onMutateAction,
  variant = 'active',
}: Props) {
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const actionListRef = useRef<HTMLDivElement | null>(null);
  const [actionListMaxPx, setActionListMaxPx] = useState<number | null>(null);
  const [showFutureGoals, setShowFutureGoals] = useState(false);
  const isWin = variant === 'win';
  const currentGoal = (isWin ? AFTER_SALE_GOAL : getCurrentGoalKey(client)) as SalesGoalKey | 'afterSale' | '';
  const remainingCount = getRemainingGoalCount(client);
  const visibleGoals = (showFutureGoals
    ? getSalesGoalKeys(client.product)
    : getVisibleGoalKeys(client)) as SalesGoalKey[];
  const futureGoalSet = new Set(getFutureGoalKeys(client) as SalesGoalKey[]);
  const currentActions = useMemo(
    () => (currentGoal ? getGoalActions(client, currentGoal) as SalesNextAction[] : []),
    [client, currentGoal]
  );
  const salesHover = clientMeetingHover(client, 'sales');
  const presets = currentGoal ? (GOAL_PRESETS[currentGoal] || []) : [];
  const hasMeeting = Boolean(client.agreedTime && client.meetingAt);
  const capActionList = currentActions.length > 1 && !edit;

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
      ...(meeting?.presetKey === 'meeting' ? { meetingMode: edit.meetingMode } : {}),
    });
    setEdit(null);
  }

  function formatControls(
    value: {
      format: SalesActionFormat;
      addToCalendar: boolean;
      presetKey?: string;
      meetingMode?: 'online' | 'in-person';
    },
    onChange: (patch: Partial<Pick<DraftState, 'format' | 'addToCalendar' | 'meetingMode'>>) => void,
  ) {
    const calendarLocked = value.presetKey === 'meeting';
    const showMeetingMode = value.presetKey === 'meeting' && value.format === 'mote';
    return (
      <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
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
        {showMeetingMode ? (
          <select
            aria-label="Møteform"
            value={value.meetingMode === 'in-person' ? 'in-person' : 'online'}
            onChange={(event) => onChange({ meetingMode: event.target.value as 'online' | 'in-person' })}
            className="w-[7.5rem] shrink-0 rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
          >
            <option value="online">Online</option>
            <option value="in-person">IRL</option>
          </select>
        ) : null}
        <span title="15 min i Google Kalender" className="shrink-0 text-gray-300">
          <CalendarDays size={15} />
        </span>
        <button
          type="button"
          role="switch"
          aria-label="15 min i Google Kalender"
          aria-checked={value.addToCalendar}
          disabled={calendarLocked}
          onClick={() => onChange({ addToCalendar: !value.addToCalendar })}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-70 ${
            value.addToCalendar ? 'bg-[#FF5B00]' : 'bg-white/20'
          }`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${value.addToCalendar ? 'ml-4' : 'ml-1'}`} />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2" onClick={(event) => event.stopPropagation()}>
      {!isWin && (
      <div className="flex flex-wrap items-center gap-1.5">
        {visibleGoals.map((key) => {
          const done = Boolean(client.progression?.[key]);
          const busy = progressBusyKey === `${client.id}:${key}`;
          const isFuture = futureGoalSet.has(key);
          return (
            <button
              key={key}
              type="button"
              disabled={busy || isFuture}
              onClick={() => onToggleGoal(key)}
              title={
                isFuture
                  ? 'Fullfør nåværende mål først'
                  : done
                    ? 'Klikk for å angre dette målet'
                    : 'Marker dette målet som ferdig. Neste mål vises automatisk.'
              }
              className={`px-2 py-1 rounded-md text-[11px] border transition-colors disabled:opacity-60 ${
                done
                  ? 'bg-green-900/40 border-green-600/40 text-green-300 hover:border-green-500/50'
                  : 'bg-black/20 border-white/10 text-gray-300 hover:border-white/20'
              }`}
            >
              {busy ? <Loader2 size={11} className="inline mr-1 animate-spin" /> : done ? <CheckCircle2 size={11} className="inline mr-1" /> : null}
              {formatGoalLabel(key)}
            </button>
          );
        })}
        {remainingCount > 0 && (
          <button
            type="button"
            onClick={() => setShowFutureGoals((prev) => !prev)}
            className="inline-flex items-center justify-center p-1 text-gray-400 hover:text-gray-200"
            title={showFutureGoals ? 'Skjul senere mål' : `Vis ${remainingCount} senere mål`}
            aria-label={showFutureGoals ? 'Skjul senere mål' : `Vis ${remainingCount} senere mål`}
          >
            {showFutureGoals ? <ChevronsUp size={16} /> : <ChevronsDown size={16} />}
          </button>
        )}
      </div>
      )}

      {currentGoal ? (
        <div className="rounded-xl border border-white/10 bg-black/20 p-2.5 space-y-2">
          <div className="text-[11px] text-gray-400">
            {isWin ? 'Neste handling' : (
              <>Neste handling i <span className="text-gray-200">{formatGoalLabel(currentGoal)}</span></>
            )}
          </div>

          {currentActions.length > 0 && (
          <div className="relative">
          <div
            ref={actionListRef}
            style={actionListMaxPx ? { maxHeight: actionListMaxPx } : undefined}
            className={actionListMaxPx ? 'sales-action-scroll overflow-y-auto overscroll-contain pr-1.5' : undefined}
          >
          <div className={actionListMaxPx ? 'space-y-2 pb-6' : 'space-y-2'}>
          {currentActions.map((currentAction) => {
            const row = (
            <div
              key={currentAction.id}
              data-action-row
              className={`rounded-lg border px-2 py-1.5 ${
                currentAction.addToCalendar && currentAction.dueAt
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
                    <input
                      type="datetime-local"
                      value={edit.dueAt}
                      onChange={(event) => setEdit((prev) => prev ? { ...prev, dueAt: event.target.value } : prev)}
                      className="mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
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
                <div className="flex items-center gap-2 min-w-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-white truncate">
                      {currentAction.name}
                      {currentAction.presetKey === 'meeting' && currentAction.format === 'mote' ? null : currentAction.format ? (
                        <span className="ml-1.5 text-[10px] uppercase tracking-wide text-gray-400">{formatActionFormatLabel(currentAction.format)}</span>
                      ) : null}
                    </div>
                    <div className="text-[11px] text-gray-400 truncate">{formatWhen(currentAction.dueAt)}</div>
                    {currentAction.note ? (
                      <div className="mt-0.5 text-[11px] text-gray-300 whitespace-pre-wrap break-words">{currentAction.note}</div>
                    ) : null}
                  </div>
                  {currentAction.presetKey === 'meeting' && currentAction.format === 'mote' ? (
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
                      className="shrink-0 w-[5.75rem] rounded-md bg-[#161616] border border-white/10 text-white text-[11px] px-1.5 py-1"
                      title="Bytt Online/IRL — ny kalenderinvitasjon sendes til kunden"
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
                      aria-checked={actionFollowsNeighbor(currentAction)}
                      disabled={actionBusy}
                      onClick={() => void onMutateAction({
                        op: 'update',
                        id: currentAction.id,
                        sticky: !actionFollowsNeighbor(currentAction),
                      })}
                      className={`shrink-0 p-1 rounded ${
                        actionFollowsNeighbor(currentAction)
                          ? 'text-sky-300 hover:text-sky-200'
                          : 'text-gray-500 hover:text-white'
                      }`}
                      title={actionFollowsNeighbor(currentAction)
                        ? 'Sticky: følger handlingen under. Klikk for å løsne.'
                        : 'Sticky: behold avstanden til handlingen under når den flyttes'}
                    >
                      <Pin size={12} fill={actionFollowsNeighbor(currentAction) ? 'currentColor' : 'none'} />
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
                      meetingMode: client.meetingMode === 'in-person' ? 'in-person' : 'online',
                    })}
                    className="shrink-0 p-1 rounded text-gray-400 hover:text-white"
                    title={currentAction.presetKey === 'meeting' ? 'Endre møtetid' : 'Endre navn eller tid'}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => void onMutateAction({ op: 'complete', id: currentAction.id })}
                    className="shrink-0 p-1 rounded text-gray-400 hover:text-green-300"
                    title={currentAction.presetKey === 'meeting' ? 'Møtet er hatt' : 'Fullfør handling'}
                  >
                    <CheckCircle2 size={12} />
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
          {actionListMaxPx ? (
            <div className="pointer-events-none absolute bottom-0 left-0 right-2 h-4 bg-gradient-to-t from-[#f3f4f6] to-transparent" />
          ) : null}
          </div>
          )}

          {draft ? (
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
                <input
                  type="datetime-local"
                  value={draft.dueAt}
                  onChange={(event) => setDraft((prev) => prev ? { ...prev, dueAt: event.target.value } : prev)}
                  className="mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
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
                },
                (patch) => setDraft((prev) => prev ? { ...prev, ...patch } : prev),
              )}
              <label className="sm:col-span-2 inline-flex items-center gap-2 text-[11px] text-gray-300">
                <input
                  type="checkbox"
                  checked={draft.sticky}
                  onChange={(event) => setDraft((prev) => prev ? { ...prev, sticky: event.target.checked } : prev)}
                />
                Sticky — behold avstanden til handlingen under
              </label>
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
          ) : (
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
          )}
        </div>
      ) : null}
    </div>
  );
}
