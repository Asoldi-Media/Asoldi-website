import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import {
  PRICING,
  type MeetingQuoteState,
  adjustedPrice,
  allPaidRecurringServices,
  customBaselineIds,
  emptyMeetingQuote,
  fmtKr,
  getTier,
  grandTotal,
  includedPagesFor,
  namedPackageMonthly,
  normalizeMeetingQuote,
  packageService,
  presetIds,
  quotedMonthly,
  cappedOneTimeCharge,
  setupCost,
} from './websitePricing';

type Props = {
  businessName: string;
  quote: unknown;
  saving?: boolean;
  embedded?: boolean;
  onClose?: () => void;
  onPersist: (payload: { meetingQuote: MeetingQuoteState }) => Promise<void> | void;
  onContinue: () => void;
  onFlushReady?: (flush: () => Promise<void>) => void;
};

export function MeetingNotesModal({ businessName, quote, saving, embedded = false, onClose, onPersist, onContinue, onFlushReady }: Props) {
  const [state, setState] = useState<MeetingQuoteState>(() => normalizeMeetingQuote(quote || emptyMeetingQuote()));
  const [savedLabel, setSavedLabel] = useState('Lagres automatisk');
  const persistRef = useRef(onPersist);
  persistRef.current = onPersist;
  const skipFirst = useRef(true);

  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    setSavedLabel('Lagrer…');
    const timer = window.setTimeout(() => {
      void Promise.resolve(persistRef.current({ meetingQuote: hostForcesOneTime ? { ...state, oneTime: true } : state }))
        .then(() => setSavedLabel('Lagret'))
        .catch(() => setSavedLabel('Kunne ikke lagre'));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [state]);
  const selected = useMemo(() => new Set<string>(state.selected), [state.selected]);
  const oneTimeAddOns = useMemo(() => new Set<string>(state.oneTimeAddOns), [state.oneTimeAddOns]);
  const hostForcesOneTime = oneTimeAddOns.has('thirdpartyhost');
  const priced = hostForcesOneTime ? { ...state, oneTime: true } : state;
  const monthly = quotedMonthly(priced);
  const setup = setupCost(priced);
  const capped = cappedOneTimeCharge(priced);
  const total = grandTotal(priced);
  const tier = getTier(state.customMode ? 'custom' : state.tierId);

  function setSelected(next: Set<string>) {
    setState((prev) => ({ ...prev, selected: [...next] }));
  }

  function applyNamed(tierId: string) {
    const pages = getTier(tierId).pages || 5;
    setState((prev) => ({
      ...prev,
      tierId,
      customMode: false,
      selected: presetIds(tierId),
      pages,
    }));
  }

  function applyCustom() {
    setState((prev) => ({
      ...prev,
      tierId: 'custom',
      customMode: true,
      selected: customBaselineIds(),
    }));
  }

  function toggleService(id: string) {
    const next = new Set<string>(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function toggleOneTimeAddOn(id: string) {
    const next = new Set<string>(oneTimeAddOns);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const hostOn = next.has('thirdpartyhost');
    setState((prev) => ({
      ...prev,
      oneTimeAddOns: [...next],
      oneTime: hostOn ? true : prev.oneTime,
    }));
  }

  function quoteToSave() {
    return hostForcesOneTime ? { ...state, oneTime: true } : state;
  }

  useEffect(() => {
    onFlushReady?.(() => Promise.resolve(persistRef.current({ meetingQuote: quoteToSave() })).then(() => undefined));
  });

  function continueToOffer() {
    void Promise.resolve(persistRef.current({ meetingQuote: quoteToSave() })).then(() => onContinue());
  }

  const meetingQuestions = [
    'Hvilke egne seksjoner trenger siden? For eksempel meny, booking, blogg eller galleri.',
    'Hva er hovedproduktet, og hva er målet med nettsiden?',
    'Identitet: farger, stil og språk.',
    'Valider at media, logo, bilder og lenker blir sendt.',
  ];

  const includedPages = includedPagesFor(state.tierId, state.customMode);

  function extraPages() {
    return Math.max(0, state.pages - includedPages);
  }

  function scalingLabel(item: { scalesWithPages?: boolean; price: number }, checked: boolean) {
    if (!item.scalesWithPages) return '—';
    const perPage = item.price * PRICING.pageScaling.ratePercent;
    const extra = extraPages();
    if (!checked || extra === 0) return `${fmtKr(perPage)}/ekstra side`;
    return `+${fmtKr(perPage * extra)} (${extra} ekstra × ${fmtKr(perPage)})`;
  }

  const shell = (
    <>
        {!embedded && (
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#E6E9EF]">
          <div className="min-w-0">
            <h3 className="font-semibold truncate">Produktnotater — {businessName || 'kunde'}</h3>
            <p className="text-xs text-[#6B7280]">Pakke og notater her er til tilbudet. Salgsnotater på kortet er noe annet.</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 rounded-lg bg-[#F3F4F6] text-[#111827] hover:bg-[#E5E7EB]" aria-label="Lukk">
            <X size={16} />
          </button>
        </div>
        )}
        <div className="grid lg:grid-cols-[minmax(0,1fr)_340px] min-h-0 flex-1 overflow-hidden">
          <div className="overflow-y-auto p-5 space-y-4 text-sm text-[#374151]">
            <label className="block">
              <span className="text-xs text-[#6B7280]">Antall sider</span>
              <input
                type="number"
                min={1}
                value={state.pages}
                onChange={(e) => setState((prev) => ({ ...prev, pages: Math.max(1, Number(e.target.value) || 1) }))}
                className="mt-1 w-24 px-3 py-2 rounded-lg bg-white border border-[#E5E7EB] text-[#111827]"
              />
              <span className="ml-2 text-xs text-[#6B7280]">
                {includedPages} inkludert i {state.customMode ? 'skreddersydd' : getTier(state.tierId).label}.
                {extraPages() > 0 ? ` ${extraPages()} ekstra.` : ' Ingen ekstra.'}
              </span>
            </label>

            <div>
              <div className="text-xs text-[#6B7280] mb-2">Pakke</div>
              <div className="space-y-1.5">
                {PRICING.tiers.map((entry) => {
                  const totalForTier = entry.id === 'custom'
                    ? quotedMonthly({ ...state, customMode: true, tierId: 'custom', selected: state.customMode ? state.selected : customBaselineIds() })
                    : namedPackageMonthly(entry.id, state.pages);
                  const checked = entry.id === 'custom' ? state.customMode : (!state.customMode && state.tierId === entry.id);
                  return (
                    <label key={entry.id} className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="meeting-tier"
                        checked={checked}
                        onChange={() => (entry.id === 'custom' ? applyCustom() : applyNamed(entry.id))}
                        className="mt-1"
                      />
                      <span>
                        {entry.label} — {fmtKr(totalForTier)}/mnd · {entry.delivery}
                        {entry.id === 'custom' ? ' — egne tjenester' : ' — fast pakkepris'}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="text-xs text-[#6B7280] mb-2">Engangskostnader</div>
              {PRICING.oneTimeAddOns.map((item) => (
                <label key={item.id} className="flex items-center gap-2 mb-1 cursor-pointer">
                  <input type="checkbox" checked={oneTimeAddOns.has(item.id)} onChange={() => toggleOneTimeAddOn(item.id)} />
                  {item.name} — {fmtKr(item.price)} engangs
                </label>
              ))}
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={state.oneTime || hostForcesOneTime}
                onChange={(e) => setState((prev) => ({
                  ...prev,
                  oneTime: hostForcesOneTime ? true : e.target.checked,
                }))}
              />
              Engangsbetaling (månedspris × 9)
              {hostForcesOneTime ? <span className="text-xs text-[#6B7280]">Tredjeparts host gjør dette til engangsbetaling.</span> : null}
            </label>

            <div className="overflow-x-auto rounded-xl border border-[#E6E9EF]">
              <table className="w-full text-xs">
                <thead className="bg-[#F8F9FB] text-[#6B7280]">
                  <tr>
                    <th className="text-left p-2">Tjeneste</th>
                    <th className="text-left p-2">Pris</th>
                    <th className="text-left p-2">Sider</th>
                    <th className="text-left p-2">Justert</th>
                  </tr>
                </thead>
                <tbody>
                  {PRICING.alwaysOn.map((item) => (
                    <tr key={item.id} className="border-t border-[#E6E9EF]">
                      <td className="p-2">{item.name}</td>
                      <td className="p-2">0 kr</td>
                      <td className="p-2">—</td>
                      <td className="p-2 text-emerald-700">Alltid</td>
                    </tr>
                  ))}
                  {allPaidRecurringServices().map((item) => {
                    const checked = selected.has(item.id);
                    const inPackage = packageService(state, item.id);
                    const p = adjustedPrice(item, state.pages, state.tierId, state.customMode);
                    return (
                      <tr key={item.id} className={`border-t border-[#E6E9EF] ${checked ? '' : 'text-[#9CA3AF]'}`}>
                        <td className="p-2">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input type="checkbox" checked={checked} onChange={() => toggleService(item.id)} />
                            {item.name}
                            {item.oneTimeMonths ? ` — engangs: ${item.oneTimeMonths} mnd` : ''}
                          </label>
                        </td>
                        <td className="p-2">{inPackage ? 'Inkl. i pakke' : fmtKr(p.base)}</td>
                        <td className="p-2">{scalingLabel(item, inPackage || checked)}</td>
                        <td className="p-2">
                          {inPackage
                            ? (p.scale > 0 ? `+${fmtKr(p.scale)}` : 'Inkl.')
                            : checked
                              ? (priced.oneTime && item.oneTimeMonths ? fmtKr(item.price * item.oneTimeMonths) : fmtKr(p.total))
                              : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="rounded-xl border border-[#E6E9EF] bg-[#F8F9FB] p-4">
              <div className="text-xs text-[#6B7280]">
                {priced.oneTime ? `Engangssum (${tier.label}, ${state.pages} sider)` : `Månedlig (${tier.label}, ${state.pages} sider)`}
              </div>
              <div className="text-2xl font-semibold text-[#111827] mt-1">
                {priced.oneTime ? fmtKr(total) : `${fmtKr(monthly)} / mnd`}
              </div>
              <div className="text-xs text-[#6B7280] mt-1">
                {priced.oneTime
                  ? `= ${fmtKr(monthly)}/mnd × ${PRICING.oneTimeMultiplier}${capped ? ` + ${fmtKr(capped)} ubegrenset 6 mnd` : ''}${setup ? ` + ${fmtKr(setup)} oppsett` : ''}`
                  : `${state.customMode ? 'Egne tjenester' : `Pakke ${fmtKr(PRICING.packagePrices[state.tierId] || 0)}`}${setup ? ` + ${fmtKr(setup)} engangs` : ''}`}
              </div>
            </div>
          </div>

          <aside className="border-t lg:border-t-0 lg:border-l border-[#E6E9EF] bg-[#F8F9FB] flex flex-col min-h-0">
            <div className="px-4 py-3 border-b border-[#E6E9EF]">
              <h4 className="font-medium text-[#111827]">Spørsmål i møtet</h4>
              <p className="text-[11px] text-[#6B7280]">Transkriptet tar med svarene. Startdato og produktnotater ligger under, og følger med i tilbudet.</p>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <ol className="list-decimal pl-4 space-y-2 text-sm text-[#111827]">
                {meetingQuestions.map((question) => (
                  <li key={question}>{question}</li>
                ))}
              </ol>
              <label className="block">
                <span className="text-xs text-[#6B7280]">Startdato for workshop</span>
                <input
                  type="date"
                  value={state.startDate || ''}
                  onChange={(e) => setState((prev) => ({ ...prev, startDate: e.target.value }))}
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-white border border-[#E5E7EB] text-sm text-[#111827]"
                />
                <span className="mt-1 block text-[11px] text-[#6B7280]">Tomt felt: e-posten sier at datoen avtales senere.</span>
              </label>
              <label className="block">
                <span className="text-xs text-[#6B7280]">Produktnotater</span>
                <textarea
                  value={state.productNotes}
                  onChange={(e) => setState((prev) => ({ ...prev, productNotes: e.target.value }))}
                  rows={5}
                  className="mt-1 w-full px-3 py-2 rounded-lg bg-white border border-[#E5E7EB] text-sm text-[#111827]"
                  placeholder="Notater om produktet, hvis du trenger dem…"
                />
              </label>
            </div>
            <div className="p-4 border-t border-[#E6E9EF] space-y-2 bg-white">
              <p className="text-[11px] text-[#6B7280]">{saving ? 'Lagrer…' : savedLabel}</p>
              {!embedded && (
              <button
                type="button"
                disabled={saving}
                onClick={continueToOffer}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-[#FF5B00] text-white font-medium hover:bg-[#e55200] disabled:opacity-50"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : null}
                Gå til tilbud
              </button>
              )}
            </div>
          </aside>
        </div>
    </>
  );

  if (embedded) {
    return (
      <div className="h-full min-h-0 overflow-hidden bg-white text-[#111827] flex flex-col">
        {shell}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[70] bg-black/75 flex items-center justify-center p-3">
      <div className="w-full max-w-[1180px] max-h-[94vh] overflow-hidden rounded-2xl bg-white text-[#111827] border border-[#E6E9EF] flex flex-col shadow-2xl">
        {shell}
      </div>
    </div>
  );
}
