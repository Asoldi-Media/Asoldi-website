import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Loader2, X } from 'lucide-react';
import type { ClientDataBank, DomainSetup } from './clientDataTypes';
import {
  DOMAIN_HELP_BUY,
  DOMAIN_HELP_OWNED,
  HOSTINGER_NAMESERVERS,
  emptyDomainSetup,
  isValidDomainName,
  normalizeDomainInput,
} from '../../../../lib/domain-setup.js';

type Step = 'enter' | 'ownership' | 'buy' | 'nameservers';
type OwnershipPick = '' | 'owned' | 'buy';

type Props = {
  token: string;
  clientData: ClientDataBank;
  setClientData: React.Dispatch<React.SetStateAction<ClientDataBank>>;
  onClose: () => void;
  onError: (message: string) => void;
  onSaved?: (profile?: unknown) => void;
};

const CONTENT = 'w-full max-w-[720px] mx-auto px-4';

function cardClass(selected: boolean) {
  return [
    'text-left w-full bg-white rounded-xl p-4 transition-[border-color,box-shadow] duration-150',
    selected
      ? 'border border-[#FF5B00] shadow-[0_0_0_1px_#FF5B00,0_10px_24px_rgba(255,91,0,0.12)]'
      : 'border border-gray-200 hover:border-[#FF5B00]',
  ].join(' ');
}

