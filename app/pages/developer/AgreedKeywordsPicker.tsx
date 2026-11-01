import React, { useMemo, useState } from 'react';
import { Ban, Check, Loader2, Plus, X } from 'lucide-react';
import { MAX_APPROVED_AGREED_KEYWORDS } from '../../../lib/seo-ops/agreed-limits.js';
import {
  SEO_PHRASE_MAX_WORDS,
  normalizeSeoPhrase,
  regulatedTermIn,
  seoPhraseKey,
  seoPhraseWordCount,
} from '../../../lib/seo-ops/phrase-filters.js';
import type { AgreedKeyword, PlanPhrase, SeoRecordView } from './seoRecordApi';

type Props = {
  record: SeoRecordView | null;
  canEdit: boolean;
  busyPhrase?: string;
  onApprove: (phrase: string, source: string) => void;
  onBlock: (phrase: string) => void;
  onRemove: (phrase: string) => void;
};

const STATUS_LABEL: Record<AgreedKeyword['status'], string> = {
  approved: 'Godkjent',
  proposed: 'Foreslått',
  blocked: 'Blokkert',
};

const STATUS_TONE: Record<AgreedKeyword['status'], string> = {
  approved: 'border-emerald-400/40 bg-emerald-500/10 text-emerald-200',
  proposed: 'border-white/15 bg-white/5 text-gray-200',
  blocked: 'border-red-400/40 bg-red-500/10 text-red-200',
};

/** Why a typed phrase cannot be an agreed keyword, or ''. */
export function agreedPhraseProblem(value: string): string {
  const phrase = normalizeSeoPhrase(value);
  if (!phrase) return '';
  if (seoPhraseWordCount(phrase) > SEO_PHRASE_MAX_WORDS) return `Høyst ${SEO_PHRASE_MAX_WORDS} ord.`;
  const term = regulatedTermIn(phrase);
  if (term) return `«${term}» er et reseptpliktig legemiddel og kan ikke brukes.`;
  return '';
}

function volumeLabel(row: PlanPhrase | undefined) {
  if (!row || typeof row.volume !== 'number') return 'ikke målt';
  return `${row.volume.toLocaleString('nb-NO')} søk/mnd`;
}

/**
 * Agreed keywords for one client: decide the stored ones, pick from the Maker's plan candidates, or
 * add a free-text phrase (unmeasured). At most three can be approved; the hub refuses more.
 */
