import React, { useCallback, useEffect, useState } from 'react';
import { Cpu, RefreshCw } from 'lucide-react';
import { API, authHeaders } from '../shared';

type ProviderState = { configured: boolean; dead: boolean; probe?: { ok: boolean; error?: string; checkedAt?: string } };
type RouteRow = { task: string; kind: string; dataClass: string; route: string; source?: string; shadowRoute?: string; configured: boolean; owner?: string; error?: string };
type Alert = { at: string; task: string; scope: string; expectedUsd: number; projectedUsd: number; salesClientId?: string };
type AiStatus = {
  contract: string;
  profile: string;
  profileSource: string;
  legacyPassthrough: boolean;
  overrides: { routes: { exists: boolean; applied: boolean; error: string; updatedAt: string; updatedBy: string }; budgets: { exists: boolean; applied: boolean; error: string } };
  providers: Record<string, ProviderState>;
  gemini: { billingTier: string; paidTierConfirmedAt: string | null };
  safeMode: { active: boolean; aiCallsAllowed: boolean };
  routes: RouteRow[];
  spend: { month: string; monthUsd: number; todayUsd: number; calls: number; byTask: Record<string, number>; byProvider: Record<string, number>; alerts: Alert[] };
  budgets: { periodic: Record<string, number> };
  warnings: string[];
  error: string;
};

const card = 'rounded-xl border border-white/10 bg-[#141414] p-4';
const PROFILES = ['legacy', 'prod'];

