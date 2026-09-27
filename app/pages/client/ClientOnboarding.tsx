import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { useClientAuth } from '../../contexts/ClientAuthContext';
import { ClientRouteGuard } from '../../components/client/ClientRouteGuard';
import { GooglePlaceAutocomplete } from '../../components/client/GooglePlaceAutocomplete';

type FormState = {
  name: string;
  businessName: string;
  businessOrgNumber: string;
  businessAddress: string;
  position: string;
  phone: string;
  email: string;
  websiteUrl: string;
  instagramUrl: string;
  facebookUrl: string;
  googleMapsUrl: string;
  googlePlaceId: string;
  googlePlaceName: string;
  discoveryChannel: string;
};

type BrregBusinessOption = {
  organizationNumber: string;
  name: string;
  address: string;
};

type PlaceOption = {
  placeId: string;
  name: string;
  address: string;
  rating?: number;
  reviews?: number;
  type?: string;
  mapsUrl: string;
};

const DISCOVERY_OPTIONS = ['Fra sosiale medier', 'Referanse', 'Telefon salg', 'Annet'] as const;

const QUESTION_STEPS = [
  { key: 'name', kind: 'text', title: 'Hva heter du?', placeholder: 'Fornavn og etternavn' },
  { key: 'businessName', kind: 'text', title: 'Hva heter bedriften din?', placeholder: 'Bedriftsnavn' },
  { key: 'position', kind: 'text', title: 'Hva er stillingen din?', placeholder: 'f.eks. Daglig leder' },
  { key: 'contact', kind: 'contact', title: 'Hvordan kan vi nå deg?' },
  { key: 'sources', kind: 'sources', title: 'Gi oss profilene deres' },
  {
    key: 'discoveryChannel',
    kind: 'select',
    title: 'Hvordan fant du oss?',
    placeholder: 'Velg et alternativ',
    options: DISCOVERY_OPTIONS,
  },
] as const;

function normalizeHttpUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

function normalizeHandle(value = '', host = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  const handle = text.replace(/^@/, '').replace(/^\/+/, '');
  if (handle.includes('.')) return normalizeHttpUrl(handle);
  return `https://${host}/${handle}`;
}

function looksLikeEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

