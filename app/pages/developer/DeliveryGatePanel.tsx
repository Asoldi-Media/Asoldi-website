import React, { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Loader2, RefreshCw } from 'lucide-react';
import { API, developmentAuthHeaders } from '../Admin/shared';

// The delivery gate for developers: what each signed client still has to send. The panel renders
// nothing while the gate is off (the API answers 404 then).

type GateLine = {
  id: string;
  group: string;
  label: string;
  gate: 'dev' | 'ready';
  level: 'required' | 'optional';
  status: 'have' | 'missing' | 'waived' | 'declined';
  evidence: string;
  waiveOptions: string[];
  waiver: { option: string; by: string; at: string } | null;
};

type GateDetail = {
  clientId: string;
  mode: string;
  stale: boolean;
  canWork: boolean;
  gate: {
    devComplete: boolean;
    passed: boolean;
    missingDev: string[];
    missingReady: string[];
    lines: GateLine[];
    info: Array<{ id: string; status: string; detail: string }>;
  };
  askable: { rows: Array<{ id: string; group: string; title: string }>; total: number };
  shadowMails?: Array<{ key: string; kind: string; at: string; subject: string; replyTo: string; text: string; purged: boolean }>;
};

type GateClient = {
  clientId: string;
  businessName: string;
  stage: string;
  mode: string;
  gate: null | { devComplete: boolean; passed: boolean; missingDev: string[]; missingReady: string[]; declined: string[] };
};

const STATUS_LABEL: Record<GateLine['status'], string> = {
  have: 'Har',
  missing: 'Mangler',
  waived: 'Fraskrevet',
  declined: 'Hoppet over',
};

const STATUS_CLASS: Record<GateLine['status'], string> = {
  have: 'bg-emerald-50 text-emerald-700',
  missing: 'bg-red-50 text-red-700',
  waived: 'bg-slate-100 text-slate-600',
  declined: 'bg-amber-50 text-amber-700',
};

