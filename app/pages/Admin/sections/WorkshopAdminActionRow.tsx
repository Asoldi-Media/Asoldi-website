import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  CheckCircle2,
  ChevronsDown,
  ChevronsUp,
  ExternalLink,
  Loader2,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import { API, salesAuthHeaders, type SalesClient, type WorkshopActionFormat, type WorkshopGoalAction } from '../shared';
import {
  formatActionFormatLabel,
  isoToDatetimeLocalOslo,
  datetimeLocalOsloToIso,
  SMS_REMINDER_NOTE,
  SALES_ACTION_TIMEZONE,
} from '../../../../lib/sales-next-actions.js';
import { WORKSHOP_FORMATS, WORKSHOP_DEFAULT_NAME } from '../../../../lib/workshop-action-shared.js';
import { clientMeetingHover } from '../../../../lib/workshop-record.js';
import {
  ADMIN_GOAL_PRESETS,
  defaultFormatForAdminPreset,
  formatAdminGoalLabel,
  formatAdminPresetLabel,
  getAdminCurrentGoalKey,
  getAdminFutureGoalKeys,
  getAdminGoalActions,
  getAdminRemainingGoalCount,
  getAdminVisibleGoalKeys,
  suggestedAdminActionDueAt,
  resolveAdminMeetJoin,
  workshopGoalHeld,
  workshopGoalIterated,
} from '../../../../lib/workshop-goal-timeline.js';
import { MeetingVideoHover } from './MeetingVideoHover';
import { WorkshopIterationLog } from './WorkshopIterationLog';

type Props = {
  client: SalesClient;
  onClient?: (client: SalesClient) => void;
};

type DraftState = {
  presetKey: string;
  name: string;
  note: string;
  format: WorkshopActionFormat;
  dueAt: string;
  addToCalendar: boolean;
};

type EditState = {
  kind: 'extra' | 'workshop' | 'iteration';
  actionId: string;
  name: string;
  note: string;
  format: WorkshopActionFormat;
  dueAt: string;
  addToCalendar: boolean;
};

const CHIP = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50';

function toWorkshopEdit(client: SalesClient): EditState {
  const booking = client.workshopAction;
  return {
    kind: 'workshop',
    actionId: 'workshop',
    name: booking?.name || WORKSHOP_DEFAULT_NAME,
    note: '',
    format: (booking?.format || 'mote') as WorkshopActionFormat,
    dueAt: isoToDatetimeLocalOslo(booking?.dueAt || ''),
    addToCalendar: Boolean(booking?.addToCalendar || (booking?.format || 'mote') === 'mote'),
  };
}

function toIterationEdit(client: SalesClient): EditState {
  const iteration = client.workshop?.iterationMeeting;
  return {
    kind: 'iteration',
    actionId: 'iteration',
    name: 'Iterasjonsmøte',
    note: '',
    format: (iteration?.format || 'mote') as WorkshopActionFormat,
    dueAt: isoToDatetimeLocalOslo(iteration?.dueAt || ''),
    addToCalendar: Boolean(iteration?.addToCalendar || (iteration?.format || 'mote') === 'mote'),
  };
}

function formatWhen(value = '') {
  if (!value) return 'Tid ikke satt';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nb-NO', { timeZone: SALES_ACTION_TIMEZONE });
}

async function parseJson(response: Response) {
  const data = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    throw new Error(String((data as { message?: string }).message || `Request failed (${response.status})`));
  }
  return data as { client?: SalesClient; summary?: unknown; warnings?: string[]; message?: string };
}

