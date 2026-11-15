import React, { useState } from 'react';
import { FeatureTreeEditor } from '../../Admin/sections/FeatureTreeEditor';
import type { BoardDetail, BoardItem } from './types';
import { servicesOf, tierOf } from './lanes';

const TABS = [
  { id: 'oversikt', label: 'Oversikt' },
  { id: 'salg', label: 'Salg' },
  { id: 'workshop', label: 'Workshop' },
  { id: 'iterasjon', label: 'Iterasjon' },
  { id: 'tilbud', label: 'Tilbud/Tier' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function summaryText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && 'text' in value && typeof (value as { text?: unknown }).text === 'string') {
    return String((value as { text: string }).text);
  }
  return '';
}

/** Brief sections already present on the card and the detail summary. */
export function BriefTabs({ item, detail }: { item: BoardItem; detail: BoardDetail | null }) {
  const [tab, setTab] = useState<TabId>('oversikt');
  const tier = tierOf(item);
  const services = servicesOf(item);
  const unfinished = item.development?.nettsideFerdig !== true;
  const siteId = String(item.hubSite?.id || item.siteId || '').trim();
  return (
    <section className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-3">
      <div className="flex flex-wrap gap-1">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-testid={`brief-tab-${entry.id}`}
            aria-pressed={tab === entry.id}
            onClick={() => setTab(entry.id)}
            className={`rounded-md px-2 py-1 text-[11px] ${tab === entry.id ? 'bg-[#FF5B00] text-white' : 'bg-white/5 text-gray-300'}`}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {tab === 'oversikt' ? (
        <div className="text-xs text-gray-200 space-y-1">
          <p>{item.businessName || 'Uten navn'}</p>
          {item.industry ? <p>Bransje: {item.industry}</p> : null}
          {item.clientBrief?.short ? <p>{item.clientBrief.short}</p> : null}
          <p>Brief: {detail?.brief?.hash || item.briefSummary?.hash || 'ingen'}{detail?.brief?.version != null ? ` · versjon ${detail.brief.version}` : ''}</p>
        </div>
      ) : null}
      {tab === 'salg' ? (
        <div className="text-xs text-gray-200 space-y-1">
          <p>Signert: {item.contractSigned ? 'ja' : 'nei'}</p>
          <p>Tier: {tier || 'ikke satt'}</p>
        </div>
      ) : null}
      {tab === 'workshop' ? (
        <div className="text-xs text-gray-200 space-y-1">
          <p>Holdt: {item.workshop?.heldAt || 'ikke holdt'}</p>
          <p>{summaryText(item.workshopSummary) || summaryText(item.workshop?.summary) || 'Ingen oppsummering.'}</p>
        </div>
      ) : null}
      {tab === 'iterasjon' ? (
        <p className="text-xs text-gray-200">
          Iterasjonslogg: {Array.isArray(item.iterationLog) ? item.iterationLog.length : 0} innslag.
        </p>
      ) : null}
      {tab === 'tilbud' ? (
        <div className="space-y-2 text-xs text-gray-200">
          <p>Tier: {tier || 'ikke satt'}</p>
          <p>Tjenester: {services.length ? services.join(', ') : 'ingen'}</p>
          <div>
            <h4 className="text-[11px] uppercase tracking-wide text-gray-500">Lovet, ikke bygget</h4>
            {unfinished && services.length ? (
              <ul className="mt-1 list-disc pl-4">
                {services.map((service) => (
                  <li key={service}>{service}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-gray-500">Ingen åpne løfter (0 av {services.length}).</p>
            )}
          </div>
          {siteId ? (
            <div className="pointer-events-none" aria-readonly="true" data-readonly="true">
              <FeatureTreeEditor siteId={siteId} compact />
            </div>
          ) : (
            <p className="text-gray-500">Funksjonstreet vises når kortet har et nettsted.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