async function readJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function DeliveryGatePanel() {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState<GateClient[]>([]);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<GateDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadList = useCallback(async () => {
    try {
      const response = await fetch(`${API}/admin/delivery/gate`, { headers: developmentAuthHeaders() });
      if (response.status === 404) {
        setEnabled(false);
        return;
      }
      const data = await readJson(response);
      if (!response.ok) throw new Error(data?.message || 'Kunne ikke hente leveranseporten.');
      setEnabled(true);
      setClients(Array.isArray(data?.clients) ? data.clients : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const loadDetail = useCallback(async (clientId: string) => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${API}/admin/delivery/gate/${encodeURIComponent(clientId)}`, { headers: developmentAuthHeaders() });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data?.message || 'Kunne ikke hente porten.');
      setDetail(data as GateDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  async function evaluate(clientId: string) {
    setBusy(true);
    try {
      const response = await fetch(`${API}/admin/delivery/gate/${encodeURIComponent(clientId)}/evaluate`, {
        method: 'POST',
        headers: { ...developmentAuthHeaders(), 'Content-Type': 'application/json' },
        body: '{}',
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data?.message || 'Kunne ikke evaluere porten.');
      await loadList();
      await loadDetail(clientId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function waive(clientId: string, lineId: string, option: string) {
    setBusy(true);
    try {
      const url = `${API}/admin/delivery/gate/${encodeURIComponent(clientId)}/waivers/${encodeURIComponent(lineId)}`;
      const response = option
        ? await fetch(url, {
          method: 'PUT',
          headers: { ...developmentAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ option }),
        })
        : await fetch(url, { method: 'DELETE', headers: developmentAuthHeaders() });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data?.message || 'Kunne ikke lagre fraskrivelsen.');
      await loadList();
      await loadDetail(clientId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!enabled) return null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white">
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold text-slate-800"
        onClick={() => setOpen((value) => !value)}
      >
        <span>Leveranseport ({clients.filter((client) => client.gate && !client.gate.passed).length} venter på innhold)</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-slate-100 px-3 py-2 text-sm">
          {error && <p className="mb-2 text-xs text-red-600">{error}</p>}
          <ul className="divide-y divide-slate-100">
            {clients.map((client) => (
              <li key={client.clientId} className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="truncate text-left font-medium text-slate-800 hover:underline"
                    onClick={() => {
                      const next = selected === client.clientId ? '' : client.clientId;
                      setSelected(next);
                      setDetail(null);
                      if (next) void loadDetail(next);
                    }}
                  >
                    {client.businessName || client.clientId}
                  </button>
                  <span className="shrink-0 text-xs text-slate-500">
                    {client.gate
                      ? client.gate.passed
                        ? 'Klar for utvikling'
                        : `${client.gate.missingDev.length} mangler før utvikling`
                      : 'Ikke evaluert'}
                    {client.mode === 'shadow' ? ' · skygge' : ''}
                  </span>
                </div>
                {selected === client.clientId && (
                  <div className="mt-2 rounded-lg bg-slate-50 p-2">
                    <div className="mb-2 flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void evaluate(client.clientId)}
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                        Evaluer og lagre
                      </button>
                      {detail?.stale && <span className="text-xs text-amber-700">Lagret port er utdatert</span>}
                    </div>
                    {detail && detail.clientId === client.clientId && (
                      <>
                        <table className="w-full text-xs">
                          <tbody>
                            {detail.gate.lines.map((line) => (
                              <tr key={line.id} className="border-b border-slate-100 last:border-0">
                                <td className="py-1 pr-2 text-slate-700">{line.label}</td>
                                <td className="py-1 pr-2 text-slate-500">{line.gate === 'dev' ? 'Før utvikling' : 'Før publisering'}{line.level === 'optional' ? ' (valgfri)' : ''}</td>
                                <td className="py-1 pr-2">
                                  <span className={`rounded px-1.5 py-0.5 ${STATUS_CLASS[line.status]}`}>{STATUS_LABEL[line.status]}</span>
                                </td>
                                <td className="py-1 pr-2 text-slate-500">{line.waiver ? `${line.waiver.option}` : line.evidence}</td>
                                <td className="py-1">
                                  {detail.canWork && line.waiveOptions.length > 0 && line.status !== 'have' && (
                                    <select
                                      disabled={busy}
                                      value={line.waiver?.option || ''}
                                      onChange={(event) => void waive(client.clientId, line.id, event.target.value)}
                                      className="rounded border border-slate-200 bg-white px-1 py-0.5 text-xs"
                                    >
                                      <option value="">Ikke fraskrevet</option>
                                      {line.waiveOptions.map((option) => (
                                        <option key={option} value={option}>{option}</option>
                                      ))}
                                    </select>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {detail.gate.info.length > 0 && (
                          <ul className="mt-2 list-disc pl-4 text-xs text-slate-600">
                            {detail.gate.info.map((info) => (
                              <li key={info.id}>{info.detail}</li>
                            ))}
                          </ul>
                        )}
                        <p className="mt-2 text-xs text-slate-500">
                          Kunden spørres om {detail.askable.rows.length} av {detail.askable.total} linjer på e-post.
                        </p>
                        {detail.shadowMails && detail.shadowMails.length > 0 && (
                          <div className="mt-2">
                            <p className="text-xs font-medium text-slate-700">Skyggeutkast (ikke sendt)</p>
                            <ul className="mt-1 space-y-1">
                              {detail.shadowMails.map((mail) => (
                                <li key={mail.key} className="text-xs text-slate-600">
                                  <details>
                                    <summary className="cursor-pointer">
                                      {mail.at.slice(0, 16).replace('T', ' ')} · {mail.subject || mail.kind}
                                      {mail.replyTo ? ` · svar til ${mail.replyTo}` : ''}
                                    </summary>
                                    <pre className="mt-1 whitespace-pre-wrap rounded bg-white p-2 text-[11px] text-slate-700">
                                      {mail.purged ? 'Innholdet er slettet fra utboksen (eldre enn 30 dager).' : mail.text}
                                    </pre>
                                  </details>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
