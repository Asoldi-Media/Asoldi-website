import React, { useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { linkFirefliesCandidate, type FirefliesCandidate, type MeetingPurposePick } from '../../sales/emailApi';

const CANDIDATE_PURPOSES: Array<{ value: MeetingPurposePick; label: string }> = [
  { value: '', label: 'Automatisk' },
  { value: 'sales', label: 'Salg' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'iteration', label: 'Iterasjon' },
  { value: 'demo', label: 'Demo' },
];

/**
 * Ranked client candidates for a recording no booked Meet room owns (shown only while the candidate
 * ranker is on). Nothing is linked until a person clicks Koble; the link is that person's link.
 */
export function FirefliesCandidateList({ meetingId, candidates, onLinked }: {
  meetingId: string;
  candidates: FirefliesCandidate[];
  onLinked?: () => void;
}) {
  const [purpose, setPurpose] = useState<MeetingPurposePick>('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function link(clientId: string) {
    setBusy(clientId);
    setError('');
    try {
      await linkFirefliesCandidate(meetingId, clientId, purpose);
      onLinked?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke koble opptaket.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="rounded-lg border border-amber-400/20 bg-amber-900/10 p-3 space-y-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-amber-100">Mulige kunder (rangert; ingenting kobles før du velger)</span>
        <select
          aria-label="Møtetype ved kobling"
          value={purpose}
          onChange={(event) => setPurpose(event.target.value as MeetingPurposePick)}
          className="rounded-md bg-black/30 border border-white/10 text-gray-200 text-[11px] px-1.5 py-1"
        >
          {CANDIDATE_PURPOSES.map((option) => (
            <option key={option.value || 'auto'} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>
      {!candidates.length ? (
        <p className="text-[11px] text-gray-500">Ingen kandidater over terskelen.</p>
      ) : candidates.map((candidate, index) => (
        <div key={candidate.clientId} className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-white truncate">
              {index + 1}. {candidate.businessName || candidate.clientId} <span className="text-gray-400">({candidate.score})</span>
            </div>
            {candidate.reasons.length ? <div className="text-[11px] text-gray-500">{candidate.reasons.join(' · ')}</div> : null}
          </div>
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() => void link(candidate.clientId)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-[#FF5B00] text-white disabled:opacity-50 shrink-0"
          >
            {busy === candidate.clientId ? <Loader2 size={12} className="animate-spin" /> : <Link2 size={12} />} Koble
          </button>
        </div>
      ))}
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
    </div>
  );
}
