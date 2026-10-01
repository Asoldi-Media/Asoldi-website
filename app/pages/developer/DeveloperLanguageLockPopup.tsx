import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { fetchLocalMakerJson } from '../../../lib/maker-browser-client.js';
import type { MakerQueueAuthHeaders } from './makerQueue';

type SupportedLanguage = { code: string; name: string };

type LanguageInfo = {
  finalizedLanguage?: {
    code?: string;
    name?: string;
    source?: string;
    confirmed?: boolean;
    overridden?: boolean;
  } | null;
  detection?: {
    candidate?: { code?: string; name?: string };
    source?: string;
    confidence?: string;
  } | null;
  supported?: SupportedLanguage[];
};

type Props = {
  runId: string;
  websiteMakerBaseUrl: string;
  businessName?: string;
  authHeaders: MakerQueueAuthHeaders;
  onClose: () => void;
  onChanged?: () => void;
};

function languagePath(runId: string) {
  return `/api/runs/${encodeURIComponent(runId)}/language`;
}

export function DeveloperLanguageLockPopup({
  runId,
  businessName = '',
  onClose,
  onChanged,
}: Props) {
  const [info, setInfo] = useState<LanguageInfo | null>(null);
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const locked = info?.finalizedLanguage?.confirmed ? info.finalizedLanguage : null;

  const refresh = useCallback(async () => {
    if (!runId) return;
    const data = await fetchLocalMakerJson(languagePath(runId)) as LanguageInfo;
    setInfo(data);
    setChoice((prev) => prev || String(data?.detection?.candidate?.code || ''));
    setErr('');
  }, [runId]);

  useEffect(() => {
    void refresh().catch((error) => setErr(error instanceof Error ? error.message : 'Failed to load language detection.'));
  }, [refresh]);

  async function lock() {
    setBusy(true);
    setErr('');
    try {
      const detected = info?.detection?.candidate?.code || '';
      const overridden = Boolean(detected) && choice !== detected;
      await fetchLocalMakerJson(languagePath(runId), {
        method: 'POST',
        body: {
          code: choice,
          source: overridden ? 'override' : info?.detection?.source || 'explicit',
          overridden,
        },
      });
      await refresh();
      onChanged?.();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Failed to lock language.');
    } finally {
      setBusy(false);
    }
  }

  async function unlock() {
    setBusy(true);
    setErr('');
    try {
      await fetchLocalMakerJson(languagePath(runId), { method: 'DELETE' });
      setChoice('');
      await refresh();
      onChanged?.();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Failed to unlock language.');
    } finally {
      setBusy(false);
    }
  }

  const detection = info?.detection;
  const supported = info?.supported || [];
  const lowConfidence = detection?.confidence === 'low';
  const driftAfterLock =
    locked && detection?.candidate?.code && detection.candidate.code !== locked.code;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl bg-[#2a2a2a] border border-white/10 p-4 text-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Nettsidespråk</h3>
            <p className="text-xs text-gray-400 mt-1">
              {businessName ? `${businessName} · ` : ''}
              Oppdag og lås språket før steg 1.5. Dette er samme valg som i Maker.
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-white/10">
            <X size={16} />
          </button>
        </div>

        {err ? (
          <div className="mt-3 rounded-xl border border-red-700/40 bg-red-900/20 px-3 py-2 text-sm text-red-200">{err}</div>
        ) : null}

        {!info && !err ? (
          <p className="mt-4 text-sm text-gray-400 inline-flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" /> Analyserer klientprofil…
          </p>
        ) : locked ? (
          <div className="mt-4 space-y-3">
            <p className="text-sm">
              <span className="px-2 py-0.5 rounded bg-emerald-900/40 border border-emerald-700/40 text-emerald-200 text-xs">
                {locked.name} ({locked.code})
              </span>
              <span className="ml-2 text-xs text-gray-400">
                kilde: {locked.source}{locked.overridden ? ' · manuelt overstyrt' : ''}
              </span>
            </p>
            {driftAfterLock ? (
              <p className="text-xs text-amber-300">
                Klientprofilen peker nå på {detection?.candidate?.name} ({detection?.candidate?.code}) — lås opp og oppdag på nytt om profilen har endret seg.
              </p>
            ) : null}
            <button
              type="button"
              onClick={() => void unlock()}
              disabled={busy}
              className="px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15 disabled:opacity-50"
            >
              {busy ? 'Jobber…' : 'Lås opp og oppdag på nytt'}
            </button>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {detection ? (
              <p className="text-sm text-gray-300">
                Oppdaget: <span className="text-white font-medium">{detection.candidate?.name}</span> ({detection.candidate?.code}) — kilde: {detection.source}, sikkerhet: {detection.confidence}
              </p>
            ) : (
              <p className="text-sm text-gray-400">Analyserer klientprofil…</p>
            )}
            {lowConfidence ? (
              <p className="text-xs text-amber-300">Lav sikkerhet — verifiser før du låser.</p>
            ) : null}
            <label className="block text-sm text-gray-300">
              Språk
              <select
                value={choice}
                onChange={(event) => setChoice(event.target.value)}
                disabled={busy || !detection}
                className="mt-1 w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
              >
                {supported.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.name} ({lang.code})
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => void lock()}
              disabled={busy || !choice}
              className="px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm hover:bg-[#e55200] disabled:opacity-50"
            >
              {busy ? 'Låser…' : 'Bekreft og lås'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
