import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Check, ChevronDown, ChevronUp, ExternalLink, Loader2, Minus, Sparkles, Tag, X } from 'lucide-react';
import { ClientPortalLayout } from '../../components/client/ClientPortalLayout';
import { ClientRouteGuard } from '../../components/client/ClientRouteGuard';
import { useClientAuth } from '../../contexts/ClientAuthContext';
import { CHECKOUT_BENEFITS, CLIENT_WEBSITE_PLANS, findWebsitePlan } from '../../data/clientWebsitePlans';
import { useClientOffer } from './useClientOffer';
import {
  formatPriceAmount,
  normalizeCouponCode,
  parsePriceAmount,
} from '../../data/coupons';

type CheckoutLegalAcknowledgement = {
  termsAccepted: boolean;
  privacyAccepted: boolean;
  bindingAccepted: boolean;
  bindingMonths: number;
  planId: string;
  planName: string;
  acceptedAt: string;
};

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

const PREVIEW_FEATURE_COUNT = 4;

export const ClientWebsitePlans = () => {
  const navigate = useNavigate();
  const { token, user, profile, updateProfileState } = useClientAuth();
  const { offer, loading, error: offerError } = useClientOffer(token);
  const [error, setError] = useState('');
  const [selectedPlanId, setSelectedPlanId] = useState(profile?.websiteBuilder?.selectedPlanId || 'tier-1-standard');
  const [savingSelection, setSavingSelection] = useState(false);
  const [expandedCards, setExpandedCards] = useState<Record<string, boolean>>({});

  const [couponInput, setCouponInput] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<AppliedPromotionCode | null>(null);
  const [couponError, setCouponError] = useState('');
  const [couponBusy, setCouponBusy] = useState(false);
  const [agreements, setAgreements] = useState({
    termsAccepted: false,
    privacyAccepted: false,
    bindingAccepted: false,
  });
  const [agreementError, setAgreementError] = useState('');
  const previousPlanIdRef = useRef(selectedPlanId);

  useEffect(() => {
    if (offerError) setError(offerError);
  }, [offerError]);

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

  const offerPlan = useMemo(() => (offer ? findWebsitePlan(offer.planId) || null : null), [offer]);
  const selectedPlan = useMemo(
    () => findWebsitePlan(selectedPlanId) || CLIENT_WEBSITE_PLANS[0],
    [selectedPlanId],
  );

  const subtotalAmount = parsePriceAmount(selectedPlan?.price || '');
  const discountAmount = Math.min(
    subtotalAmount,
    Math.max(0, Math.round(Number(appliedCoupon?.discountAmount || 0)))
  );
  const totalAmount = Math.max(0, subtotalAmount - discountAmount);
  const allCheckoutAgreementsAccepted =
    agreements.termsAccepted && agreements.privacyAccepted && agreements.bindingAccepted;

  useEffect(() => {
    if (previousPlanIdRef.current && previousPlanIdRef.current !== selectedPlanId) {
      setAgreements((prev) => ({
        ...prev,
        bindingAccepted: false,
      }));
      setAgreementError('');
    }
    previousPlanIdRef.current = selectedPlanId;
  }, [selectedPlanId]);

  function buildLegalAcknowledgement(planId: string): CheckoutLegalAcknowledgement {
    const plan = findWebsitePlan(planId);
    return {
      termsAccepted: Boolean(agreements.termsAccepted),
      privacyAccepted: Boolean(agreements.privacyAccepted),
      bindingAccepted: Boolean(agreements.bindingAccepted),
      bindingMonths: 6,
      planId,
      planName: plan?.name || selectedPlan?.name || '',
      acceptedAt: new Date().toISOString(),
    };
  }

  async function saveSelection(planId: string, options: { legalAcknowledgement?: CheckoutLegalAcknowledgement } = {}) {
    setSavingSelection(true);
    setError('');
    try {
      const response = await fetch('/api/client/plans/website/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          type: 'standard',
          planId,
          legalAcknowledgement: options.legalAcknowledgement,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke lagre planvalg.');
      if (payload.profile) updateProfileState(payload.profile);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre planvalg.');
    } finally {
      setSavingSelection(false);
    }
  }

  async function choosePlan(planId: string) {
    setAgreementError('');
    setSelectedPlanId(planId);
    await saveSelection(planId);
    if (appliedCoupon) {
      await removeCoupon({ silent: true });
    }
  }

  async function applyCoupon() {
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
    } catch (err) {
      setAppliedCoupon(null);
      setCouponError(err instanceof Error ? err.message : 'Kunne ikke bruke rabattkoden.');
    } finally {
      setCouponBusy(false);
    }
  }

  async function removeCoupon(options: { silent?: boolean } = {}) {
    if (!token) {
      setAppliedCoupon(null);
      setCouponInput('');
      setCouponError('');
      return;
    }
    setCouponBusy(true);
    if (!options.silent) setCouponError('');
    try {
      const response = await fetch('/api/client/checkout/promotion-code', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke fjerne rabattkoden.');
    } catch (err) {
      if (!options.silent) {
        setCouponError(err instanceof Error ? err.message : 'Kunne ikke fjerne rabattkoden.');
      }
      return;
    } finally {
      setCouponBusy(false);
    }
    setAppliedCoupon(null);
    setCouponInput('');
    if (!options.silent) setCouponError('');
  }

  async function goToCheckout() {
    setAgreementError('');
    if (!allCheckoutAgreementsAccepted) {
      setAgreementError('Du må godkjenne vilkår, personvern og bindingstid før du går til checkout.');
      return;
    }
    await saveSelection(selectedPlanId, {
      legalAcknowledgement: buildLegalAcknowledgement(selectedPlanId),
    });
    navigate('/kunde/tjenester/nettside/checkout');
  }

  function toggleExpand(id: string) {
    setExpandedCards((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <ClientRouteGuard>
      <Helmet>
        <title>Kundeportal – Handlekurv</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <ClientPortalLayout title="Handlekurv" subtitle="Velg din nettsideplan">
        {loading ? (
          <div className="min-h-[280px] flex items-center justify-center text-[#6B7280]">
            <Loader2 className="animate-spin mr-2" size={18} /> Laster…
          </div>
        ) : (
          <div className="grid xl:grid-cols-[1.35fr_0.85fr] gap-6">
            <div className="space-y-5">
              {offer ? (
                <div className="overflow-hidden rounded-2xl border-2 border-[#FFB68F] bg-gradient-to-br from-[#FFF3EC] via-[#FFF8F5] to-white">
                  <div className="p-6">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FF5B00] px-3 py-1 text-xs font-semibold text-white">
                          <Sparkles size={13} />
                          Ditt tilbud fra Asoldi
                        </span>
                        <h2 className="mt-3 text-2xl font-semibold text-[#111827]">
                          {offer.planName || offerPlan?.name || 'Nettsideplan'}
                        </h2>
                        {offer.note ? <p className="mt-1 max-w-md text-sm text-[#6B7280]">{offer.note}</p> : null}
                      </div>
                      <div className="text-right">
                        <p className="text-2xl font-bold text-[#111827]">{offer.price || offerPlan?.price}</p>
                        <p className="text-xs text-[#9CA3AF]">Kode: {offer.code}</p>
                      </div>
                    </div>

                    {offerPlan ? (
                      <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                        {offerPlan.includedFeatures.slice(0, 6).map((feature) => (
                          <li key={feature} className="flex items-start gap-2 text-sm text-[#374151]">
                            <Check size={15} className="mt-0.5 shrink-0 text-[#FF5B00]" />
                            <span>{feature}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    <div className="mt-5 flex flex-wrap gap-3">
                      {offer.previewUrl ? (
                        <a
                          href={offer.previewUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-2 rounded-xl border border-[#111827] bg-white px-4 py-2.5 text-sm font-medium text-[#111827] hover:bg-[#F9FAFB]"
                        >
                          <ExternalLink size={15} />
                          Forhåndsvis nettside
                        </a>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => choosePlan(offer.planId)}
                        disabled={savingSelection}
                        className={`inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium disabled:opacity-50 ${
                          selectedPlanId === offer.planId
                            ? 'bg-[#FF5B00] text-white'
                            : 'border border-[#FFB68F] bg-white text-[#111827] hover:bg-[#FFF3EC]'
                        }`}
                      >
                        {selectedPlanId === offer.planId ? (
                          <>
                            <Check size={15} /> Valgt
                          </>
                        ) : (
                          'Velg dette tilbudet'
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}

              <div>
                <h3 className="text-lg font-semibold text-[#111827]">Velg din nettsideplan</h3>
                <p className="mt-1 text-sm text-[#6B7280]">Planene er basert på nettsideutvikling i prisoversikten vår.</p>

                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  {CLIENT_WEBSITE_PLANS.map((plan) => {
                    const isSelected = selectedPlanId === plan.id;
                    const isExpanded = Boolean(expandedCards[plan.id]);
                    const previewFeatures = plan.includedFeatures.slice(0, PREVIEW_FEATURE_COUNT);
                    const restFeatures = plan.includedFeatures.slice(PREVIEW_FEATURE_COUNT);
                    return (
                      <div
                        key={plan.id}
                        className={`relative flex flex-col rounded-2xl border bg-white p-5 transition-colors ${
                          isSelected ? 'border-[#FF5B00] shadow-[0_8px_24px_rgba(255,91,0,0.10)]' : 'border-[#E7E9EE] hover:border-[#D8DCE3]'
                        }`}
                      >
                        {plan.popular ? (
                          <span className="absolute right-4 top-4 rounded-full bg-[#FFE7DA] px-2.5 py-1 text-[11px] font-semibold text-[#FF5B00]">
                            Mest populær
                          </span>
                        ) : null}

                        <h4 className="text-base font-semibold text-[#111827]">{plan.name}</h4>
                        <p className="mt-1 text-xs text-[#9CA3AF] min-h-[32px]">{plan.description}</p>

                        <div className="mt-3 flex items-baseline gap-1">
                          <span className="text-2xl font-bold text-[#111827]">{plan.price.replace('/mnd', '')}</span>
                          <span className="text-sm text-[#9CA3AF]">/mnd</span>
                        </div>

                        <ul className="mt-4 space-y-2 border-t border-[#F0F2F5] pt-4">
                          {previewFeatures.map((feature) => (
                            <li key={feature} className="flex items-start gap-2 text-sm text-[#374151]">
                              <Check size={15} className="mt-0.5 shrink-0 text-[#FF5B00]" />
                              <span>{feature}</span>
                            </li>
                          ))}
                          {isExpanded
                            ? restFeatures.map((feature) => (
                                <li key={feature} className="flex items-start gap-2 text-sm text-[#374151]">
                                  <Check size={15} className="mt-0.5 shrink-0 text-[#FF5B00]" />
                                  <span>{feature}</span>
                                </li>
                              ))
                            : null}
                          {isExpanded
                            ? plan.notIncludedFeatures.map((feature) => (
                                <li key={feature} className="flex items-start gap-2 text-sm text-[#B6BBC4]">
                                  <Minus size={15} className="mt-0.5 shrink-0 text-[#CBD0D8]" />
                                  <span>{feature}</span>
                                </li>
                              ))
                            : null}
                        </ul>

                        {restFeatures.length || plan.notIncludedFeatures.length ? (
                          <button
                            type="button"
                            onClick={() => toggleExpand(plan.id)}
                            className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[#6B7280] hover:text-[#111827]"
                          >
                            {isExpanded ? (
                              <>
                                Vis mindre <ChevronUp size={14} />
                              </>
                            ) : (
                              <>
                                Les mer <ChevronDown size={14} />
                              </>
                            )}
                          </button>
                        ) : null}

                        <button
                          type="button"
                          onClick={() => choosePlan(plan.id)}
                          disabled={savingSelection}
                          className={`mt-5 w-full rounded-xl py-2.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                            isSelected
                              ? 'bg-[#FF5B00] text-white'
                              : 'border border-[#D7DCE5] bg-white text-[#111827] hover:bg-[#F9FAFB]'
                          }`}
                        >
                          {isSelected ? 'Valgt' : 'Velg'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <aside className="rounded-2xl border border-[#E7E9EE] bg-white p-5 h-fit xl:sticky xl:top-6">
              <h3 className="text-lg font-semibold text-[#111827]">Sammendrag</h3>
              <p className="mt-1 text-sm text-[#6B7280]">{selectedPlan?.name}</p>

              <ul className="mt-4 space-y-2">
                {(selectedPlan?.includedFeatures || []).slice(0, 6).map((item) => (
                  <li key={item} className="flex items-start gap-2 text-sm text-[#374151]">
                    <Check size={14} className="mt-0.5 shrink-0 text-[#FF5B00]" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-5 border-t border-[#F0F2F5] pt-4 text-sm">
                <div className="flex justify-between text-[#374151]">
                  <span>Subtotal</span>
                  <strong className="text-[#111827]">{selectedPlan?.price || '—'}</strong>
                </div>
                <div className="mt-1.5 flex justify-between text-[#374151]">
                  <span>Rabatt{appliedCoupon ? ` (${appliedCoupon.code})` : ''}</span>
                  <strong className={discountAmount > 0 ? 'text-emerald-600' : 'text-[#111827]'}>
                    {discountAmount > 0 ? `- ${formatPriceAmount(discountAmount, ',-')}` : '0,-'}
                  </strong>
                </div>
                <div className="mt-2.5 flex justify-between border-t border-[#F0F2F5] pt-2.5 text-base">
                  <span className="font-semibold text-[#111827]">Total</span>
                  <strong className="text-[#111827]">{formatPriceAmount(totalAmount)}</strong>
                </div>
              </div>

              {/* Coupon section */}
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
                      onClick={() => void removeCoupon()}
                      disabled={couponBusy}
                      aria-label="Fjern rabattkode"
                      className="text-emerald-700 hover:text-emerald-900 disabled:opacity-60"
                    >
                      <X size={15} />
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
                          void applyCoupon();
                        }
                      }}
                      placeholder="F.eks. ASOLDI10"
                      disabled={couponBusy}
                      className="flex-1 rounded-lg border border-[#DDE2EA] bg-white px-3 py-2 text-sm uppercase outline-none focus:border-[#FF5B00]"
                    />
                    <button
                      type="button"
                      onClick={() => void applyCoupon()}
                      disabled={couponBusy || !couponInput.trim()}
                      className="rounded-lg bg-[#111827] px-4 py-2 text-sm font-medium text-white hover:bg-[#1F2937] disabled:opacity-60"
                    >
                      {couponBusy ? 'Sjekker…' : 'Bruk'}
                    </button>
                  </div>
                )}
                {couponError ? <p className="mt-2 text-xs text-red-500">{couponError}</p> : null}
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 rounded-xl border border-[#EDEFF3] bg-[#FCFCFD] p-3">
                {CHECKOUT_BENEFITS.map((benefit) => (
                  <div key={benefit.key} className="text-center">
                    <img src={benefit.illustration} alt={benefit.label} className="mx-auto h-9 w-9 object-contain" />
                    <p className="mt-2 text-[11px] leading-4 text-[#6B7280]">{benefit.label}</p>
                  </div>
                ))}
              </div>

              {error ? <p className="mt-3 text-sm text-red-500">{error}</p> : null}

              <div className="mt-5 rounded-xl border border-[#E7E9EE] bg-[#FAFBFC] p-3.5 space-y-2.5">
                <p className="text-xs font-semibold uppercase tracking-wide text-[#6B7280]">Bekreft før checkout</p>
                <label htmlFor="plans-agree-terms" className="flex items-start gap-2.5 text-sm text-[#374151]">
                  <input
                    id="plans-agree-terms"
                    type="checkbox"
                    checked={agreements.termsAccepted}
                    onChange={(event) => {
                      setAgreements((prev) => ({ ...prev, termsAccepted: event.target.checked }));
                      setAgreementError('');
                    }}
                    className="mt-0.5 h-4 w-4 rounded border-[#D1D5DB] text-[#FF5B00] focus:ring-[#FF5B00]"
                  />
                  <span>
                    Jeg godtar{' '}
                    <a
                      href="https://asoldi.com/vilkar"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-[#FF5B00] underline hover:text-[#E55200]"
                    >
                      vilkår og betingelser
                    </a>
                    .
                  </span>
                </label>
                <label htmlFor="plans-agree-privacy" className="flex items-start gap-2.5 text-sm text-[#374151]">
                  <input
                    id="plans-agree-privacy"
                    type="checkbox"
                    checked={agreements.privacyAccepted}
                    onChange={(event) => {
                      setAgreements((prev) => ({ ...prev, privacyAccepted: event.target.checked }));
                      setAgreementError('');
                    }}
                    className="mt-0.5 h-4 w-4 rounded border-[#D1D5DB] text-[#FF5B00] focus:ring-[#FF5B00]"
                  />
                  <span>
                    Jeg godtar{' '}
                    <a
                      href="https://asoldi.com/personvern"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-[#FF5B00] underline hover:text-[#E55200]"
                    >
                      personvernerklæringen
                    </a>
                    .
                  </span>
                </label>
                <label htmlFor="plans-agree-binding" className="flex items-start gap-2.5 text-sm text-[#374151]">
                  <input
                    id="plans-agree-binding"
                    type="checkbox"
                    checked={agreements.bindingAccepted}
                    onChange={(event) => {
                      setAgreements((prev) => ({ ...prev, bindingAccepted: event.target.checked }));
                      setAgreementError('');
                    }}
                    className="mt-0.5 h-4 w-4 rounded border-[#D1D5DB] text-[#FF5B00] focus:ring-[#FF5B00]"
                  />
                  <span>
                    Jeg anerkjenner at ved kjøp av nettside <strong>{selectedPlan?.name || 'valgt nivå'}</strong> er det
                    bindingstid på 6 måneder.
                  </span>
                </label>
              </div>
              {agreementError ? <p className="mt-3 text-sm text-red-500">{agreementError}</p> : null}

              <button
                type="button"
                onClick={goToCheckout}
                disabled={savingSelection || !allCheckoutAgreementsAccepted}
                className="mt-5 w-full rounded-xl bg-[#FF5B00] py-3 text-sm font-semibold text-white hover:bg-[#E55200] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingSelection ? 'Lagrer…' : 'Gå til checkout'}
              </button>
            </aside>
          </div>
        )}
      </ClientPortalLayout>
    </ClientRouteGuard>
  );
};
