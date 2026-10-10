import React, { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import {
  clientIdentityBrief,
  compactClientIdentityLine,
  kundekortHref,
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

export function DeveloperKundedata({ source }: { source: Source }) {
  const card = salesKundekortView(source);
  const address = card.meetingPlace || card.businessAddress;
  const extraLinks = card.otherLinks.filter(Boolean);

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-300">Kundedata</h3>
        <p className="mt-1 text-[11px] text-gray-500">Fra salgskundekortet. Kun visning — endres på Sales.</p>
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
