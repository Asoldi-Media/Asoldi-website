import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { API, authHeaders } from '../shared';
import {
  INACTIVE_PROMOTION_TEXT,
  demoteSwitchPatch,
  diffPatch,
  getAt,
  groupLabel,
  parseList,
  promotionModel,
  setAt,
  settingFields,
} from '../../../../lib/automation-section-helpers.js';

type ClientOption = { id: string; name?: string };
type FieldError = { path?: string; message?: string };
type Field = ReturnType<typeof settingFields>[number];
type PromoRow = ReturnType<typeof promotionModel>['rows'][number];

type Props = {
  clients?: ClientOption[];
  onOpenTab?: (tab: string) => void;
};

const card = 'rounded-xl border border-white/10 bg-[#141414] p-4 min-w-0';
const input = 'min-w-0 max-w-full px-2 py-1 rounded-lg bg-[#1a1a1a] border border-white/20 text-white text-sm';

const VALUE_LABELS: Record<string, string> = {
  shadow: 'Skygge',
  auto: 'Auto',
  legacy: 'Som i dag',
  gate: 'Krav',
  'owner-rep': 'Kundens selger',
  service: 'Tjeneste',
  'known-contacts': 'Kjente kontakter',
  'accepted+must': 'Godtatt og må',
  accepted: 'Godtatt',
  none: 'Ingen',
  track: 'Spor',
  enforce: 'Håndhev',
  off: 'Av',
  'dry-run': 'Prøvekjøring',
  apply: 'Bruk',
  record: 'Registrer',
};

function valueLabel(value: string) {
  return VALUE_LABELS[value] || value;
}

function errorText(errors: FieldError[], path: string) {
  return errors.find((error) => error.path === path)?.message || '';
}

function FieldControl({ field, onChange }: { field: Field; onChange: (value: unknown) => void }) {
  if (field.kind === 'boolean') {
    return (
      <input type="checkbox" checked={field.value === true} onChange={(event) => onChange(event.target.checked)} />
    );
  }
  if (field.kind === 'number') {
    return (
      <input type="number" className={`${input} w-28`} value={Number(field.value)} onChange={(event) => onChange(event.target.value === '' ? '' : Number(event.target.value))} />
    );
  }
  if (field.kind === 'enum') {
    return (
      <select className={input} value={String(field.value ?? '')} onChange={(event) => onChange(event.target.value)}>
        {field.options.map((option) => <option key={option} value={option}>{valueLabel(option)}</option>)}
      </select>
    );
  }
  if (field.kind === 'string-list' || field.kind === 'number-list') {
    const text = Array.isArray(field.value) ? field.value.join(', ') : '';
    return (
      <input
        className={`${input} w-full`}
        value={text}
        onChange={(event) => onChange(parseList(event.target.value, { numbers: field.kind === 'number-list' }))}
      />
    );
  }
  if (field.kind === 'mailbox-map') {
    const map = field.value && typeof field.value === 'object' ? field.value as Record<string, boolean> : {};
    return (
      <div className="flex flex-wrap gap-3 min-w-0">
        {Object.keys(map).map((mailbox) => (
          <label key={mailbox} className="inline-flex items-center gap-2 text-gray-200 min-w-0">
            <input
              type="checkbox"
              checked={map[mailbox] === true}
              onChange={(event) => onChange({ ...map, [mailbox]: event.target.checked })}
            />
            <span className="truncate">{mailbox}</span>
          </label>
        ))}
      </div>
    );
  }
  if (field.kind === 'paused') {
    const paused = field.value && typeof field.value === 'object' ? field.value as { reason?: string } : null;
    return (
      <label className="inline-flex items-center gap-2 min-w-0">
        <input
          type="checkbox"
          checked={Boolean(paused)}
          onChange={(event) => onChange(event.target.checked ? { reason: paused?.reason || 'pause', at: new Date().toISOString(), by: 'admin' } : null)}
        />
        <input
          className={input}
          placeholder="Årsak"
          value={paused?.reason || ''}
          onChange={(event) => onChange(event.target.value ? { reason: event.target.value, at: new Date().toISOString(), by: 'admin' } : null)}
        />
      </label>
    );
  }
  if (field.kind === 'string') {
    return <input className={`${input} w-full`} value={String(field.value ?? '')} onChange={(event) => onChange(event.target.value)} />;
  }
  return <span className="text-gray-500 text-xs truncate">{JSON.stringify(field.value)}</span>;
}

