import React, { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { API, getSalesToken, salesAuthHeaders } from '../Admin/shared';

type Candidate = {
  id: string;
  businessName: string;
  meetingPlace?: string;
  meetingMode?: string;
};

type JudgedLink = {
  url: string;
  title: string;
  snippet: string;
  kind: string;
  reason: string;
  score?: number;
  query?: string;
};

type Run = {
  clientId: string;
  businessName: string;
  locationHint?: string;
  queries: string[];
  kept: JudgedLink[];
  rejected: JudgedLink[];
  reason?: string;
};

export function ClientContextLinksPocPage() {
  const navigate = useNavigate();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [configured, setConfigured] = useState(true);

  useEffect(() => {
    if (!getSalesToken()) {
      navigate('/login/ansatt', { replace: true });
      return;
    }
    (async () => {
      try {
        const response = await fetch(`${API}/admin/sales?product=asoldi`, { headers: salesAuthHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Kunne ikke laste kunder');
        const rows = (Array.isArray(data.clients) ? data.clients : [])
          .filter((client: Candidate) => client.businessName && client.id)
          .slice(0, 24);
        setCandidates(rows);
        setSelectedIds(rows.slice(0, 5).map((client: Candidate) => client.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Kunne ikke laste kunder');
      } finally {
        setLoading(false);
      }
    })();
  }, [navigate]);

  function toggle(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id].slice(0, 8)));
  }

  async function runResearch() {
    if (!selectedIds.length) return;
    setRunning(true);
    setError('');
    try {
      const response = await fetch(`${API}/admin/sales/context-links-poc`, {
        method: 'POST',
        headers: { ...salesAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientIds: selectedIds }),
      });
      const data = await response.json();
      if (response.status === 503) {
        setConfigured(false);
        throw new Error(data.message || 'SerpAPI er ikke satt opp');
      }
      if (!response.ok) throw new Error(data.message || 'Søk feilet');
      setConfigured(data.configured !== false);
      setRuns(Array.isArray(data.runs) ? data.runs : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Søk feilet');
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <Helmet>
        <title>POC kundekontekst – Asoldi</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <div className="staff-light min-h-screen bg-[#1a1a1a] text-white">
        <header className="border-b border-white/10 bg-white">
          <div className="max-w-[1200px] mx-auto px-4 py-4 flex items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-[#111827]">POC: kundekontekst-lenker</h1>
              <p className="text-xs text-[#6B7280]">
                Proof of concept. Lagrer ikke på kundekortet. Søker Trustpilot og nyheter via SerpAPI.
              </p>
            </div>
            <Link to="/sales" className="px-3 py-2 rounded-lg bg-[#F3F4F6] text-sm text-[#111827]">Tilbake til salg</Link>
          </div>
        </header>
        <main className="max-w-[1200px] mx-auto px-4 py-5 space-y-5">
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          {!configured ? (
            <p className="text-sm text-amber-700">SERPAPI_API_KEY mangler. Sett nøkkelen lokalt før live-søk.</p>
          ) : null}
          <section className="rounded-2xl border border-[#E5E7EB] bg-white p-4 text-[#111827]">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h2 className="font-semibold">Eksisterende salgskunder</h2>
              <button
                type="button"
                disabled={running || !selectedIds.length}
                onClick={() => void runResearch()}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm disabled:opacity-50"
              >
                {running ? <Loader2 size={14} className="animate-spin" /> : null}
                Kjør søk ({selectedIds.length})
              </button>
            </div>
            {loading ? (
              <Loader2 className="animate-spin" />
            ) : (
              <div className="grid sm:grid-cols-2 gap-2 max-h-72 overflow-auto">
                {candidates.map((client) => (
                  <label key={client.id} className="flex items-start gap-2 rounded-lg border border-[#E5E7EB] px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(client.id)}
                      onChange={() => toggle(client.id)}
                      className="mt-1 accent-[#FF5B00]"
                    />
                    <span>
                      <span className="font-medium block">{client.businessName}</span>
                      <span className="text-xs text-[#6B7280]">
                        {client.meetingMode === 'in-person' ? 'IRL' : 'Online'}
                        {client.meetingPlace ? ` · ${client.meetingPlace}` : ''}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </section>
          {runs.map((run) => (
            <section key={run.clientId} className="rounded-2xl border border-[#E5E7EB] bg-white p-4 text-[#111827]">
              <h2 className="font-semibold">{run.businessName}</h2>
              <p className="text-xs text-[#6B7280] mt-1">Søk: {run.queries.join(' · ') || run.reason || '—'}</p>
              <div className="grid md:grid-cols-2 gap-4 mt-3">
                <div>
                  <h3 className="text-sm font-medium text-emerald-800 mb-2">Beholdt ({run.kept.length})</h3>
                  {run.kept.length ? run.kept.map((link) => (
                    <article key={link.url} className="mb-3 text-sm">
                      <div className="text-[11px] uppercase tracking-wide text-emerald-700">{link.kind}</div>
                      <a href={link.url} target="_blank" rel="noreferrer" className="text-[#1d4ed8] underline break-all">{link.title || link.url}</a>
                      <p className="text-xs text-[#4B5563] mt-1">{link.snippet}</p>
                    </article>
                  )) : <p className="text-sm text-[#6B7280]">Ingen relevante treff.</p>}
                </div>
                <div>
                  <h3 className="text-sm font-medium text-[#6B7280] mb-2">Forkastet (utvalg)</h3>
                  {run.rejected.slice(0, 6).map((link) => (
                    <article key={`${link.url}:${link.reason}`} className="mb-2 text-xs text-[#6B7280]">
                      <span className="font-medium">{link.reason}</span>
                      {' · '}
                      <span className="break-all">{link.title || link.url}</span>
                    </article>
                  ))}
                </div>
              </div>
            </section>
          ))}
        </main>
      </div>
    </>
  );
}
