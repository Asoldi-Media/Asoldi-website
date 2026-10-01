import React, { useState } from 'react';
import { Edit } from 'lucide-react';
import type { ClientDataBank } from './clientDataTypes';

type Field = 'name' | 'industry' | 'goal';

type Props = {
  clientData: ClientDataBank;
  setClientData: React.Dispatch<React.SetStateAction<ClientDataBank>>;
};

export function BusinessCardSection({ clientData, setClientData }: Props) {
  const [editing, setEditing] = useState<Field | null>(null);
  const card = clientData.businessCard;

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
        <InlineRow
          label="Bedriftsnavn"
          editing={editing === 'name'}
          onEdit={() => setEditing('name')}
          onDone={() => setEditing(null)}
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
          onDone={() => setEditing(null)}
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
          onDone={() => setEditing(null)}
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
  onDone: () => void;
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
