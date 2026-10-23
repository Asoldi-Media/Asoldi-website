import React, { useEffect, useState } from 'react';
import { Ban, Loader2, Undo2, UserMinus } from 'lucide-react';
import {
  excludeFirefliesMeeting,
  getSalesClient,
  isMissingRoute,
  setClientMeetingPurpose,
  setFirefliesRecordingState,
  type MeetingPurposePick,
} from '../../sales/emailApi';
import type { SalesClient } from '../shared';
import { RECORDING_TONE_CLASS, recordingStateLabel, recordingStateTone, type RecordingTone } from './firefliesRecording';

/**
 * Buttons on one meeting row: "Marker uten opptak" / "Angre" on a placeholder, the purpose picker and
 * admin's "Ikke denne kunden" on a real recording. A route this hub does not have yet hides its control.
 */

const missingRoutes = new Set<string>();
const missingRouteListeners = new Set<() => void>();

/** Once one row learns a route is missing, every row hides that control. */
function noteMissingRoute(route: string) {
  missingRoutes.add(route);
  for (const listener of missingRouteListeners) listener();
}

function useMissingRoute(route: string) {
  const [, rerender] = useState(0);
  useEffect(() => {
    const listener = () => rerender((value) => value + 1);
    missingRouteListeners.add(listener);
    return () => {
      missingRouteListeners.delete(listener);
    };
  }, []);
  return missingRoutes.has(route);
}

