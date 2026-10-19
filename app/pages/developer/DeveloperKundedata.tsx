import React, { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, Loader2, Plus, Trash2, Volume2 } from 'lucide-react';
import { API } from '../Admin/shared';
import {
  clientIdentityBrief,
  compactClientIdentityLine,
  kundekortHref,
  normalizeExtraFacts,
  salesKundekortView,
} from '../../../lib/sales-kundekort.js';

type Source = Record<string, unknown>;

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="shrink-0 p-1 rounded text-gray-500 hover:text-white hover:bg-white/10"
      title="Kopier"
      aria-label="Kopier"
    >
      {copied ? <Check size={12} className="text-green-300" /> : <Copy size={12} />}
    </button>
  );
}

function ValueRow({
  label,
  value,
  href = '',
}: {
  label: string;
  value: string;
  href?: string;
}) {
  return (
    <div className="min-w-0">
      {label ? <div className="text-[10px] uppercase tracking-wide text-gray-500">{label}</div> : null}
      <div className={`${label ? 'mt-0.5' : ''} flex items-start gap-1 min-w-0`}>
        {value && href ? (
          <a
            href={href}
            target={href.startsWith('http') ? '_blank' : undefined}
            rel={href.startsWith('http') ? 'noreferrer' : undefined}
            className="min-w-0 break-all text-sm text-[#FF9A5C] hover:underline"
          >
            {value}
          </a>
        ) : (
          <span className={`min-w-0 break-all text-sm ${value ? 'text-gray-100' : 'text-gray-600'}`}>
            {value || '—'}
          </span>
        )}
        {href && href.startsWith('http') ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 p-1 rounded text-gray-500 hover:text-white hover:bg-white/10"
            title="Åpne"
            aria-label="Åpne"
          >
            <ExternalLink size={12} />
          </a>
        ) : null}
        <CopyValue value={value} />
      </div>
    </div>
  );
}

export function DeveloperClientIdentityLine({
  source,
  className = '',
}: {
  source: Source;
  className?: string;
}) {
  const line = compactClientIdentityLine(source);
  if (!line) return null;
  return (
    <span className={`text-[11px] text-gray-400 max-w-[18rem] line-clamp-2 ${className}`}>
      {line}
    </span>
  );
}

export function DeveloperClientIdentityFull({ source }: { source: Source }) {
  const brief = clientIdentityBrief(source);
  const fallback = compactClientIdentityLine(source);
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-300">Klientbeskrivelse</h3>
      {brief.ready && brief.full ? (
        <p className="whitespace-pre-wrap text-sm text-gray-200">{brief.full}</p>
      ) : (
        <div className="space-y-2">
          {fallback ? <p className="text-sm text-gray-200">{fallback}</p> : null}
          <p className="text-xs text-gray-500">
            Full beskrivelse er ikke generert ennå. Senere skrives den fra møtebooker-lyd, kundekortet og salgsmøte-transkriptet. Kortet viser da et kort sammendrag; her kommer den lange versjonen.
          </p>
        </div>
      )}
    </section>
  );
}