export const ClientOnboarding = () => {
  const navigate = useNavigate();
  const { profile, token, updateProfileState } = useClientAuth();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [brregResults, setBrregResults] = useState<BrregBusinessOption[]>([]);
  const [brregLoading, setBrregLoading] = useState(false);
  const [brregError, setBrregError] = useState('');
  const [selectedBrreg, setSelectedBrreg] = useState<BrregBusinessOption | null>(null);
  const [placeQuery, setPlaceQuery] = useState('');
  const [placeResults, setPlaceResults] = useState<PlaceOption[]>([]);
  const [placeLoading, setPlaceLoading] = useState(false);
  const [placeError, setPlaceError] = useState('');
  const [placesApiKey, setPlacesApiKey] = useState('');
  const [placesAutocomplete, setPlacesAutocomplete] = useState(false);
  const [form, setForm] = useState<FormState>({
    name: profile?.name || '',
    businessName: profile?.businessName || '',
    businessOrgNumber: profile?.businessOrgNumber || '',
    businessAddress: '',
    position: profile?.position || '',
    phone: String(profile?.clientDataBank?.generalInfo?.companyPhone || ''),
    email: String(profile?.clientDataBank?.generalInfo?.companyEmail || profile?.email || ''),
    websiteUrl: String(profile?.clientDataBank?.generalInfo?.websiteUrl || ''),
    instagramUrl: String(profile?.clientDataBank?.generalInfo?.instagramUrl || ''),
    facebookUrl: String(profile?.clientDataBank?.generalInfo?.facebookUrl || ''),
    googleMapsUrl: String(profile?.clientDataBank?.generalInfo?.googleMapsUrl || profile?.clientDataBank?.openingHours?.googleBusinessSyncUrl || ''),
    googlePlaceId: String(profile?.clientDataBank?.generalInfo?.googlePlaceId || ''),
    googlePlaceName: String(profile?.clientDataBank?.generalInfo?.googlePlaceName || ''),
    discoveryChannel: profile?.discoveryChannel || '',
  });

  const current = QUESTION_STEPS[step];
  const progress = useMemo(() => Math.round(((step + 1) / QUESTION_STEPS.length) * 100), [step]);
  const sourceFilled = [
    form.websiteUrl,
    form.instagramUrl,
    form.facebookUrl,
    form.googleMapsUrl || form.googlePlaceId,
  ].filter((value) => String(value || '').trim()).length;
  const sourceProgress = Math.round((sourceFilled / 4) * 100);

  const canProceed = useMemo(() => {
    if (current.kind === 'sources') return true;
    if (current.kind === 'contact') return looksLikeEmail(form.email);
    if (current.key === 'discoveryChannel') return Boolean(form.discoveryChannel.trim());
    return Boolean(String(form[current.key as keyof FormState] || '').trim());
  }, [current, form]);

  function patchForm(next: Partial<FormState>) {
    setForm((prev) => ({ ...prev, ...next }));
  }

  function setCurrentValue(value: string) {
    if (current.key === 'businessName') {
      patchForm({ businessName: value, businessOrgNumber: '', businessAddress: '' });
      setSelectedBrreg(null);
      setBrregError('');
      return;
    }
    if (current.key === 'name' || current.key === 'position' || current.key === 'discoveryChannel') {
      patchForm({ [current.key]: value });
    }
  }

  function selectBrregOption(option: BrregBusinessOption) {
    setSelectedBrreg(option);
    patchForm({
      businessName: option.name,
      businessOrgNumber: option.organizationNumber,
      businessAddress: option.address || '',
    });
    setBrregResults([]);
    setBrregError('');
  }

  function selectPlace(option: PlaceOption) {
    patchForm({
      googleMapsUrl: option.mapsUrl,
      googlePlaceId: option.placeId,
      googlePlaceName: option.name,
    });
    setPlaceQuery(option.name);
    setPlaceResults([]);
    setPlaceError('');
  }

  const selectGooglePlace = useCallback((place: PlaceOption) => {
    setForm((prev) => ({
      ...prev,
      googleMapsUrl: place.mapsUrl,
      googlePlaceId: place.placeId,
      googlePlaceName: place.name,
    }));
    setPlaceQuery(place.name);
    setPlaceResults([]);
    setPlaceError('');
  }, []);

  useEffect(() => {
    if (!token) return;
    fetch('/api/client/places-config', { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        setPlacesAutocomplete(Boolean(data?.autocomplete && data?.apiKey));
        setPlacesApiKey(String(data?.apiKey || ''));
      })
      .catch(() => {
        setPlacesAutocomplete(false);
        setPlacesApiKey('');
      });
  }, [token]);

  useEffect(() => {
    if (current.key !== 'businessName') return;
    const query = String(form.businessName || '').trim();
    if (query.length < 2) {
      setBrregResults([]);
      setBrregLoading(false);
      setBrregError('');
      return;
    }

    let active = true;
    setBrregLoading(true);
    setBrregError('');
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/client/brreg-search?q=${encodeURIComponent(query)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || 'Kunne ikke hente bedriftsdata fra BRREG.');
        if (!active) return;
        setBrregResults(Array.isArray(data.results) ? data.results : []);
      } catch (err) {
        if (!active) return;
        setBrregResults([]);
        setBrregError(err instanceof Error ? err.message : 'Kunne ikke hente bedriftsdata fra BRREG.');
      } finally {
        if (active) setBrregLoading(false);
      }
    }, 250);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [current.key, form.businessName, token]);

  useEffect(() => {
    if (current.kind !== 'sources' || placesAutocomplete) return;
    if (!placeQuery && form.businessName && !form.googleMapsUrl) {
      setPlaceQuery([form.businessName, form.businessAddress].filter(Boolean).join(' '));
    }
  }, [current.kind, form.businessName, form.businessAddress, form.googleMapsUrl, placeQuery, placesAutocomplete]);

  useEffect(() => {
    if (current.kind !== 'sources' || placesAutocomplete) return;
    const query = placeQuery.trim();
    if (query.length < 3) {
      setPlaceResults([]);
      setPlaceLoading(false);
      return;
    }
    if (form.googlePlaceName && query === form.googlePlaceName) {
      setPlaceResults([]);
      return;
    }

    let active = true;
    setPlaceLoading(true);
    setPlaceError('');
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/client/places-search?q=${encodeURIComponent(query)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.message || 'Kunne ikke søke i Google-profiler.');
        if (!active) return;
        setPlaceResults(Array.isArray(data.results) ? data.results : []);
      } catch (err) {
        if (!active) return;
        setPlaceResults([]);
        setPlaceError(err instanceof Error ? err.message : 'Kunne ikke søke i Google-profiler.');
      } finally {
        if (active) setPlaceLoading(false);
      }
    }, 350);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [current.kind, placeQuery, form.googlePlaceName, token, placesAutocomplete]);

  async function completeOnboarding() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/client/profile', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: form.name,
          businessName: form.businessName,
          businessOrgNumber: form.businessOrgNumber,
          position: form.position,
          discoveryChannel: form.discoveryChannel,
          phone: form.phone,
          email: form.email,
          sources: {
            websiteUrl: normalizeHttpUrl(form.websiteUrl),
            instagramUrl: normalizeHandle(form.instagramUrl, 'instagram.com'),
            facebookUrl: normalizeHandle(form.facebookUrl, 'facebook.com'),
            googleMapsUrl: form.googleMapsUrl,
            googlePlaceId: form.googlePlaceId,
            googlePlaceName: form.googlePlaceName,
          },
          onboardingCompleted: true,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Kunne ikke lagre onboarding.');
      updateProfileState(data.profile || null);
      navigate('/kunde/hjem', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre onboarding.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <ClientRouteGuard>
      <Helmet>
        <title>Onboarding – Kundeportal</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <section className="min-h-screen bg-[#F8F9FB] px-6 py-10 flex items-center">
        <div className="max-w-3xl mx-auto w-full rounded-[28px] border border-[#E6E9EF] bg-white p-8 lg:p-10 shadow-[0_20px_50px_rgba(17,24,39,0.06)]">
          <div className="flex items-center justify-between gap-4 mb-6">
            <div>
              <p className="text-sm text-[#FF5B00] font-medium">Kunde onboarding</p>
              <h1 className="text-2xl font-semibold text-[#111827] mt-1">Før vi starter, noen raske spørsmål</h1>
            </div>
            <span className="text-sm text-[#6B7280]">{step + 1}/{QUESTION_STEPS.length}</span>
          </div>

          <div className="mb-8">
            <div className="flex items-center justify-between text-xs text-[#6B7280] mb-2">
              <span>Profil og kilder til nettsiden</span>
              <span>{progress}%</span>
            </div>
            <div className="h-2 rounded-full bg-[#EEF1F5] overflow-hidden">
              <div className="h-full bg-[#FF5B00] transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>

          <div className="rounded-2xl border border-[#E5E7EB] bg-[#FAFBFC] p-6">
            <h2 className="text-xl font-semibold text-[#111827]">{current.title}</h2>

            {current.kind === 'select' ? (
              <select
                value={form.discoveryChannel}
                onChange={(e) => setCurrentValue(e.target.value)}
                className="mt-4 w-full rounded-xl border border-[#DDE2EA] bg-white px-4 py-3 text-[#111827] outline-none focus:border-[#FF5B00]"
                autoFocus
              >
                <option value="" disabled>
                  {current.placeholder}
                </option>
                {current.options?.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : null}

            {current.kind === 'contact' ? (
              <div className="mt-4 space-y-4">
                <p className="text-sm text-[#6B7280]">
                  Vi bruker dette til onboarding og oppfølging. E-posten er allerede fra innloggingen din.
                </p>
                <label className="block">
                  <span className="text-sm text-[#374151]">E-post</span>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => patchForm({ email: e.target.value })}
                    className="mt-1 w-full rounded-xl border border-[#DDE2EA] bg-white px-4 py-3 outline-none focus:border-[#FF5B00]"
                    autoFocus
                  />
                </label>
                <label className="block">
                  <span className="text-sm text-[#374151]">Telefon <span className="text-[#9CA3AF]">(valgfritt)</span></span>
                  <input
                    type="tel"
                    value={form.phone}
                    onChange={(e) => patchForm({ phone: e.target.value })}
                    placeholder="f.eks. 400 00 000"
                    className="mt-1 w-full rounded-xl border border-[#DDE2EA] bg-white px-4 py-3 outline-none focus:border-[#FF5B00]"
                  />
                </label>
              </div>
            ) : null}

            {current.kind === 'sources' ? (
              <div className="mt-4 space-y-5">
                <p className="text-sm leading-relaxed text-[#4B5563]">
                  Har dere allerede nettside, Instagram, Facebook eller Google-bedrift? Legg inn profilene her.
                  Vi bruker dem til å hente bilder, priser, åpningstider og tekster — så onboarding går mye raskere,
                  og dere får et mer treffsikkert førsteutkast av nettsiden.
                </p>
                <div>
                  <div className="flex items-center justify-between text-xs text-[#6B7280] mb-2">
                    <span>Kilder vi kan hente fra til nettsiden</span>
                    <span>{sourceFilled} av 4</span>
                  </div>
                  <div className="h-2 rounded-full bg-[#EEF1F5] overflow-hidden">
                    <div className="h-full bg-[#059669] transition-all" style={{ width: `${sourceProgress}%` }} />
                  </div>
                  <p className="mt-2 text-xs text-[#6B7280]">
                    Alt er valgfritt. Jo flere dere fyller, jo mer kan vi gjøre automatisk.
                  </p>
                </div>

                <label className="block">
                  <span className="text-sm text-[#374151]">Eksisterende nettside <span className="text-[#9CA3AF]">(valgfritt)</span></span>
                  <input
                    type="text"
                    value={form.websiteUrl}
                    onChange={(e) => patchForm({ websiteUrl: e.target.value })}
                    placeholder="cafeen.no"
                    className="mt-1 w-full rounded-xl border border-[#DDE2EA] bg-white px-4 py-3 outline-none focus:border-[#FF5B00]"
                  />
                </label>
                <label className="block">
                  <span className="text-sm text-[#374151]">Instagram <span className="text-[#9CA3AF]">(valgfritt)</span></span>
                  <input
                    type="text"
                    value={form.instagramUrl}
                    onChange={(e) => patchForm({ instagramUrl: e.target.value })}
                    placeholder="@bedriften eller instagram.com/bedriften"
                    className="mt-1 w-full rounded-xl border border-[#DDE2EA] bg-white px-4 py-3 outline-none focus:border-[#FF5B00]"
                  />
                </label>
                <label className="block">
                  <span className="text-sm text-[#374151]">Facebook <span className="text-[#9CA3AF]">(valgfritt)</span></span>
                  <input
                    type="text"
                    value={form.facebookUrl}
                    onChange={(e) => patchForm({ facebookUrl: e.target.value })}
                    placeholder="facebook.com/bedriften"
                    className="mt-1 w-full rounded-xl border border-[#DDE2EA] bg-white px-4 py-3 outline-none focus:border-[#FF5B00]"
                  />
                </label>
                <div>
                  <span className="text-sm text-[#374151]">Google-bedrift / Maps <span className="text-[#9CA3AF]">(valgfritt)</span></span>
                  <p className="mt-1 text-xs text-[#6B7280]">
                    Skriv bedriftsnavnet og velg i Google-listen. Vi lagrer Place ID — du trenger ikke kopiere en Maps-lenke.
                  </p>
                  {placesAutocomplete && placesApiKey ? (
                    <GooglePlaceAutocomplete
                      key={form.googlePlaceId || 'empty'}
                      apiKey={placesApiKey}
                      defaultQuery={form.businessName}
                      selectedName={form.googlePlaceName}
                      onSelect={selectGooglePlace}
                      onClear={() => patchForm({ googleMapsUrl: '', googlePlaceId: '', googlePlaceName: '' })}
                      onLoadError={() => setPlacesAutocomplete(false)}
                    />
                  ) : (
                    <>
                      <input
                        type="text"
                        value={placeQuery}
                        onChange={(e) => {
                          setPlaceQuery(e.target.value);
                          if (form.googlePlaceName) {
                            patchForm({ googleMapsUrl: '', googlePlaceId: '', googlePlaceName: '' });
                          }
                        }}
                        placeholder="Søk f.eks. Bydelskafe Trondheim"
                        className="mt-2 w-full rounded-xl border border-[#DDE2EA] bg-white px-4 py-3 outline-none focus:border-[#FF5B00]"
                      />
                      {form.googlePlaceName ? (
                        <p className="mt-2 text-xs text-[#059669]">
                          Valgt: {form.googlePlaceName}
                          {form.googleMapsUrl ? ' · Google-profilen er lagret' : ''}
                        </p>
                      ) : null}
                      {placeLoading ? <p className="mt-2 text-xs text-[#6B7280]">Søker i Google-profiler…</p> : null}
                      {placeError ? <p className="mt-2 text-xs text-red-500">{placeError}</p> : null}
                      {!placeLoading && placeResults.length > 0 ? (
                        <div className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-[#E5E7EB] bg-white divide-y divide-[#EEF1F5]">
                          {placeResults.map((option) => (
                            <button
                              key={`${option.placeId}:${option.name}`}
                              type="button"
                              onClick={() => selectPlace(option)}
                              className="w-full text-left px-4 py-3 hover:bg-[#F8F9FB]"
                            >
                              <div className="text-sm font-medium text-[#111827]">{option.name}</div>
                              <div className="text-xs text-[#6B7280]">
                                {option.address || 'Google-bedrift'}
                                {option.rating ? ` · ${option.rating}` : ''}
                                {option.reviews ? ` (${option.reviews} anmeldelser)` : ''}
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            ) : null}

            {current.kind === 'text' ? (
              <>
                <input
                  type="text"
                  value={String(form[current.key as keyof FormState] || '')}
                  onChange={(e) => setCurrentValue(e.target.value)}
                  placeholder={current.placeholder}
                  className="mt-4 w-full rounded-xl border border-[#DDE2EA] bg-white px-4 py-3 text-[#111827] outline-none focus:border-[#FF5B00]"
                  autoFocus
                />
                {current.key === 'businessName' ? (
                  <div className="mt-3">
                    <p className="text-xs text-[#6B7280]">
                      Søk i BRREG med bedriftsnavn eller organisasjonsnummer og velg riktig bedrift.
                    </p>
                    {form.businessOrgNumber ? (
                      <p className="mt-1 text-xs text-[#111827]">
                        Valgt org.nr: <strong>{form.businessOrgNumber}</strong>
                      </p>
                    ) : null}
                    {brregLoading ? (
                      <p className="mt-2 text-xs text-[#6B7280]">Søker i BRREG…</p>
                    ) : null}
                    {brregError ? (
                      <p className="mt-2 text-xs text-red-500">{brregError}</p>
                    ) : null}
                    {!brregLoading && brregResults.length > 0 ? (
                      <div className="mt-2 max-h-52 overflow-y-auto rounded-xl border border-[#E5E7EB] bg-white divide-y divide-[#EEF1F5]">
                        {brregResults.map((option) => (
                          <button
                            key={`${option.organizationNumber}:${option.name}`}
                            type="button"
                            onClick={() => selectBrregOption(option)}
                            className="w-full text-left px-4 py-3 hover:bg-[#F8F9FB]"
                          >
                            <div className="text-sm font-medium text-[#111827]">{option.name}</div>
                            <div className="text-xs text-[#6B7280]">
                              Org.nr {option.organizationNumber}
                              {option.address ? ` · ${option.address}` : ''}
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {!brregLoading && !brregError && String(form.businessName || '').trim().length >= 2 && brregResults.length === 0 ? (
                      <p className="mt-2 text-xs text-[#6B7280]">Ingen treff i BRREG for dette søket.</p>
                    ) : null}
                    {selectedBrreg ? (
                      <p className="mt-2 text-xs text-[#059669]">
                        {selectedBrreg.name} er valgt fra BRREG.
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>

          {error ? <p className="mt-5 text-sm text-red-500">{error}</p> : null}

          <div className="mt-8 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setStep((prev) => Math.max(0, prev - 1))}
              disabled={step === 0 || loading}
              className="inline-flex items-center gap-2 rounded-xl border border-[#E5E7EB] bg-white px-4 py-2.5 text-sm text-[#374151] hover:bg-[#F9FAFB] disabled:opacity-50"
            >
              <ArrowLeft size={14} />
              Tilbake
            </button>
            {step < QUESTION_STEPS.length - 1 ? (
              <button
                type="button"
                onClick={() => setStep((prev) => Math.min(QUESTION_STEPS.length - 1, prev + 1))}
                disabled={!canProceed || loading}
                className="inline-flex items-center gap-2 rounded-xl bg-[#FF5B00] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#E55200] disabled:opacity-50"
              >
                {current.kind === 'sources' && sourceFilled === 0 ? 'Hopp over' : 'Neste'}
                <ArrowRight size={14} />
              </button>
            ) : (
              <button
                type="button"
                onClick={completeOnboarding}
                disabled={!canProceed || loading}
                className="inline-flex items-center gap-2 rounded-xl bg-[#FF5B00] px-4 py-2.5 text-sm font-medium text-white hover:bg-[#E55200] disabled:opacity-50"
              >
                {loading ? 'Lagrer…' : 'Fullfør onboarding'}
              </button>
            )}
          </div>
        </div>
      </section>
    </ClientRouteGuard>
  );
};
