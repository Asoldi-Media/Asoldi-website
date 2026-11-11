import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { API, authHeaders } from '../shared';
import {
  applyDefaultEnabled,
  applyEnumValue,
  applyLock,
  applyServiceTri,
  applyTriState,
  featureEditorModel,
  featureSpecSavePatch,
  showFeatureTreeEditor,
} from '../../../../lib/feature-tree-editor-helpers.js';
// The registry JSON has no type declaration. A global json module would hide an existing error.
// @ts-ignore
import registryJson from '../../../../data/cms-feature-tree.json';

type Props = { siteId: string; onSaved?: () => void; compact?: boolean; onSiteConfigMode?: (mode: string) => void };
type FieldError = { path?: string; message?: string };

const ENFORCEMENT = [
  { id: 'off', label: 'Av' },
  { id: 'log', label: 'Logg' },
  { id: 'on', label: 'På' },
] as const;

const TRI = [
  { id: 'inherit', label: 'Arver' },
  { id: 'grant', label: 'Gi' },
  { id: 'revoke', label: 'Trekk tilbake' },
];

const input = 'min-w-0 max-w-[9rem] px-2 py-1 rounded bg-[#1a1a1a] border border-white/20 text-white text-xs';

function errorText(errors: FieldError[], path: string) {
  return errors.find((error) => error.path === path)?.message || '';
}

