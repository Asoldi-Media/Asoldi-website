import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { ExternalLink, Loader2, Tag } from 'lucide-react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from '@stripe/react-stripe-js';
import { ClientRouteGuard } from '../../components/client/ClientRouteGuard';
import { ClientPortalLayout } from '../../components/client/ClientPortalLayout';
import { useClientAuth } from '../../contexts/ClientAuthContext';
import { CHECKOUT_BENEFITS, CLIENT_WEBSITE_PLANS } from '../../data/clientWebsitePlans';
import { formatPriceAmount, normalizeCouponCode, parsePriceAmount } from '../../data/coupons';
import { requestClientApi } from './auth';
import { useClientOffer } from './useClientOffer';

type PaymentMethod = 'faktura' | 'vipps' | 'kort';

type AppliedPromotionCode = {
  code: string;
  promotionCodeId: string;
  couponId: string;
  label: string;
  percentOff: number;
  amountOff: number;
  currency: string;
  discountAmount: number;
  totalAmount: number;
  planId: string;
  planName: string;
  appliedAt: string;
};

function formatPrice(value: unknown) {
  if (typeof value === 'number') return `${value},-/mnd`;
  const text = String(value || '').trim();
  return text || 'Etter avtale';
}

function formatPlanFromProfile(profile: any) {
  if (!profile) return null;
  const type = profile?.websiteBuilder?.selectedPlanType;
  if (type === 'custom') {
    return {
      name: profile?.customWebsitePlan?.title || 'Din nettside plan',
      price: formatPrice(profile?.customWebsitePlan?.monthlyPrice),
      features: ['Skreddersydd struktur', 'Tilpasset levering', 'Direkte oppfølging'],
    };
  }
  const selectedId = String(profile?.websiteBuilder?.selectedPlanId || '');
  const found = CLIENT_WEBSITE_PLANS.find((plan) => plan.id === selectedId) || CLIENT_WEBSITE_PLANS[0];
  return {
    name: found.name,
    price: found.price,
    features: found.features,
  };
}