function PilotPicker({ clients, selected, onChange }: { clients: ClientOption[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const known = new Set(clients.map((client) => client.id));
  const extras = selected.filter((id) => !known.has(id)).map((id) => ({ id, name: id }));
  const shown = [...extras, ...clients].filter((client) => !needle || `${client.name || ''} ${client.id}`.toLowerCase().includes(needle));
  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]);
  }
  return (
    <div className="space-y-2 min-w-0">
      <input className={`${input} w-full`} value={query} placeholder="Søk klient" onChange={(event) => setQuery(event.target.value)} />
      {!selected.length && <p className="text-gray-500 text-xs">Tom liste betyr ingen piloter.</p>}
      {!clients.length && <p className="text-gray-500 text-xs">Ingen klienter er lastet inn.</p>}
      <ul className="max-h-40 overflow-y-auto space-y-1">
        {shown.map((client) => (
          <li key={client.id}>
            <label className="flex items-center gap-2 text-sm text-gray-200 min-w-0">
              <input type="checkbox" checked={selected.includes(client.id)} onChange={() => toggle(client.id)} />
              <span className="truncate">{client.name || client.id}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RelatedLinks({ onOpenTab }: { onOpenTab?: (tab: string) => void }) {
  const item = 'text-sm text-left';
  return (
    <div className={card}>
      <h2 className="text-white font-medium mb-2">Snarveier</h2>
      <ul className="space-y-1">
        <li>
          <button type="button" className={`${item} text-[#FF5B00] hover:underline`} onClick={() => onOpenTab?.('system')}>Maker-vertsliste</button>
        </li>
        <li><button type="button" disabled className={`${item} text-gray-500`}>IMAP-passord · kommer</button></li>
        <li><button type="button" disabled className={`${item} text-gray-500`}>Kundeomtaler · kommer</button></li>
        <li><button type="button" disabled className={`${item} text-gray-500`}>Varsler · kommer</button></li>
      </ul>
    </div>
  );
}

function PromotionPanel({ reason }: { reason: string }) {
  const [model, setModel] = useState<ReturnType<typeof promotionModel> | null>(null);
  const [failed, setFailed] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setFailed('');
    const res = await fetch(`${API}/admin/automation/promotion`, { headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (res.status === 404) {
      setModel(promotionModel({ code: 'disabled' }));
      return;
    }
    if (!res.ok) {
      setFailed(body.message || 'Kunne ikke hente opprykk.');
      setModel(null);
      return;
    }
    setModel(promotionModel(body));
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function demote(row: PromoRow) {
    setBusy(row.id);
    try {
      const res = await fetch(`${API}/admin/automation-settings`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: demoteSwitchPatch(row.id), reason: reason || 'Manuell overstyring' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const first = Array.isArray(body.errors) ? body.errors[0]?.message : '';
        setFailed(first || body.message || 'Kunne ikke endre modus.');
        return;
      }
      setFailed('');
      await load();
    } finally {
      setBusy('');
    }
  }

  return (
    <section className={card}>
      <h2 className="text-white font-medium mb-2">Opprykk</h2>
      {failed && <p className="text-red-300 text-sm">{failed}</p>}
      {model && !model.active && <p className="text-gray-500 text-sm">{model.message || INACTIVE_PROMOTION_TEXT}</p>}
      {model?.active && (
        <ul className="space-y-3">
          {model.rows.map((row) => (
            <li key={row.id} className="border-t border-white/10 pt-2 min-w-0">
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <span className="text-white truncate">{row.id}</span>
                <span className="text-gray-400 text-xs">{valueLabel(String(row.mode || 'ukjent'))}</span>
                {row.releasePassedAt && <span className="text-gray-500 text-xs">Utgivelse {row.releasePassedAt}</span>}
                {row.streak != null && <span className="text-gray-400 text-xs">Serie {row.streak}{row.target != null ? ` / ${row.target}` : ''}</span>}
              </div>
              {!!row.blockers.length && (
                <p className="text-amber-200 text-xs mt-1">{row.blockers.map((item) => item.label).join(', ')}</p>
              )}
              <button type="button" disabled={busy === row.id} onClick={() => void demote(row)} className="mt-1 text-xs text-[#FF5B00] hover:underline disabled:opacity-50">
                Sett modus til godkjenning
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AutomationSection({ clients = [], onOpenTab }: Props) {
  const [loaded, setLoaded] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [defaults, setDefaults] = useState<Record<string, unknown>>({});
  const [envOverrides, setEnvOverrides] = useState<{ path: string }[]>([]);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`${API}/admin/automation-settings`, { headers: authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErrors([{ path: '', message: body.message || 'Kunne ikke hente innstillinger.' }]);
      return;
    }
    setLoaded(body.settings || {});
    setDraft(body.settings || {});
    setDefaults(body.defaults || {});
    setEnvOverrides(Array.isArray(body.envOverrides) ? body.envOverrides : []);
    setErrors([]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const fields = useMemo(
    () => (draft ? settingFields(draft, { defaults, envOverrides }) : []),
    [draft, defaults, envOverrides],
  );
  const groups = useMemo(() => {
    const order: string[] = [];
    for (const field of fields) if (!order.includes(field.group)) order.push(field.group);
    return order;
  }, [fields]);

  function update(path: string, value: unknown) {
    setDraft((current) => (current ? setAt(current, path, value) : current));
  }

  async function save() {
    if (!loaded || !draft) return;
    const patch = diffPatch(loaded, draft) || {};
    setSaving(true);
    setNotice('');
    try {
      const res = await fetch(`${API}/admin/automation-settings`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: patch, reason }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrors(Array.isArray(body.errors) ? body.errors : [{ path: '', message: body.message || 'Kunne ikke lagre.' }]);
        return;
      }
      setErrors([]);
      setNotice('Lagret.');
      setLoaded(body.settings || draft);
      setDraft(body.settings || draft);
    } finally {
      setSaving(false);
    }
  }

  const pilots = Array.isArray(getAt(draft, 'pilotClientIds')) ? getAt(draft, 'pilotClientIds') as string[] : [];

  return (
    <div className="max-w-5xl min-w-0 space-y-4 text-white">
      <h1 className="text-2xl font-bold">Automatisering</h1>
      <p className="text-gray-400 text-sm">Innstillingene lagres bare for feltene du endrer. Ingenting slås på av seg selv.</p>
      {errors.filter((error) => !error.path).map((error) => <p key={error.message} className="text-red-300 text-sm">{error.message}</p>)}
      {notice && <p className="text-emerald-300 text-sm">{notice}</p>}
      <div className={card}>
        <label className="block text-xs text-gray-400 mb-1">Begrunnelse</label>
        <input className={`${input} w-full`} value={reason} onChange={(event) => setReason(event.target.value)} />
        <button type="button" disabled={saving || !draft} onClick={() => void save()} className="mt-3 px-3 py-1.5 rounded-lg bg-[#FF5B00] text-white text-sm disabled:opacity-50">
          {saving ? 'Lagrer…' : 'Lagre'}
        </button>
      </div>
      {groups.map((group) => (
        <section key={group} className={card}>
          <h2 className="text-white font-medium mb-3">{groupLabel(group)}</h2>
          <div className="space-y-3">
            {fields.filter((field) => field.group === group).map((field) => (
              <div key={field.path} className="grid gap-1 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:items-center min-w-0">
                <div className="min-w-0">
                  <div className="text-sm text-gray-200 truncate">{field.path === 'pilotClientIds' ? 'Pilotkunder' : field.label}</div>
                  <div className="text-[11px] text-gray-500 truncate">{field.path}</div>
                </div>
                <div className="min-w-0">
                  {field.path === 'pilotClientIds' ? (
                    <PilotPicker clients={clients} selected={pilots} onChange={(ids) => update('pilotClientIds', ids)} />
                  ) : field.editable ? (
                    <FieldControl field={field} onChange={(value) => update(field.path, value)} />
                  ) : (
                    <span className="text-gray-500 text-xs">Skrivebeskyttet</span>
                  )}
                  {field.overriddenBy === 'env' && <span className="ml-2 text-[11px] text-amber-200">Overstyrt av miljø</span>}
                  {errorText(errors, field.path) && <p className="text-red-300 text-xs mt-1">{errorText(errors, field.path)}</p>}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      <PromotionPanel reason={reason} />
      <RelatedLinks onOpenTab={onOpenTab} />
    </div>
  );
}
