import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Loader2, X } from 'lucide-react';
import {
  datetimeLocalOsloToIso,
  groupCalendarEventsByOsloDay,
  isoToDatetimeLocalOslo,
} from '../../../lib/sales-next-actions.js';
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

type WorkshopDraft = {
  name: string;
  format: 'mote' | 'sms-ring';
  dueAt: string;
  addToCalendar: boolean;
};

type WorkshopBusyBlock = {
  start?: string;
  end?: string;
  allDay?: boolean;
  summary?: string;
};

type WorkshopAvailability = {
  connected?: boolean;
  googleEmail?: string;
  message?: string;
  days?: string[];
  timeMin?: string;
  timeMax?: string;
  busy?: WorkshopBusyBlock[];
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
    workshopAction: { name: string; format: 'mote' | 'sms-ring'; dueAt: string; addToCalendar: boolean };
  }) => Promise<void> | void;
  onLoadWorkshopAvailability?: (weekOffset: number) => Promise<WorkshopAvailability>;
  onContinue: () => void;
  onFlushReady?: (flush: () => Promise<void>) => void;
};

function workshopDraftFromAction(action?: Props['workshopAction']): WorkshopDraft {
  const format = action?.format === 'sms-ring' ? 'sms-ring' : 'mote';
  return {
    name: String(action?.name || 'Workshop').trim() || 'Workshop',
    format,
    dueAt: isoToDatetimeLocalOslo(action?.dueAt || ''),
    addToCalendar: format === 'mote' ? true : Boolean(action?.addToCalendar),
  };
}

