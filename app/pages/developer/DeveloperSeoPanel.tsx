import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Search } from 'lucide-react';
import { AgreedKeywordsPicker } from './AgreedKeywordsPicker';
import {
  approveSeoKeyword,
  blockSeoKeyword,
  fetchSeoRecord,
  putAgreedKeywords,
  SeoRecordCallError,
  type SeoRecordView,
} from './seoRecordApi';
import { seoPhraseKey } from '../../../lib/seo-ops/phrase-filters.js';

type Props = {
  salesClientId: string;
  authHeaders: Record<string, string>;
  canEdit?: boolean;
};

function formatDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The SEO panel on the developer page: the agreed keywords (decide them with the picker), the
 * contract line they give, the Maker's plan summary and the page map's primaries.
 */
export function DeveloperSeoPanel({ salesClientId, authHeaders, canEdit = false }: Props) {
  const [record, setRecord] = useState<SeoRecordView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyPhrase, setBusyPhrase] = useState('');
  const [error, setError] = useState('');
  const headersKey = JSON.stringify(authHeaders);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setRecord((await fetchSeoRecord(salesClientId, authHeaders)).record);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesClientId, headersKey]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(phrase: string, run: () => Promise<{ record: SeoRecordView | null }>) {
    setBusyPhrase(phrase);
    setError('');
    try {
      setRecord((await run()).record);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPhrase('');
    }
  }

  /** Approves a phrase; the business's own name is approved only after the developer confirms it. */
  async function approve(phrase: string, source: string) {
    setBusyPhrase(phrase);
    setError('');
    try {
      try {
        setRecord((await approveSeoKeyword(salesClientId, phrase, authHeaders, source)).record);
      } catch (err) {
        if (!(err instanceof SeoRecordCallError) || err.code !== 'brand') throw err;
        if (!window.confirm(`${err.message}\n\nGodkjenne «${phrase}» likevel?`)) return;
        setRecord((await approveSeoKeyword(salesClientId, phrase, authHeaders, source, true)).record);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyPhrase('');
    }
  }

  const summary = record?.planSummary || null;
  const primaries = (record?.pageMap || []).filter((row) => row.indexable !== false && row.primary);
  return (
    <section className="rounded-xl border border-white/10 bg-[#161616] p-4 space-y-3" aria-label="SEO">
      <div className="flex items-center gap-2">
        <Search size={15} className="text-gray-400" />
        <div className="font-medium text-white text-sm">SEO</div>
        <button type="button" onClick={() => void load()} className="ml-auto rounded-md p-1 text-gray-400 hover:text-white" aria-label="Oppdater" title="Oppdater">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
      {!loading && !record && !error ? (
        <p className="text-[11px] text-gray-500">Ingen søkeordsplan fra Website Maker ennå. Avtalte søkeord kan likevel legges inn.</p>
      ) : null}
      <AgreedKeywordsPicker
        record={record}
        canEdit={canEdit}
        busyPhrase={busyPhrase}
        onApprove={(phrase, source) => void approve(phrase, source)}
        onBlock={(phrase) => void act(phrase, () => blockSeoKeyword(salesClientId, phrase, authHeaders))}
        onRemove={(phrase) => void act(phrase, () => putAgreedKeywords(
          salesClientId,
          (record?.agreedKeywords || []).filter((row) => seoPhraseKey(row.phrase) !== seoPhraseKey(phrase)),
          authHeaders,
        ))}
      />
      <div className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 text-[11px]">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">I kontrakten</div>
        <div className="text-gray-200">{record?.contractText || 'Ingen avtalte søkeord i kontrakten.'}</div>
      </div>
      {summary ? (
        <div className="space-y-1 text-[11px] text-gray-400">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Søkeordsplan</div>
          <div>
            {summary.mode === 'preview' ? 'Forhåndsanalyse' : 'Plan'}
            {summary.builtAt ? ` fra ${formatDate(summary.builtAt)}` : ''}
            {summary.town ? ` · ${summary.town}` : ''}
            {summary.counts?.candidates ? ` · ${summary.counts.candidates} kandidater` : ''}
            {summary.qa?.status ? ` · kvalitet: ${summary.qa.status}` : ''}
          </div>
          {summary.primaries?.length ? <div>Hovedsøkeord: {summary.primaries.map((row) => row.phrase).join(', ')}</div> : null}
        </div>
      ) : null}
      {primaries.length ? (
        <div className="space-y-1 text-[11px]">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Søkeord per side</div>
          <ul className="space-y-0.5">
            {primaries.slice(0, 20).map((row) => (
              <li key={row.route} className="flex gap-2">
                <span className="font-mono text-gray-500">{row.route}</span>
                <span className="text-gray-200">{row.primary}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {record?.guidesConsumers ? (
        <p className="text-[10px] text-gray-500">Maps-rangering og analysemål bruker de godkjente søkeordene først, og aldri de blokkerte.</p>
      ) : null}
    </section>
  );
}
