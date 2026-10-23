import React, { useEffect, useState } from 'react';
import { ExternalLink, Link2, Link2Off, Loader2, RefreshCw } from 'lucide-react';
import { isPlaceholderMeetingId } from '../../../../lib/offer-meetings.js';
import {
  firefliesMediaUrl,
  getFirefliesMeeting,
  linkFirefliesMeeting,
  refreshFirefliesMeeting,
  unlinkFirefliesMeeting,
} from '../../sales/emailApi';
import { API, salesAuthHeaders, type SalesMeetingRecording } from '../shared';
import { RecordingChip } from './MeetingRecordingControls';

export type MeetingMediaInfo = {
  hasVideo: boolean;
  videoBytes?: number;
  hasAudio: boolean;
  audioBytes?: number;
  hasTranscript: boolean;
};

export type StoredMeetingRow = {
  meetingId: string;
  title: string;
  when: string;
  startedAt: string;
  durationMinutes: number | '';
  recordedBy: string;
  hostEmail: string;
  attendees: string[];
  attendeeEmails: string[];
  videoUrl: string;
  transcriptUrl: string;
  summary: string;
  actionItems: string[];
  keywords?: string[];
  hasTranscript: boolean;
  transcript?: string;
  match?: { clientId: string; businessName: string; confidence: string; score: number; reasons: string[] } | null;
  candidates?: { clientId: string; businessName: string; score: number; confidence: string; reasons: string[] }[];
  mediaOnDisk?: MeetingMediaInfo;
  media?: MeetingMediaInfo;
  notifiedAt?: string;
};

type ClientOption = { id: string; businessName: string };

