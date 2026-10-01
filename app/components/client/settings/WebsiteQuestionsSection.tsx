import React from 'react';
import type { ClientDataBank } from './clientDataTypes';

type Props = {
  clientData: ClientDataBank;
  setClientData: React.Dispatch<React.SetStateAction<ClientDataBank>>;
};

function setQuestion(
  setClientData: Props['setClientData'],
  patch: Partial<ClientDataBank['websiteCreatorQuestions']>
) {
  setClientData((prev) => ({
    ...prev,
    websiteCreatorQuestions: { ...prev.websiteCreatorQuestions, ...patch },
  }));
}

export function WebsiteQuestionsSection({ clientData, setClientData }: Props) {
  const q = clientData.websiteCreatorQuestions;
  return (
    <div className="max-w-4xl w-full pb-20">
      <h3 className="text-[20px] font-semibold text-[#121212] mb-2">Nettsidebygger v2-spørsmål</h3>
      <p className="text-sm text-gray-500 mb-6">
        Spørsmål som bare brukes når nettsiden bygges. Adresse, språk, telefon, e-post, by, land og nettadresse ligger under Generell info.
      </p>
      <div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm grid gap-4 md:grid-cols-2">
        <Field label="Målgruppe">
          <input value={q.targetAudience} onChange={(e) => setQuestion(setClientData, { targetAudience: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Kjernebudskap">
          <input value={q.keyMessage} onChange={(e) => setQuestion(setClientData, { keyMessage: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Tone og stil">
          <input value={q.toneOfVoice} onChange={(e) => setQuestion(setClientData, { toneOfVoice: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Hva bedriften gjør" wide>
          <textarea rows={3} value={q.businessWhat} onChange={(e) => setQuestion(setClientData, { businessWhat: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Bedriftshistorie" wide>
          <textarea rows={3} value={q.businessStory} onChange={(e) => setQuestion(setClientData, { businessStory: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Hva som skiller dere" wide>
          <textarea rows={3} value={q.differentiator} onChange={(e) => setQuestion(setClientData, { differentiator: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Hovedhandling (CTA)" wide>
          <textarea
            rows={3}
            value={q.mainCtaText || q.primaryAction}
            onChange={(e) => setQuestion(setClientData, { mainCtaText: e.target.value, primaryAction: e.target.value })}
            placeholder="F.eks. bestill bord, be om tilbud, handle i nettbutikken"
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-[#9CA3AF]">Brukes som etikett i analyse.</span>
        </Field>
        <Field label="Hoved-CTA-side (valgfri URL)" wide>
          <input
            value={q.mainCtaUrl}
            onChange={(e) => setQuestion(setClientData, { mainCtaUrl: e.target.value })}
            placeholder="/bestill eller https://kunde.no/booking"
            className={inputClass}
          />
        </Field>
        <Field label="Viktige nøkkelord (kommaseparert)" wide>
          <input
            value={q.importantKeywords.join(', ')}
            onChange={(e) => setQuestion(setClientData, {
              importantKeywords: e.target.value.split(',').map((word) => word.trim()).filter(Boolean),
            })}
            className={inputClass}
          />
        </Field>
        <Field label="Konkurrentlenker (kommaseparert)" wide>
          <input
            value={q.competitorLinks.join(', ')}
            onChange={(e) => setQuestion(setClientData, {
              competitorLinks: e.target.value.split(',').map((word) => word.trim()).filter(Boolean),
            })}
            className={inputClass}
          />
        </Field>
        <Field label="Anmeldelser" wide>
          <textarea rows={4} value={q.reviews} onChange={(e) => setQuestion(setClientData, { reviews: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Ekstra kontekst til AI" wide>
          <textarea rows={3} value={q.extraContext} onChange={(e) => setQuestion(setClientData, { extraContext: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Ønskede sider">
          <textarea rows={2} value={q.wantedPages} onChange={(e) => setQuestion(setClientData, { wantedPages: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Egne seksjoner">
          <textarea rows={2} value={q.customSections} onChange={(e) => setQuestion(setClientData, { customSections: e.target.value })} className={inputClass} />
        </Field>
        <Field label="Relevante lenker" wide>
          <textarea rows={3} value={q.relevantLinks} onChange={(e) => setQuestion(setClientData, { relevantLinks: e.target.value })} className={inputClass} />
        </Field>
      </div>
    </div>
  );
}

const inputClass = 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-[#FF5B00]';

function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`text-sm ${wide ? 'md:col-span-2' : ''}`}>
      <span className="block text-[12px] font-medium text-gray-500 uppercase tracking-wider mb-1">{label}</span>
      {children}
    </label>
  );
}