export function DomainSetupOverlay({ token, clientData, setClientData, onClose, onError, onSaved }: Props) {
  const existing: DomainSetup = {
    ...emptyDomainSetup(),
    ...(clientData.domainSetup || {}),
    ownership: clientData.domainSetup?.ownership === 'owned' || clientData.domainSetup?.ownership === 'buy'
      ? clientData.domainSetup.ownership
      : '',
  };
  const [step, setStep] = useState<Step>('enter');
  const [draft, setDraft] = useState(existing.domain || clientData.websiteCreatorQuestions.websiteDomain || '');
  const [pickedOwnership, setPickedOwnership] = useState<OwnershipPick>(existing.ownership || '');
  const [helpBuy, setHelpBuy] = useState(Boolean(existing.helpBuy));
  const [helpNameservers, setHelpNameservers] = useState(Boolean(existing.helpNameservers));
  const [nameserversConfirmed, setNameserversConfirmed] = useState(Boolean(existing.nameserversConfirmed));
  const [busy, setBusy] = useState('');
  const [localError, setLocalError] = useState('');

  const domain = normalizeDomainInput(draft);
  const valid = isValidDomainName(domain);

  const setupPatch = useMemo((): DomainSetup => ({
    ...existing,
    domain,
    ownership: pickedOwnership || existing.ownership,
    helpBuy,
    helpNameservers,
    nameserversConfirmed,
    updatedAt: new Date().toISOString(),
  }), [domain, existing, helpBuy, helpNameservers, nameserversConfirmed, pickedOwnership]);

  async function persist(nextBank: ClientDataBank) {
    const response = await fetch('/api/client/settings/client-data', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ clientDataBank: nextBank }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'Kunne ikke lagre domenet.');
    if (payload.clientDataBank) {
      setClientData((prev) => ({ ...prev, ...payload.clientDataBank }));
    } else {
      setClientData(nextBank);
    }
    onSaved?.(payload.profile);
    return payload;
  }

  function applyLocal(patch: Partial<DomainSetup>, ownership?: DomainSetup['ownership'], extra: Partial<ClientDataBank> = {}) {
    const nextOwnership: DomainSetup['ownership'] = ownership
      || patch.ownership
      || pickedOwnership
      || existing.ownership
      || '';
    const nextSetup: DomainSetup = { ...setupPatch, ...patch, ownership: nextOwnership };
    const nextBank: ClientDataBank = {
      ...clientData,
      ...extra,
      websiteCreatorQuestions: {
        ...clientData.websiteCreatorQuestions,
        websiteDomain: nextSetup.domain || clientData.websiteCreatorQuestions.websiteDomain,
      },
      domainSetup: nextSetup,
    };
    setClientData(nextBank);
    return nextBank;
  }

  async function sendHelp(kind: typeof DOMAIN_HELP_OWNED | typeof DOMAIN_HELP_BUY) {
    setBusy('help');
    setLocalError('');
    try {
      const response = await fetch('/api/client/domain-help', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ kind, domain }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke sende forespørselen.');
      if (payload.clientDataBank) {
        setClientData((prev) => ({ ...prev, ...payload.clientDataBank }));
      } else {
        const nextBank = applyLocal({
          status: 'help-requested',
          requestKind: kind,
          requestSentAt: new Date().toISOString(),
          ownership: kind === DOMAIN_HELP_OWNED ? 'owned' : 'buy',
        }, kind === DOMAIN_HELP_OWNED ? 'owned' : 'buy');
        await persist(nextBank);
      }
      onSaved?.(payload.profile);
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Kunne ikke sende forespørselen.';
      setLocalError(message);
      onError(message);
    } finally {
      setBusy('');
    }
  }

  async function finishOwned() {
    setBusy('save');
    try {
      const nextBank = applyLocal({
        status: 'nameservers-submitted',
        ownership: 'owned',
        nameserversConfirmed: true,
      }, 'owned');
      await persist(nextBank);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Kunne ikke lagre domenet.');
    } finally {
      setBusy('');
    }
  }

  async function finishBuyWithoutHelp() {
    setBusy('save');
    try {
      const nextBank = applyLocal({
        status: 'waiting-purchase',
        ownership: 'buy',
        helpBuy: false,
      }, 'buy');
      await persist(nextBank);
      onClose();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Kunne ikke lagre.');
    } finally {
      setBusy('');
    }
  }

  const canNameserverNext = helpNameservers || nameserversConfirmed;
  const canFooterNext = (
    (step === 'enter' && valid)
    || (step === 'ownership' && Boolean(pickedOwnership))
    || step === 'buy'
    || (step === 'nameservers' && canNameserverNext)
  ) && !busy;

  function onFooterNext() {
    if (step === 'enter' && valid) setStep('ownership');
    else if (step === 'ownership' && pickedOwnership === 'owned') setStep('nameservers');
    else if (step === 'ownership' && pickedOwnership === 'buy') setStep('buy');
    else if (step === 'buy') void (helpBuy ? sendHelp(DOMAIN_HELP_BUY) : finishBuyWithoutHelp());
    else if (step === 'nameservers') void (helpNameservers ? sendHelp(DOMAIN_HELP_OWNED) : finishOwned());
  }

  const footerLabel = step === 'buy'
    ? (helpBuy ? 'Send forespørsel til Asoldi' : 'Avslutt domene oppsett')
    : step === 'nameservers' && helpNameservers
      ? 'Send forespørsel'
      : 'Neste';

  return createPortal(
    <div className="fixed inset-0 z-[200] bg-[#F4F5F7] text-[#111827] flex flex-col">
      <div className="h-16 px-4 md:px-8 flex items-center justify-between shrink-0">
        <button
          type="button"
          onClick={() => {
            if (step === 'enter') onClose();
            else if (step === 'ownership') setStep('enter');
            else setStep('ownership');
          }}
          className="inline-flex items-center gap-2 text-sm text-[#374151] hover:text-[#111827]"
        >
          <ArrowLeft className="w-4 h-4" /> Tilbake
        </button>
        <img src="/media/Untitled-1.png" alt="Asoldi" className="h-8 w-auto" />
        <button type="button" onClick={onClose} className="p-2 rounded-full hover:bg-white" aria-label="Lukk">
          <X className="w-5 h-5 text-[#6B7280]" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto pb-6">
        <div className={`${CONTENT} pt-6 md:pt-10`}>
          {step === 'enter' ? (
            <>
              <h1 className="text-center text-[28px] md:text-[34px] font-semibold text-[#111827] leading-tight">
                Hvilket domene vil du bruke?
              </h1>
              <p className="text-center text-sm text-[#6B7280] mt-3">
                Skriv inn domenet nettsiden skal ligge på. Vi bruker ikke midlertidig domene.
              </p>
              <label className="mt-8 flex items-center gap-2.5 h-10 bg-white border border-[#E5E7EB] rounded-lg px-3 shadow-[0_1px_2px_rgba(16,24,40,0.04)] focus-within:border-[#FF5B00] focus-within:shadow-[0_0_0_3px_rgba(255,91,0,0.12)]">
                {valid ? (
                  <span className="w-[18px] h-[18px] rounded-full bg-emerald-500 text-white inline-flex items-center justify-center shrink-0">
                    <Check className="w-2.5 h-2.5" strokeWidth={3} />
                  </span>
                ) : (
                  <span className="w-[18px] h-[18px] rounded-full border border-[#D1D5DB] shrink-0" />
                )}
                <input
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && valid) setStep('ownership');
                  }}
                  placeholder="Skriv inn domenet du vil bruke"
                  className="flex-1 min-w-0 h-full text-[13.5px] leading-none text-[#111827] caret-[#111827] placeholder:text-[#9CA3AF] outline-none bg-transparent"
                />
              </label>
              <div className="mt-7 rounded-xl border border-[#E5E7EB] bg-white overflow-hidden shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                <div className="h-9 bg-[#EEF0F3] flex items-center px-3 gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-[#FF5B5B]" />
                  <span className="w-2 h-2 rounded-full bg-[#FFB020]" />
                  <span className="w-2 h-2 rounded-full bg-[#2EC45A]" />
                  <span className="ml-3 flex-1 h-5 rounded-md bg-white text-[11px] text-[#6B7280] flex items-center px-2.5 truncate">
                    {valid ? domain : 'ditt-domene.no'}
                  </span>
                </div>
                <div className="h-[200px] bg-[#F8F9FB] flex flex-col items-center justify-center">
                  <img src="/media/Untitled-1.png" alt="" className="h-10 w-auto mb-3" />
                  <p className="text-sm text-[#9CA3AF]">Nettsiden vises her når domenet er klart</p>
                </div>
              </div>
            </>
          ) : null}

          {step === 'ownership' ? (
            <>
              <h1 className="text-center text-[28px] md:text-[34px] font-semibold text-[#111827] leading-tight">
                Eier du {domain}?
              </h1>
              <p className="text-center text-sm text-[#6B7280] mt-3 mb-8">
                Velg det som passer, og trykk Neste.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <button
                  type="button"
                  aria-pressed={pickedOwnership === 'owned'}
                  onClick={() => setPickedOwnership('owned')}
                  className={cardClass(pickedOwnership === 'owned')}
                >
                  <OwnDomainIllustration />
                  <p className="font-semibold text-[#111827] mt-3">Jeg eier dette domenet</p>
                  <p className="text-sm text-[#6B7280] mt-1">Jeg peker det mot Asoldi hos leverandøren min.</p>
                </button>
                <button
                  type="button"
                  aria-pressed={pickedOwnership === 'buy'}
                  onClick={() => setPickedOwnership('buy')}
                  className={cardClass(pickedOwnership === 'buy')}
                >
                  <BuyDomainIllustration />
                  <p className="font-semibold text-[#111827] mt-3">Jeg må kjøpe domenet først</p>
                  <p className="text-sm text-[#6B7280] mt-1">Jeg har ikke kjøpt det enda.</p>
                </button>
              </div>
            </>
          ) : null}

          {step === 'buy' ? (
            <>
              <h1 className="text-center text-[28px] md:text-[34px] font-semibold text-[#111827] leading-tight">
                Etter at du har kjøpt domenet kan du komme tilbake med det
              </h1>
              <div className="mt-8 rounded-xl border border-[#E5E7EB] bg-white overflow-hidden shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                <div className="h-[200px] bg-[#F8F9FB] flex flex-col items-center justify-center px-6">
                  <BuyDomainIllustration />
                  <p className="text-sm text-[#9CA3AF] mt-4 text-center">Kjøp {domain} hos en registrar, og kom tilbake hit.</p>
                </div>
              </div>
              <label className="mt-6 flex items-start gap-3 bg-white border border-[#E5E7EB] rounded-xl p-4 cursor-pointer">
                <input type="checkbox" checked={helpBuy} onChange={(event) => setHelpBuy(event.target.checked)} className="mt-1" />
                <span>
                  <span className="block font-medium text-[#111827]">Få hjelp med å kjøpe domene</span>
                  <span className="block text-sm text-[#6B7280] mt-0.5">Asoldi tar kontakt og hjelper deg gjennom kjøpet.</span>
                </span>
              </label>
            </>
          ) : null}

          {step === 'nameservers' ? (
            <>
              <h1 className="text-center text-[28px] md:text-[34px] font-semibold text-[#111827]">Sett inn navnservere</h1>
              <p className="text-center text-sm text-[#6B7280] mt-3">
                Gå til domeneleverandøren for <span className="font-medium text-[#111827]">{domain}</span> og bytt DNS/navnservere til verdiene under.
              </p>
              <div className="mt-8 bg-white border border-[#E5E7EB] rounded-xl p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                <h2 className="font-semibold text-[#111827]">Nameservers</h2>
                <p className="text-sm text-[#6B7280] mt-1">
                  Navnservere styrer hvor internett finner domenet ditt. Bruk Hostinger sine verdier hos leverandøren.
                </p>
                <div className="mt-4 rounded-lg bg-gray-50 border border-gray-100 px-4 py-3 font-mono text-sm text-[#111827] space-y-1">
                  {HOSTINGER_NAMESERVERS.map((row) => (
                    <p key={row}>{row}</p>
                  ))}
                </div>
              </div>
              <label className="mt-5 flex items-start gap-3 bg-white border border-[#E5E7EB] rounded-xl p-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={helpNameservers}
                  onChange={(event) => {
                    setHelpNameservers(event.target.checked);
                    if (event.target.checked) setNameserversConfirmed(false);
                  }}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium text-[#111827]">Få hjelp med å sette opp navnservere</span>
                  <span className="block text-sm text-[#6B7280] mt-0.5">
                    Da trenger du ikke bekrefte at du har lagt dem inn selv. Asoldi tar kontakt.
                  </span>
                </span>
              </label>
            </>
          ) : null}
        </div>
      </div>

      <div className="shrink-0 border-t border-gray-200 bg-white">
        <div className={`${CONTENT} py-3.5 flex items-center gap-4`}>
          {localError ? <p className="text-sm text-red-600 flex-1 min-w-0">{localError}</p> : null}
          {step === 'nameservers' && !helpNameservers && !localError ? (
            <label className="flex items-center gap-2 flex-1 min-w-0 text-sm text-[#111827] cursor-pointer">
              <input
                type="checkbox"
                checked={nameserversConfirmed}
                onChange={(event) => setNameserversConfirmed(event.target.checked)}
                className="shrink-0"
              />
              <span className="truncate">Jeg har lagt inn navnserverne til {domain}</span>
            </label>
          ) : null}
          {!localError && !(step === 'nameservers' && !helpNameservers) ? <div className="flex-1" /> : null}
          <button
            type="button"
            disabled={!canFooterNext}
            onClick={onFooterNext}
            className="shrink-0 bg-[#111827] text-white px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 inline-flex items-center gap-2"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {footerLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function OwnDomainIllustration() {
  return (
    <div className="h-[118px] rounded-lg bg-gradient-to-b from-[#FFF4EC] to-[#F3F4F6] flex items-center justify-center overflow-hidden">
      <svg viewBox="0 0 180 118" className="w-[180px] h-[118px]" aria-hidden="true">
        <ellipse cx="90" cy="96" rx="46" ry="8" fill="#E5E7EB" />
        <circle cx="90" cy="58" r="34" fill="#FF8A4C" />
        <circle cx="90" cy="58" r="28" fill="#FFF7F2" />
        <ellipse cx="90" cy="58" rx="12" ry="28" fill="none" stroke="#FF5B00" strokeWidth="2" />
        <path d="M62 58h56" stroke="#FF5B00" strokeWidth="2" />
        <path d="M66 44h48M66 72h48" stroke="#FDBA8C" strokeWidth="1.6" />
        <rect x="118" y="22" width="40" height="28" rx="6" fill="white" stroke="#E5E7EB" />
        <rect x="122" y="26" width="32" height="4" rx="2" fill="#F3F4F6" />
        <rect x="122" y="33" width="22" height="3" rx="1.5" fill="#FFD8C2" />
        <rect x="122" y="39" width="16" height="3" rx="1.5" fill="#FFD8C2" />
        <circle cx="122" cy="86" r="12" fill="#10B981" />
        <path d="M116.5 86.2l3.4 3.4 7.6-8" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function BuyDomainIllustration() {
  return (
    <div className="h-[118px] rounded-lg bg-gradient-to-b from-[#FFF4EC] to-[#F3F4F6] flex items-center justify-center overflow-hidden">
      <svg viewBox="0 0 180 118" className="w-[180px] h-[118px]" aria-hidden="true">
        <ellipse cx="90" cy="96" rx="46" ry="8" fill="#E5E7EB" />
        <path d="M62 44h56l6 42H56l6-42z" fill="white" stroke="#E5E7EB" strokeWidth="1.6" />
        <path d="M76 44c0-8 6.2-14 14-14s14 6 14 14" fill="none" stroke="#FF5B00" strokeWidth="2.4" strokeLinecap="round" />
        <rect x="72" y="56" width="36" height="8" rx="4" fill="#FF5B00" />
        <rect x="78" y="70" width="24" height="5" rx="2.5" fill="#FFD8C2" />
        <circle cx="128" cy="38" r="14" fill="#111827" />
        <path d="M128 31v14M121 38h14" stroke="white" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    </div>
  );
}
