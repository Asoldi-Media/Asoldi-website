import React, { useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, Mic, Send } from 'lucide-react';
import { HubRequestError, requestFirefliesLiveJoin, type LiveJoinAnswer } from '../../sales/emailApi';
import type { SalesClient, SalesLiveRecording } from '../shared';
import {
  RECORDING_TONE_CLASS,
  isNoRecordingState,
  liveJoinAnswerText,
  livePlaceholderRow,
  liveRecordingBookedMinutes,
  liveRecordingView,
  liveRecordingsByUrgency,
  mostUrgentLiveRecording,
  recordingClock,
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

// Before the meeting is over, "uten opptak" stops every send: ask first.
const DECLINE_CONFIRM = 'Marker møtet uten opptak? Huben slutter da å sende Fireflies inn i dette møtet og varsler ikke om manglende opptak. Bruk det når kunden ikke vil bli tatt opp, eller møtet ikke blir holdt.';

/**
 * Is Fireflies in each booked online meeting near now (client.liveRecordings), with the server's own words
 * as detail and "Send Fireflies inn nå" while a send is allowed. A knock at the door is an amber banner,
 * since only someone in the Meet can let the notetaker in.
 */
export function FirefliesLiveStatus({ client, onClient, nowMs }: {
  client: SalesClient;
  onClient?: (client: SalesClient) => void;
  nowMs?: number;
}) {
  const now = nowMs ?? Date.now();
  const entries = liveRecordingsByUrgency(client, now);
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

  function actions(entry: SalesLiveRecording, ready: boolean) {
    // Once a transcript with talk is in there is nothing to send or mark.
    if (ready) return null;
    const busy = busySlot === entry.slotKey;
    // This booking's own row only: with none yet, the slot key lets the server find the booking.
    const row = livePlaceholderRow(client, entry);
    const settled = isNoRecordingState(entry.state) || entry.state === 'declined';
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
        <PlaceholderRecordingActions
          clientId={client.id}
          meetingId={row?.meetingId || ''}
          slotKey={entry.slotKey}
          state={entry.state}
          anyState
          confirmText={settled ? '' : DECLINE_CONFIRM}
          onClient={onClient}
        />
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
        const view = liveRecordingView(entry, { nowMs: now, bookedMinutes: liveRecordingBookedMinutes(entry, client) });
        const { ready } = view;
        // Once the transcript is in, an older "uten opptak" or "kom ikke inn" note only confuses.
        const detail = !ready && entry.message && entry.message !== view.label ? entry.message : '';
        if (view.knock) {
          return (
            <div key={entry.slotKey} role="status" className={`rounded-xl border px-3 py-2.5 space-y-1.5 ${RECORDING_TONE_CLASS.amber}`}>
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold leading-snug">{view.label}</div>
                  <div className="text-[11px] opacity-90">{entryMeta(entry)}</div>
                  {detail ? <p className="mt-1 text-[11px]">{detail}</p> : null}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {/^https:\/\/meet\.google\.com\//i.test(entry.meetLink || '') ? (
                  <a href={entry.meetLink} target="_blank" rel="noreferrer" className={BUTTON}>
                    <ExternalLink size={11} />
                    Åpne Meet
                  </a>
                ) : null}
                {actions(entry, ready)}
              </div>
              {noteFor(entry)}
            </div>
          );
        }
        return (
          <div key={entry.slotKey} className="rounded-lg border border-white/10 bg-black/20 px-2.5 py-2 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium ${RECORDING_TONE_CLASS[view.tone]}`}>
                <Mic size={11} />
                {view.label}
              </span>
              <span className="text-[11px] text-gray-400">{entryMeta(entry)}</span>
            </div>
            {detail ? <p className="text-[11px] text-gray-400">{detail}</p> : null}
            {actions(entry, ready)}
            {noteFor(entry)}
          </div>
        );
      })}
    </div>
  );
}

/** One short chip for a compact card: the meeting that needs attention first. */
export function FirefliesLiveChip({ client, nowMs }: { client: SalesClient; nowMs?: number }) {
  const now = nowMs ?? Date.now();
  const entry = mostUrgentLiveRecording(client, now);
  if (!entry) return null;
  const view = liveRecordingView(entry, { nowMs: now, bookedMinutes: liveRecordingBookedMinutes(entry, client) });
  if (!view.short) return null;
  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] ${RECORDING_TONE_CLASS[view.tone]}`}
      title={entry.message && entry.message !== view.label ? `${view.label}. ${entry.message}` : view.label}
    >
      <Mic size={11} />
      {view.short}
    </span>
  );
}
