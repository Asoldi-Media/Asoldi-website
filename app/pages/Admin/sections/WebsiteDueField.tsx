import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { API, authHeaders as defaultAuthHeaders } from '../shared';

type DueView = {
  dueDate: string;
  weeks: number;
  phrase: string;
  contractSigned: boolean;
  label: string;
};

type Props = {
  salesClientId: string;
  authHeaders?: Record<string, string>;
};

export function WebsiteDueField({ salesClientId, authHeaders }: Props) {
  const headers = authHeaders || defaultAuthHeaders();
  const [view, setView] = useState<DueView | null>(null);
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const id = String(salesClientId || '').trim();
    if (!id) return undefined;
    let active = true;
    void fetch(`${API}/admin/sales/${encodeURIComponent(id)}/website-due`, { headers })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || 'Kunne ikke lese fristen.');
        if (!active) return;
        setView(data);
        setDate(String(data.dueDate || ''));
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Kunne ikke lese fristen.');
      });
    return () => {
      active = false;
    };
  }, [salesClientId, headers.Authorization]);

  async function save(nextDate: string) {
    const id = String(salesClientId || '').trim();
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${API}/admin/sales/${encodeURIComponent(id)}/website-due`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dueDate: nextDate }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Kunne ikke lagre fristen.');
      setView(data);
      setDate(String(data.dueDate || ''));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre fristen.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-[#161616] p-4 space-y-2">
      <div className="text-sm font-medium text-white">Leveringsfrist</div>
      <p className="text-xs text-gray-300">{view?.label || view?.phrase || 'Leser fristen…'}</p>
      <p className="text-[11px] text-gray-500">
        Tom dato bruker pakken: tier 1 og 2 er 2 uker, tier 3 er 3 uker, skreddersydd er 4 uker. Fristen starter når salg huker av signert kontrakt.
        {view?.contractSigned ? ' Kontrakten er signert.' : ' Kontrakten er ikke signert ennå.'}
      </p>
      <label className="block text-[11px] text-gray-400">
        Egen dato
        <input
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
          className="mt-1 w-full px-2 py-1.5 rounded-lg bg-[#111] border border-white/15 text-white text-xs"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || date === String(view?.dueDate || '')}
          onClick={() => void save(date)}
          className="px-2 py-1 rounded bg-[#FF5B00] text-white text-xs disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : 'Lagre dato'}
        </button>
        {view?.dueDate ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save('')}
            className="px-2 py-1 rounded bg-white/10 text-gray-200 text-xs disabled:opacity-50"
          >
            Bruk pakke
          </button>
        ) : null}
      </div>
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
    </div>
  );
}