export function BookerRecordingPlayer({
  itemId = '',
  latestRecordingUrl = '',
  authHeaders = {},
  recordingEndpoint = '',
}: {
  itemId?: string;
  latestRecordingUrl?: string;
  authHeaders?: Record<string, string>;
  recordingEndpoint?: string;
}) {
  const endpoint = recordingEndpoint
    || (itemId ? `${API}/admin/development/${encodeURIComponent(itemId)}/recording` : '');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [blobUrl, setBlobUrl] = useState('');
  const [error, setError] = useState('');
  const authKey = String(authHeaders?.Authorization || '');

  useEffect(() => () => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }, [blobUrl]);

  useEffect(() => {
    setOpen(false);
    setLoading(false);
    setError('');
    setBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return '';
    });
  }, [endpoint, latestRecordingUrl, authKey]);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    if (blobUrl) {
      setOpen(true);
      return;
    }
    if (!endpoint) {
      setError('Mangler utvikler-id for opptaket.');
      setOpen(true);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await fetch(endpoint, { method: 'GET', headers: authHeaders });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'Klarte ikke å laste booker-opptaket.');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      setBlobUrl(url);
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Klarte ikke å laste booker-opptaket.');
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-gray-500">Møtebooker-opptak</div>
      {!latestRecordingUrl ? (
        <p className="text-sm text-gray-600">—</p>
      ) : (
        <>
          <button
            type="button"
            onClick={() => void toggle()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
            title="Last og spill booker-samtalen her"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <Volume2 size={13} />}
            {open ? 'Skjul lyd' : 'Lytt her'}
          </button>
          {open ? (
            <div className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-2">
              {blobUrl ? (
                <audio controls preload="metadata" src={blobUrl} className="w-full" />
              ) : (
                <div className="text-xs text-amber-300">
                  {error || 'Klarte ikke å laste booker-opptaket.'}
                </div>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

type ExtraFact = { id: string; label: string; value: string };

export type KundekortDraft = {
  businessName: string;
  industry: string;
  orgNumber: string;
  meetingPlace: string;
  websiteDomain: string;
  contactPerson: string;
  contactPhone: string;
  contactEmail: string;
  websiteEmail: string;
  instagramUrl: string;
  facebookUrl: string;
  proffUrl: string;
  googleBusinessProfile: string;
  otherLinks: string;
  notes: string;
  brief: string;
  extraFacts: ExtraFact[];
};

function draftFromSource(source: Source): KundekortDraft {
  const card = salesKundekortView(source);
  const brief = clientIdentityBrief(source);
  return {
    businessName: card.businessName,
    industry: card.industry,
    orgNumber: card.orgNumber,
    meetingPlace: card.meetingPlace || card.businessAddress,
    websiteDomain: card.websiteDomain,
    contactPerson: card.contactPerson,
    contactPhone: card.contactPhone,
    contactEmail: card.contactEmail,
    websiteEmail: card.websiteEmail,
    instagramUrl: card.instagramUrl,
    facebookUrl: card.facebookUrl,
    proffUrl: card.proffUrl,
    googleBusinessProfile: card.googleBusinessProfile,
    otherLinks: card.otherLinks.join('\n'),
    notes: card.notes,
    brief: brief.full || brief.short,
    extraFacts: normalizeExtraFacts(card.extraFacts) as ExtraFact[],
  };
}

function EditField({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  const className = 'mt-0.5 w-full rounded-lg border border-white/10 bg-[#161616] px-2.5 py-1.5 text-sm text-white';
  return (
    <label className="block min-w-0">
      <span className="text-[10px] uppercase tracking-wide text-gray-500">{label}</span>
      {multiline ? (
        <textarea value={value} rows={3} onChange={(event) => onChange(event.target.value)} className={`${className} resize-y`} />
      ) : (
        <input value={value} onChange={(event) => onChange(event.target.value)} className={className} />
      )}
    </label>
  );
}

export function DeveloperKundedata({
  source,
  itemId = '',
  latestRecordingUrl = '',
  authHeaders = {},
  recordingEndpoint = '',
  note = 'Samme kundekort som Sales og Admin. Lagre her, så oppdateres det overalt.',
  onSave,
}: {
  source: Source;
  itemId?: string;
  latestRecordingUrl?: string;
  authHeaders?: Record<string, string>;
  /** Overrides the developer recording route (Sales uses /admin/sales/:id/recording). */
  recordingEndpoint?: string;
  note?: string;
  onSave?: (draft: KundekortDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<KundekortDraft>(() => draftFromSource(source));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const sourceKey = JSON.stringify(draftFromSource(source));
  useEffect(() => {
    setDraft(draftFromSource(source));
  }, [sourceKey]);

  async function save() {
    if (!onSave) return;
    setSaving(true);
    setError('');
    try {
      await onSave(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre kundedata.');
    } finally {
      setSaving(false);
    }
  }

  if (onSave) {
    const set = (key: keyof KundekortDraft) => (value: string) => setDraft((prev) => ({ ...prev, [key]: value }));
    return (
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-300">Kundedata</h3>
            <p className="mt-1 text-[11px] text-gray-500">{note}</p>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={() => void save()}
            className="shrink-0 rounded-lg bg-[#FF5B00] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#e55200] disabled:opacity-50"
          >
            {saving ? 'Lagrer…' : 'Lagre'}
          </button>
        </div>
        {error ? <p className="text-xs text-red-300">{error}</p> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <EditField label="Bedrift" value={draft.businessName} onChange={set('businessName')} />
          <EditField label="Bransje" value={draft.industry} onChange={set('industry')} />
          <EditField label="Kontakt" value={draft.contactPerson} onChange={set('contactPerson')} />
          <EditField label="Telefon" value={draft.contactPhone} onChange={set('contactPhone')} />
          <EditField label="E-post" value={draft.contactEmail} onChange={set('contactEmail')} />
          <EditField label="Nettside-e-post" value={draft.websiteEmail} onChange={set('websiteEmail')} />
          <EditField label="Org.nr" value={draft.orgNumber} onChange={set('orgNumber')} />
          <EditField label="Domene" value={draft.websiteDomain} onChange={set('websiteDomain')} />
          <EditField label="Adresse" value={draft.meetingPlace} onChange={set('meetingPlace')} />
          <EditField label="Instagram" value={draft.instagramUrl} onChange={set('instagramUrl')} />
          <EditField label="Facebook" value={draft.facebookUrl} onChange={set('facebookUrl')} />
          <EditField label="proff.no" value={draft.proffUrl} onChange={set('proffUrl')} />
          <EditField label="Google" value={draft.googleBusinessProfile} onChange={set('googleBusinessProfile')} />
        </div>
        <EditField label="Andre lenker (én per linje)" value={draft.otherLinks} onChange={set('otherLinks')} multiline />
        <EditField label="Klientbeskrivelse" value={draft.brief} onChange={set('brief')} multiline />
        <EditField label="Salgsnotater" value={draft.notes} onChange={set('notes')} multiline />
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Ekstra info</div>
          {draft.extraFacts.map((fact) => (
            <div key={fact.id} className="flex items-start gap-2">
              <input
                value={fact.label}
                placeholder="Navn"
                onChange={(event) => setDraft((prev) => ({
                  ...prev,
                  extraFacts: prev.extraFacts.map((row) => (row.id === fact.id ? { ...row, label: event.target.value } : row)),
                }))}
                className="w-36 shrink-0 rounded-lg border border-white/10 bg-[#161616] px-2.5 py-1.5 text-sm text-white"
              />
              <input
                value={fact.value}
                placeholder="Innhold"
                onChange={(event) => setDraft((prev) => ({
                  ...prev,
                  extraFacts: prev.extraFacts.map((row) => (row.id === fact.id ? { ...row, value: event.target.value } : row)),
                }))}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-[#161616] px-2.5 py-1.5 text-sm text-white"
              />
              <button
                type="button"
                onClick={() => setDraft((prev) => ({ ...prev, extraFacts: prev.extraFacts.filter((row) => row.id !== fact.id) }))}
                className="shrink-0 rounded-lg p-2 text-gray-400 hover:text-red-300"
                aria-label="Slett"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setDraft((prev) => ({
              ...prev,
              extraFacts: [...prev.extraFacts, { id: `ny-${Date.now()}`, label: '', value: '' }],
            }))}
            className="inline-flex items-center gap-1 rounded-lg bg-white/10 px-2.5 py-1.5 text-xs text-white hover:bg-white/15"
          >
            <Plus size={12} />
            Legg til info
          </button>
        </div>
        <BookerRecordingPlayer
          itemId={itemId}
          latestRecordingUrl={latestRecordingUrl}
          authHeaders={authHeaders}
          recordingEndpoint={recordingEndpoint}
        />
      </section>
    );
  }

  const card = salesKundekortView(source);
  const address = card.meetingPlace || card.businessAddress;
  const extraLinks = card.otherLinks.filter(Boolean);

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-300">Kundedata</h3>
        <p className="mt-1 text-[11px] text-gray-500">{note}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <ValueRow label="Bedrift" value={card.businessName} />
        <ValueRow label="Bransje" value={card.industry} />
        <ValueRow label="Produkt" value={card.productLabel} />
        <ValueRow label="Org.nr" value={card.orgNumber} />
        <ValueRow label="Adresse" value={address} />
        <ValueRow
          label="Domene"
          value={card.websiteDomain}
          href={kundekortHref(card.websiteDomain, 'domain')}
        />
        <ValueRow label="Kontakt" value={card.contactPerson} />
        <ValueRow
          label="Telefon"
          value={card.contactPhone}
          href={kundekortHref(card.contactPhone, 'phone')}
        />
        <ValueRow
          label="E-post"
          value={card.contactEmail}
          href={kundekortHref(card.contactEmail, 'email')}
        />
        <ValueRow
          label="Nettside-e-post"
          value={card.websiteEmail}
          href={kundekortHref(card.websiteEmail, 'email')}
        />
        <ValueRow
          label="Instagram"
          value={card.instagramUrl}
          href={kundekortHref(card.instagramUrl)}
        />
        <ValueRow
          label="Facebook"
          value={card.facebookUrl}
          href={kundekortHref(card.facebookUrl)}
        />
        <ValueRow
          label="proff.no"
          value={card.proffUrl}
          href={kundekortHref(card.proffUrl)}
        />
        <ValueRow
          label="Google"
          value={card.googleBusinessProfile}
          href={kundekortHref(card.googleBusinessProfile)}
        />
      </div>

      {card.extraFacts?.length ? (
        <div className="space-y-2">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Ekstra info</div>
          {card.extraFacts.map((fact) => (
            <ValueRow key={fact.id} label={fact.label || 'Info'} value={fact.value} />
          ))}
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">Andre lenker</div>
        {extraLinks.length ? (
          <ul className="space-y-1.5">
            {extraLinks.map((link) => (
              <li key={link}>
                <ValueRow label="" value={link} href={kundekortHref(link)} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-600">—</p>
        )}
      </div>

      <BookerRecordingPlayer
        itemId={itemId}
        latestRecordingUrl={latestRecordingUrl}
        authHeaders={authHeaders}
        recordingEndpoint={recordingEndpoint}
      />

      <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[10px] uppercase tracking-wide text-gray-500">Salgsnotater</div>
          <CopyValue value={card.notes} />
        </div>
        <p className={`mt-1 whitespace-pre-wrap text-sm ${card.notes ? 'text-gray-200' : 'text-gray-600'}`}>
          {card.notes || 'Ingen salgsnotater.'}
        </p>
      </div>
    </section>
  );
}