function formatControls(
  value: { format: WorkshopActionFormat; addToCalendar: boolean; lockCalendar?: boolean },
  onChange: (patch: Partial<{ format: WorkshopActionFormat; addToCalendar: boolean }>) => void,
) {
  const calendarOn = value.lockCalendar ? true : value.addToCalendar;
  return (
    <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
      <select
        aria-label="Format"
        value={value.format}
        onChange={(event) => {
          const format = event.target.value as WorkshopActionFormat;
          onChange({ format, addToCalendar: format === 'mote' ? true : value.addToCalendar });
        }}
        className="min-w-0 flex-1 rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
      >
        {WORKSHOP_FORMATS.map((format) => (
          <option key={format} value={format}>{formatActionFormatLabel(format)}</option>
        ))}
      </select>
      <span title="I Google Kalender" className="shrink-0 text-gray-300">
        <CalendarDays size={15} />
      </span>
      <button
        type="button"
        role="switch"
        aria-label="I Google Kalender"
        aria-checked={calendarOn}
        disabled={value.lockCalendar || value.format === 'mote'}
        onClick={() => onChange({ addToCalendar: !value.addToCalendar })}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-70 ${
          calendarOn ? 'bg-[#FF5B00]' : 'bg-white/20'
        }`}
      >
        <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${calendarOn ? 'ml-4' : 'ml-1'}`} />
      </button>
    </div>
  );
}