function errorText(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The client a route sent back, or a fresh read of it when the route only answered for the row. */
export async function freshClientAfter(clientId: string, data?: { client?: SalesClient } | null) {
  if (data?.client?.id) return data.client;
  try {
    const read = await getSalesClient(clientId);
    return read.client?.id ? read.client : null;
  } catch {
    return null;
  }
}

export function RecordingChip({ state, hasTranscript = false, label = '', title = '', tone: toneOverride }: {
  state: string;
  hasTranscript?: boolean;
  label?: string;
  title?: string;
  /** When the label says more than the state (a blocked or late send). */
  tone?: RecordingTone;
}) {
  const text = label || recordingStateLabel(state, { hasTranscript });
  if (!text) return null;
  const tone = toneOverride || recordingStateTone(state, { hasTranscript });
  return (
    <span title={title || undefined} className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] ${RECORDING_TONE_CLASS[tone]}`}>
      {text}
    </span>
  );
}

const ROW_BUTTON = 'inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/10 text-[11px] text-gray-100 hover:bg-white/15 disabled:opacity-50';

/** "Marker uten opptak" on a meeting Fireflies did not record, "Angre" on one a rep marked. */
export function PlaceholderRecordingActions({
  clientId,
  meetingId = '',
  slotKey = '',
  state,
  anyState = false,
  confirmText = '',
  onClient,
  onDone,
}: {
  clientId: string;
  meetingId?: string;
  slotKey?: string;
  state: string;
  /** The live card: a rep may also mark a meeting that is still due or running (the client said no, a no-show). */
  anyState?: boolean;
  /** Asked before "Marker uten opptak" is saved. */
  confirmText?: string;
  onClient?: (client: SalesClient) => void;
  /** After the hub saved it: the state the meeting was set to. */
  onDone?: (state: 'declined' | 'open') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const declined = state === 'declined';
  const canDecline = state === 'not-admitted' || state === 'missing' || state === 'empty' || (anyState && Boolean(state));
  const hidden = useMissingRoute('recording');
  if ((!declined && !canDecline) || (hidden && !error)) return null;

  async function run(next: 'declined' | 'open') {
    if (next === 'declined' && confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError('');
    try {
      const data = await setFirefliesRecordingState(clientId, meetingId ? { meetingId } : { slotKey }, next);
      onDone?.(next);
      if (onClient) {
        const fresh = await freshClientAfter(clientId, data);
        if (fresh) onClient(fresh);
      }
    } catch (err) {
      if (isMissingRoute(err)) noteMissingRoute('recording');
      setError(errorText(err, 'Kunne ikke lagre.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {hidden ? null : declined ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run('open')}
          className={ROW_BUTTON}
          title="Angre «uten opptak». Huben ser etter opptaket igjen."
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
          Angre
        </button>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run('declined')}
          className={ROW_BUTTON}
          title="Møtet ble holdt uten opptak, for eksempel fordi kunden ikke ville bli tatt opp. Huben slutter å lete og varsle."
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Ban size={11} />}
          Marker uten opptak
        </button>
      )}
      {error ? <span className="text-[11px] text-red-300">{error}</span> : null}
    </span>
  );
}

const PURPOSE_OPTIONS: Array<{ value: MeetingPurposePick; label: string }> = [
  { value: '', label: 'Automatisk' },
  { value: 'sales', label: 'Salg' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'iteration', label: 'Iterasjon' },
];

function purposePick(value = ''): MeetingPurposePick {
  return value === 'sales' || value === 'workshop' || value === 'iteration' ? value : '';
}

/** Which booked meeting a recording is: the hub's guess until a rep picks. Automatisk hands it back. */
export function MeetingPurposePicker({ clientId, meetingId, purpose = '', onClient }: {
  clientId: string;
  meetingId: string;
  purpose?: string;
  onClient?: (client: SalesClient) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [value, setValue] = useState<MeetingPurposePick | null>(null);
  const hidden = useMissingRoute('purpose');
  if (!clientId || !meetingId || (hidden && !error)) return null;
  const shown = value ?? purposePick(purpose);

  async function pick(next: MeetingPurposePick) {
    setValue(next);
    setBusy(true);
    setError('');
    try {
      const data = await setClientMeetingPurpose(clientId, meetingId, next);
      const fresh = onClient ? await freshClientAfter(clientId, data) : null;
      setValue(null);
      if (fresh) onClient?.(fresh);
    } catch (err) {
      setValue(null);
      if (isMissingRoute(err)) noteMissingRoute('purpose');
      setError(errorText(err, 'Kunne ikke lagre møtetypen.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {hidden ? null : (
        <select
          aria-label="Møtetype"
          title="Hva slags møte opptaket er. Automatisk lar huben velge ut fra Meet-rommet og tiden."
          value={shown}
          disabled={busy}
          onChange={(event) => void pick(purposePick(event.target.value))}
          className="rounded-md bg-black/30 border border-white/10 text-gray-200 text-[11px] px-1.5 py-1 disabled:opacity-50"
        >
          {PURPOSE_OPTIONS.map((option) => (
            <option key={option.value || 'auto'} value={option.value}>{option.label}</option>
          ))}
        </select>
      )}
      {busy ? <Loader2 size={11} className="animate-spin text-gray-400" /> : null}
      {error ? <span className="text-[11px] text-red-300">{error}</span> : null}
    </span>
  );
}

/** Admin: the recording is another client's meeting. It leaves this client and is never matched back. */
export function ExcludeMeetingButton({ clientId, meetingId, title = '', businessName = '', onClient, onDone }: {
  clientId: string;
  meetingId: string;
  title?: string;
  businessName?: string;
  onClient?: (client: SalesClient) => void;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hidden = useMissingRoute('exclude');
  if (!clientId || !meetingId || (hidden && !error)) return null;

  async function exclude() {
    const what = title ? `«${title}»` : 'opptaket';
    const who = businessName || 'denne kunden';
    if (!window.confirm(`Ta ${what} bort fra ${who}? Huben kobler det ikke til ${who} igjen.`)) return;
    setBusy(true);
    setError('');
    try {
      const data = await excludeFirefliesMeeting(meetingId, clientId);
      const fresh = onClient ? await freshClientAfter(clientId, data) : null;
      if (fresh) onClient?.(fresh);
      onDone?.();
    } catch (err) {
      if (isMissingRoute(err)) noteMissingRoute('exclude');
      setError(errorText(err, 'Kunne ikke ta opptaket bort.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {hidden ? null : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void exclude()}
          className={`${ROW_BUTTON} text-red-200`}
          title="Opptaket hører til en annen kunde. Det kobles fra her og kobles ikke hit igjen automatisk."
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <UserMinus size={11} />}
          Ikke denne kunden
        </button>
      )}
      {error ? <span className="text-[11px] text-red-300">{error}</span> : null}
    </span>
  );
}
