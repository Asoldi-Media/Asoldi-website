import React, { useEffect, useState } from 'react';
import { clientAuthHeaders } from '../../pages/client/auth';

type LegalState = {
  client: boolean;
  current: { catalogVersion: number; dpaVersion: string; date: string };
  binding: { mode: 'catalog' | 'legacy' | 'unsigned'; catalogVersion?: number; boundAt?: string };
  dpa: { status: string; missing: boolean; version: string; signedAt: string; current: string };
  links: { vilkar: string; personvern: string; databehandleravtale: string };
};

function dateLabel(value = '') {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('nb-NO') : '';
}

/**
 * The client's terms version and data processing agreement, with a button to sign the current
 * DPA. Renders nothing while the legal routes answer 404 (the legal switch is off) or on errors.
 */
export const ClientLegalCard: React.FC = () => {
  const [state, setState] = useState<LegalState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    fetch('/api/client/legal', { headers: clientAuthHeaders() })
      .then((response) => (response.status === 200 ? response.json() : null))
      .then((body) => {
        if (alive && body && body.binding) setState(body as LegalState);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!state || !state.client) return null;

  async function signDpa() {
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/client/dpa/sign', { method: 'POST', headers: clientAuthHeaders({ 'Content-Type': 'application/json' }), body: '{}' });
      const body = await response.json().catch(() => null);
      if (response.status !== 200 || !body?.binding) throw new Error(body?.message || 'Kunne ikke signere.');
      setState(body as LegalState);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke signere.');
    } finally {
      setBusy(false);
    }
  }

  const { binding, dpa, links, current } = state;
  const terms = binding.mode === 'catalog'
    ? `Versjon ${binding.catalogVersion}${binding.boundAt ? `, signert ${dateLabel(binding.boundAt)}` : ''}`
    : binding.mode === 'legacy'
      ? 'Vilkårene som gjaldt da du signerte'
      : `Versjon ${current.catalogVersion} gjelder når du signerer`;
  const dpaLine = dpa.status === 'signed'
    ? `Signert ${dateLabel(dpa.signedAt)} (versjon ${dpa.version})`
    : dpa.status === 'accepted-with-contract'
      ? `Godtatt med tjenesteavtalen (versjon ${dpa.current})`
      : dpa.status === 'outdated'
        ? `Du har signert en eldre versjon. Versjon ${dpa.current} må signeres.`
        : dpa.missing
          ? 'Ikke signert. E-postfunksjonene på nettsiden er av til databehandleravtalen er signert.'
          : 'Gjelder fra du signerer tjenesteavtalen.';

  return (
    <section className="rounded-2xl border border-[#E5E7EB] bg-white p-5">
      <h2 className="text-lg font-semibold text-[#111827]">Vilkår og databehandleravtale</h2>
      <div className="mt-3 space-y-2 text-sm">
        <p>
          <span className="text-[#6B7280]">Vilkår:</span> {terms}{' '}
          <a href={links.vilkar} className="text-[#FF5B00] hover:underline">Les vilkårene</a>
        </p>
        <p>
          <span className="text-[#6B7280]">Databehandleravtale:</span> {dpaLine}{' '}
          <a href={links.databehandleravtale} className="text-[#FF5B00] hover:underline">Les avtalen</a>
        </p>
      </div>
      {dpa.missing ? (
        <button type="button" onClick={() => void signDpa()} disabled={busy} className="mt-3 rounded-lg bg-[#FF5B00] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy ? 'Signerer...' : 'Signer databehandleravtale'}
        </button>
      ) : null}
      {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
    </section>
  );
};
