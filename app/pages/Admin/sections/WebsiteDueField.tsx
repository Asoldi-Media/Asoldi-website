import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { API, authHeaders as defaultAuthHeaders } from '../shared';

type DueView = {
  dueDate: string;
  effectiveDate: string;
  override: boolean;
  weeks: number;
  phrase: string;
  contractSigned: boolean;
  label: string;
};

type Props = {
  salesClientId?: string;
  siteId?: string;
  authHeaders?: Record<string, string>;
  note?: string;
  clearLabel?: string;
  variant?: 'panel' | 'card';
  onSaved?: () => void;
};

function applyView(data: Partial<DueView> | null | undefined): DueView {
  return {
    dueDate: String(data?.dueDate || ''),
    effectiveDate: String(data?.effectiveDate || ''),
    override: Boolean(data?.override),
    weeks: Number(data?.weeks) || 0,
    phrase: String(data?.phrase || ''),
    contractSigned: Boolean(data?.contractSigned),
    label: String(data?.label || ''),
  };
}

export function WebsiteDueField({
  salesClientId = '',
  siteId = '',
  authHeaders,
  note,
  clearLabel = 'Fjern dato',
  variant = 'panel',
  onSaved,
}: Props) {
  const headers = authHeaders || defaultAuthHeaders();
  const salesId = String(salesClientId || '').trim();
  const hubId = String(siteId || '').trim();
  const endpoint = salesId
    ? `${API}/admin/sales/${encodeURIComponent(salesId)}/website-due`
    : hubId
      ? `${API}/hub/sites/${encodeURIComponent(hubId)}/website-due`
      : '';
  const [view, setView] = useState<DueView | null>(null);
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!endpoint) return undefined;
    let active = true;
    void fetch(endpoint, { headers })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || 'Kunne ikke lese fristen.');
        if (!active) return;
        const next = applyView(data);
        setView(next);
        setDate(next.effectiveDate);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Kunne ikke lese fristen.');
      });
    return () => {
      active = false;
    };
  }, [endpoint, headers.Authorization]);

  async function save(nextDate: string) {
    if (!endpoint) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ dueDate: nextDate }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Kunne ikke lagre fristen.');
      const next = applyView(data);
      setView(next);
      setDate(next.effectiveDate);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre fristen.');
    } finally {
      setBusy(false);
    }
  }

  if (!endpoint) return null;

  const effectiveDate = String(view?.effectiveDate || '');
  const help = note === ''
    ? ''
    : note || (
      variant === 'card'
        ? 'Sett eller endre fristen. Fjern dato bruker pakken når kontrakten er signert.'
        : (
          <>
            Tom dato bruker pakken: tier 1 og 2 er 14 arbeidsdager, tier 3 er 21 arbeidsdager. Datoen lander aldri på lørdag eller søndag. Skreddersydd og henvisninger uten kontrakt trenger en dato her.
            {view?.contractSigned ? ' Kontrakten er signert.' : ' Kontrakten er ikke signert ennå.'}
          </>
        )
    );

  return (
    <div
      className={
        variant === 'card'
          ? 'rounded-xl border border-white/10 bg-black/20 p-3 space-y-2'
          : 'rounded-xl border border-white/10 bg-[#161616] p-4 space-y-2'
      }
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between gap-2">
        <div className={variant === 'card' ? 'text-[11px] uppercase tracking-wide text-gray-500' : 'text-sm font-medium text-white'}>
          Leveringsfrist
        </div>
        {variant === 'card' && view?.label ? (
          <p className="text-[11px] text-gray-300 truncate">{view.label}</p>
        ) : null}
      </div>
      {variant !== 'card' ? (
        <p className="text-xs text-gray-300">{view?.label || view?.phrase || 'Leser fristen…'}</p>
      ) : null}
      {help ? <p className="text-[11px] text-gray-500">{help}</p> : null}
      <label className="block text-[11px] text-gray-400">
        {variant === 'card' ? 'Dato' : 'Egen dato'}
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
          disabled={busy || date === effectiveDate}
          onClick={() => void save(date)}
          className="px-2 py-1 rounded bg-[#FF5B00] text-white text-xs disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : 'Lagre dato'}
        </button>
        {view?.override ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save('')}
            className="px-2 py-1 rounded bg-white/10 text-gray-200 text-xs disabled:opacity-50"
          >
            {clearLabel}
          </button>
        ) : null}
      </div>
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
    </div>
  );
}
