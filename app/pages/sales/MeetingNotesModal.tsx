import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Loader2, Minus, Plus, X } from 'lucide-react';
import {
  datetimeLocalOsloToIso,
  isoToDatetimeLocalOslo,
} from '../../../lib/sales-next-actions.js';
import { WORKSHOP_FORMATS, offerStartDateFromWorkshopDueAt } from '../../../lib/workshop-action-shared.js';
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
  activeMeetingQuoteIndex,
  activeMeetingQuotePackage,
  addAltMeetingQuote,
  hasAltMeetingQuote,
  removeAltMeetingQuote,
  withActiveMeetingQuotePackage,
} from './websitePricing';

type WorkshopDraft = {
  name: string;
  format: 'sms' | 'ring' | 'sms-ring' | 'mote';
  dueAt: string;
  addToCalendar: boolean;
};

type Props = {
  businessName: string;
  quote: unknown;
  workshopAction?: {
    name?: string;
    format?: string;
    dueAt?: string;
    addToCalendar?: boolean;
    meetLink?: string;
  } | null;
  saving?: boolean;
  embedded?: boolean;
  onClose?: () => void;
  onPersist: (payload: { meetingQuote: MeetingQuoteState }) => Promise<void> | void;
  onPersistWorkshop?: (payload: {
    workshopAction: { name: string; format: WorkshopDraft['format']; dueAt: string; addToCalendar: boolean };
  }) => Promise<void> | void;
  onContinue: () => void;
  onFlushReady?: (flush: () => Promise<void>) => void;
};

function workshopUiFormat(value = ''): WorkshopDraft['format'] {
  const raw = String(value || '').toLowerCase();
  if (raw === 'sms') return 'sms';
  if (raw === 'ring') return 'ring';
  if (raw === 'sms-ring' || raw === 'sms/ring') return 'sms-ring';
  return 'mote';
}

function workshopDraftFromAction(action?: Props['workshopAction']): WorkshopDraft {
  const format = workshopUiFormat(action?.format);
  return {
    name: String(action?.name || 'Workshop').trim() || 'Workshop',
    format,
    dueAt: isoToDatetimeLocalOslo(action?.dueAt || ''),
    addToCalendar: format === 'mote' ? true : Boolean(action?.addToCalendar),
  };
}

const SALES_MEETING_SCRIPT: { title: string; goal?: string; lines: { text?: string; quote?: string }[] }[] = [
  {
    title: 'Bli kjent',
    lines: [
      { quote: 'Hvorfor sa dere ja til et møte med oss?' },
      { quote: 'Hvor lenge har dere drevet bedriften, og hvorfor startet dere? Fortell litt mer.' },
      { quote: 'Hva er en kunde verdt for dere over en livstid?' },
      { quote: 'Hva er hovedproduktet deres?' },
      { quote: 'Har dere gjort dere noen tanker om design eller funksjonalitet? Hva er målet?' },
    ],
  },
  {
    title: 'Fremvisning',
    lines: [
      { text: 'Vis nettsiden (SEO-analyse hvis de allerede har en nettside) og spør:', quote: 'Hva synes dere?' },
      { text: 'Snakk om endringer og spesifikasjoner' },
      { text: 'Snakk om funksjonalitet' },
      { text: 'Snakk om identitet: farger, stil og språk (har de dette?)' },
      { text: 'Avklar hvilke egne seksjoner siden trenger' },
      { text: 'Vis andre prosjekter og reviews' },
      { text: 'Avklar tid og betaling: hvor mye tid de vil bruke, hosting, og om de vil betale over tid eller med en gang. Når vil de starte?' },
      { text: 'Bekreft at media, logo, bilder og lenker blir sendt' },
    ],
  },
  {
    title: 'Pris',
    lines: [
      { text: 'Oppsummer samtalen og painpoints' },
      { text: 'Sammenlign med andre aktører i bransjen (kvalitet og kost)' },
      { text: 'Si prisen:', quote: 'Så en investering fra deres side, med [funksjonalitet], hadde vært [sum]. Hva synes du om dette tallet?' },
      { text: 'Håndter innvendinger' },
    ],
  },
  {
    title: 'Signatur',
    goal: 'mål: signert avtale',
    lines: [
      { quote: 'For å starte prosjektet trenger vi en signatur som lar oss sette i gang. Den dekker tjenesten deres, prisen og forventet leveringstid, og dere betaler ikke noe før prosjektet er levert.' },
      { text: 'Signerer de nå: gå videre til steg 5' },
      { text: 'Vil de ha tilbud på e-post: send tilbud med kontraktkopi innen 2 timer, og avtal et telefonmøte innen 48 timer for å få signaturen' },
    ],
  },
  {
    title: 'Neste steg',
    lines: [
      { text: 'En kollega tar workshop med kunden:', quote: 'Før workshopen kan dere tenke gjennom hva dere ellers ønsker på nettsiden, utover det vi allerede har snakket om. Så tar [kollega] workshop med dere.' },
    ],
  },
];

