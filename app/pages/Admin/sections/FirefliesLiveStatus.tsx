import React, { useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Mic, Send } from 'lucide-react';
import { HubRequestError, requestFirefliesLiveJoin, type LiveJoinAnswer } from '../../sales/emailApi';
import type { SalesClient, SalesLiveRecording } from '../shared';
import {
  RECORDING_TONE_CLASS,
  isNoRecordingState,
  isPlaceholderRow,
  liveJoinAnswerText,
  liveRecordingLabel,
  liveRecordingSendAt,
  liveRecordingsByUrgency,
  mostUrgentLiveRecording,
  recordingClock,
  recordingStateShortLabel,
  recordingStateTone,
  slotKindLabel,
} from './firefliesRecording';
import { PlaceholderRecordingActions } from './MeetingRecordingControls';

type Note = { slotKey: string; text: string; tone: 'ok' | 'warn' };

function entryMeta(entry: SalesLiveRecording) {
  const start = recordingClock(entry.startAt);
  const seen = entry.state === 'recording' ? recordingClock(entry.lastSeenAt) : '';
  return [
    `${slotKindLabel(entry.kind)}${start ? ` kl. ${start}` : ''}`,
    seen ? `sist sett kl. ${seen}` : '',
    entry.attempts > 1 ? `${entry.attempts} forsøk` : '',
  ].filter(Boolean).join(' · ');
}

const BUTTON = 'inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/10 text-[11px] text-gray-100 hover:bg-white/15 disabled:opacity-50';

/**
 * Is Fireflies in each booked online meeting near now (client.liveRecordings), with the server's own words
 * as detail and "Send Fireflies inn nå" while a send is allowed. A knock at the door is an amber banner,
 * since only someone in the Meet can let the notetaker in.
 */
export function FirefliesLiveStatus({ client, onClient }: {
  client: SalesClient;
  onClient?: (client: SalesClient) => void;
}) {
  const entries = useMemo(() => liveRecordingsByUrgency(client), [client]);
  const [busySlot, setBusySlot] = useState('');
  const [note, setNote] = useState<Note | null>(null);
  if (!entries.length) return null;

  async function sendNow(entry: SalesLiveRecording) {
    setBusySlot(entry.slotKey);
    setNote(null);
    try {
      const answer = await requestFirefliesLiveJoin(client.id, entry.slotKey);
      if (answer.client?.id) onClient?.(answer.client);
      setNote({ slotKey: entry.slotKey, tone: 'ok', text: liveJoinAnswerText(answer, Date.now()) || 'Fireflies sendes inn nå.' });
    } catch (error) {
      // 409 and 423 carry the same body: the reason, the slot and the card as it is now.
      const answer = (error instanceof HubRequestError ? error.data : {}) as LiveJoinAnswer;
      if (answer.client?.id) onClient?.(answer.client);
      const text = liveJoinAnswerText(answer, Date.now()) || (error instanceof Error ? error.message : '');
      setNote({ slotKey: entry.slotKey, tone: 'warn', text: text || 'Kunne ikke sende Fireflies inn.' });
    } finally {
      setBusySlot('');
    }
  }

  function placeholderFor(entry: SalesLiveRecording) {
    return (Array.isArray(client.meetings) ? client.meetings : [])
      .find((row) => isPlaceholderRow(row) && row.slotKey === entry.slotKey) || null;
  }

  function actions(entry: SalesLiveRecording) {
    const busy = busySlot === entry.slotKey;
    const row = placeholderFor(entry);
    const markable = isNoRecordingState(entry.state) || entry.state === 'declined';
    if (!entry.canResend && !markable) return null;
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {entry.canResend ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void sendNow(entry)}
            className={BUTTON}
            title="Sender Fireflies inn i Meet-rommet på nytt. Slipp den inn når den banker på."
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
            Send Fireflies inn nå
          </button>
        ) : null}
        {markable ? (
          <PlaceholderRecordingActions
            clientId={client.id}
            meetingId={row?.meetingId || ''}
            slotKey={entry.slotKey}
            state={entry.state}
            onClient={onClient}
          />
        ) : null}
      </div>
    );
  }

  function noteFor(entry: SalesLiveRecording) {
    if (!note || note.slotKey !== entry.slotKey) return null;
    return (
      <p role="status" className={`text-[11px] ${note.tone === 'ok' ? 'text-emerald-200' : 'text-amber-200'}`}>
        {note.text}
      </p>
    );
  }

  return (
    <div className="space-y-1.5" data-fireflies-live>
      {entries.map((entry) => {
        const label = liveRecordingLabel(entry);
        const detail = entry.message && entry.message !== label ? entry.message : '';
        if (entry.state === 'dispatched') {
          return (
            <div key={entry.slotKey} role="status" className={`rounded-xl border px-3 py-2.5 space-y-1.5 ${RECORDING_TONE_CLASS.amber}`}>
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold leading-snug">{label}</div>
                  <div className="text-[11px] opacity-90">{entryMeta(entry)}</div>
                  {detail ? <p className="mt-1 text-[11px]">{detail}</p> : null}
                </div>
              </div>
              {actions(entry)}
              {noteFor(entry)}
            </div>
          );
        }
        const tone = recordingStateTone(entry.state, { hasTranscript: entry.hasTranscript });
        return (
          <div key={entry.slotKey} className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium ${RECORDING_TONE_CLASS[tone]}`}>
                <Mic size={11} />
                {label}
              </span>
              <span className="text-[11px] text-gray-400">{entryMeta(entry)}</span>
            </div>
            {detail ? <p className="text-[11px] text-gray-400">{detail}</p> : null}
            {actions(entry)}
            {noteFor(entry)}
          </div>
        );
      })}
    </div>
  );
}

/** One short chip for a compact card: the meeting that needs attention first. */
export function FirefliesLiveChip({ client }: { client: SalesClient }) {
  const entry = mostUrgentLiveRecording(client);
  if (!entry) return null;
  const tone = recordingStateTone(entry.state, { hasTranscript: entry.hasTranscript });
  const text = recordingStateShortLabel(entry.state, { at: liveRecordingSendAt(entry), hasTranscript: entry.hasTranscript });
  if (!text) return null;
  const label = liveRecordingLabel(entry);
  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] ${RECORDING_TONE_CLASS[tone]}`}
      title={entry.message && entry.message !== label ? `${label}. ${entry.message}` : label}
    >
      <Mic size={11} />
      {text}
    </span>
  );
}
