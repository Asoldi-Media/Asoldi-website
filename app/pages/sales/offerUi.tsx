import React from 'react';
import type { OfferAlternative, OfferContractSummary, OfferProduct, SalesOffer, SalesOfferStatus } from '../Admin/shared';
import { formatKr, withMva } from '../../../lib/website-tiers.js';
import { offerTotals } from '../../../lib/offer-email.js';

export const OFFER_STATUS_LABEL: Record<SalesOfferStatus, string> = {
  draft: 'Utkast',
  'review-requested': 'Venter på admin',
  verified: 'Verifisert',
  sent: 'Sendt',
};

export function offerStatusLabel(offer: Pick<SalesOffer, 'status'> | null | undefined) {
  if (!offer) return '';
  return OFFER_STATUS_LABEL[offer.status] || offer.status;
}

export function OfferStatusChip({ status, className = '' }: { status: SalesOfferStatus; className?: string }) {
  const tone = status === 'sent'
    ? 'bg-emerald-900/20 text-emerald-200 border-emerald-400/30'
    : status === 'verified'
      ? 'bg-sky-900/30 text-sky-300 border-sky-400/30'
      : status === 'review-requested'
        ? 'bg-amber-900/20 text-amber-200 border-amber-400/30'
        : 'bg-white/10 text-gray-200 border-white/15';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone} ${className}`}>
      Tilbud: {OFFER_STATUS_LABEL[status] || status}
    </span>
  );
}

export function OfferProductsCard({
  products,
  alternatives,
  title = 'Produkter i tilbudet',
  mvaIncluded = false,
  onRemove,
  onEdit,
}: {
  products: OfferProduct[];
  alternatives?: OfferAlternative[];
  title?: string;
  /** Listed prices are what the client pays incl. MVA (rep absorbed the VAT). */
  mvaIncluded?: boolean;
  onRemove?: (id: string) => void;
  onEdit?: (product: OfferProduct) => void;
}) {
  const alts = Array.isArray(alternatives) && alternatives.length >= 2 ? alternatives : null;
  if (alts) {
    return (
      <div className="space-y-2">
        {alts.map((alt, index) => (
          <div key={`alt-${index}`}>
            {index > 0 ? (
              <p className="py-1 text-center text-xs font-semibold uppercase tracking-wide text-gray-400">eller</p>
            ) : null}
            <OfferPackageList
              products={alt.products}
              title={`Tilbud ${index + 1}`}
              mvaIncluded={mvaIncluded}
            />
          </div>
        ))}
      </div>
    );
  }
  return (
    <OfferPackageList
      products={products}
      title={title}
      mvaIncluded={mvaIncluded}
      onRemove={onRemove}
      onEdit={onEdit}
    />
  );
}

function OfferPackageList({
  products,
  title,
  mvaIncluded = false,
  onRemove,
  onEdit,
}: {
  products: OfferProduct[];
  title: string;
  mvaIncluded?: boolean;
  onRemove?: (id: string) => void;
  onEdit?: (product: OfferProduct) => void;
}) {
  const totals = offerTotals(products, { mvaIncluded });
  const once = products.some((item) => /engangsbetaling/i.test(item.note || ''));
  const unit = once ? 'engang' : '/ mnd';
  return (
    <div className="rounded-xl border border-white/10 bg-[#161616] p-4 text-sm text-gray-200">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="font-medium text-white">{title}</span>
        <span className="text-xs text-gray-400">{products.length} stk{mvaIncluded ? ' · mva inkludert' : ''}</span>
      </div>
      {!products.length ? (
        <p className="text-xs text-gray-500">Ingen produkter enda – velg en nettside-tier.</p>
      ) : (
        <ul className="space-y-2">
          {products.map((item) => (
            <li key={item.id} className="rounded-lg bg-black/30 px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-white font-medium truncate">{item.name}</div>
                  <div className="text-xs text-gray-400">
                    {item.pages ? `Opp til ${item.pages} sider · ` : ''}{item.includes.length} punkter{item.deliveryWeeks ? ` · ${item.deliveryWeeks} uker` : ''}
                    {item.kind === 'tier' ? ' · pakke' : ' · skreddersydd'}
                  </div>
                  {item.note && <div className="text-xs text-gray-400 mt-1 italic">{item.note}</div>}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-white">{formatKr(item.priceExMva)}</div>
                  <div className="text-[11px] text-gray-500">{mvaIncluded ? `inkl. mva ${unit}` : `eks. mva ${unit}`}</div>
                  {(onEdit || onRemove) && (
                    <div className="mt-1 flex gap-2 justify-end">
                      {onEdit && (
                        <button type="button" onClick={() => onEdit(item)} className="text-[11px] text-sky-300 hover:underline">Rediger</button>
                      )}
                      {onRemove && (
                        <button type="button" onClick={() => onRemove(item.id)} className="text-[11px] text-red-300 hover:underline">Fjern</button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 border-t border-white/10 pt-2 text-xs text-gray-300 space-y-0.5">
        <div className="flex justify-between"><span>Eks. mva</span><span>{formatKr(totals.exMva)} {unit}</span></div>
        <div className="flex justify-between"><span>{mvaIncluded ? 'Herav MVA 25 %' : 'MVA 25 %'}</span><span>{formatKr(totals.mva)}</span></div>
        <div className="flex justify-between text-white font-semibold"><span>Inkl. mva</span><span>{formatKr(totals.inclMva)} {unit}</span></div>
        <div className="flex justify-between text-gray-500"><span>Leveringstid</span><span>{totals.deliveryWeeks} uker</span></div>
      </div>
    </div>
  );
}

export function ContractSummaryCard({ summary, mvaIncluded = false }: { summary: OfferContractSummary | null; mvaIncluded?: boolean }) {
  if (!summary) {
    return (
      <div className="rounded-xl border border-dashed border-white/15 bg-[#161616] p-4 text-xs text-gray-500">
        Ingen kontraktsammendrag enda. For pakke 1–3 brukes standardkontrakten. For skreddersydd må admin speile e-posten i kontrakten.
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-white/10 bg-[#161616] p-4 text-sm text-gray-200 space-y-2">
      <div className="font-medium text-white">{summary.title || 'Kontraktsammendrag'}</div>
      {summary.scopeSummary && <p className="text-xs text-gray-300">{summary.scopeSummary}</p>}
      <ul className="space-y-2">
        {summary.products.map((item) => (
          <li key={item.id} className="rounded-lg bg-black/30 px-3 py-2">
            <div className="flex justify-between gap-2 text-white">
              <span>{item.name}{item.pages ? ` – opp til ${item.pages} sider` : ''}</span>
              <span>{formatKr(item.priceExMva)}</span>
            </div>
            {item.includes.length > 0 && (
              <ul className="mt-1 list-disc pl-4 text-xs text-gray-300 space-y-0.5">
                {item.includes.map((line, index) => <li key={index}>{line}</li>)}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <div className="text-xs text-gray-300">
        {mvaIncluded ? (
          <>Månedspris: <span className="text-white">{formatKr(summary.monthlyExMva)}</span> inkl. mva ({formatKr(Math.round(summary.monthlyExMva / 1.25))} eks.) · Levering {summary.deliveryWeeks} uker</>
        ) : (
          <>Månedspris: <span className="text-white">{formatKr(summary.monthlyExMva)}</span> eks. mva ({formatKr(withMva(summary.monthlyExMva))} inkl.) · Levering {summary.deliveryWeeks} uker</>
        )}
      </div>
      {summary.extraTerms.length > 0 && (
        <div className="text-xs text-gray-300">
          <div className="text-gray-400 mb-1">Tilleggsvilkår:</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {summary.extraTerms.map((line, index) => <li key={index}>{line}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

export function HtmlPreview({ html, className = '' }: { html: string; className?: string }) {
  return (
    <iframe
      title="Forhåndsvisning"
      sandbox=""
      srcDoc={`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#f4f4f4;}</style></head><body>${html}</body></html>`}
      className={`w-full rounded-xl border border-white/10 bg-white ${className}`}
    />
  );
}
