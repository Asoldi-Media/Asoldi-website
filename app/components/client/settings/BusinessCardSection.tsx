import React, { useState } from 'react';
import { Edit } from 'lucide-react';
import type { ClientDataBank } from './clientDataTypes';
import { DomainSetupOverlay } from './DomainSetupOverlay';

type Field = 'name' | 'industry' | 'goal';

type Props = {
  token: string;
  clientData: ClientDataBank;
  setClientData: React.Dispatch<React.SetStateAction<ClientDataBank>>;
  onError: (message: string) => void;
  onSaved?: (profile?: unknown) => void;
};

export function BusinessCardSection({ token, clientData, setClientData, onError, onSaved }: Props) {
  const [editing, setEditing] = useState<Field | null>(null);
  const [domainOpen, setDomainOpen] = useState(false);
  const card = clientData.businessCard;
  const domain = String(clientData.domainSetup?.domain || clientData.websiteCreatorQuestions.websiteDomain || '').trim();
  const status = String(clientData.domainSetup?.status || '').trim();
  const statusLabel = status === 'help-requested'
    ? 'Forespørsel sendt til Asoldi'
    : status === 'waiting-purchase'
      ? 'Venter til domenet er kjøpt'
      : status === 'nameservers-submitted'
        ? 'Navnservere er bekreftet'
        : '';

  function setField(field: Field, value: string) {
    setClientData((prev) => {
      if (field === 'name') {
        return {
          ...prev,
          businessCard: { ...prev.businessCard, companyName: value },
          generalInfo: { ...prev.generalInfo, companyName: value },
        };
      }
      if (field === 'industry') {
        return { ...prev, businessCard: { ...prev.businessCard, industry: value } };
      }
      return { ...prev, businessCard: { ...prev.businessCard, websiteGoal: value } };
    });
  }

  return (
    <div className="max-w-4xl w-full">
      <h3 className="text-[20px] font-semibold text-[#121212] mb-6">Bedrifts kort</h3>
      <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm flex flex-col gap-5">
        <div className="flex flex-col gap-1 border-b border-gray-100 pb-4">
          <span className="text-[12px] font-medium text-gray-500 uppercase tracking-wider">Domene</span>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[15px] text-[#121212] font-medium truncate">
              {domain || <span className="text-gray-400 font-normal">Ikke satt opp</span>}
            </span>
            <button
              type="button"
              onClick={() => setDomainOpen(true)}
              className="shrink-0 bg-[#FF5B00] text-white px-4 py-2 rounded-full text-[13px] font-semibold hover:bg-[#e05000]"
            >
              {domain ? 'Endre domene' : 'Sett opp domene'}
            </button>
          </div>
          {statusLabel ? <p className="text-xs text-gray-500">{statusLabel}</p> : null}
        </div>
        <InlineRow
          label="Bedriftsnavn"
          editing={editing === 'name'}
          onEdit={() => setEditing('name')}
        >
          {editing === 'name' ? (
            <input
              autoFocus
              type="text"
              value={card.companyName}
              onChange={(e) => setField('name', e.target.value)}
              onBlur={() => setEditing(null)}
              onKeyDown={(e) => e.key === 'Enter' && setEditing(null)}
              className="text-[15px] text-[#121212] font-medium bg-transparent border-b border-[#FF5B00] outline-none w-full mr-4 px-1"
            />
          ) : (
            <span className="text-[15px] text-[#121212] font-medium w-full py-0.5">
              {card.companyName || '—'}
            </span>
          )}
        </InlineRow>
        <InlineRow
          label="Bransje"
          editing={editing === 'industry'}
          onEdit={() => setEditing('industry')}
        >
          {editing === 'industry' ? (
            <input
              autoFocus
              type="text"
              value={card.industry}
              onChange={(e) => setField('industry', e.target.value)}
              onBlur={() => setEditing(null)}
              onKeyDown={(e) => e.key === 'Enter' && setEditing(null)}
              className="text-[15px] text-[#121212] font-medium bg-transparent border-b border-[#FF5B00] outline-none w-full mr-4 px-1"
            />
          ) : (
            <span className="text-[15px] text-[#121212] font-medium w-full py-0.5">
              {card.industry || '—'}
            </span>
          )}
        </InlineRow>
        <InlineRow
          label="Nettsidens mål"
          editing={editing === 'goal'}
          onEdit={() => setEditing('goal')}
          multiline
        >
          {editing === 'goal' ? (
            <textarea
              autoFocus
              value={card.websiteGoal}
              onChange={(e) => setField('goal', e.target.value)}
              onBlur={() => setEditing(null)}
              className="text-[15px] text-[#121212] leading-relaxed bg-transparent border-b border-[#FF5B00] outline-none w-full mr-4 px-1 resize-none min-h-[60px]"
            />
          ) : (
            <span className="text-[15px] text-[#121212] leading-relaxed w-full py-0.5 min-h-[60px]">
              {card.websiteGoal || '—'}
            </span>
          )}
        </InlineRow>
      </div>
      {domainOpen ? (
        <DomainSetupOverlay
          token={token}
          clientData={clientData}
          setClientData={setClientData}
          onClose={() => setDomainOpen(false)}
          onError={onError}
          onSaved={onSaved}
        />
      ) : null}
    </div>
  );
}

function InlineRow({
  label,
  children,
  editing,
  onEdit,
  multiline = false,
}: {
  label: string;
  children: React.ReactNode;
  editing: boolean;
  onEdit: () => void;
  multiline?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-gray-100 pb-4 last:border-b-0 last:pb-0">
      <span className="text-[12px] font-medium text-gray-500 uppercase tracking-wider">{label}</span>
      <div className={`flex ${multiline ? 'items-start' : 'items-center'} justify-between group`}>
        {children}
        {editing ? null : (
          <button type="button" onClick={onEdit} className="shrink-0 mt-1" aria-label={`Rediger ${label}`}>
            <Edit className="w-4 h-4 text-gray-300 hover:text-gray-500" />
          </button>
        )}
      </div>
    </div>
  );
}
