import React, { useState } from 'react';
import { CalendarDays, CheckCircle2, Loader2, Paperclip, Plus, Send } from 'lucide-react';
import { API, salesAuthHeaders, type SalesClient, type WorkshopActionFormat, type WorkshopGoalAction } from '../shared';
import { formatActionFormatLabel, isoToDatetimeLocalOslo, datetimeLocalOsloToIso } from '../../../../lib/sales-next-actions.js';
import { WORKSHOP_FORMATS } from '../../../../lib/workshop-action-shared.js';
import { clientMeetingHover } from '../../../../lib/workshop-record.js';
import { MeetingVideoHover } from './MeetingVideoHover';
import { WorkshopIterationLog } from './WorkshopIterationLog';

type Props = {
  client: SalesClient;
  onClient?: (client: SalesClient) => void;
};

const CHIP = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50';

function formatWhen(value = '') {
  if (!value) return 'Tid ikke satt';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nb-NO');
}

async function parseJson(response: Response) {
  const data = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    throw new Error(String((data as { message?: string }).message || `Request failed (${response.status})`));
  }
  return data as { client?: SalesClient; summary?: unknown; warnings?: string[]; message?: string };
}

export function WorkshopAdminActionRow({ client, onClient }: Props) {
  const workshop = client.workshop;
  const held = Boolean(workshop?.heldAt && workshop?.summary);
  const iterated = Boolean(workshop?.iteratedAt);
  const iteration = workshop?.iterationMeeting;
  const hover = clientMeetingHover(client, 'iteration');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [workshopNote, setWorkshopNote] = useState('');
  const [workshopFiles, setWorkshopFiles] = useState<FileList | null>(null);
  const [iterationNote, setIterationNote] = useState('');
  const [iterationFiles, setIterationFiles] = useState<FileList | null>(null);
  const [workshopName, setWorkshopName] = useState(() => String(client.workshopAction?.name || 'Workshop'));
  const [workshopDue, setWorkshopDue] = useState(() => isoToDatetimeLocalOslo(client.workshopAction?.dueAt || ''));
  const [workshopFormat, setWorkshopFormat] = useState<WorkshopActionFormat>(client.workshopAction?.format || 'mote');
  const [workshopCalendar, setWorkshopCalendar] = useState(Boolean(client.workshopAction?.addToCalendar || client.workshopAction?.format === 'mote'));
  const [goalActions, setGoalActions] = useState<WorkshopGoalAction[]>(() => (
    Array.isArray(client.workshop?.goalActions) ? client.workshop.goalActions : []
  ));
  const [iterationDue, setIterationDue] = useState(() => isoToDatetimeLocalOslo(iteration?.dueAt || ''));
  const [iterationFormat, setIterationFormat] = useState<WorkshopActionFormat>(iteration?.format || 'mote');
  const [iterationCalendar, setIterationCalendar] = useState(Boolean(iteration?.addToCalendar));
  const [noteKind, setNoteKind] = useState<'' | 'workshop' | 'iteration'>('');

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
    return data;
  }

  async function postNote(kind: 'workshop' | 'iteration') {
    const text = kind === 'workshop' ? workshopNote : iterationNote;
    const files = kind === 'workshop' ? workshopFiles : iterationFiles;
    const form = new FormData();
    form.append('kind', kind);
    form.append('text', text);
    if (files) {
      Array.from(files).forEach((file) => form.append('files', file));
    }
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

  function saveWorkshopBooking() {
    void run('workshop-action', async () => {
      const format = workshopFormat === 'sms' || workshopFormat === 'ring' || workshopFormat === 'sms-ring'
        ? workshopFormat
        : 'mote';
      await patchJson(`/admin/sales/${encodeURIComponent(client.id)}/workshop-action`, {
        name: workshopName.trim() || 'Workshop',
        format,
        dueAt: datetimeLocalOsloToIso(workshopDue),
        addToCalendar: format === 'mote' ? true : workshopCalendar,
        confirmSend: true,
        goalActions,
      });
    });
  }

  const summary = workshop?.summary;
  const booking = client.workshopAction;
  const pendingApproval = Boolean(booking?.dueAt) && booking?.status !== 'confirmed';

  return (
    <div className="space-y-2" onClick={(event) => event.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          disabled={busy === 'summary'}
          onClick={confirmSummary}
          className={`px-2 py-1 rounded-md text-[11px] border transition-colors disabled:opacity-60 ${
            held
              ? 'bg-green-900/40 border-green-600/40 text-green-300 hover:border-green-500/50'
              : 'bg-black/20 border-white/10 text-gray-300 hover:border-white/20'
          }`}
        >
          {busy === 'summary' ? <Loader2 size={11} className="inline mr-1 animate-spin" /> : held ? <CheckCircle2 size={11} className="inline mr-1" /> : null}
          Ha workshop
        </button>
        <button
          type="button"
          disabled={!held || busy === 'iterated'}
          onClick={() => void run('iterated', async () => {
            await patchJson(`/admin/sales/${encodeURIComponent(client.id)}/workshop/iterated`, { iterated: !iterated });
          })}
          className={`px-2 py-1 rounded-md text-[11px] border transition-colors disabled:opacity-60 ${
            iterated
              ? 'bg-green-900/40 border-green-600/40 text-green-300 hover:border-green-500/50'
              : 'bg-black/20 border-white/10 text-gray-300 hover:border-white/20'
          }`}
        >
          {busy === 'iterated' ? <Loader2 size={11} className="inline mr-1 animate-spin" /> : iterated ? <CheckCircle2 size={11} className="inline mr-1" /> : null}
          Iterert
        </button>
      </div>

      <div className="rounded-lg border border-white/10 bg-black/20 p-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] text-gray-400">Workshop-handling</div>
          {pendingApproval ? (
            <span className="text-[10px] uppercase tracking-wide text-amber-300">Venter på godkjenning</span>
          ) : booking?.status === 'confirmed' ? (
            <span className="text-[10px] uppercase tracking-wide text-emerald-300">Bekreftet</span>
          ) : null}
        </div>
        <input
          type="text"
          value={workshopName}
          onChange={(event) => setWorkshopName(event.target.value)}
          className="w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
        />
        <input
          type="datetime-local"
          value={workshopDue}
          onChange={(event) => setWorkshopDue(event.target.value)}
          className="w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
        />
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={workshopFormat}
            onChange={(event) => {
              const format = event.target.value as WorkshopActionFormat;
              setWorkshopFormat(format);
              if (format === 'mote') setWorkshopCalendar(true);
            }}
            className="min-w-0 flex-1 rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
          >
            {WORKSHOP_FORMATS.map((format) => (
              <option key={format} value={format}>{formatActionFormatLabel(format)}</option>
            ))}
          </select>
          <CalendarDays size={14} className="text-gray-400" />
          <button
            type="button"
            role="switch"
            aria-label="I Google Kalender"
            aria-checked={workshopFormat === 'mote' ? true : workshopCalendar}
            disabled={workshopFormat === 'mote'}
            onClick={() => setWorkshopCalendar((prev) => !prev)}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-70 ${
              (workshopFormat === 'mote' ? true : workshopCalendar) ? 'bg-[#FF5B00]' : 'bg-white/20'
            }`}
          >
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              (workshopFormat === 'mote' ? true : workshopCalendar) ? 'ml-4' : 'ml-1'
            }`} />
          </button>
        </div>
        {goalActions.map((row) => (
          <div key={row.id} className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
            <input
              type="text"
              value={row.name}
              onChange={(event) => setGoalActions((prev) => prev.map((item) => (
                item.id === row.id ? { ...item, name: event.target.value } : item
              )))}
              className="rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
            />
            <input
              type="datetime-local"
              value={isoToDatetimeLocalOslo(row.dueAt)}
              onChange={(event) => setGoalActions((prev) => prev.map((item) => (
                item.id === row.id ? { ...item, dueAt: datetimeLocalOsloToIso(event.target.value) } : item
              )))}
              className="rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
            />
            <select
              value={row.format}
              onChange={(event) => setGoalActions((prev) => prev.map((item) => (
                item.id === row.id ? { ...item, format: event.target.value as WorkshopActionFormat } : item
              )))}
              className="rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
            >
              {WORKSHOP_FORMATS.map((format) => (
                <option key={format} value={format}>{formatActionFormatLabel(format)}</option>
              ))}
            </select>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setGoalActions((prev) => [
              ...prev,
              {
                id: `wga-${Date.now()}`,
                name: 'Handling',
                format: 'sms',
                dueAt: '',
                addToCalendar: false,
              },
            ])}
            className={CHIP}
          >
            <Plus size={12} />
            Legg til handling
          </button>
          <button
            type="button"
            disabled={busy === 'workshop-action' || !workshopDue}
            onClick={saveWorkshopBooking}
            className={CHIP}
          >
            {busy === 'workshop-action' ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
            Lagre
          </button>
        </div>
        <p className="text-[10px] text-gray-500">
          Lagre sender workshop-e-post og kalenderinvitasjon bare for Møte med kalender på.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy === 'invoice'}
          onClick={() => void run('invoice', async () => {
            await postJson(`/admin/sales/${encodeURIComponent(client.id)}/workshop/invoice-request`, {});
          })}
          className={CHIP}
        >
          {busy === 'invoice' ? <Loader2 size={12} className="animate-spin" /> : null}
          Send faktura
        </button>
        <button type="button" onClick={() => setNoteKind((prev) => (prev === 'workshop' ? '' : 'workshop'))} className={CHIP}>
          Manuelt workshop-notat
        </button>
        <button type="button" onClick={() => setNoteKind((prev) => (prev === 'iteration' ? '' : 'iteration'))} className={CHIP}>
          Manuelt iterasjonsnotat
        </button>
      </div>

      {noteKind ? (
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
            <button
              type="button"
              disabled={busy === 'note'}
              onClick={() => void run('note', () => postNote(noteKind))}
              className={CHIP}
            >
              {busy === 'note' ? <Loader2 size={12} className="animate-spin" /> : null}
              Legg til
            </button>
          </div>
        </div>
      ) : null}

      {workshop?.notes?.length ? (
        <div className="max-h-28 overflow-y-auto space-y-1">
          {workshop.notes.map((note) => (
            <div key={note.id} className="rounded-md border border-white/10 bg-black/20 px-2 py-1 text-[11px] text-gray-300">
              <div className="whitespace-pre-wrap break-words">{note.text || '(fil)'}</div>
              <div className="text-[10px] text-gray-500">{formatWhen(note.at)}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="rounded-lg border border-white/10 bg-black/20 p-2 space-y-2">
        <div className="text-[11px] text-gray-400">Iterasjonsmøte</div>
        <MeetingVideoHover meetingId={hover.meetingId} hasVideo={hover.hasVideo}>
          <div className="text-xs text-white">
            Iterasjonsmøte
            <span className="ml-1.5 text-[10px] uppercase tracking-wide text-gray-400">
              {formatActionFormatLabel(iterationFormat)}
            </span>
            <div className="text-[11px] text-gray-400">{formatWhen(iteration?.dueAt || datetimeLocalOsloToIso(iterationDue))}</div>
          </div>
        </MeetingVideoHover>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input
            type="datetime-local"
            value={iterationDue}
            onChange={(event) => setIterationDue(event.target.value)}
            className="rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
          />
          <select
            value={iterationFormat}
            onChange={(event) => {
              const format = event.target.value as WorkshopActionFormat;
              setIterationFormat(format);
              if (format === 'mote') setIterationCalendar(true);
            }}
            className="rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5"
          >
            <option value="mote">Møte</option>
            <option value="sms-ring">SMS/ring</option>
          </select>
        </div>
        {iterationFormat === 'sms-ring' ? (
          <label className="inline-flex items-center gap-2 text-[11px] text-gray-300">
            <input
              type="checkbox"
              checked={iterationCalendar}
              onChange={(event) => setIterationCalendar(event.target.checked)}
            />
            Legg i kalender (privat, ingen invitasjon)
          </label>
        ) : (
          <p className="text-[11px] text-gray-500">Møte er 30 minutter online med Meet og Fireflies.</p>
        )}
        <button
          type="button"
          disabled={!iterationDue || busy === 'iteration'}
          onClick={() => void run('iteration', async () => {
            await postJson(`/admin/sales/${encodeURIComponent(client.id)}/workshop/iteration-meeting`, {
              dueAt: datetimeLocalOsloToIso(iterationDue),
              format: iterationFormat,
              addToCalendar: iterationFormat === 'mote' ? true : iterationCalendar,
              send: true,
            });
          })}
          className={CHIP}
        >
          {busy === 'iteration' ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          Send
        </button>
      </div>

      <WorkshopIterationLog client={client} canMarkDone onClient={onClient} />

      {summary ? (
        <div className="rounded-lg border border-white/10 bg-black/20 p-2 space-y-1.5 text-[11px] text-gray-300">
          <div className="text-gray-400">Utviklersammendrag</div>
          <div><span className="text-gray-500">Intro. </span>{summary.intro}</div>
          <div><span className="text-gray-500">Voice. </span>{summary.voice}</div>
          <div><span className="text-gray-500">What they want. </span>{summary.whatTheyWant}</div>
          <div><span className="text-gray-500">Functionality. </span>{summary.functionality}</div>
        </div>
      ) : (
        <p className="text-[11px] text-gray-500">Sammendraget lages først når du trykker Ha workshop.</p>
      )}

      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
    </div>
  );
}