export function FeatureTreeEditor({ siteId, onSaved, compact = false, onSiteConfigMode }: Props) {
  const registry = registryJson as { nodes?: unknown[] };
  const [view, setView] = useState<Record<string, unknown> | null>(null);
  const [spec, setSpec] = useState<Record<string, unknown>>({});
  const [enforcement, setEnforcement] = useState('log');
  const [loadedEnforcement, setLoadedEnforcement] = useState('log');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => {
    setConflict(false);
    setReloadKey((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    setErrors([]);
    if (reloadKey === 0) setNotice('');
    (async () => {
      const res = await fetch(`${API}/hub/sites/${encodeURIComponent(siteId)}/cms-spec`, { headers: authHeaders() });
      const body = await res.json().catch(() => ({}));
      if (cancelled) return;
      const mode = String(body.siteConfigMode || '');
      onSiteConfigMode?.(mode);
      if (!res.ok) {
        setErrors([{ path: '', message: body.message || 'Kunne ikke hente funksjonstreet.' }]);
        return;
      }
      setView(body);
      setSpec(body.featureSpec || {});
      setEnforcement(body.featureEnforcement || 'log');
      setLoadedEnforcement(body.featureEnforcement || 'log');
    })();
    return () => { cancelled = true; };
  }, [siteId, reloadKey, onSiteConfigMode]);

  const model = useMemo(() => (view ? featureEditorModel(registry, { ...view, featureSpec: spec, featureEnforcement: enforcement }) : null), [registry, view, spec, enforcement]);

  async function copyPrompt() {
    const res = await fetch(`${API}/hub/sites/${encodeURIComponent(siteId)}/cms-spec/prompt`, { headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.prompt) {
      setErrors([{ path: 'prompt', message: body.message || 'Kunne ikke hente prompten.' }]);
      return;
    }
    await navigator.clipboard.writeText(String(body.prompt));
    setNotice('Prompten er kopiert.');
  }

  async function save() {
    if (!view) return;
    const featureSpec = featureSpecSavePatch(view.featureSpec, spec);
    const body: Record<string, unknown> = { reason, cmsSpecRev: Number((view.cmsSpec as { rev?: number } | undefined)?.rev) || 0 };
    if (featureSpec) body.featureSpec = featureSpec;
    if (enforcement !== loadedEnforcement) body.featureEnforcement = enforcement;
    if (!body.featureSpec && body.featureEnforcement === undefined) {
      setNotice('Ingen endringer.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${API}/hub/sites/${encodeURIComponent(siteId)}/cms-spec`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setConflict(true);
        setErrors([{ path: '', message: 'Noen andre lagret først. Last inn på nytt.' }]);
        return;
      }
      if (!res.ok) {
        setConflict(false);
        setErrors(Array.isArray(payload.errors) ? payload.errors : [{ path: '', message: payload.message || 'Kunne ikke lagre.' }]);
        return;
      }
      setErrors([]);
      setConflict(false);
      setNotice('Lagret.');
      onSaved?.();
      reload();
    } finally {
      setSaving(false);
    }
  }

  if (!model) {
    return <p className="text-gray-400 text-sm">{errors[0]?.message || 'Laster funksjoner…'}</p>;
  }

  if (!showFeatureTreeEditor(String(view?.siteConfigMode || ''))) return null;

  const reported = (model.cmsReported || {}) as {
    effective?: string[] | string | null;
    featuresRev?: number | null;
    settingsConflicts?: unknown[];
    blockHistory?: { date?: string; count?: number }[];
  };
  const effectiveText = Array.isArray(reported.effective) ? reported.effective.join(', ') : String(reported.effective || '');
  const roots = model.nodes.filter((node) => node.depth === 0);

  return (
    <div className={`min-w-0 text-white ${compact ? 'space-y-2 text-xs' : 'space-y-3 text-sm'}`}>
      <div className="min-w-0">
        <p className="text-gray-300 truncate">Plan {model.plan || 'egen'}{model.tier != null ? ` · nivå ${model.tier}` : ''}{model.source ? ` · kilde ${model.source}` : ''}</p>
        <p className="text-gray-500 text-xs">{model.count} funksjoner</p>
      </div>
      {errors.filter((error) => !error.path).map((error) => <p key={error.message} className="text-red-300 text-xs">{error.message}</p>)}
      {conflict && (
        <button type="button" onClick={reload} className="text-xs text-[#FF5B00] hover:underline">Last inn på nytt</button>
      )}
      {notice && <p className="text-emerald-300 text-xs">{notice}</p>}
      <div className="space-y-1 min-w-0">
        <p className="text-xs text-gray-400">Tjenester</p>
        {model.services.map((service) => (
          <div key={service.id} className="flex flex-wrap items-center gap-2 min-w-0">
            <span className="truncate">{service.label}</span>
            <span className="text-[11px] text-gray-500">{service.active ? 'i planen' : 'utenfor planen'}</span>
            <select className={input} value={service.tri} onChange={(event) => setSpec((current) => applyServiceTri(current, service.id, event.target.value))}>
              {TRI.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div className="min-w-0">
        {roots.map((root) => (
          <details key={root.key} className="min-w-0 border-t border-white/10">
            <summary className="cursor-pointer py-1 truncate">{root.label}</summary>
            <ul className="min-w-0">
              {model.nodes.filter((node) => node.key === root.key || node.key.startsWith(`${root.key}.`)).map((node) => (
                <li key={node.key} className="min-w-0 py-1" style={{ paddingLeft: `${node.depth * 0.75}rem` }}>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                    <span className="truncate max-w-[12rem]" title={node.key}>{node.label}</span>
                    <span className="text-gray-400 shrink-0" aria-label={node.entitled ? 'inkludert' : 'ikke inkludert'}>{node.entitled ? '✓' : '–'}</span>
                    {!!node.via.length && <span className="text-[11px] text-gray-500 truncate">via {node.via.join(', ')}</span>}
                    <select className={input} value={node.tri} aria-label={`Tilgang ${node.label}`} onChange={(event) => setSpec((current) => applyTriState(current, node.key, event.target.value))}>
                      {TRI.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                    </select>
                    {node.type === 'bool' && (
                      <label className="inline-flex items-center gap-1 text-[11px] text-gray-300">
                        <input type="checkbox" checked={node.defaultEnabled} onChange={(event) => setSpec((current) => applyDefaultEnabled(current, node.key, event.target.checked, node.registryDefault === true))} />
                        Standard på
                      </label>
                    )}
                    {node.type === 'enum' && (
                      <select className={input} value={String(node.value ?? '')} aria-label={node.label} onChange={(event) => setSpec((current) => applyEnumValue(current, node.key, event.target.value, node.registryDefault))}>
                        {node.values.map((value) => <option key={value} value={value}>{value}</option>)}
                      </select>
                    )}
                    <label className="inline-flex items-center gap-1 text-[11px] text-gray-300">
                      <input type="checkbox" checked={node.locked} onChange={(event) => setSpec((current) => applyLock(current, node.key, event.target.checked))} />
                      Lås
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </div>
      <div className="min-w-0 space-y-1 text-xs text-gray-400">
        <p>Rapportert revisjon {reported.featuresRev ?? '–'}</p>
        <p className="break-words">Aktivt: {effectiveText || 'ikke rapportert'}</p>
        {!!reported.settingsConflicts?.length && <p className="text-amber-200 break-words">Konflikter: {reported.settingsConflicts.map((item) => String(item)).join(', ')}</p>}
        {!!reported.blockHistory?.length && (
          <ul>
            {reported.blockHistory.slice(-14).map((day) => (
              <li key={day.date}>{day.date}: {day.count ?? 0}</li>
            ))}
          </ul>
        )}
      </div>
      <label className="flex flex-wrap items-center gap-2 text-xs text-gray-300">
        Håndheving
        <select className={input} value={enforcement} onChange={(event) => setEnforcement(event.target.value)}>
          {ENFORCEMENT.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
        </select>
      </label>
      {errorText(errors, 'featureEnforcement') && <p className="text-red-300 text-xs">{errorText(errors, 'featureEnforcement')}</p>}
      {errors.filter((error) => error.path && error.path !== 'featureEnforcement').map((error) => (
        <p key={`${error.path}:${error.message}`} className="text-red-300 text-xs break-words">{error.path}: {error.message}</p>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void copyPrompt()} className="px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs">Kopier AI-prompt</button>
        <input className={`${input} max-w-full flex-1`} placeholder="Begrunnelse" value={reason} onChange={(event) => setReason(event.target.value)} />
        <button type="button" disabled={saving} onClick={() => void save()} className="px-3 py-1.5 rounded-lg bg-[#FF5B00] text-white text-xs disabled:opacity-50">{saving ? 'Lagrer…' : 'Lagre'}</button>
      </div>
    </div>
  );
}
