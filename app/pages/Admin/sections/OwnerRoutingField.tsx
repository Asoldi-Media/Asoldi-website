import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { API, authHeaders as defaultAuthHeaders } from '../shared';

type RoutingMode = '' | 'owner' | 'owner+asoldi-bcc';

type RoutingView = {
  ownerRouting: RoutingMode;
  ownerRoutingSetAt: string;
  ownerRecipients: { email: string; status: string; source: string; confirmedAt?: string }[];
  owner: { recipients: string[]; source: string };
  routing: { to: string; bcc: string; subjectPrefix: string; bccUntil: string };
};

/** Only confirmed addresses are shown and edited here; pending ones wait for their own confirmation. */
function confirmedEmails(view: RoutingView | null) {
  return (view?.ownerRecipients || [])
    .filter((row) => row.status === 'confirmed')
    .map((row) => row.email)
    .join(', ');
}

function sameEmailList(a: string, b: string) {
  const norm = (value: string) => value.split(/[,;\s]+/).map((part) => part.trim().toLowerCase()).filter(Boolean).sort().join(',');
  return norm(a) === norm(b);
}

const MODE_LABELS: Record<RoutingMode, string> = {
  '': 'Asoldi-innboksen (som før)',
  'owner+asoldi-bcc': 'Eieren, med kopi til Asoldi i 30 dager',
  owner: 'Bare eieren',
};

const SOURCE_LABELS: Record<string, string> = {
  ownerRecipients: 'eier-adresse satt her',
  clientAdmin: 'klientadmin',
  salesClient: 'kundekortet',
  none: 'ingen',
};

function formatDay(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('nb-NO');
}

/** WS7.39: where form submissions and order notices for this site go. */
export function OwnerRoutingField({ siteId, authHeaders }: { siteId: string; authHeaders?: Record<string, string> }) {
  const headers = authHeaders || defaultAuthHeaders();
  const endpoint = `${API}/hub/sites/${encodeURIComponent(siteId)}/owner-routing`;
  const [view, setView] = useState<RoutingView | null>(null);
  const [mode, setMode] = useState<RoutingMode>('');
  const [emails, setEmails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function apply(data: RoutingView) {
    setView(data);
    setMode(data.ownerRouting || '');
    setEmails(confirmedEmails(data));
  }

  useEffect(() => {
    let active = true;
    void fetch(endpoint, { headers })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || 'Kunne ikke lese e-postrutingen.');
        if (active) apply(data as RoutingView);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Kunne ikke lese e-postrutingen.');
      });
    return () => {
      active = false;
    };
  }, [endpoint, headers.Authorization]);

  async function save() {
    setBusy(true);
    setError('');
    try {
      // Send the addresses only when they were edited, so a mode change never rewrites them.
      const body: { ownerRouting: RoutingMode; ownerEmails?: string } = { ownerRouting: mode };
      if (!sameEmailList(emails, confirmedEmails(view))) body.ownerEmails = emails;
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Kunne ikke lagre e-postrutingen.');
      apply(data as RoutingView);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre e-postrutingen.');
    } finally {
      setBusy(false);
    }
  }

  const dirty = Boolean(view) && (mode !== (view?.ownerRouting || '') || !sameEmailList(emails, confirmedEmails(view)));
  const pending = (view?.ownerRecipients || []).filter((row) => row.status !== 'confirmed').map((row) => row.email);
  const owner = view?.owner;

  return (
    <div className="mt-2 rounded-xl border border-white/10 bg-black/20 p-3 space-y-2" onClick={(event) => event.stopPropagation()}>
      <div className="text-[11px] uppercase tracking-wide text-gray-500">Skjema og ordrevarsler</div>
      <label className="block text-[11px] text-gray-400">
        Sendes til
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as RoutingMode)}
          className="mt-1 w-full px-2 py-1.5 rounded-lg bg-[#111] border border-white/15 text-white text-xs"
        >
          {(Object.keys(MODE_LABELS) as RoutingMode[]).map((key) => (
            <option key={key || 'legacy'} value={key}>{MODE_LABELS[key]}</option>
          ))}
        </select>
      </label>
      <label className="block text-[11px] text-gray-400">
        Bekreftet eier-e-post (valgfritt, maks 3, kommaseparert)
        <input
          type="text"
          value={emails}
          placeholder={owner?.recipients?.[0] || 'eier@firma.no'}
          onChange={(event) => setEmails(event.target.value)}
          className="mt-1 w-full px-2 py-1.5 rounded-lg bg-[#111] border border-white/15 text-white text-xs"
        />
      </label>
      {view ? (
        <p className="text-[11px] text-gray-400">
          {owner?.recipients?.length
            ? `Eier: ${owner.recipients.join(', ')} (${SOURCE_LABELS[owner.source] || owner.source}).`
            : 'Ingen eier-e-post funnet. Varsler går til Asoldi med «[Ingen eier-e-post satt]» i emnet.'}
          {view.ownerRouting ? ` Nå: ${view.routing.to}` : ''}
          {view.routing.bcc ? `, kopi til ${view.routing.bcc}` : ''}
          {view.routing.bccUntil && view.routing.bcc ? ` til ${formatDay(view.routing.bccUntil)}` : ''}
          {view.ownerRouting ? '.' : ''}
        </p>
      ) : (
        <p className="text-[11px] text-gray-500">Leser rutingen…</p>
      )}
      {pending.length ? (
        <p className="text-[11px] text-gray-500">Venter på bekreftelse (får ingenting ennå): {pending.join(', ')}</p>
      ) : null}
      <button
        type="button"
        disabled={busy || !dirty}
        onClick={() => void save()}
        className="px-2 py-1 rounded bg-[#FF5B00] text-white text-xs disabled:opacity-50"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : 'Lagre ruting'}
      </button>
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
    </div>
  );
}