export function WorkshopAdminActionRow({ client, onClient }: Props) {
  const workshop = client.workshop;
  const held = workshopGoalHeld(client);
  const iterated = workshopGoalIterated(client);
  const booking = client.workshopAction;
  const iteration = workshop?.iterationMeeting;
  const workshopHover = clientMeetingHover(client, 'workshop');
  const iterationHover = clientMeetingHover(client, 'iteration');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [showFutureGoals, setShowFutureGoals] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [workshopDraft, setWorkshopDraft] = useState<EditState>(() => toWorkshopEdit(client));
  const [iterationDraft, setIterationDraft] = useState<EditState>(() => toIterationEdit(client));
  const [workshopNote, setWorkshopNote] = useState('');
  const [workshopFiles, setWorkshopFiles] = useState<FileList | null>(null);
  const [iterationNote, setIterationNote] = useState('');
  const [iterationFiles, setIterationFiles] = useState<FileList | null>(null);
  const [noteKind, setNoteKind] = useState<'' | 'workshop' | 'iteration'>('');
  const actionListRef = useRef<HTMLDivElement | null>(null);
  const [actionListMaxPx, setActionListMaxPx] = useState<number | null>(null);

  const currentGoal = getAdminCurrentGoalKey(client) as 'haWorkshop' | 'iterated' | '';
  const remainingCount = getAdminRemainingGoalCount(client);
  const visibleGoals = getAdminVisibleGoalKeys(client, showFutureGoals) as Array<'haWorkshop' | 'iterated'>;
  const futureGoalSet = new Set(getAdminFutureGoalKeys(client));
  const extras = useMemo(
    () => (currentGoal ? getAdminGoalActions(client, currentGoal) as WorkshopGoalAction[] : []),
    [client, currentGoal],
  );
  const meetJoin = resolveAdminMeetJoin(client);
  const pendingApproval = Boolean(booking?.dueAt) && booking?.status !== 'confirmed';
  const showWorkshopRow = currentGoal === 'haWorkshop';
  const showIterationRow = currentGoal === 'iterated';
  const capActionList = extras.length > 1 && !showWorkshopRow && !showIterationRow && !edit;

  useEffect(() => {
    setWorkshopDraft(toWorkshopEdit(client));
  }, [client.id, client.workshopAction?.dueAt, client.workshopAction?.format, client.workshopAction?.name, client.workshopAction?.status]);

  useEffect(() => {
    setIterationDraft(toIterationEdit(client));
  }, [client.id, client.workshop?.iterationMeeting?.dueAt, client.workshop?.iterationMeeting?.format, client.workshop?.iterationMeeting?.confirmationSentAt]);

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
  }, [capActionList, extras, showWorkshopRow, showIterationRow, edit]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noe gikk galt');
    } finally {
      setBusy('');
    }
  }

  async function postJson(path: string, body: Record<string, unknown>) {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { ...salesAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await parseJson(response);
    if (data.client) onClient?.(data.client);
    if (Array.isArray(data.warnings) && data.warnings.length) setError(data.warnings.filter(Boolean).join(' | '));
    return data;
  }

  async function patchJson(path: string, body: Record<string, unknown>) {
    const response = await fetch(`${API}${path}`, {
      method: 'PATCH',
      headers: { ...salesAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await parseJson(response);
    if (data.client) onClient?.(data.client);
    if (Array.isArray(data.warnings) && data.warnings.length) setError(data.warnings.filter(Boolean).join(' | '));
    return data;
  }

  async function postNote(kind: 'workshop' | 'iteration') {
    const text = kind === 'workshop' ? workshopNote : iterationNote;
    const files = kind === 'workshop' ? workshopFiles : iterationFiles;
    const form = new FormData();
    form.append('kind', kind);
    form.append('text', text);
    if (files) Array.from(files).forEach((file) => form.append('files', file));
    const response = await fetch(`${API}/admin/sales/${encodeURIComponent(client.id)}/workshop/notes`, {
      method: 'POST',
      headers: salesAuthHeaders(),
      body: form,
    });
    const data = await parseJson(response);
    if (data.client) onClient?.(data.client);
    if (kind === 'workshop') {
      setWorkshopNote('');
      setWorkshopFiles(null);
    } else {
      setIterationNote('');
      setIterationFiles(null);
    }
    setNoteKind('');
  }

  function confirmSummary() {
    const regenerating = Boolean(workshop?.summary);
    const ok = window.confirm(
      regenerating
        ? 'Lage et nytt utviklersammendrag? Forrige tekst beholdes i historikken.'
        : 'Lage utviklersammendrag nå? Dette er det eneste tidspunktet sammendraget genereres.',
    );
    if (!ok) return;
    void run('summary', async () => {
      await postJson(`/admin/sales/${encodeURIComponent(client.id)}/workshop/summary`, { confirm: true });
    });
  }

  function startPreset(presetKey: string) {
    if (!currentGoal) return;
    setEdit(null);
    setDraft({
      presetKey,
      name: formatAdminPresetLabel(presetKey) === 'Custom' ? '' : formatAdminPresetLabel(presetKey),
      note: presetKey === 'sms24h' ? SMS_REMINDER_NOTE : '',
      format: defaultFormatForAdminPreset(presetKey) as WorkshopActionFormat,
      dueAt: isoToDatetimeLocalOslo(suggestedAdminActionDueAt(presetKey, client, currentGoal)),
      addToCalendar: false,
    });
  }

  function saveWorkshopBooking(next: EditState) {
    void run('workshop-action', async () => {
      const format = next.format === 'sms' || next.format === 'ring' || next.format === 'sms-ring' ? next.format : 'mote';
      await patchJson(`/admin/sales/${encodeURIComponent(client.id)}/workshop-action`, {
        name: next.name.trim() || WORKSHOP_DEFAULT_NAME,
        format,
        dueAt: datetimeLocalOsloToIso(next.dueAt),
        addToCalendar: format === 'mote' ? true : next.addToCalendar,
        confirmSend: true,
      });
      setEdit(null);
    });
  }

  function saveIterationMeeting(next: EditState) {
    void run('iteration', async () => {
      const format = next.format === 'sms' || next.format === 'ring' || next.format === 'sms-ring' ? next.format : 'mote';
      await postJson(`/admin/sales/${encodeURIComponent(client.id)}/workshop/iteration-meeting`, {
        dueAt: datetimeLocalOsloToIso(next.dueAt),
        format,
        addToCalendar: format === 'mote' ? true : next.addToCalendar,
        send: true,
      });
      setEdit(null);
    });
  }

  function mutateExtra(body: Record<string, unknown>) {
    return run('extra', async () => {
      await patchJson(`/admin/sales/${encodeURIComponent(client.id)}/workshop/goal-actions`, body);
      setEdit(null);
      setDraft(null);
    });
  }

  function actionEditor(state: EditState, onChange: (patch: Partial<EditState>) => void, onSave: () => void) {
    const lockCalendar = state.kind !== 'extra' && state.format === 'mote';
    const meetingTime = state.kind === 'workshop' || state.kind === 'iteration';
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="text-[10px] text-gray-400 uppercase tracking-wide">
          Navn
          <input
            value={state.name}
            onChange={(event) => onChange({ name: event.target.value })}
            className="mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
          />
        </label>
        <label className={`text-[10px] text-gray-400 uppercase tracking-wide ${meetingTime ? 'sm:col-span-2' : ''}`}>
          {meetingTime ? 'Møtetid' : 'Tid for neste handling'}
          <input
            type="datetime-local"
            aria-label={meetingTime ? 'Møtetid' : 'Tid for neste handling'}
            value={state.dueAt}
            onChange={(event) => onChange({ dueAt: event.target.value })}
            className="mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
          />
        </label>
        {state.kind === 'extra' ? (
          <label className="sm:col-span-2 text-[10px] text-gray-400 uppercase tracking-wide">
            Notat til handlingen
            <textarea
              value={state.note}
              onChange={(event) => onChange({ note: event.target.value })}
              rows={2}
              className="mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5 resize-y"
            />
          </label>
        ) : null}
        {formatControls(
          { format: state.format, addToCalendar: state.addToCalendar, lockCalendar },
          (patch) => onChange(patch),
        )}
        <div className="sm:col-span-2 flex gap-2">
          <button
            type="button"
            disabled={Boolean(busy) || !state.name.trim() || !state.dueAt}
            onClick={onSave}
            className="px-2 py-1 rounded-md bg-[#FF5B00] text-white text-[11px] disabled:opacity-50"
          >
            {state.kind === 'extra' ? 'Lagre' : (
              <span className="inline-flex items-center gap-1"><Send size={11} /> Lagre og send</span>
            )}
          </button>
          {state.kind === 'extra' ? (
            <button type="button" onClick={() => setEdit(null)} className="px-2 py-1 rounded-md bg-white/10 text-gray-200 text-[11px]">
              Avbryt
            </button>
          ) : null}
        </div>
        {state.kind === 'workshop' ? (
          <p className="sm:col-span-2 text-[10px] text-gray-500">
            Lagre og send oppdaterer møtetiden og sender ny e-post og kalenderinvitasjon for Møte.
          </p>
        ) : null}
        {state.kind === 'iteration' ? (
          <p className="sm:col-span-2 text-[10px] text-gray-500">
            Lagre og send oppdaterer iterasjonsmøtet og sender ny e-post og kalenderinvitasjon for Møte.
          </p>
        ) : null}
      </div>
    );
  }

  function readRow(
    title: string,
    format: WorkshopActionFormat,
    dueAt: string,
    note: string,
    onCalendar: boolean,
    onEdit: () => void,
    extra?: { onComplete?: () => void; onDelete?: () => void; badge?: string },
  ) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-white truncate">
            {title}
            {format ? (
              <span className="ml-1.5 text-[10px] uppercase tracking-wide text-gray-400">
                {formatActionFormatLabel(format)}
              </span>
            ) : null}
            {extra?.badge ? (
              <span className="ml-1.5 text-[10px] uppercase tracking-wide text-amber-300">{extra.badge}</span>
            ) : null}
          </div>
          <div className="text-[11px] text-gray-400 truncate">{formatWhen(dueAt)}</div>
          {note ? <div className="mt-0.5 text-[11px] text-gray-300 whitespace-pre-wrap break-words">{note}</div> : null}
        </div>
        {onCalendar ? (
          <span title="I Google Kalender" className="shrink-0 text-sky-300"><CalendarDays size={12} /></span>
        ) : null}
        <button type="button" onClick={onEdit} className="shrink-0 p-1 rounded text-gray-400 hover:text-white" title="Endre">
          <Pencil size={12} />
        </button>
        {extra?.onComplete ? (
          <button type="button" disabled={Boolean(busy)} onClick={extra.onComplete} className="shrink-0 p-1 rounded text-gray-400 hover:text-green-300" title="Fullfør handling">
            <CheckCircle2 size={12} />
          </button>
        ) : null}
        {extra?.onDelete ? (
          <button type="button" disabled={Boolean(busy)} onClick={extra.onDelete} className="shrink-0 p-1 rounded text-gray-500 hover:text-red-300" title="Fjern handling">
            <Trash2 size={12} />
          </button>
        ) : null}
      </div>
    );
  }

  const presets = currentGoal ? (ADMIN_GOAL_PRESETS[currentGoal] || []) : [];

  return (
    <div className="space-y-2" onClick={(event) => event.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-1.5">
        {visibleGoals.map((key) => {
          const done = key === 'haWorkshop' ? held : iterated;
          const isFuture = futureGoalSet.has(key);
          const keyBusy = key === 'haWorkshop' ? busy === 'summary' : busy === 'iterated';
          return (
            <button
              key={key}
              type="button"
              disabled={keyBusy || isFuture}
              onClick={() => {
                if (key === 'haWorkshop') confirmSummary();
                else {
                  void run('iterated', async () => {
                    await patchJson(`/admin/sales/${encodeURIComponent(client.id)}/workshop/iterated`, { iterated: !iterated });
                  });
                }
              }}
              title={isFuture ? 'Fullfør nåværende mål først' : done ? 'Klikk for å angre dette målet' : 'Marker dette målet som ferdig. Neste mål vises automatisk.'}
              className={`px-2 py-1 rounded-md text-[11px] border transition-colors disabled:opacity-60 ${
                done
                  ? 'bg-green-900/40 border-green-600/40 text-green-300 hover:border-green-500/50'
                  : 'bg-black/20 border-white/10 text-gray-300 hover:border-white/20'
              }`}
            >
              {keyBusy ? <Loader2 size={11} className="inline mr-1 animate-spin" /> : done ? <CheckCircle2 size={11} className="inline mr-1" /> : null}
              {formatAdminGoalLabel(key)}
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
        <button
          type="button"
          onClick={() => {
            if (!meetJoin.canOpen) return;
            window.open(meetJoin.joinUrl, '_blank', 'noopener,noreferrer');
          }}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 ${
            meetJoin.canOpen ? '' : 'opacity-60'
          }`}
          title={
            meetJoin.canOpen
              ? 'Åpner Meet som damian@asoldi.com'
              : (meetJoin.format === 'sms' || meetJoin.format === 'ring' || meetJoin.format === 'sms-ring')
                ? 'Telefon/SMS-møte har ingen Meet-lenke'
                : 'Ingen Meet-lenke ennå'
          }
        >
          <ExternalLink size={13} />
          Meet link
        </button>
      </div>

      {currentGoal ? (
        <div className="rounded-xl border border-white/10 bg-black/20 p-2.5 space-y-2">
          <div className="text-[11px] text-gray-400">
            Neste handling i <span className="text-gray-200">{formatAdminGoalLabel(currentGoal)}</span>
          </div>

          <div className="relative">
            <div
              ref={actionListRef}
              style={actionListMaxPx ? { maxHeight: actionListMaxPx } : undefined}
              className={actionListMaxPx ? 'sales-action-scroll overflow-y-auto overscroll-contain pr-1.5' : undefined}
            >
              <div className={actionListMaxPx ? 'space-y-2 pb-6' : 'space-y-2'}>
                {showWorkshopRow ? (
                  <MeetingVideoHover meetingId={workshopHover.meetingId} hasVideo={workshopHover.hasVideo}>
                    <div
                      data-action-row
                      className={`rounded-lg border px-2 py-1.5 ${
                        booking?.addToCalendar && booking?.dueAt
                          ? 'border-sky-400/50 bg-black/30 shadow-[0_0_0_3px_rgba(56,189,248,0.08)]'
                          : 'border-white/10 bg-black/30'
                      }`}
                    >
                      <div className="mb-1.5 flex items-center justify-between gap-2">
                        <div className="text-[11px] text-gray-400">Workshop-møte</div>
                        {pendingApproval ? (
                          <span className="text-[10px] uppercase tracking-wide text-amber-300">Venter</span>
                        ) : booking?.status === 'confirmed' ? (
                          <span className="text-[10px] uppercase tracking-wide text-emerald-300">Bekreftet</span>
                        ) : null}
                      </div>
                      {actionEditor(
                        workshopDraft,
                        (patch) => setWorkshopDraft((prev) => ({ ...prev, ...patch })),
                        () => saveWorkshopBooking(workshopDraft),
                      )}
                    </div>
                  </MeetingVideoHover>
                ) : null}

                {showIterationRow ? (
                  <MeetingVideoHover meetingId={iterationHover.meetingId} hasVideo={iterationHover.hasVideo}>
                    <div
                      data-action-row
                      className={`rounded-lg border px-2 py-1.5 ${
                        iteration?.addToCalendar && iteration?.dueAt
                          ? 'border-sky-400/50 bg-black/30 shadow-[0_0_0_3px_rgba(56,189,248,0.08)]'
                          : 'border-white/10 bg-black/30'
                      }`}
                    >
                      <div className="mb-1.5 text-[11px] text-gray-400">Iterasjonsmøte</div>
                      {actionEditor(
                        iterationDraft,
                        (patch) => setIterationDraft((prev) => ({ ...prev, ...patch })),
                        () => saveIterationMeeting(iterationDraft),
                      )}
                    </div>
                  </MeetingVideoHover>
                ) : null}

                {extras.map((row) => (
                  <div
                    key={row.id}
                    data-action-row
                    className={`rounded-lg border px-2 py-1.5 ${
                      row.addToCalendar && row.dueAt
                        ? 'border-sky-400/50 bg-black/30 shadow-[0_0_0_3px_rgba(56,189,248,0.08)]'
                        : 'border-white/10 bg-black/30'
                    }`}
                  >
                    {edit?.kind === 'extra' && edit.actionId === row.id ? actionEditor(
                      edit,
                      (patch) => setEdit((prev) => (prev ? { ...prev, ...patch } : prev)),
                      () => {
                        if (!edit) return;
                        void mutateExtra({
                          op: 'update',
                          id: row.id,
                          name: edit.name,
                          note: edit.note,
                          format: edit.format,
                          dueAt: datetimeLocalOsloToIso(edit.dueAt),
                          addToCalendar: edit.addToCalendar,
                        });
                      },
                    ) : readRow(
                      row.name,
                      row.format,
                      row.dueAt,
                      row.note || '',
                      Boolean(row.addToCalendar),
                      () => setEdit({
                        kind: 'extra',
                        actionId: row.id,
                        name: row.name,
                        note: row.note || '',
                        format: row.format,
                        dueAt: isoToDatetimeLocalOslo(row.dueAt),
                        addToCalendar: Boolean(row.addToCalendar),
                      }),
                      {
                        onComplete: () => void mutateExtra({ op: 'complete', id: row.id }),
                        onDelete: () => void mutateExtra({ op: 'delete', id: row.id }),
                      },
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {draft ? (
            <div className="rounded-lg border border-white/10 bg-black/10 p-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="text-[10px] text-gray-400 uppercase tracking-wide">
                Navn
                <input
                  value={draft.name}
                  onChange={(event) => setDraft((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
                  className="mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
                />
              </label>
              <label className="text-[10px] text-gray-400 uppercase tracking-wide">
                Tid for neste handling
                <input
                  type="datetime-local"
                  value={draft.dueAt}
                  onChange={(event) => setDraft((prev) => (prev ? { ...prev, dueAt: event.target.value } : prev))}
                  className="mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
                />
              </label>
              <label className="sm:col-span-2 text-[10px] text-gray-400 uppercase tracking-wide">
                Notat til handlingen
                <textarea
                  value={draft.note}
                  onChange={(event) => setDraft((prev) => (prev ? { ...prev, note: event.target.value } : prev))}
                  rows={2}
                  className="mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5 resize-y"
                />
              </label>
              {formatControls(
                { format: draft.format, addToCalendar: draft.addToCalendar },
                (patch) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev)),
              )}
              <div className="sm:col-span-2 flex gap-2">
                <button
                  type="button"
                  disabled={Boolean(busy) || !draft.name.trim() || !draft.dueAt}
                  onClick={() => void mutateExtra({
                    op: 'create',
                    goalKey: currentGoal,
                    presetKey: draft.presetKey,
                    name: draft.name,
                    note: draft.note,
                    format: draft.format,
                    dueAt: datetimeLocalOsloToIso(draft.dueAt),
                    addToCalendar: draft.addToCalendar,
                  })}
                  className="px-2 py-1 rounded-md bg-[#FF5B00] text-white text-[11px] disabled:opacity-50"
                >
                  Sett handling
                </button>
                <button type="button" onClick={() => setDraft(null)} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/10 text-gray-200 text-[11px]">
                  <X size={11} />
                  Avbryt
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {presets.map((presetKey: string) => (
                <button
                  key={presetKey}
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => startPreset(presetKey)}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-white/10 bg-white/5 text-gray-200 hover:border-white/20 disabled:opacity-40"
                >
                  <Plus size={11} />
                  {formatAdminPresetLabel(presetKey)}
                </button>
              ))}
              {currentGoal === 'haWorkshop' ? (
                <button type="button" onClick={() => setNoteKind((prev) => (prev === 'workshop' ? '' : 'workshop'))} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-white/10 bg-white/5 text-gray-200 hover:border-white/20">
                  Manuelt workshop-notat
                </button>
              ) : null}
              {currentGoal === 'iterated' ? (
                <button type="button" onClick={() => setNoteKind((prev) => (prev === 'iteration' ? '' : 'iteration'))} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-white/10 bg-white/5 text-gray-200 hover:border-white/20">
                  Manuelt iterasjonsnotat
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}

      {noteKind && ((noteKind === 'workshop' && currentGoal === 'haWorkshop') || (noteKind === 'iteration' && currentGoal === 'iterated')) ? (
        <div className="rounded-lg border border-white/10 bg-black/20 p-2 space-y-2">
          <textarea
            value={noteKind === 'workshop' ? workshopNote : iterationNote}
            onChange={(event) => (noteKind === 'workshop' ? setWorkshopNote(event.target.value) : setIterationNote(event.target.value))}
            rows={3}
            placeholder={noteKind === 'workshop' ? 'Workshop-notat. Dette overskriver ikke forrige notat.' : 'Iterasjonsnotat. Sendes ikke som møte.'}
            className="w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
          />
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-1 text-[11px] text-gray-300">
              <Paperclip size={12} />
              <input
                type="file"
                multiple
                onChange={(event) => (noteKind === 'workshop' ? setWorkshopFiles(event.target.files) : setIterationFiles(event.target.files))}
                className="text-[11px] text-gray-400"
              />
            </label>
            <button type="button" disabled={busy === 'note'} onClick={() => void run('note', () => postNote(noteKind))} className={CHIP}>
              {busy === 'note' ? <Loader2 size={12} className="animate-spin" /> : null}
              Legg til
            </button>
          </div>
        </div>
      ) : null}

      {currentGoal === 'haWorkshop' && workshop?.notes?.length ? (
        <div className="max-h-28 overflow-y-auto space-y-1">
          {workshop.notes.map((note) => (
            <div key={note.id} className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-gray-300">
              <div className="whitespace-pre-wrap break-words">{note.text || '(fil)'}</div>
              <div className="text-[10px] text-gray-500">{formatWhen(note.at)}</div>
            </div>
          ))}
        </div>
      ) : null}

      {currentGoal === 'iterated' ? <WorkshopIterationLog client={client} canMarkDone onClient={onClient} /> : null}

      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
    </div>
  );
}
