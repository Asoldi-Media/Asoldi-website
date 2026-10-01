import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, Image as ImageIcon, Plus, Trash2, Upload } from 'lucide-react';
import { GoogleBusinessConnectCard } from '../GoogleBusinessConnectCard';
import type { AffiliationItem, ClientDataBank } from './clientDataTypes';
import { LANGUAGE_OPTIONS, clientMediaSrc, normalizeHex, randomId } from './clientDataTypes';
import { uploadClientMediaFile } from './uploadClientMedia';

type AccordionId = 'Aapningstider' | 'Affiliasjoner' | 'Identitet' | 'Kobling';

type Props = {
  token: string;
  clientData: ClientDataBank;
  setClientData: React.Dispatch<React.SetStateAction<ClientDataBank>>;
  onError: (message: string) => void;
};

export function GeneralInfoSection({ token, clientData, setClientData, onError }: Props) {
  const [open, setOpen] = useState<AccordionId | null>('Identitet');
  const [addressSuggestions, setAddressSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const language = clientData.generalInfo.websiteLanguage;
  const filteredLanguages = LANGUAGE_OPTIONS.filter((option) =>
    option.toLowerCase().includes(language.toLowerCase()) || language === 'Norsk (Norge)'
  );

  useEffect(() => {
    const query = clientData.generalInfo.companyAddress.trim();
    if (query.length < 3) {
      setAddressSuggestions([]);
      return;
    }
    let ignore = false;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`,
          { headers: { 'Accept-Language': 'nb' } }
        );
        const rows = await response.json().catch(() => []);
        if (ignore || !Array.isArray(rows)) return;
        setAddressSuggestions(rows.map((row: any) => String(row?.display_name || '').trim()).filter(Boolean));
        setShowSuggestions(true);
      } catch {
        if (!ignore) setAddressSuggestions([]);
      }
    }, 350);
    return () => {
      ignore = true;
      window.clearTimeout(timeout);
    };
  }, [clientData.generalInfo.companyAddress]);

  async function uploadTo(setter: (url: string) => void, file?: File | null) {
    if (!file) return;
    try {
      setter(await uploadClientMediaFile(token, file));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Kunne ikke laste opp filen.');
    }
  }

  const maker = clientData.makerLink;

  return (
    <div className="max-w-4xl w-full pb-20 flex flex-col gap-4">
      <Accordion
        id="Kobling"
        title="Nettsidebygger-kobling og Google"
        open={open}
        setOpen={setOpen}
        done={Boolean(maker?.bundleId || maker?.publicPreviewUrl)}
      >
        {token ? <GoogleBusinessConnectCard token={token} /> : null}
        {maker?.bundleId || maker?.publicPreviewUrl ? (
          <div className="rounded-xl border border-[#FFE4D4] bg-[#FFF7F2] p-4 text-sm text-[#374151] space-y-1">
            {maker?.bundleName ? <p>Klient: {maker.bundleName}</p> : null}
            {maker?.syncedAt ? <p>Sist synket: {new Date(maker.syncedAt).toLocaleString('nb-NO')}</p> : null}
            {maker?.publicPreviewUrl ? (
              <p>
                Forhåndsvisning:{' '}
                <a href={maker.publicPreviewUrl} target="_blank" rel="noreferrer" className="text-[#FF5B00] underline break-all">
                  {maker.publicPreviewUrl}
                </a>
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-gray-500">Ingen Website Maker-kobling er synket hit ennå.</p>
        )}
      </Accordion>

      <Accordion id="Aapningstider" title="Åpningstider" open={open} setOpen={setOpen} done={clientData.openingHours.days.some((day) => !day.closed)}>
        <label className="text-sm block">
          <span className="block text-[13px] font-medium text-gray-700 mb-2">Google Business Sync-lenke (valgfri)</span>
          <input
            value={clientData.openingHours.googleBusinessSyncUrl}
            onChange={(e) => setClientData((prev) => ({
              ...prev,
              openingHours: { ...prev.openingHours, googleBusinessSyncUrl: e.target.value },
            }))}
            className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-[13px] outline-none focus:border-[#FF5B00]"
            placeholder="https://g.page/..."
          />
        </label>
        <div className="flex flex-col gap-3">
          {clientData.openingHours.days.map((day, index) => (
            <div key={day.day} className="flex items-center justify-between bg-white border border-gray-200 rounded-lg p-3">
              <span className="text-[13px] font-medium text-[#121212] w-20">{day.day}</span>
              <div className="flex items-center gap-3">
                {day.closed ? (
                  <span className="text-[13px] text-gray-500 italic w-[150px] text-center">Stengt</span>
                ) : (
                  <>
                    <input
                      type="time"
                      className="bg-gray-50 border border-gray-200 rounded px-2 py-1 text-[13px] outline-none"
                      value={day.opensAt}
                      onChange={(e) => setClientData((prev) => {
                        const days = [...prev.openingHours.days];
                        days[index] = { ...days[index], opensAt: e.target.value };
                        return { ...prev, openingHours: { ...prev.openingHours, days } };
                      })}
                    />
                    <span className="text-gray-400">-</span>
                    <input
                      type="time"
                      className="bg-gray-50 border border-gray-200 rounded px-2 py-1 text-[13px] outline-none"
                      value={day.closesAt}
                      onChange={(e) => setClientData((prev) => {
                        const days = [...prev.openingHours.days];
                        days[index] = { ...days[index], closesAt: e.target.value };
                        return { ...prev, openingHours: { ...prev.openingHours, days } };
                      })}
                    />
                  </>
                )}
                <button
                  type="button"
                  onClick={() => setClientData((prev) => {
                    const days = [...prev.openingHours.days];
                    days[index] = { ...days[index], closed: !days[index].closed };
                    return { ...prev, openingHours: { ...prev.openingHours, days } };
                  })}
                  className={`ml-4 text-[12px] font-semibold ${day.closed ? 'text-[#FF5B00]' : 'text-gray-400 hover:text-gray-600'}`}
                >
                  {day.closed ? 'Åpne' : 'Sett stengt'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </Accordion>

      <Accordion
        id="Affiliasjoner"
        title="Affiliasjoner og partnere"
        open={open}
        setOpen={setOpen}
        done={clientData.affiliations.some((row) => row.items.length > 0)}
      >
        <button
          type="button"
          onClick={() => setClientData((prev) => ({
            ...prev,
            affiliations: [...prev.affiliations, { id: randomId('aff-cat'), categoryName: 'Ny kategori', items: [] }],
          }))}
          className="w-fit flex items-center gap-2 bg-white border border-gray-200 text-[#121212] px-4 py-2 rounded-full text-[13px] font-medium shadow-sm hover:bg-gray-50"
        >
          <Plus className="w-3.5 h-3.5" /> Legg til kategori
        </button>
        {clientData.affiliations.map((category, categoryIndex) => (
          <div key={category.id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="flex items-center justify-between bg-gray-50/80 p-3 border-b border-gray-200">
              <input
                type="text"
                className="bg-transparent font-medium text-[#121212] text-[14px] outline-none flex-1"
                value={category.categoryName}
                onChange={(e) => setClientData((prev) => {
                  const affiliations = [...prev.affiliations];
                  affiliations[categoryIndex] = { ...affiliations[categoryIndex], categoryName: e.target.value };
                  return { ...prev, affiliations };
                })}
              />
              <button
                type="button"
                onClick={() => setClientData((prev) => ({
                  ...prev,
                  affiliations: prev.affiliations.filter((_, index) => index !== categoryIndex),
                }))}
                className="text-gray-400 hover:text-red-500"
                aria-label="Fjern kategori"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 flex flex-col gap-3">
              {category.items.map((item, itemIndex) => (
                <div key={item.id} className="flex items-center gap-4 border border-gray-100 p-3 rounded-lg">
                  <LogoDrop
                    src={clientMediaSrc(item.imageUrl, token)}
                    onFile={(file) => void uploadTo((url) => {
                      setClientData((prev) => {
                        const affiliations = [...prev.affiliations];
                        const items = [...affiliations[categoryIndex].items];
                        items[itemIndex] = { ...items[itemIndex], imageUrl: url };
                        affiliations[categoryIndex] = { ...affiliations[categoryIndex], items };
                        return { ...prev, affiliations };
                      });
                    }, file)}
                  />
                  <div className="flex flex-col flex-1 gap-1">
                    <input
                      value={item.title}
                      onChange={(e) => updateAffiliationItem(setClientData, categoryIndex, itemIndex, 'title', e.target.value)}
                      placeholder="Tittel"
                      className="text-[14px] font-medium text-[#121212] outline-none border-b border-transparent focus:border-[#FF5B00]"
                    />
                    <input
                      value={item.description}
                      onChange={(e) => updateAffiliationItem(setClientData, categoryIndex, itemIndex, 'description', e.target.value)}
                      placeholder="Beskrivelse"
                      className="text-[12px] text-gray-500 outline-none border-b border-transparent focus:border-[#FF5B00]"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setClientData((prev) => {
                      const affiliations = [...prev.affiliations];
                      affiliations[categoryIndex] = {
                        ...affiliations[categoryIndex],
                        items: affiliations[categoryIndex].items.filter((_, index) => index !== itemIndex),
                      };
                      return { ...prev, affiliations };
                    })}
                    className="text-gray-400 hover:text-red-500"
                    aria-label="Fjern partner"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setClientData((prev) => {
                  const affiliations = [...prev.affiliations];
                  affiliations[categoryIndex] = {
                    ...affiliations[categoryIndex],
                    items: [...affiliations[categoryIndex].items, { id: randomId('aff-item'), title: '', description: '', imageUrl: '' }],
                  };
                  return { ...prev, affiliations };
                })}
                className="border-2 border-dashed border-gray-200 rounded-lg p-3 flex items-center justify-center text-[13px] font-medium text-gray-500 hover:text-[#FF5B00] gap-2"
              >
                <Plus className="w-4 h-4" /> Legg til ny affiliasjon
              </button>
            </div>
          </div>
        ))}
      </Accordion>

      <Accordion
        id="Identitet"
        title="Identitet og kontakt"
        open={open}
        setOpen={setOpen}
        done={Boolean(clientData.brandIdentity.orgNumber || clientData.generalInfo.companyAddress)}
      >
        <div>
          <label className="text-[13px] font-medium text-gray-700 mb-2 block">Organisasjonsnummer</label>
          <input
            type="text"
            placeholder="F.eks: 912 345 678"
            className="w-full max-w-[300px] bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-[13px] outline-none focus:border-[#FF5B00]"
            value={clientData.brandIdentity.orgNumber}
            onChange={(e) => setClientData((prev) => ({
              ...prev,
              brandIdentity: { ...prev.brandIdentity, orgNumber: e.target.value },
            }))}
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-[13px] font-medium text-gray-700">Fargeprofil</span>
          <div className="flex items-center gap-4 flex-wrap">
            {([
              ['primary', 'Primær'],
              ['secondary', 'Sekundær'],
              ['accent', 'Aksent'],
            ] as const).map(([key, label]) => (
              <div key={key} className="flex flex-col gap-1">
                <span className="text-[11px] text-gray-500">{label}</span>
                <div className="flex items-center gap-2">
                  <div className="flex items-center border border-gray-200 rounded bg-white p-1">
                    <input
                      type="color"
                      className="w-8 h-8 rounded border-none cursor-pointer"
                      value={clientData.brandIdentity.colors[key]}
                      onChange={(e) => setClientData((prev) => ({
                        ...prev,
                        brandIdentity: {
                          ...prev.brandIdentity,
                          colors: { ...prev.brandIdentity.colors, [key]: e.target.value.toUpperCase() },
                        },
                      }))}
                    />
                  </div>
                  <input
                    type="text"
                    maxLength={7}
                    className="w-[72px] bg-white border border-gray-200 rounded px-2 py-1.5 text-[12px] font-mono outline-none focus:border-[#FF5B00] uppercase"
                    value={clientData.brandIdentity.colors[key]}
                    onChange={(e) => setClientData((prev) => ({
                      ...prev,
                      brandIdentity: {
                        ...prev.brandIdentity,
                        colors: {
                          ...prev.brandIdentity.colors,
                          [key]: normalizeHex(e.target.value, prev.brandIdentity.colors[key]),
                        },
                      },
                    }))}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex gap-6">
          <LogoUpload
            label="Normal logo"
            src={clientMediaSrc(clientData.brandIdentity.logos.normal, token)}
            empty="Last opp logo"
            onFile={(file) => void uploadTo((url) => setClientData((prev) => ({
              ...prev,
              brandIdentity: { ...prev.brandIdentity, logos: { ...prev.brandIdentity.logos, normal: url } },
            })), file)}
          />
          <LogoUpload
            label="Favicon (ikon)"
            src={clientMediaSrc(clientData.brandIdentity.logos.favicon, token)}
            empty="Last opp favicon"
            onFile={(file) => void uploadTo((url) => setClientData((prev) => ({
              ...prev,
              brandIdentity: { ...prev.brandIdentity, logos: { ...prev.brandIdentity.logos, favicon: url } },
            })), file)}
          />
        </div>
        <div className="flex flex-col md:flex-row gap-6 relative">
          <div className="flex-1 relative">
            <label className="text-[13px] font-medium text-gray-700 mb-2 block">Bedriftsadresse</label>
            <input
              type="text"
              placeholder="F.eks: Karl Johans gate 1, 0154 Oslo"
              className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-[13px] outline-none focus:border-[#FF5B00]"
              value={clientData.generalInfo.companyAddress}
              onChange={(e) => setClientData((prev) => ({
                ...prev,
                generalInfo: { ...prev.generalInfo, companyAddress: e.target.value },
              }))}
              onFocus={() => setShowSuggestions(true)}
              onBlur={() => window.setTimeout(() => setShowSuggestions(false), 150)}
            />
            {showSuggestions && addressSuggestions.length > 0 ? (
              <div className="absolute z-10 w-full bg-white border border-gray-200 mt-1 rounded-lg shadow-lg overflow-hidden">
                {addressSuggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    className="w-full px-4 py-2 text-[13px] text-left hover:bg-gray-50"
                    onMouseDown={() => setClientData((prev) => ({
                      ...prev,
                      generalInfo: { ...prev.generalInfo, companyAddress: suggestion },
                    }))}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <div className="flex-1 relative">
            <label className="text-[13px] font-medium text-gray-700 mb-2 block">Nettsidens språk</label>
            <input
              type="text"
              className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-[13px] outline-none focus:border-[#FF5B00] peer"
              value={language}
              onChange={(e) => setClientData((prev) => ({
                ...prev,
                generalInfo: { ...prev.generalInfo, websiteLanguage: e.target.value },
              }))}
              placeholder="Søk etter språk"
            />
            <div className="absolute z-10 w-full bg-white border border-gray-200 mt-1 rounded-lg shadow-lg overflow-y-auto max-h-48 opacity-0 invisible peer-focus:opacity-100 peer-focus:visible hover:opacity-100 hover:visible">
              {filteredLanguages.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="w-full px-4 py-2 text-[13px] text-left hover:bg-gray-50"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setClientData((prev) => ({
                      ...prev,
                      generalInfo: { ...prev.generalInfo, websiteLanguage: option },
                    }));
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <label className="text-[13px] font-medium text-gray-700 mb-2 block">By</label>
            <input
              value={clientData.websiteCreatorQuestions.town}
              onChange={(e) => setClientData((prev) => ({
                ...prev,
                websiteCreatorQuestions: { ...prev.websiteCreatorQuestions, town: e.target.value },
              }))}
              className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-[13px] outline-none focus:border-[#FF5B00]"
            />
          </div>
          <div>
            <label className="text-[13px] font-medium text-gray-700 mb-2 block">Land</label>
            <input
              value={clientData.websiteCreatorQuestions.country}
              onChange={(e) => setClientData((prev) => ({
                ...prev,
                websiteCreatorQuestions: { ...prev.websiteCreatorQuestions, country: e.target.value },
              }))}
              className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-[13px] outline-none focus:border-[#FF5B00]"
            />
          </div>
          <div>
            <label className="text-[13px] font-medium text-gray-700 mb-2 block">Bedriftstelefon</label>
            <input
              type="tel"
              value={clientData.generalInfo.companyPhone}
              onChange={(e) => setClientData((prev) => ({
                ...prev,
                generalInfo: { ...prev.generalInfo, companyPhone: e.target.value },
              }))}
              className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-[13px] outline-none focus:border-[#FF5B00]"
            />
          </div>
          <div>
            <label className="text-[13px] font-medium text-gray-700 mb-2 block">Bedriftse-post</label>
            <input
              type="email"
              value={clientData.generalInfo.companyEmail}
              onChange={(e) => setClientData((prev) => ({
                ...prev,
                generalInfo: { ...prev.generalInfo, companyEmail: e.target.value },
              }))}
              className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-[13px] outline-none focus:border-[#FF5B00]"
            />
          </div>
          <div className="md:col-span-2">
            <label className="text-[13px] font-medium text-gray-700 mb-2 block">Nettadresse</label>
            <input
              value={clientData.websiteCreatorQuestions.websiteDomain}
              onChange={(e) => setClientData((prev) => ({
                ...prev,
                websiteCreatorQuestions: { ...prev.websiteCreatorQuestions, websiteDomain: e.target.value },
              }))}
              placeholder="https://..."
              className="w-full bg-white border border-gray-200 rounded-lg px-4 py-2.5 text-[13px] outline-none focus:border-[#FF5B00]"
            />
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-[13px] font-medium text-gray-700">Sosiale medier</label>
          {clientData.generalInfo.socialMediaLinks.map((link, index) => (
            <div key={`social-${index}`} className="flex gap-2">
              <input
                type="url"
                placeholder="Lim inn link til Facebook, Instagram, etc."
                className="flex-1 bg-white border border-gray-200 rounded-lg px-4 py-2 text-[13px] outline-none focus:border-[#FF5B00]"
                value={link}
                onChange={(e) => setClientData((prev) => {
                  const socialMediaLinks = [...prev.generalInfo.socialMediaLinks];
                  socialMediaLinks[index] = e.target.value;
                  return { ...prev, generalInfo: { ...prev.generalInfo, socialMediaLinks } };
                })}
              />
              <button
                type="button"
                onClick={() => setClientData((prev) => ({
                  ...prev,
                  generalInfo: {
                    ...prev.generalInfo,
                    socialMediaLinks: prev.generalInfo.socialMediaLinks.filter((_, current) => current !== index),
                  },
                }))}
                className="text-gray-400 hover:text-red-500"
                aria-label="Fjern sosial lenke"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="flex items-center gap-1.5 text-[12px] font-medium text-[#FF5B00] w-fit"
            onClick={() => setClientData((prev) => ({
              ...prev,
              generalInfo: { ...prev.generalInfo, socialMediaLinks: [...prev.generalInfo.socialMediaLinks, ''] },
            }))}
          >
            <Plus className="w-3.5 h-3.5" /> Legg til mer
          </button>
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-[13px] font-medium text-gray-700">Ekstra lenker (f.eks. Trustpilot, Airbnb)</label>
          {clientData.generalInfo.extraLinks.map((entry, index) => (
            <div key={`extra-${index}`} className="flex gap-2">
              <input
                type="text"
                placeholder="Navn"
                className="w-1/3 bg-white border border-gray-200 rounded-lg px-4 py-2 text-[13px] outline-none focus:border-[#FF5B00]"
                value={entry.name}
                onChange={(e) => setClientData((prev) => {
                  const extraLinks = [...prev.generalInfo.extraLinks];
                  extraLinks[index] = { ...extraLinks[index], name: e.target.value };
                  return { ...prev, generalInfo: { ...prev.generalInfo, extraLinks } };
                })}
              />
              <input
                type="url"
                placeholder="https://..."
                className="flex-1 bg-white border border-gray-200 rounded-lg px-4 py-2 text-[13px] outline-none focus:border-[#FF5B00]"
                value={entry.url}
                onChange={(e) => setClientData((prev) => {
                  const extraLinks = [...prev.generalInfo.extraLinks];
                  extraLinks[index] = { ...extraLinks[index], url: e.target.value };
                  return { ...prev, generalInfo: { ...prev.generalInfo, extraLinks } };
                })}
              />
              <button
                type="button"
                onClick={() => setClientData((prev) => ({
                  ...prev,
                  generalInfo: {
                    ...prev.generalInfo,
                    extraLinks: prev.generalInfo.extraLinks.filter((_, current) => current !== index),
                  },
                }))}
                className="text-gray-400 hover:text-red-500"
                aria-label="Fjern ekstra lenke"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="flex items-center gap-1.5 text-[12px] font-medium text-[#FF5B00] w-fit"
            onClick={() => setClientData((prev) => ({
              ...prev,
              generalInfo: {
                ...prev.generalInfo,
                extraLinks: [...prev.generalInfo.extraLinks, { name: '', url: '' }],
              },
            }))}
          >
            <Plus className="w-3.5 h-3.5" /> Legg til ny lenke
          </button>
        </div>
      </Accordion>
    </div>
  );
}

function updateAffiliationItem(
  setClientData: React.Dispatch<React.SetStateAction<ClientDataBank>>,
  categoryIndex: number,
  itemIndex: number,
  field: keyof AffiliationItem,
  value: string
) {
  setClientData((prev) => {
    const affiliations = [...prev.affiliations];
    const items = [...affiliations[categoryIndex].items];
    items[itemIndex] = { ...items[itemIndex], [field]: value };
    affiliations[categoryIndex] = { ...affiliations[categoryIndex], items };
    return { ...prev, affiliations };
  });
}

function Accordion({
  id,
  title,
  open,
  setOpen,
  done,
  children,
}: {
  id: AccordionId;
  title: string;
  open: AccordionId | null;
  setOpen: (value: AccordionId | null) => void;
  done: boolean;
  children: React.ReactNode;
}) {
  const expanded = open === id;
  return (
    <div className="flex flex-col border border-gray-200 rounded-2xl overflow-hidden">
      <button
        type="button"
        className="flex items-center justify-between p-5 bg-white"
        onClick={() => setOpen(expanded ? null : id)}
      >
        <div className="flex items-center gap-3">
          {done ? <CheckCircle2 className="w-5 h-5 text-green-500" /> : <div className="w-5 h-5 border-2 border-gray-300 rounded-full" />}
          <span className="font-medium text-[#121212] text-[15px]">{title}</span>
        </div>
        <ChevronDown className={`w-5 h-5 text-gray-500 transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>
      {expanded ? (
        <div className="p-5 border-t border-gray-100 bg-gray-50/50 flex flex-col gap-6">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function LogoUpload({
  label,
  src,
  empty,
  onFile,
}: {
  label: string;
  src: string;
  empty: string;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-col flex-1">
      <span className="text-[13px] font-medium text-gray-700 mb-2 block">{label}</span>
      <button
        type="button"
        className="border-2 border-dashed border-gray-300 rounded-lg h-24 flex flex-col items-center justify-center bg-white hover:bg-gray-50 overflow-hidden relative group"
        onClick={() => inputRef.current?.click()}
      >
        {src ? (
          <>
            <img src={src} className="w-auto h-full p-2 object-contain" alt={label} />
            <div className="absolute inset-0 bg-black/40 flex flex-col items-center justify-center opacity-0 group-hover:opacity-100">
              <Upload className="w-5 h-5 text-white mb-1" />
              <span className="text-white text-[11px] font-medium">Trykk for å endre bilde</span>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-gray-500">
            <Upload className="w-5 h-5" />
            <span className="text-[12px] font-medium">{empty}</span>
          </div>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function LogoDrop({ src, onFile }: { src: string; onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        className="w-12 h-12 bg-gray-100 rounded border border-gray-200 shrink-0 flex items-center justify-center overflow-hidden relative"
        onClick={() => inputRef.current?.click()}
      >
        {src ? <img src={src} className="w-full h-full object-cover" alt="" /> : <ImageIcon className="w-5 h-5 text-gray-300" />}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
    </>
  );
}