export function MeetingNotesModal({
  businessName,
  quote,
  workshopAction,
  saving,
  embedded = false,
  onClose,
  onPersist,
  onPersistWorkshop,
  onContinue,
  onFlushReady,
}: Props) {
  const [state, setState] = useState<MeetingQuoteState>(() => normalizeMeetingQuote(quote || emptyMeetingQuote()));
  const [workshop, setWorkshop] = useState<WorkshopDraft>(() => workshopDraftFromAction(workshopAction));
  const persistRef = useRef(onPersist);
  persistRef.current = onPersist;
  const persistWorkshopRef = useRef(onPersistWorkshop);
  persistWorkshopRef.current = onPersistWorkshop;
  const skipFirst = useRef(true);
  const skipFirstWorkshop = useRef(true);

  function workshopPayload() {
    const format = workshopUiFormat(workshop.format);
    return {
      name: workshop.name.trim() || 'Workshop',
      format,
      dueAt: datetimeLocalOsloToIso(workshop.dueAt),
      addToCalendar: format === 'mote' ? true : workshop.addToCalendar,
    };
  }

  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      const startDate = offerStartDateFromWorkshopDueAt(datetimeLocalOsloToIso(workshop.dueAt));
      void Promise.resolve(persistRef.current({ meetingQuote: { ...state, startDate } }))
        .catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [state, workshop.dueAt]);

  useEffect(() => {
    if (skipFirstWorkshop.current) {
      skipFirstWorkshop.current = false;
      return;
    }
    if (!persistWorkshopRef.current) return;
    const timer = window.setTimeout(() => {
      void Promise.resolve(persistWorkshopRef.current?.({ workshopAction: workshopPayload() }))
        .catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [workshop]);

  const pkg = useMemo(() => activeMeetingQuotePackage(state), [state]);
  const selected = useMemo(() => new Set<string>(pkg.selected), [pkg.selected]);
  const oneTimeAddOns = useMemo(() => new Set<string>(pkg.oneTimeAddOns), [pkg.oneTimeAddOns]);
  const hostForcesOneTime = oneTimeAddOns.has('thirdpartyhost');
  const priced = hostForcesOneTime ? { ...pkg, oneTime: true } : pkg;
  const monthly = quotedMonthly(priced);
  const setup = setupCost(priced);
  const capped = cappedOneTimeCharge(priced);
  const total = grandTotal(priced);
  const tier = getTier(pkg.customMode ? 'custom' : pkg.tierId);
  const activeIndex = activeMeetingQuoteIndex(state);
  const hasAlt = hasAltMeetingQuote(state);

  function patchPackage(patch: Partial<typeof pkg>) {
    setState((prev) => withActiveMeetingQuotePackage(prev, patch));
  }

  function setSelected(next: Set<string>) {
    patchPackage({ selected: [...next] });
  }

  function applyNamed(tierId: string) {
    const pages = getTier(tierId).pages || 5;
    patchPackage({
      tierId,
      customMode: false,
      selected: presetIds(tierId),
      pages,
    });
  }

  function applyCustom() {
    patchPackage({
      tierId: 'custom',
      customMode: true,
      selected: customBaselineIds(),
    });
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
    patchPackage({
      oneTimeAddOns: [...next],
      oneTime: hostOn ? true : pkg.oneTime,
    });
  }

  function quoteToSave() {
    const startDate = offerStartDateFromWorkshopDueAt(datetimeLocalOsloToIso(workshop.dueAt));
    const forced = hostForcesOneTime
      ? withActiveMeetingQuotePackage(state, { oneTime: true })
      : state;
    return { ...forced, startDate };
  }

  async function persistWorkshopNow() {
    if (!persistWorkshopRef.current) return;
    await Promise.resolve(persistWorkshopRef.current({ workshopAction: workshopPayload() }));
  }

  useEffect(() => {
    onFlushReady?.(() => Promise.resolve(persistRef.current({ meetingQuote: quoteToSave() }))
      .then(() => persistWorkshopNow())
      .then(() => undefined));
  });

  function continueToOffer() {
    void Promise.resolve(persistRef.current({ meetingQuote: quoteToSave() }))
      .then(() => persistWorkshopNow())
      .then(() => onContinue());
  }

  const includedPages = includedPagesFor(pkg.tierId, pkg.customMode);

  function extraPages() {
    return Math.max(0, pkg.pages - includedPages);
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
        <div className="grid grid-rows-2 lg:grid-rows-1 lg:grid-cols-2 min-h-0 flex-1 overflow-hidden">
          <div className="overflow-y-auto p-3 sm:p-5 space-y-4 text-sm text-[#374151] min-h-0">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setState((prev) => ({ ...prev, activeOfferIndex: 0 }))}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                  activeIndex === 0 ? 'bg-[#FF5B00] text-white' : 'bg-[#F3F4F6] text-[#111827] hover:bg-[#E5E7EB]'
                }`}
              >
                Tilbud 1
              </button>
              {hasAlt ? (
                <>
                  <button
                    type="button"
                    onClick={() => setState((prev) => ({ ...prev, activeOfferIndex: 1 }))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium ${
                      activeIndex === 1 ? 'bg-[#FF5B00] text-white' : 'bg-[#F3F4F6] text-[#111827] hover:bg-[#E5E7EB]'
                    }`}
                  >
                    Tilbud 2
                  </button>
                  <button
                    type="button"
                    onClick={() => setState((prev) => removeAltMeetingQuote(prev))}
                    className="p-1.5 rounded-lg bg-[#F3F4F6] text-[#111827] hover:bg-[#E5E7EB]"
                    aria-label="Fjern tilbud 2"
                  >
                    <Minus size={14} />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setState((prev) => addAltMeetingQuote(prev))}
                  className="p-1.5 rounded-lg bg-[#F3F4F6] text-[#111827] hover:bg-[#E5E7EB]"
                  aria-label="Legg til tilbud 2"
                >
                  <Plus size={14} />
                </button>
              )}
            </div>
            <label className="block">
              <span className="text-xs text-[#6B7280]">Antall sider</span>
              <input
                type="number"
                min={1}
                value={pkg.pages}
                onChange={(e) => patchPackage({ pages: Math.max(1, Number(e.target.value) || 1) })}
                className="mt-1 w-24 px-3 py-2 rounded-lg bg-white border border-[#E5E7EB] text-[#111827]"
              />
              <span className="ml-2 text-xs text-[#6B7280]">
                {includedPages} inkludert i {pkg.customMode ? 'skreddersydd' : getTier(pkg.tierId).label}.
                {extraPages() > 0 ? ` ${extraPages()} ekstra.` : ' Ingen ekstra.'}
              </span>
            </label>

            <div>
              <div className="text-xs text-[#6B7280] mb-2">Pakke</div>
              <div className="space-y-1.5">
                {PRICING.tiers.map((entry) => {
                  const totalForTier = entry.id === 'custom'
                    ? quotedMonthly({ ...pkg, customMode: true, tierId: 'custom', selected: pkg.customMode ? pkg.selected : customBaselineIds() })
                    : namedPackageMonthly(entry.id, pkg.pages);
                  const checked = entry.id === 'custom' ? pkg.customMode : (!pkg.customMode && pkg.tierId === entry.id);
                  return (
                    <label key={entry.id} className="flex items-start gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name={`meeting-tier-${activeIndex}`}
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
                checked={pkg.oneTime || hostForcesOneTime}
                onChange={(e) => patchPackage({
                  oneTime: hostForcesOneTime ? true : e.target.checked,
                })}
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
                    const inPackage = packageService(pkg, item.id);
                    const p = adjustedPrice(item, pkg.pages, pkg.tierId, pkg.customMode);
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
                {priced.oneTime ? `Engangssum (${tier.label}, ${pkg.pages} sider)` : `Månedlig (${tier.label}, ${pkg.pages} sider)`}
              </div>
              <div className="text-2xl font-semibold text-[#111827] mt-1">
                {priced.oneTime ? fmtKr(total) : `${fmtKr(monthly)} / mnd`}
              </div>
              <div className="text-xs text-[#6B7280] mt-1">
                {priced.oneTime
                  ? `= ${fmtKr(monthly)}/mnd × ${PRICING.oneTimeMultiplier}${capped ? ` + ${fmtKr(capped)} ubegrenset 6 mnd` : ''}${setup ? ` + ${fmtKr(setup)} oppsett` : ''}`
                  : `${pkg.customMode ? 'Egne tjenester' : `Pakke ${fmtKr(PRICING.packagePrices[pkg.tierId] || 0)}`}${setup ? ` + ${fmtKr(setup)} engangs` : ''}`}
              </div>
            </div>
          </div>

          <aside className="border-t lg:border-t-0 lg:border-l border-[#E6E9EF] bg-[#F8F9FB] flex flex-col min-h-0">
            <div className="px-4 py-3 border-b border-[#E6E9EF]">
              <h4 className="font-medium text-[#111827]">Spørsmål til møte</h4>
            </div>
            <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-4">
              <ol className="space-y-4">
                {SALES_MEETING_SCRIPT.map((stage, index) => (
                  <li key={stage.title}>
                    <h5 className="text-sm font-semibold text-[#111827]">
                      {index + 1}. {stage.title}
                      {stage.goal ? (
                        <span className="font-normal text-[#6B7280]"> ({stage.goal})</span>
                      ) : null}
                    </h5>
                    <ul className="mt-1.5 list-disc space-y-1.5 pl-4 text-[13px] leading-snug text-[#374151]">
                      {stage.lines.map((line, lineIndex) => (
                        <li key={`${stage.title}-${lineIndex}`}>
                          {line.text ? <span>{line.text}{line.quote ? ' ' : ''}</span> : null}
                          {line.quote ? <span className="text-[#111827]">«{line.quote}»</span> : null}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ol>
              <div className="rounded-xl border border-[#E6E9EF] bg-white p-3 space-y-3">
                <div className="text-xs font-medium text-[#111827]">Workshop-handling</div>
                <label className="block">
                  <span className="text-xs text-[#6B7280]">Navn</span>
                  <input
                    type="text"
                    value={workshop.name}
                    onChange={(e) => setWorkshop((prev) => ({ ...prev, name: e.target.value }))}
                    className="mt-1 w-full px-3 py-2 rounded-lg bg-white border border-[#E5E7EB] text-sm text-[#111827]"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-[#6B7280]">Tid</span>
                  <input
                    type="datetime-local"
                    value={workshop.dueAt}
                    onChange={(e) => setWorkshop((prev) => ({ ...prev, dueAt: e.target.value }))}
                    className="mt-1 w-full px-3 py-2 rounded-lg bg-white border border-[#E5E7EB] text-sm text-[#111827]"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="min-w-0 flex-1">
                    <span className="text-xs text-[#6B7280]">Format</span>
                    <select
                      value={workshop.format}
                      onChange={(e) => {
                        const format = workshopUiFormat(e.target.value);
                        setWorkshop((prev) => ({
                          ...prev,
                          format,
                          addToCalendar: format === 'mote' ? true : prev.addToCalendar,
                        }));
                      }}
                      className="mt-1 w-full px-3 py-2 rounded-lg bg-white border border-[#E5E7EB] text-sm text-[#111827]"
                    >
                      {WORKSHOP_FORMATS.map((format) => (
                        <option key={format} value={format}>
                          {format === 'mote' ? 'Møte' : format === 'sms' ? 'SMS' : format === 'ring' ? 'Ring' : 'SMS/ring'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span title="30 min i Google Kalender hos Damian" className="mt-5 shrink-0 text-[#6B7280]">
                    <CalendarDays size={15} />
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-label="30 min i Google Kalender"
                    aria-checked={workshop.format === 'mote' ? true : workshop.addToCalendar}
                    disabled={workshop.format === 'mote'}
                    onClick={() => setWorkshop((prev) => ({ ...prev, addToCalendar: !prev.addToCalendar }))}
                    className={`mt-5 relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-70 ${
                      (workshop.format === 'mote' ? true : workshop.addToCalendar) ? 'bg-[#FF5B00]' : 'bg-[#D1D5DB]'
                    }`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                      (workshop.format === 'mote' ? true : workshop.addToCalendar) ? 'ml-4' : 'ml-1'
                    }`} />
                  </button>
                </div>
                <p className="text-[11px] text-[#6B7280]">
                  Møte er alltid online, 30 minutter. Admin sender bekreftelse, Meet og Fireflies.
                  SMS, ring og SMS/ring inviterer ikke kunden.
                </p>
              </div>
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
            {!embedded && (
            <div className="p-4 border-t border-[#E6E9EF] bg-white">
              <button
                type="button"
                disabled={saving}
                onClick={continueToOffer}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-[#FF5B00] text-white font-medium hover:bg-[#e55200] disabled:opacity-50"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : null}
                Gå til tilbud
              </button>
            </div>
            )}
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