function formatBytes(bytes = 0) {
  if (!bytes) return '';
  if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} kB`;
}

async function fetchTranscript(meetingId: string) {
  const response = await fetch(`${API}/admin/fireflies/meetings/${encodeURIComponent(meetingId)}`, { headers: salesAuthHeaders() });
  if (!response.ok) throw new Error('Kunne ikke hente transkript');
  const data = await response.json() as { meeting: StoredMeetingRow };
  return data.meeting;
}

type MeetingCardProps = {
  meeting: StoredMeetingRow;
  clients?: ClientOption[];
  onChanged?: (next: StoredMeetingRow | null) => void;
  compact?: boolean;
};

export const MeetingCard: React.FC<MeetingCardProps> = ({
  meeting,
  clients = [],
  onChanged,
  compact = false,
}) => {
  const [busy, setBusy] = useState<'' | 'refresh' | 'link' | 'unlink' | 'transcript'>('');
  const [error, setError] = useState('');
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [transcript, setTranscript] = useState(meeting.transcript || '');
  const [linkClientId, setLinkClientId] = useState(meeting.candidates?.[0]?.clientId || '');
  const media = meeting.mediaOnDisk || meeting.media || { hasVideo: false, hasAudio: false, hasTranscript: false };

  useEffect(() => {
    setTranscript(meeting.transcript || '');
  }, [meeting.meetingId, meeting.transcript]);

  async function run(kind: 'refresh' | 'link' | 'unlink', fn: () => Promise<{ meeting: StoredMeetingRow }>) {
    setBusy(kind);
    setError('');
    try {
      const data = await fn();
      onChanged?.(data.meeting);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noe gikk galt');
    } finally {
      setBusy('');
    }
  }

  async function toggleTranscript() {
    if (transcriptOpen) {
      setTranscriptOpen(false);
      return;
    }
    setTranscriptOpen(true);
    if (transcript) return;
    setBusy('transcript');
    try {
      const full = await fetchTranscript(meeting.meetingId);
      setTranscript(full.transcript || '(tomt transkript)');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke hente transkript');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-[#161616] p-4 text-sm text-gray-200 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-white font-medium truncate">{meeting.title}</div>
          <div className="text-xs text-gray-400">
            {meeting.when || meeting.startedAt}{meeting.durationMinutes ? ` · ${meeting.durationMinutes} min` : ''}{meeting.recordedBy ? ` · ${meeting.recordedBy}` : ''}
          </div>
          {meeting.attendees?.length > 0 && (
            <div className="text-xs text-gray-500 truncate">Deltakere: {meeting.attendees.join(', ')}</div>
          )}
        </div>
        <div className="text-right text-xs shrink-0">
          {meeting.match ? (
            <span className="inline-flex rounded-full bg-emerald-900/20 text-emerald-200 px-2 py-0.5">
              {meeting.match.businessName} · {meeting.match.confidence === 'manual' ? 'manuelt' : meeting.match.confidence}
            </span>
          ) : (
            <span className="inline-flex rounded-full bg-amber-900/20 text-amber-200 px-2 py-0.5">Ikke koblet</span>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-red-300">{error}</p>}

      {!compact && meeting.summary && (
        <div className="rounded-lg bg-black/30 p-3 text-xs text-gray-300 whitespace-pre-wrap">
          <div className="text-gray-400 mb-1">Sammendrag (Fireflies)</div>
          {meeting.summary}
        </div>
      )}
      {!compact && meeting.actionItems?.length > 0 && (
        <div className="text-xs text-gray-300">
          <div className="text-gray-400 mb-1">Oppfølgingspunkter</div>
          <ul className="list-disc pl-4 space-y-0.5">{meeting.actionItems.map((item, index) => <li key={index}>{item}</li>)}</ul>
        </div>
      )}

      {media.hasVideo ? (
        <video controls preload="metadata" src={firefliesMediaUrl(meeting.meetingId, 'video')} className="w-full rounded-lg bg-black max-h-[360px]" />
      ) : media.hasAudio ? (
        <audio controls preload="metadata" src={firefliesMediaUrl(meeting.meetingId, 'audio')} className="w-full" />
      ) : (
        <p className="text-xs text-gray-500">Video/lyd er ikke lastet ned lokalt (enda). Bruk Fireflies-lenken eller «Oppdater».</p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {media.hasVideo && <span className="text-gray-500">Video {formatBytes(media.videoBytes)}</span>}
        {media.hasAudio && <span className="text-gray-500">Lyd {formatBytes(media.audioBytes)}</span>}
        {meeting.videoUrl && (
          <a href={meeting.videoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sky-300 hover:underline">
            <ExternalLink size={12} /> Åpne i Fireflies
          </a>
        )}
        <button type="button" onClick={() => void toggleTranscript()} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white/10 hover:bg-white/15">
          {busy === 'transcript' ? <Loader2 size={12} className="animate-spin" /> : null}
          {transcriptOpen ? 'Skjul transkript' : meeting.hasTranscript || media.hasTranscript ? 'Vis transkript' : 'Transkript (mangler)'}
        </button>
        <button
          type="button"
          onClick={() => void run('refresh', () => refreshFirefliesMeeting(meeting.meetingId) as Promise<{ meeting: StoredMeetingRow }>)}
          disabled={busy === 'refresh'}
          className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white/10 hover:bg-white/15 disabled:opacity-50"
          title="Henter transkript/sammendrag/video på nytt fra Fireflies"
        >
          {busy === 'refresh' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Oppdater
        </button>
        {meeting.match ? (
          <button
            type="button"
            onClick={() => void run('unlink', () => unlinkFirefliesMeeting(meeting.meetingId) as Promise<{ meeting: StoredMeetingRow }>)}
            disabled={busy === 'unlink'}
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white/10 hover:bg-white/15 disabled:opacity-50 text-red-200"
          >
            <Link2Off size={12} /> Koble fra kunde
          </button>
        ) : clients.length > 0 ? (
          <span className="inline-flex items-center gap-1">
            <select
              value={linkClientId}
              onChange={(event) => setLinkClientId(event.target.value)}
              className="px-2 py-1 rounded bg-[#111] border border-white/15 text-white text-xs max-w-[220px]"
            >
              <option value="">Velg kunde…</option>
              {(meeting.candidates || []).map((candidate) => (
                <option key={`c-${candidate.clientId}`} value={candidate.clientId}>★ {candidate.businessName} ({candidate.score})</option>
              ))}
              {clients.map((client) => (
                <option key={client.id} value={client.id}>{client.businessName}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={!linkClientId || busy === 'link'}
              onClick={() => void run('link', () => linkFirefliesMeeting(meeting.meetingId, linkClientId) as Promise<{ meeting: StoredMeetingRow }>)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#FF5B00] text-white disabled:opacity-50"
            >
              <Link2 size={12} /> Koble
            </button>
          </span>
        ) : null}
      </div>
      {meeting.match?.reasons?.length ? (
        <div className="text-[11px] text-gray-500">Match: {meeting.match.reasons.join(' · ')}</div>
      ) : null}
      {transcriptOpen && (
        <pre className="max-h-[360px] overflow-auto rounded-lg bg-black/30 p-3 text-xs text-gray-200 whitespace-pre-wrap">{transcript || (busy === 'transcript' ? 'Henter…' : 'Ingen transkript lagret.')}</pre>
      )}
    </div>
  );
};

type ClientMeetingCardProps = {
  meetingId: string;
  clients?: ClientOption[];
  onChanged?: (next: StoredMeetingRow | null) => void;
  /** The client row of a live: placeholder, shown instead of a Fireflies record that does not exist. */
  recording?: Pick<SalesMeetingRecording, 'state' | 'message'> | null;
  title?: string;
  when?: string;
};

/** A booked meeting with no Fireflies record behind it yet: its recording state, nothing to fetch or open. */
function PlaceholderMeetingCard({ recording, title = '', when = '' }: Pick<ClientMeetingCardProps, 'recording' | 'title' | 'when'>) {
  return (
    <div className="rounded-xl border border-white/10 bg-[#161616] p-4 text-sm text-gray-200 space-y-2">
      <div className="min-w-0">
        <div className="text-white font-medium truncate">{title || 'Booket møte'}</div>
        {when ? <div className="text-xs text-gray-400">{when}</div> : null}
      </div>
      {recording?.state ? (
        <RecordingChip state={recording.state} />
      ) : (
        <p className="text-xs text-gray-400">Ingen Fireflies-opptak er koblet til dette møtet ennå.</p>
      )}
      {recording?.message ? <p className="text-xs text-gray-400">{recording.message}</p> : null}
    </div>
  );
}

/** Loads the full record (with transcript) for a client meeting reference. */
export const ClientMeetingCard: React.FC<ClientMeetingCardProps> = ({ meetingId, clients, onChanged, recording, title, when }) => {
  const [meeting, setMeeting] = useState<StoredMeetingRow | null>(null);
  const [error, setError] = useState('');
  const placeholder = isPlaceholderMeetingId(meetingId);

  useEffect(() => {
    if (placeholder) return undefined;
    let cancelled = false;
    getFirefliesMeeting(meetingId)
      .then((data) => {
        if (!cancelled) setMeeting((data as { meeting: StoredMeetingRow }).meeting);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Kunne ikke hente møtet');
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId, placeholder]);

  if (placeholder) return <PlaceholderMeetingCard recording={recording} title={title} when={when} />;
  if (error) return <p className="text-xs text-red-300">{error}</p>;
  if (!meeting) return <p className="text-xs text-gray-500 inline-flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Henter møtedata…</p>;
  return (
    <MeetingCard
      meeting={meeting}
      clients={clients}
      onChanged={(next) => {
        setMeeting(next);
        onChanged?.(next);
      }}
    />
  );
};