function usd(value = 0) {
  const n = Number(value) || 0;
  return `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}

function when(iso = '') {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * Superadmin → System safety → AI. The hub LLM facade: active profile and where it comes from, provider
 * keys, the route per task (with the route the prod profile would take), spend from the AI ledger and
 * budget alerts. The profile switch writes the data-dir override (PUT /api/admin/ai/routes); no env change.
 */
export function AiStatusCard() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showRoutes, setShowRoutes] = useState(false);

  const load = useCallback(async (probe = false) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/admin/ai/status${probe ? '?probe=1' : ''}`, { headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(body.message || 'Could not load the AI status.');
        return;
      }
      setStatus(body);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  async function switchProfile(profile: string) {
    if (!status || profile === status.profile) return;
    const note = profile === 'legacy'
      ? 'Switch the hub back to the legacy profile? Every AI call site sends its own request again.'
      : `Switch the hub to the ${profile} profile? AI calls follow the routes and data policy (transcripts and personal data go to Claude).`;
    if (!window.confirm(note)) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`${API}/admin/ai/routes`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError([body.message, ...(Array.isArray(body.errors) ? body.errors : [])].filter(Boolean).join(' '));
        return;
      }
      await load(false);
    } finally {
      setSaving(false);
    }
  }

  if (!status) {
    return (
      <div className={card}>
        <h3 className="text-white font-medium mb-2 inline-flex items-center gap-2"><Cpu size={16} /> AI</h3>
        <p className="text-gray-400 text-sm">{error || (loading ? 'Loading…' : '')}</p>
      </div>
    );
  }

  const topTasks = (Object.entries(status.spend.byTask || {}) as [string, number][]).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return (
    <div className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 className="text-white font-medium inline-flex items-center gap-2"><Cpu size={16} /> AI</h3>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => void load(true)} className="px-2 py-1 rounded bg-white/10 text-white text-xs inline-flex items-center gap-1" title="Free key checks (no model call)">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Check providers
          </button>
        </div>
      </div>
      {error && <p className="text-amber-400 text-sm mb-2">{error}</p>}
      <div className="grid gap-4 md:grid-cols-3 text-sm">
        <div>
          <p className="text-gray-300">
            Profile: <span className="text-white font-medium">{status.profile}</span>
            <span className="text-gray-500"> ({status.profileSource})</span>
          </p>
          <p className="text-gray-400 text-xs mt-1">
            {status.legacyPassthrough
              ? 'Legacy: every call site sends its own request unchanged; the ledger records it.'
              : 'Routes and the data policy decide the provider for each call.'}
          </p>
          <div className="flex gap-2 mt-2">
            {PROFILES.map((profile) => (
              <button
                key={profile}
                type="button"
                disabled={saving || status.profileSource === 'env'}
                onClick={() => void switchProfile(profile)}
                className={`px-2 py-1 rounded text-xs ${status.profile === profile ? 'bg-white text-black' : 'bg-white/10 text-white'} disabled:opacity-50`}
              >
                {profile}
              </button>
            ))}
          </div>
          {status.profileSource === 'env' && <p className="text-gray-500 text-xs mt-1">AI_PROFILE is set in the environment, so the switch is off.</p>}
          {status.overrides.routes.error && <p className="text-amber-400 text-xs mt-1">Routes override ignored: {status.overrides.routes.error}</p>}
          {status.overrides.routes.updatedAt && (
            <p className="text-gray-500 text-xs mt-1">Override saved {when(status.overrides.routes.updatedAt)}{status.overrides.routes.updatedBy ? ` by ${status.overrides.routes.updatedBy}` : ''}</p>
          )}
          {status.safeMode.active && <p className="text-green-400 text-xs mt-1">Safe mode: {status.safeMode.aiCallsAllowed ? 'AI calls allowed' : 'AI calls are stubbed or replayed'}</p>}
        </div>
        <div>
          <h4 className="text-gray-400 text-xs uppercase mb-1">Providers</h4>
          <ul className="space-y-1">
            {(Object.entries(status.providers) as [string, ProviderState][]).map(([name, state]) => (
              <li key={name} className="flex justify-between gap-2">
                <span className="text-gray-300">{name}</span>
                <span className={state.dead ? 'text-red-400' : state.configured ? 'text-green-400' : 'text-gray-500'}>
                  {state.dead ? 'key refused' : state.configured ? 'key set' : 'no key'}
                  {state.probe ? ` · ${state.probe.ok ? 'ok' : state.probe.error || 'failed'}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-gray-500 text-xs mt-1">Gemini billing: {status.gemini.billingTier}{status.gemini.paidTierConfirmedAt ? ` (${status.gemini.paidTierConfirmedAt})` : ''}</p>
        </div>
        <div>
          <h4 className="text-gray-400 text-xs uppercase mb-1">Spend ({status.spend.month})</h4>
          <p className="text-gray-300">Today: <span className="text-white tabular-nums">{usd(status.spend.todayUsd)}</span>{status.budgets.periodic.hubDayUsd ? <span className="text-gray-500"> / {usd(status.budgets.periodic.hubDayUsd)}</span> : null}</p>
          <p className="text-gray-300">Month: <span className="text-white tabular-nums">{usd(status.spend.monthUsd)}</span> <span className="text-gray-500">· {status.spend.calls} calls</span></p>
          <ul className="text-xs space-y-0.5 mt-1">
            {topTasks.map(([task, value]) => (
              <li key={task} className="flex justify-between gap-2"><span className="text-gray-400 truncate">{task}</span><span className="text-gray-200 tabular-nums">{usd(value)}</span></li>
            ))}
          </ul>
          {!!status.spend.alerts?.length && (
            <ul className="text-xs space-y-0.5 mt-2">
              {status.spend.alerts.slice(0, 3).map((alert, index) => (
                <li key={`${alert.at}-${index}`} className="text-amber-300">
                  {when(alert.at)} {alert.scope}{alert.salesClientId ? ` (${alert.salesClientId})` : ''}: {usd(alert.projectedUsd)} of {usd(alert.expectedUsd)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <button type="button" onClick={() => setShowRoutes((value) => !value)} className="mt-3 text-xs text-gray-400 underline">
        {showRoutes ? 'Hide routes' : `Routes for ${status.routes.length} tasks`}
      </button>
      {showRoutes && (
        <table className="w-full text-xs mt-2">
          <thead>
            <tr className="text-gray-500 text-left">
              <th className="py-1 pr-2 font-normal">Task</th>
              <th className="py-1 pr-2 font-normal">Data</th>
              <th className="py-1 pr-2 font-normal">Route</th>
              <th className="py-1 font-normal">Prod route</th>
            </tr>
          </thead>
          <tbody>
            {status.routes.map((row) => (
              <tr key={row.task} className="border-t border-white/5 align-top">
                <td className={`py-1 pr-2 ${row.configured ? 'text-white' : 'text-gray-500'}`}>{row.task}</td>
                <td className="py-1 pr-2 text-gray-400">{row.dataClass}</td>
                <td className="py-1 pr-2 text-gray-300 break-all">{row.route || row.error}</td>
                <td className="py-1 text-gray-500 break-all">{row.shadowRoute || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!!status.warnings.length && (
        <details className="mt-2 text-xs text-gray-500">
          <summary>{status.warnings.length} config note(s)</summary>
          <ul className="mt-1 space-y-0.5">{status.warnings.map((line) => <li key={line}>{line}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