export const ClientWebsiteCheckout = () => {
  const { token, user, profile, updateProfileState } = useClientAuth();
  const [error, setError] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('kort');
  const [paid, setPaid] = useState(false);
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedPromotionCode | null>(null);
  const [couponInput, setCouponInput] = useState('');
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponError, setCouponError] = useState('');
  const { offer } = useClientOffer(token);

  // Card (embedded Stripe Checkout)
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);
  const [cardConfigured, setCardConfigured] = useState<boolean | null>(null);
  const [clientSecret, setClientSecret] = useState('');
  const [cardLoading, setCardLoading] = useState(false);
  const [cardError, setCardError] = useState('');

  // Faktura (EHF) request
  const [orgNumber, setOrgNumber] = useState('');
  const [fakturaBusiness, setFakturaBusiness] = useState('');
  const [fakturaEmail, setFakturaEmail] = useState('');
  const [fakturaLoading, setFakturaLoading] = useState(false);
  const [fakturaDone, setFakturaDone] = useState(false);

  useEffect(() => {
    async function refreshProfile() {
      if (!token) return;
      try {
        const profileRes = await fetch('/api/client/profile', { headers: { Authorization: `Bearer ${token}` } });
        const data = await profileRes.json().catch(() => ({}));
        if (profileRes.ok && data.profile) {
          updateProfileState(data.profile);
        }
      } catch {
        // Ignore refresh errors.
      }
    }
    void refreshProfile();
  }, [token, updateProfileState]);

  useEffect(() => {
    let active = true;
    async function loadPromotionCode() {
      if (!token) return;
      try {
        const response = await fetch('/api/client/checkout/promotion-code', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !active) return;
        const promotion = (payload.promotionCode || null) as AppliedPromotionCode | null;
        setAppliedCoupon(promotion);
        setCouponInput(promotion?.code || '');
      } catch {
        if (!active) return;
      }
    }
    void loadPromotionCode();
    return () => {
      active = false;
    };
  }, [token, user?.id]);

  // Load Stripe publishable key and prep the client SDK once.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const cfg = await requestClientApi<{ configured: boolean; publishableKey: string }>(
          '/api/client/checkout/config',
        );
        if (!active) return;
        if (cfg.configured && cfg.publishableKey) {
          setStripePromise(loadStripe(cfg.publishableKey));
          setCardConfigured(true);
        } else {
          setCardConfigured(false);
        }
      } catch {
        if (active) setCardConfigured(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Returning from a completed embedded Checkout (Stripe appends ?session_id=).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session_id');
    if (!sessionId) return;
    (async () => {
      try {
        const res = await requestClientApi<{ status: string }>(
          `/api/client/checkout/session-status?session_id=${encodeURIComponent(sessionId)}`,
        );
        if (res.status === 'complete') setPaid(true);
      } catch {
        // Ignore — webhook is the source of truth.
      } finally {
        window.history.replaceState({}, '', '/kunde/tjenester/nettside/checkout');
      }
    })();
  }, []);

  // Reflect a confirmed subscription (set by the Stripe webhook) on load.
  useEffect(() => {
    if (profile?.payment?.status === 'active') setPaid(true);
  }, [profile]);

  useEffect(() => {
    setFakturaBusiness((prev) => prev || profile?.businessName || '');
    setFakturaEmail((prev) => prev || profile?.email || '');
  }, [profile?.businessName, profile?.email]);

  const createCardSession = useCallback(async () => {
    setCardError('');
    setCardLoading(true);
    try {
      const res = await requestClientApi<{ clientSecret: string }>(
        '/api/client/checkout/create-session',
        { method: 'POST' },
      );
      setClientSecret(res.clientSecret || '');
    } catch (err) {
      setCardError(err instanceof Error ? err.message : 'Kunne ikke starte kortbetaling.');
    } finally {
      setCardLoading(false);
    }
  }, []);

  // Create the embedded session as soon as the card method is active.
  useEffect(() => {
    if (method !== 'kort' || cardConfigured !== true) return;
    if (clientSecret || cardLoading || cardError) return;
    void createCardSession();
  }, [method, cardConfigured, clientSecret, cardLoading, cardError, createCardSession]);

  const selectedPlan = useMemo(() => formatPlanFromProfile(profile), [profile]);
  const subtotalAmount = parsePriceAmount(selectedPlan?.price || '');
  const discountAmount = Math.min(
    subtotalAmount,
    Math.max(0, Math.round(Number(appliedCoupon?.discountAmount || 0)))
  );
  const totalAmount = Math.max(0, subtotalAmount - discountAmount);

  function refreshEmbeddedCheckoutSession() {
    setClientSecret('');
    setCardError('');
  }

  async function applyCouponCode() {
    setCouponError('');
    const normalized = normalizeCouponCode(couponInput);
    if (!normalized) {
      setCouponError('Skriv inn en rabattkode.');
      return;
    }
    if (!token) return;
    setCouponBusy(true);
    try {
      const response = await fetch('/api/client/checkout/promotion-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: normalized }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Ugyldig rabattkode.');
      const promotion = (payload.promotionCode || null) as AppliedPromotionCode | null;
      setAppliedCoupon(promotion);
      setCouponInput(promotion?.code || normalized);
      if (method === 'kort') {
        refreshEmbeddedCheckoutSession();
      }
    } catch (err) {
      setAppliedCoupon(null);
      setCouponError(err instanceof Error ? err.message : 'Kunne ikke bruke rabattkoden.');
    } finally {
      setCouponBusy(false);
    }
  }

  async function removeCouponCode() {
    if (!token) {
      setAppliedCoupon(null);
      setCouponInput('');
      setCouponError('');
      return;
    }
    setCouponBusy(true);
    setCouponError('');
    try {
      const response = await fetch('/api/client/checkout/promotion-code', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke fjerne rabattkoden.');
      setAppliedCoupon(null);
      setCouponInput('');
      if (method === 'kort') {
        refreshEmbeddedCheckoutSession();
      }
    } catch (err) {
      setCouponError(err instanceof Error ? err.message : 'Kunne ikke fjerne rabattkoden.');
    } finally {
      setCouponBusy(false);
    }
  }

  async function submitFaktura(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    const cleanedOrg = orgNumber.replace(/\s+/g, '');
    if (!/^\d{9}$/.test(cleanedOrg)) {
      setError('Oppgi et gyldig organisasjonsnummer (9 siffer).');
      return;
    }
    setFakturaLoading(true);
    try {
      await requestClientApi('/api/client/checkout/request-faktura', {
        method: 'POST',
        body: JSON.stringify({ orgNumber: cleanedOrg, businessName: fakturaBusiness, invoiceEmail: fakturaEmail }),
      });
      setFakturaDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke sende fakturaforespørsel.');
    } finally {
      setFakturaLoading(false);
    }
  }

  return (
    <ClientRouteGuard>
      <Helmet>
        <title>Kundeportal – Checkout</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <ClientPortalLayout title="Bygger > Handlekurv > Checkout" subtitle="Betaling">
        {paid ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
            <h2 className="text-2xl font-semibold text-emerald-700">Betaling registrert</h2>
            <p className="mt-2 text-sm text-emerald-700/90">Tusen takk! Teamet vårt starter oppsettet av nettsiden din nå.</p>
          </div>
        ) : fakturaDone ? (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
            <h2 className="text-2xl font-semibold text-emerald-700">Fakturaforespørsel mottatt</h2>
            <p className="mt-2 text-sm text-emerald-700/90">
              Takk! Vi sender en EHF-faktura til bedriften din og starter oppsettet så snart den er bekreftet.
            </p>
          </div>
        ) : (
          <div className="grid xl:grid-cols-[1.2fr_0.8fr] gap-6">
            <div className="rounded-2xl border border-[#E5E7EB] bg-white p-6">
              <h2 className="text-4xl font-semibold text-[#111827]">Betalingsmåte</h2>
              <div className="mt-6 space-y-4">
                <PaymentOption
                  checked={method === 'faktura'}
                  onClick={() => setMethod('faktura')}
                  label="Faktura (EHF)"
                  badge="Til bedrift"
                />
                <PaymentOption
                  checked={method === 'vipps'}
                  onClick={() => setMethod('vipps')}
                  label="Vipps"
                  badge="Kommer snart"
                />
                <PaymentOption
                  checked={method === 'kort'}
                  onClick={() => setMethod('kort')}
                  label="Kortbetaling"
                  badge="Visa / Mastercard / AmEx"
                />
              </div>

              {method === 'kort' && (
                <div className="mt-6">
                  {cardConfigured === false ? (
                    <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                      Kortbetaling er ikke tilgjengelig akkurat nå. Velg faktura, eller prøv igjen senere.
                    </p>
                  ) : cardError ? (
                    <div className="rounded-xl border border-red-200 bg-red-50 p-4">
                      <p className="text-sm text-red-600">{cardError}</p>
                      <button
                        type="button"
                        onClick={() => void createCardSession()}
                        className="mt-3 rounded-lg bg-[#FF5B00] px-4 py-2 text-sm font-medium text-white hover:bg-[#E55200]"
                      >
                        Prøv igjen
                      </button>
                      <button
                        type="button"
                        onClick={() => setMethod('faktura')}
                        className="mt-3 ml-2 rounded-lg border border-[#E5E7EB] px-4 py-2 text-sm font-medium text-[#374151] hover:bg-[#F9FAFB]"
                      >
                        Betal med faktura i stedet
                      </button>
                    </div>
                  ) : clientSecret && stripePromise ? (
                    <div className="overflow-hidden rounded-xl border border-[#E5E7EB]">
                      <EmbeddedCheckoutProvider stripe={stripePromise} options={{ clientSecret }}>
                        <EmbeddedCheckout />
                      </EmbeddedCheckoutProvider>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 rounded-xl border border-[#E5E7EB] bg-[#FAFBFC] p-6 text-sm text-[#6B7280]">
                      <Loader2 size={16} className="animate-spin" /> Laster sikker kortbetaling…
                    </div>
                  )}
                </div>
              )}

              {method === 'vipps' && (
                <div className="mt-6 rounded-xl border border-[#E5E7EB] bg-[#FAFBFC] p-4 text-sm text-[#6B7280]">
                  Vipps kommer snart. Velg kort eller faktura i mellomtiden.
                </div>
              )}

              {method === 'faktura' && (
                <form onSubmit={submitFaktura} className="mt-6 rounded-xl border border-[#E5E7EB] bg-[#FAFBFC] p-4 space-y-3">
                  <p className="text-sm text-[#4B5563]">
                    Vi sender en EHF-faktura til bedriften din. Fyll inn organisasjonsnummeret så ordner vi resten.
                  </p>
                  <label className="block">
                    <span className="text-xs text-[#6B7280]">Bedriftsnavn</span>
                    <input
                      value={fakturaBusiness}
                      onChange={(e) => setFakturaBusiness(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#DDE2EA] bg-white px-3 py-2 outline-none"
                      placeholder="Bedrift AS"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-[#6B7280]">Organisasjonsnummer (9 siffer)</span>
                    <input
                      value={orgNumber}
                      onChange={(e) => setOrgNumber(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#DDE2EA] bg-white px-3 py-2 outline-none"
                      placeholder="123 456 789"
                      inputMode="numeric"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-[#6B7280]">Faktura-e-post</span>
                    <input
                      value={fakturaEmail}
                      onChange={(e) => setFakturaEmail(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-[#DDE2EA] bg-white px-3 py-2 outline-none"
                      placeholder="faktura@bedrift.no"
                      type="email"
                    />
                  </label>
                  {error ? <p className="text-sm text-red-500">{error}</p> : null}
                  <button
                    type="submit"
                    disabled={fakturaLoading}
                    className="w-full rounded-xl bg-[#FF5B00] py-3 text-white font-medium hover:bg-[#E55200] disabled:opacity-50"
                  >
                    {fakturaLoading ? (
                      <span className="inline-flex items-center gap-2"><Loader2 size={15} className="animate-spin" /> Sender…</span>
                    ) : (
                      'Be om faktura'
                    )}
                  </button>
                </form>
              )}

              {method !== 'faktura' && error ? <p className="mt-4 text-sm text-red-500">{error}</p> : null}
            </div>

            <aside className="rounded-2xl border border-[#E5E7EB] bg-white p-5 h-fit">
              <h3 className="text-2xl font-semibold text-[#111827]">{selectedPlan?.name || 'Plan ikke valgt'}</h3>
              <ul className="mt-4 space-y-2 text-sm text-[#374151]">
                {(selectedPlan?.features || []).map((feature) => (
                  <li key={feature}>• {feature}</li>
                ))}
              </ul>

              {offer?.previewUrl ? (
                <a
                  href={offer.previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex items-center gap-2 rounded-xl border border-[#111827] bg-white px-4 py-2 text-sm font-medium text-[#111827] hover:bg-[#F9FAFB]"
                >
                  <ExternalLink size={15} />
                  Forhåndsvis nettside
                </a>
              ) : null}

              <div className="mt-6 border-t border-[#E5E7EB] pt-4 text-sm">
                <div className="flex justify-between text-[#374151]">
                  <span>Subtotal</span>
                  <strong className="text-[#111827]">{selectedPlan?.price || '—'}</strong>
                </div>
                <div className="mt-1.5 flex justify-between text-[#374151]">
                  <span className="inline-flex items-center gap-1.5">
                    <Tag size={13} />
                    Rabatt{appliedCoupon ? ` (${appliedCoupon.code})` : ''}
                  </span>
                  <strong className={discountAmount > 0 ? 'text-emerald-600' : 'text-[#111827]'}>
                    {discountAmount > 0 ? `- ${formatPriceAmount(discountAmount, ',-')}` : '0,-'}
                  </strong>
                </div>
                <div className="mt-2.5 flex justify-between border-t border-[#F0F2F5] pt-2.5 text-base">
                  <span className="font-semibold text-[#111827]">Total</span>
                  <strong className="text-[#111827]">{formatPriceAmount(totalAmount)}</strong>
                </div>
              </div>
              <div className="mt-5 rounded-xl border border-[#E7E9EE] bg-[#FAFBFC] p-3.5">
                <label className="flex items-center gap-1.5 text-xs font-medium text-[#6B7280]">
                  <Tag size={13} />
                  Rabattkode
                </label>
                {appliedCoupon ? (
                  <div className="mt-2 flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
                    <span className="text-sm font-medium text-emerald-700">
                      {appliedCoupon.code} · {appliedCoupon.label}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removeCouponCode()}
                      disabled={couponBusy}
                      aria-label="Fjern rabattkode"
                      className="text-emerald-700 hover:text-emerald-900 disabled:opacity-60"
                    >
                      ✕
                    </button>
                  </div>
                ) : (
                  <div className="mt-2 flex gap-2">
                    <input
                      value={couponInput}
                      onChange={(e) => setCouponInput(normalizeCouponCode(e.target.value))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void applyCouponCode();
                        }
                      }}
                      placeholder="F.eks. ASOLDI10"
                      disabled={couponBusy}
                      className="flex-1 rounded-lg border border-[#DDE2EA] bg-white px-3 py-2 text-sm uppercase outline-none focus:border-[#FF5B00]"
                    />
                    <button
                      type="button"
                      onClick={() => void applyCouponCode()}
                      disabled={couponBusy || !couponInput.trim()}
                      className="rounded-lg bg-[#111827] px-4 py-2 text-sm font-medium text-white hover:bg-[#1F2937] disabled:opacity-60"
                    >
                      {couponBusy ? 'Sjekker…' : 'Bruk'}
                    </button>
                  </div>
                )}
                {couponError ? <p className="mt-2 text-xs text-red-500">{couponError}</p> : null}
              </div>
              <div className="mt-5 rounded-xl border border-[#E5E7EB] bg-[#FAFAFA] p-3 grid grid-cols-3 gap-2">
                {CHECKOUT_BENEFITS.map((benefit) => (
                  <div key={benefit.key} className="text-center">
                    <img src={benefit.illustration} alt={benefit.label} className="mx-auto h-10 w-10 object-contain" />
                    <p className="mt-2 text-[11px] text-[#4B5563] leading-4">{benefit.label}</p>
                  </div>
                ))}
              </div>
            </aside>
          </div>
        )}
      </ClientPortalLayout>
    </ClientRouteGuard>
  );
};

function PaymentOption({
  checked,
  onClick,
  label,
  badge,
}: {
  checked: boolean;
  onClick: () => void;
  label: string;
  badge: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-xl border px-4 py-3 flex items-center justify-between text-left ${
        checked ? 'border-[#FF5B00] bg-[#FFF7F2]' : 'border-[#E5E7EB] bg-white'
      }`}
    >
      <span className="inline-flex items-center gap-2">
        <span className={`h-4 w-4 rounded-full border ${checked ? 'border-[#FF5B00] bg-[#FF5B00]' : 'border-[#D1D5DB]'}`} />
        <span className="text-sm font-medium text-[#111827]">{label}</span>
      </span>
      <span className="text-xs text-[#6B7280]">{badge}</span>
    </button>
  );
}