function formatAvailabilityDay(date = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const [year, month, day] = date.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day, 12)).toLocaleDateString('nb-NO', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function formatBusyRange(start = '', end = '') {
  const from = isoToDatetimeLocalOslo(start);
  const to = isoToDatetimeLocalOslo(end);
  const startTime = from.slice(11, 16);
  const endTime = to.slice(11, 16);
  if (!startTime) return 'Opptatt';
  return endTime ? `Opptatt ${startTime}–${endTime}` : `Opptatt ${startTime}`;
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
  onLoadWorkshopAvailability,
  onContinue,
  onFlushReady,
}: Props) {
  const [state, setState] = useState<MeetingQuoteState>(() => normalizeMeetingQuote(quote || emptyMeetingQuote()));
  const [workshop, setWorkshop] = useState<WorkshopDraft>(() => workshopDraftFromAction(workshopAction));
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  const [availabilitySeen, setAvailabilitySeen] = useState(false);
  const [availabilityOpened, setAvailabilityOpened] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [availability, setAvailability] = useState<WorkshopAvailability | null>(null);
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [availabilityError, setAvailabilityError] = useState('');
  const persistRef = useRef(onPersist);
  persistRef.current = onPersist;
  const persistWorkshopRef = useRef(onPersistWorkshop);
  persistWorkshopRef.current = onPersistWorkshop;
  const skipFirst = useRef(true);
  const skipFirstWorkshop = useRef(true);

  function workshopPayload() {
    const format = workshop.format === 'sms-ring' ? 'sms-ring' : 'mote';
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
      void Promise.resolve(persistRef.current({ meetingQuote: hostForcesOneTime ? { ...state, oneTime: true } : state }))
        .catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(timer);
  }, [state]);

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

  useEffect(() => {
    if (!availabilityOpen || !onLoadWorkshopAvailability) return;
    let cancelled = false;
    setAvailabilityLoading(true);
    setAvailabilityError('');
    void onLoadWorkshopAvailability(weekOffset)
      .then((data) => {
        if (cancelled) return;
        setAvailability(data || null);
      })
      .catch((error) => {
        if (cancelled) return;
        setAvailabilityError(error instanceof Error ? error.message : 'Kunne ikke hente ledig tid.');
      })
      .finally(() => {
        if (!cancelled) setAvailabilityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [availabilityOpen, weekOffset, onLoadWorkshopAvailability]);

  const selected = useMemo(() => new Set<string>(state.selected), [state.selected]);
  const availabilityDays = useMemo(() => (
    groupCalendarEventsByOsloDay(availability?.busy || [], availability?.days || [])
  ), [availability]);
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

  function openAvailability() {
    setAvailabilityOpened(true);
    setAvailabilityOpen(true);
  }

  function closeAvailability() {
    setAvailabilityOpen(false);
    if (availabilityOpened) setAvailabilitySeen(true);
  }

  const timeFormatLocked = !availabilitySeen;

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
        <div className="grid grid-rows-2 lg:grid-rows-1 lg:grid-cols-2 min-h-0 flex-1 overflow-hidden">
          <div className="overflow-y-auto p-3 sm:p-5 space-y-4 text-sm text-[#374151] min-h-0">
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
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={openAvailability}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-xs font-medium hover:bg-[#e55200]"
                  >
                    <CalendarDays size={14} />
                    Finn ledig tid
                  </button>
                  <span className="text-[11px] text-[#6B7280]">
                    {availabilitySeen
                      ? 'Tid og format kan settes. Kalenderen er damian@asoldi.com.'
                      : 'Åpne og lukk Finn ledig tid før du setter tid og format.'}
                  </span>
                </div>
                <label className="block">
                  <span className="text-xs text-[#6B7280]">Tid</span>
                  <input
                    type="datetime-local"
                    value={workshop.dueAt}
                    disabled={timeFormatLocked}
                    onChange={(e) => setWorkshop((prev) => ({ ...prev, dueAt: e.target.value }))}
                    className="mt-1 w-full px-3 py-2 rounded-lg bg-white border border-[#E5E7EB] text-sm text-[#111827] disabled:bg-[#F3F4F6] disabled:text-[#9CA3AF]"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="min-w-0 flex-1">
                    <span className="text-xs text-[#6B7280]">Format</span>
                    <select
                      value={workshop.format}
                      disabled={timeFormatLocked}
                      onChange={(e) => {
                        const format = e.target.value === 'sms-ring' ? 'sms-ring' : 'mote';
                        setWorkshop((prev) => ({
                          ...prev,
                          format,
                          addToCalendar: format === 'mote' ? true : prev.addToCalendar,
                        }));
                      }}
                      className="mt-1 w-full px-3 py-2 rounded-lg bg-white border border-[#E5E7EB] text-sm text-[#111827] disabled:bg-[#F3F4F6] disabled:text-[#9CA3AF]"
                    >
                      <option value="mote">Møte</option>
                      <option value="sms-ring">SMS/ring</option>
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
                  Møte er alltid online, 30 minutter, med Meet og Fireflies på damian@asoldi.com.
                  SMS/ring er 30 minutter hos Damian uten gjester.
                </p>
              </div>
              {availabilityOpen ? (
                <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-3">
                  <div className="w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-2xl bg-white border border-[#E6E9EF] shadow-2xl flex flex-col">
                    <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#E6E9EF]">
                      <div>
                        <h4 className="font-medium text-[#111827]">Finn ledig tid</h4>
                        <p className="text-[11px] text-[#6B7280]">
                          Opptatt-blokker for damian@asoldi.com. Ingen møtetitler.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={closeAvailability}
                        className="p-2 rounded-lg bg-[#F3F4F6] text-[#111827] hover:bg-[#E5E7EB]"
                        aria-label="Lukk"
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <div className="px-4 py-2 border-b border-[#E6E9EF] flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setWeekOffset((prev) => prev - 1)}
                        className="px-3 py-1.5 rounded-lg bg-[#F3F4F6] text-xs text-[#111827]"
                      >
                        Forrige uke
                      </button>
                      <button
                        type="button"
                        onClick={() => setWeekOffset((prev) => prev + 1)}
                        className="px-3 py-1.5 rounded-lg bg-[#F3F4F6] text-xs text-[#111827]"
                      >
                        Neste uke
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto p-4">
                      {availabilityError ? (
                        <p className="text-sm text-red-600">{availabilityError}</p>
                      ) : availabilityLoading ? (
                        <div className="flex items-center gap-2 text-sm text-[#6B7280]">
                          <Loader2 size={16} className="animate-spin" />
                          Henter ledig tid…
                        </div>
                      ) : availability && !availability.connected ? (
                        <p className="text-sm text-[#374151]">
                          {availability.message || 'damian@asoldi.com er ikke koblet til Google Calendar. Selgerens kalender brukes ikke her.'}
                        </p>
                      ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                          {availabilityDays.map((day) => (
                            <div key={day.date} className="rounded-lg border border-[#E6E9EF] bg-[#F8F9FB] p-2 min-h-[7rem]">
                              <div className="text-[11px] font-medium text-[#111827] mb-1.5">
                                {formatAvailabilityDay(day.date)}
                              </div>
                              {day.events.length ? day.events.map((block, index) => (
                                <div
                                  key={`${day.date}-${index}`}
                                  className="mb-1 rounded bg-[#FEE2E2] text-[#991B1B] text-[11px] px-1.5 py-1"
                                >
                                  {formatBusyRange(block.start, block.end)}
                                </div>
                              )) : (
                                <div className="text-[11px] text-[#9CA3AF]">Ledig</div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="p-3 border-t border-[#E6E9EF]">
                      <button
                        type="button"
                        onClick={closeAvailability}
                        className="w-full px-4 py-2 rounded-lg bg-[#111827] text-white text-sm"
                      >
                        Lukk
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
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
