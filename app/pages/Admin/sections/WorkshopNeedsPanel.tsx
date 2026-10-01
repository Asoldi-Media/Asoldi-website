import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { API, salesAuthHeaders } from '../shared';

export type WorkshopNeedStatus = 'open' | 'filled' | 'received' | 'checked';
export type WorkshopNeedBucket = 'activity' | 'have' | 'need' | 'heard' | 'unknown';

export type WorkshopNeedLine = {
  id: string;
  bucket: WorkshopNeedBucket;
  title: string;
  detail?: string;
  source?: string;
  status: WorkshopNeedStatus;
  quote?: string;
  mailAt?: string;
  attachmentNames?: string[];
};

export type WorkshopNeedsDocument = {
  clientId: string;
  lines: WorkshopNeedLine[];
  counts: { products: number; media: number; makerUploads: number };
  materials: { logo: boolean; domain: boolean };
  gmail?: { skipped?: boolean; reason?: string; messageCount?: number };
};

type Props = {
  clientId: string;
};

const BUCKETS: { id: WorkshopNeedBucket; title: string; hint: string }[] = [
  { id: 'activity', title: 'Aktivitet', hint: 'Det som allerede har skjedd.' },
  { id: 'have', title: 'Har allerede', hint: 'Fakta vi eier. Ikke spør kunden om dette.' },
  { id: 'heard', title: 'Hørt, ikke lagret', hint: 'Hørt i møte, notat eller e-post. Ikke kopiert til Kundedata.' },
  { id: 'need', title: 'Trenger fra kunden', hint: 'Bare hull kunden fortsatt må fylle.' },
  { id: 'unknown', title: 'Kunne ikke avgjøre', hint: 'Admin avgjør. Ikke spør kunden ennå.' },
];

function statusLabel(status: WorkshopNeedStatus) {
  if (status === 'filled') return 'Utfylt';
  if (status === 'received') return 'Mottatt på e-post';
  if (status === 'checked') return 'Avkrysset';
  return '';
}

function formatMailAt(value = '') {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' });
}

export function WorkshopNeedsPanel({ clientId }: Props) {
  const [document, setDocument] = useState<WorkshopNeedsDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState('');
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const id = String(clientId || '').trim();
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${API}/admin/sales/${encodeURIComponent(id)}/workshop-needs`, {
        headers: salesAuthHeaders(),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || 'Kunne ikke hente behovslisten.');
      }
      setDocument(payload as WorkshopNeedsDocument);
      const nextDrafts: Record<string, string> = {};
      for (const line of payload.lines || []) {
        nextDrafts[line.id] = line.title || '';
      }
      setDrafts(nextDrafts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke hente behovslisten.');
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const patchLine = useCallback(async (lineId: string, body: { checked?: boolean; wording?: string }) => {
    const id = String(clientId || '').trim();
    if (!id || !lineId) return;
    setSavingId(lineId);
    setError('');
    try {
      const response = await fetch(`${API}/admin/sales/${encodeURIComponent(id)}/workshop-needs`, {
        method: 'PATCH',
        headers: { ...salesAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineId, ...body }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.message || 'Kunne ikke lagre linjen.');
      }
      setDocument(payload as WorkshopNeedsDocument);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre linjen.');
    } finally {
      setSavingId('');
    }
  }, [clientId]);

  const grouped = useMemo(() => {
    const lines = document?.lines || [];
    return Object.fromEntries(
      BUCKETS.map((bucket) => [bucket.id, lines.filter((line) => line.bucket === bucket.id)]),
    ) as Record<WorkshopNeedBucket, WorkshopNeedLine[]>;
  }, [document]);

  if (!clientId) return null;

  return (
    <section className="rounded-2xl bg-[#2a2a2a] border border-white/10 p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">Workshop-behov</h3>
          <p className="mt-1 text-[11px] text-gray-400">
            Sporing for admin. Ingen logo, media eller produkter skrives til Kundedata, Maker eller hub-biblioteket.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
        >
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          Oppdater
        </button>
      </div>

      {document ? (
        <div className="flex flex-wrap gap-2 text-[11px] text-gray-300">
          <span className="rounded-full bg-white/10 px-2.5 py-1">Produkter {document.counts.products}</span>
          <span className="rounded-full bg-white/10 px-2.5 py-1">Media {document.counts.media}</span>
          <span className="rounded-full bg-white/10 px-2.5 py-1">Maker-opplastinger {document.counts.makerUploads}</span>
        </div>
      ) : null}

      {error ? (
        <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-200">{error}</p>
      ) : null}

      {BUCKETS.map((bucket) => {
        const rows = grouped[bucket.id] || [];
        if (!rows.length) return null;
        return (
          <div key={bucket.id} className="space-y-2">
            <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-left text-neutral-700">
              <p className="text-sm font-semibold">{bucket.title}</p>
              <p className="text-[11px] opacity-80">{bucket.hint}</p>
            </div>
            <ul className="space-y-2">
              {rows.map((row) => {
                const canCheck = row.bucket === 'need' && (row.status === 'open' || row.status === 'checked');
                const checked = row.status === 'checked' || row.status === 'filled' || row.status === 'received';
                return (
                  <li key={row.id} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1 accent-[#FF5B00]"
                        checked={checked}
                        disabled={!canCheck || savingId === row.id}
                        onChange={(event) => void patchLine(row.id, { checked: event.target.checked })}
                      />
                      <span className="min-w-0 flex-1">
                        <input
                          value={drafts[row.id] ?? row.title}
                          onChange={(event) => setDrafts((prev) => ({ ...prev, [row.id]: event.target.value }))}
                          onBlur={(event) => {
                            const wording = event.target.value.trim();
                            if (wording && wording !== row.title) void patchLine(row.id, { wording });
                          }}
                          className="w-full rounded-md bg-transparent text-sm text-white outline-none border border-transparent focus:border-white/20 px-0 py-0.5"
                        />
                        {row.detail ? <p className="text-[11px] text-gray-400">{row.detail}</p> : null}
                        {statusLabel(row.status) ? (
                          <p className="mt-1 text-[11px] text-[#FF5B00]">{statusLabel(row.status)}</p>
                        ) : null}
                        {row.status === 'received' ? (
                          <div className="mt-1 space-y-1 text-[11px] text-gray-300">
                            {row.quote ? <p className="italic text-gray-400">«{row.quote}»</p> : null}
                            {row.mailAt ? <p>{formatMailAt(row.mailAt)}</p> : null}
                            {row.attachmentNames?.length ? (
                              <p>Vedlegg: {row.attachmentNames.join(', ')}</p>
                            ) : null}
                          </div>
                        ) : null}
                        {row.bucket === 'heard' && row.quote ? (
                          <p className="mt-1 text-[11px] italic text-gray-400">«{row.quote}»</p>
                        ) : null}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

export default WorkshopNeedsPanel;