export function AgreedKeywordsPicker({ record, canEdit, busyPhrase = '', onApprove, onBlock, onRemove }: Props) {
  const [draft, setDraft] = useState('');
  const agreed = record?.agreedKeywords || [];
  const approvedCount = agreed.filter((row) => row.status === 'approved').length;
  const full = approvedCount >= MAX_APPROVED_AGREED_KEYWORDS;
  const preview = record?.planSummary?.mode === 'preview';
  const known = useMemo(() => new Set(agreed.map((row) => seoPhraseKey(row.phrase))), [agreed]);
  const planRows = useMemo(() => {
    const byKey = new Map<string, PlanPhrase>();
    for (const row of [...(record?.planSummary?.primaries || []), ...(record?.planSummary?.candidates || [])]) {
      const key = seoPhraseKey(row.phrase);
      if (key && !byKey.has(key)) byKey.set(key, row);
    }
    return byKey;
  }, [record]);
  const candidates = [...planRows.entries()].filter(([key]) => !known.has(key)).map(([, row]) => row).slice(0, 50);
  const problem = agreedPhraseProblem(draft);
  const busy = (phrase: string) => busyPhrase && seoPhraseKey(busyPhrase) === seoPhraseKey(phrase);

  const button = 'inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] disabled:opacity-40';
  return (
    <div className="space-y-3 text-xs text-gray-300">
      <div className="flex items-center justify-between">
        <div className="font-medium text-white text-sm">Avtalte søkeord</div>
        <div className="text-[11px] text-gray-400">{approvedCount} av {MAX_APPROVED_AGREED_KEYWORDS} godkjent</div>
      </div>
      {agreed.length === 0 ? (
        <p className="text-[11px] text-gray-500">Ingen avtalte søkeord ennå. Velg fra forslagene under eller skriv inn et.</p>
      ) : (
        <ul className="space-y-1.5">
          {agreed.map((row) => (
            <li key={row.phrase} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
              <span className="font-medium text-white">{row.phrase}</span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${STATUS_TONE[row.status]}`}>{STATUS_LABEL[row.status]}</span>
              <span className="text-[10px] text-gray-500">{volumeLabel(planRows.get(seoPhraseKey(row.phrase)))}</span>
              {row.flags?.includes('brand') ? <span className="rounded-full border border-amber-400/40 px-2 py-0.5 text-[10px] text-amber-200" title="Søk på eget navn rangerer av seg selv og brukes ikke som mål.">eget navn</span> : null}
              {canEdit ? (
                <span className="ml-auto flex gap-1">
                  {busy(row.phrase) ? <Loader2 size={13} className="animate-spin text-gray-400" /> : null}
                  {row.status !== 'approved' ? (
                    <button type="button" className={`${button} bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25`} disabled={Boolean(busyPhrase) || full} onClick={() => onApprove(row.phrase, row.source || 'developer')} title={full ? 'Tre søkeord er allerede godkjent.' : 'Godkjenn'}>
                      <Check size={12} /> Godkjenn
                    </button>
                  ) : null}
                  {row.status !== 'blocked' ? (
                    <button type="button" className={`${button} bg-red-500/10 text-red-200 hover:bg-red-500/20`} disabled={Boolean(busyPhrase)} onClick={() => onBlock(row.phrase)}>
                      <Ban size={12} /> Blokker
                    </button>
                  ) : null}
                  <button type="button" className={`${button} bg-white/5 text-gray-300 hover:bg-white/10`} disabled={Boolean(busyPhrase)} onClick={() => onRemove(row.phrase)} aria-label={`Fjern ${row.phrase}`}>
                    <X size={12} />
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const phrase = normalizeSeoPhrase(draft);
            if (!phrase || problem || full) return;
            onApprove(phrase, 'free-text');
            setDraft('');
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Skriv inn et søkeord (1–6 ord)"
            className="min-w-[12rem] flex-1 rounded-lg border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white placeholder:text-gray-600"
          />
          <button type="submit" className={`${button} bg-white/10 text-white hover:bg-white/15`} disabled={!normalizeSeoPhrase(draft) || Boolean(problem) || full || Boolean(busyPhrase)}>
            <Plus size={12} /> Godkjenn
          </button>
          {problem ? <span className="w-full text-[11px] text-red-300">{problem}</span> : null}
          {!problem && normalizeSeoPhrase(draft) ? <span className="w-full text-[11px] text-gray-500">Et søkeord du skriver selv er ikke målt ennå.</span> : null}
        </form>
      ) : null}
      {candidates.length ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-gray-500">
            Forslag fra søkeordsplanen
            {preview ? <span className="rounded-full border border-sky-400/40 px-2 py-0.5 normal-case tracking-normal text-sky-200">forhåndsanalyse</span> : null}
          </div>
          <ul className="space-y-1">
            {candidates.map((row) => (
              <li key={row.phrase} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/5 px-2 py-1">
                <span className="text-gray-100">{row.phrase}</span>
                <span className="text-[10px] text-gray-500">{volumeLabel(row)}{row.intent ? ` · ${row.intent}` : ''}</span>
                {canEdit ? (
                  <span className="ml-auto flex gap-1">
                    <button type="button" className={`${button} bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25`} disabled={Boolean(busyPhrase) || full || Boolean(agreedPhraseProblem(row.phrase))} onClick={() => onApprove(row.phrase, 'plan')}>
                      <Check size={12} /> Godkjenn
                    </button>
                    <button type="button" className={`${button} bg-red-500/10 text-red-200 hover:bg-red-500/20`} disabled={Boolean(busyPhrase)} onClick={() => onBlock(row.phrase)}>
                      <Ban size={12} /> Blokker
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
