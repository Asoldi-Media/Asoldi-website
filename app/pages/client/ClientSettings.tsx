import React, { useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Users,
} from 'lucide-react';
import { ClientRouteGuard } from '../../components/client/ClientRouteGuard';
import { ClientPortalLayout } from '../../components/client/ClientPortalLayout';
import { useClientAuth } from '../../contexts/ClientAuthContext';
import { CLIENT_WEBSITE_PLANS } from '../../data/clientWebsitePlans';
import { SettingsInnerNav } from '../../components/client/settings/SettingsInnerNav';
import { BusinessCardSection } from '../../components/client/settings/BusinessCardSection';
import { ProductsSection } from '../../components/client/settings/ProductsSection';
import { MediaSection } from '../../components/client/settings/MediaSection';
import { GeneralInfoSection } from '../../components/client/settings/GeneralInfoSection';
import { StaffSection } from '../../components/client/settings/StaffSection';
import { WebsiteQuestionsSection } from '../../components/client/settings/WebsiteQuestionsSection';
import {
  type ClientDataBank,
  type DataTab,
  type SettingsSection,
  dataTabFromHash,
  ensureClientDataBank,
  hashForDataTab,
  sectionPath,
} from '../../components/client/settings/clientDataTypes';

type BillingSummary = {
  status: string;
  method: string;
  planId: string;
  planName: string;
  amount: number;
  currency: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  paidAt: string;
  updatedAt: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string;
  cancelAt: string;
  canceledAt: string;
};

type BillingInvoice = {
  id: string;
  number: string;
  status: string;
  paid: boolean;
  amountPaid: number;
  amountDue: number;
  currency: string;
  createdAt: string;
  dueAt: string;
  paidAt: string;
  hostedInvoiceUrl: string;
  invoicePdf: string;
};

type BillingOverview = {
  summary: BillingSummary;
  subscription: {
    id: string;
    status: string;
    planId: string;
    planName: string;
    priceId: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string;
    cancelAt: string;
    canceledAt: string;
  } | null;
  invoices: BillingInvoice[];
  stripePortalAvailable: boolean;
  warnings: string[];
  availablePlans: Array<{
    id: string;
    name: string;
    price: string;
    description: string;
    isCurrent: boolean;
    stripePriceConfigured: boolean;
  }>;
};

const BILLING_STATUS_LABELS: Record<string, string> = {
  none: 'Ingen aktiv betalingsavtale',
  processing: 'Under behandling',
  active: 'Aktiv',
  past_due: 'Forfalt',
  canceled: 'Avsluttet',
  invoice_requested: 'Faktura forespurt',
  paid: 'Betalt',
  open: 'Åpen',
  draft: 'Utkast',
  void: 'Annullert',
  uncollectible: 'Ikke innkrevbar',
  trialing: 'Prøveperiode',
  unpaid: 'Ubetalt',
  incomplete: 'Ufullstendig',
};

function toIsoDate(value: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('nb-NO');
}

function toMoney(amount: number, currency = 'nok') {
  const normalizedCurrency = String(currency || 'nok').toUpperCase();
  try {
    return new Intl.NumberFormat('nb-NO', {
      style: 'currency',
      currency: normalizedCurrency,
      maximumFractionDigits: 0,
    }).format(Number.isFinite(amount) ? amount : 0);
  } catch {
    return `${Math.round(Number(amount || 0)).toLocaleString('nb-NO')},-`;
  }
}

export const ClientSettings = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    token,
    user,
    profile,
    businesses,
    activeBusinessId,
    membership,
    updateProfileState,
    refreshClientSession,
    clearClientSession,
  } = useClientAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [members, setMembers] = useState<Array<{
    id: string;
    userId: string;
    email: string;
    role: string;
    status: string;
  }>>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'collaborator'>('collaborator');
  const [newBusinessName, setNewBusinessName] = useState('');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [transferUserId, setTransferUserId] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [billing, setBilling] = useState<BillingOverview | null>(null);
  const [clientData, setClientData] = useState<ClientDataBank>(() => ensureClientDataBank(profile?.clientDataBank, profile));

  const activeSection: SettingsSection = useMemo(() => {
    if (location.pathname.endsWith('/fakturering') || location.pathname.endsWith('/billing')) return 'fakturering';
    if (location.pathname.endsWith('/konto')) return 'konto';
    return 'kundedata';
  }, [location.pathname]);
  const [dataTab, setDataTab] = useState<DataTab>(() => dataTabFromHash(window.location.hash));

  function selectDataTab(tab: DataTab) {
    setDataTab(tab);
    navigate(`/kunde/innstillinger${hashForDataTab(tab)}`, { replace: true });
  }

  function selectSection(section: SettingsSection) {
    if (section === 'kundedata') {
      navigate(`/kunde/innstillinger${hashForDataTab(dataTab)}`);
      return;
    }
    navigate(sectionPath(section));
  }

  useEffect(() => {
    if (activeSection !== 'kundedata') return;
    setDataTab(dataTabFromHash(window.location.hash));
  }, [activeSection, location.pathname]);

  useEffect(() => {
    let active = true;
    async function loadSettings() {
      if (!token) return;
      setError('');
      try {
        const response = await fetch('/api/client/settings', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || 'Kunne ikke laste innstillinger.');
        if (!active) return;
        if (payload.profile) updateProfileState(payload.profile);
        if (Array.isArray(payload.members)) setMembers(payload.members);
        setLoginEmail((prev) => prev || payload.user?.email || user?.email || '');
        setClientData(ensureClientDataBank(payload.clientDataBank || payload.profile?.clientDataBank, payload.profile || profile));
        setBilling((payload.billing || null) as BillingOverview | null);
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : 'Kunne ikke laste innstillinger.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadSettings();
    return () => {
      active = false;
    };
  }, [token, updateProfileState, activeBusinessId]);

  async function refreshBillingOnly() {
    if (!token) return;
    const response = await fetch('/api/client/billing/overview', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || 'Kunne ikke laste fakturering.');
    setBilling((payload.billing || null) as BillingOverview | null);
  }

  async function saveClientData() {
    if (!token) return;
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/api/client/settings/client-data', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ clientDataBank: clientData }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke lagre kundedata.');
      if (payload.profile) updateProfileState(payload.profile);
      setClientData(ensureClientDataBank(payload.clientDataBank || payload.profile?.clientDataBank, payload.profile || profile));
      setSuccess('Kundedata er lagret.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre kundedata.');
    } finally {
      setSaving(false);
    }
  }

  async function openStripePortal() {
    if (!token) return;
    setBusyAction('portal');
    setError('');
    try {
      const response = await fetch('/api/client/billing/portal-session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke åpne Stripe-portalen.');
      if (!payload.url) throw new Error('Mangler portal-lenke.');
      window.location.href = payload.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke åpne Stripe-portalen.');
    } finally {
      setBusyAction('');
    }
  }

  async function upgradePlan(planId: string) {
    if (!token) return;
    setBusyAction(`upgrade:${planId}`);
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/api/client/billing/upgrade-subscription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ planId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke oppgradere abonnement.');
      if (payload.mode === 'checkout' && payload.redirect) {
        setSuccess(payload.message || 'Planen ble oppdatert. Fullfør i betaling.');
        navigate(payload.redirect);
        return;
      }
      await refreshBillingOnly();
      setSuccess(payload.message || 'Abonnementet er oppgradert.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke oppgradere abonnement.');
    } finally {
      setBusyAction('');
    }
  }

  async function cancelSubscription() {
    if (!token) return;
    setBusyAction('cancel');
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/api/client/billing/cancel-subscription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ immediate: false }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke avslutte abonnementet.');
      if (payload.billing) setBilling(payload.billing as BillingOverview);
      setSuccess(payload.message || 'Abonnementet avsluttes ved periodens slutt.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke avslutte abonnementet.');
    } finally {
      setBusyAction('');
    }
  }

  async function resumeSubscription() {
    if (!token) return;
    setBusyAction('resume');
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/api/client/billing/resume-subscription', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke gjenoppta abonnementet.');
      if (payload.billing) setBilling(payload.billing as BillingOverview);
      setSuccess(payload.message || 'Abonnementet er aktivt igjen.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke gjenoppta abonnementet.');
    } finally {
      setBusyAction('');
    }
  }

  const canManageMembers = membership?.role === 'owner' || membership?.role === 'admin';
  const canTransfer = membership?.role === 'owner';

  async function inviteMember() {
    if (!token || !activeBusinessId) return;
    setBusyAction('invite');
    setError('');
    setSuccess('');
    try {
      const response = await fetch(`/api/client/businesses/${encodeURIComponent(activeBusinessId)}/members`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke invitere.');
      if (Array.isArray(payload.members)) setMembers(payload.members);
      setInviteEmail('');
      setSuccess(payload.alreadyPending ? 'Invitasjonen venter allerede.' : 'Personen er lagt til eller invitert.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke invitere.');
    } finally {
      setBusyAction('');
    }
  }

  async function revokeMember(membershipId: string) {
    if (!token || !activeBusinessId) return;
    setBusyAction(`revoke:${membershipId}`);
    setError('');
    try {
      const response = await fetch(
        `/api/client/businesses/${encodeURIComponent(activeBusinessId)}/members/${encodeURIComponent(membershipId)}/revoke`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke fjerne medlemmet.');
      if (Array.isArray(payload.members)) setMembers(payload.members);
      setSuccess('Medlemmet er fjernet.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke fjerne medlemmet.');
    } finally {
      setBusyAction('');
    }
  }

  async function createBusiness() {
    if (!token) return;
    setBusyAction('create-business');
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/api/client/businesses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name: newBusinessName }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke opprette bedrift.');
      await refreshClientSession();
      setNewBusinessName('');
      setSuccess('Ny bedrift er opprettet. Du kan bytte i menyen øverst.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke opprette bedrift.');
    } finally {
      setBusyAction('');
    }
  }

  async function changeLoginEmail() {
    if (!token) return;
    setBusyAction('change-email');
    setError('');
    setSuccess('');
    try {
      const response = await fetch('/api/client/account/change-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke bytte e-post.');
      setLoginPassword('');
      await refreshClientSession();
      setSuccess('Innloggings-e-post er oppdatert.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke bytte e-post.');
    } finally {
      setBusyAction('');
    }
  }

  async function transferBusiness() {
    if (!token || !activeBusinessId) return;
    setBusyAction('transfer');
    setError('');
    setSuccess('');
    try {
      const response = await fetch(`/api/client/businesses/${encodeURIComponent(activeBusinessId)}/transfer`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userId: transferUserId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke overføre bedriften.');
      if (Array.isArray(payload.members)) setMembers(payload.members);
      await refreshClientSession();
      setSuccess('Eierskap er overført. Du er nå admin på denne bedriften.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke overføre bedriften.');
    } finally {
      setBusyAction('');
    }
  }

  async function deleteAccount() {
    if (!token) return;
    if (deleteConfirm.trim().toUpperCase() !== 'SLETT') {
      setError('Skriv "SLETT" for å bekrefte kontoavslutning.');
      return;
    }
    setDeletingAccount(true);
    setError('');
    try {
      const response = await fetch('/api/client/account/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ confirmText: deleteConfirm }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke avslutte kontoen.');
      clearClientSession();
      navigate('/login/kunde', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke avslutte kontoen.');
    } finally {
      setDeletingAccount(false);
    }
  }

  const summary = billing?.summary;
  const invoices = billing?.invoices || [];
  const pageTitle = activeSection === 'fakturering'
    ? 'Fakturering'
    : activeSection === 'konto'
      ? 'Konto'
      : 'Bedrifts info';

  return (
    <ClientRouteGuard>
      <Helmet>
        <title>Kundeportal – Innstillinger</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <ClientPortalLayout
        title="Innstillinger"
        subtitle="Kundedata, fakturering og konto"
        innerNav={(
          <SettingsInnerNav
            section={activeSection}
            dataTab={dataTab}
            onSection={selectSection}
            onDataTab={selectDataTab}
          />
        )}
      >
        {!profile && loading ? (
          <div className="min-h-[320px] flex items-center justify-center text-[#6B7280]">
            <Loader2 size={18} className="animate-spin mr-2" />
            Laster innstillinger...
          </div>
        ) : (
          <div className="flex flex-col min-h-full">
            <div className="h-[72px] border-b border-gray-100 flex items-center px-6 shrink-0 justify-between bg-white">
              <span className="font-bold text-[18px]">{pageTitle}</span>
              <div className="w-[100px]" />
            </div>

            <div className="flex-1 p-6 md:p-10 relative">
              {error ? (
                <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
              ) : null}
              {success ? (
                <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 inline-flex items-center gap-2">
                  <CheckCircle2 size={14} />
                  {success}
                </div>
              ) : null}

              {activeSection === 'kundedata' && dataTab === 'bedrifts_kort' && token ? (
                <BusinessCardSection
                  token={token}
                  clientData={clientData}
                  setClientData={setClientData}
                  onError={setError}
                  onSaved={updateProfileState}
                />
              ) : null}
              {activeSection === 'kundedata' && dataTab === 'produkter' && token ? (
                <ProductsSection
                  token={token}
                  clientData={clientData}
                  setClientData={setClientData}
                  onError={setError}
                  onProfile={updateProfileState}
                />
              ) : null}
              {activeSection === 'kundedata' && dataTab === 'media' && token ? (
                <MediaSection token={token} clientData={clientData} setClientData={setClientData} onError={setError} />
              ) : null}
              {activeSection === 'kundedata' && dataTab === 'ansatte' && token ? (
                <StaffSection token={token} clientData={clientData} setClientData={setClientData} onError={setError} />
              ) : null}
              {activeSection === 'kundedata' && dataTab === 'generell' && token ? (
                <GeneralInfoSection token={token} clientData={clientData} setClientData={setClientData} onError={setError} />
              ) : null}
              {activeSection === 'kundedata' && dataTab === 'v2' ? (
                <WebsiteQuestionsSection clientData={clientData} setClientData={setClientData} />
              ) : null}

              {activeSection === 'fakturering' ? (
                loading && !billing ? (
                  <div className="min-h-[240px] flex items-center justify-center text-[#6B7280]">
                    <Loader2 size={18} className="animate-spin mr-2" />
                    Laster fakturering...
                  </div>
                ) : (
                  <div className="space-y-5 max-w-4xl">
                    <section className="rounded-2xl border border-[#E5E7EB] bg-white p-5">
                      <h2 className="text-lg font-semibold text-[#111827]">Abonnement og fakturering</h2>
                      <div className="mt-4 grid gap-4 md:grid-cols-3">
                        <div className="rounded-xl border border-[#E5E7EB] bg-[#FAFBFC] p-4">
                          <p className="text-xs text-[#6B7280]">Status</p>
                          <p className="mt-1 text-sm font-semibold text-[#111827]">
                            {BILLING_STATUS_LABELS[String(summary?.status || '')] || summary?.status || 'Ukjent'}
                          </p>
                        </div>
                        <div className="rounded-xl border border-[#E5E7EB] bg-[#FAFBFC] p-4">
                          <p className="text-xs text-[#6B7280]">Aktiv plan</p>
                          <p className="mt-1 text-sm font-semibold text-[#111827]">{summary?.planName || 'Ingen plan valgt'}</p>
                          <p className="mt-1 text-xs text-[#6B7280]">{toMoney(Number(summary?.amount || 0), summary?.currency || 'nok')}/mnd</p>
                        </div>
                        <div className="rounded-xl border border-[#E5E7EB] bg-[#FAFBFC] p-4">
                          <p className="text-xs text-[#6B7280]">Neste periode-slutt</p>
                          <p className="mt-1 text-sm font-semibold text-[#111827]">
                            {summary?.currentPeriodEnd ? toIsoDate(summary.currentPeriodEnd) : 'Ikke tilgjengelig'}
                          </p>
                        </div>
                      </div>
                      {billing?.warnings?.length ? (
                        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                          {billing.warnings.map((warning) => (
                            <p key={warning}>{warning}</p>
                          ))}
                        </div>
                      ) : null}
                      <div className="mt-4 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void openStripePortal()}
                          disabled={busyAction === 'portal' || !billing?.stripePortalAvailable}
                          className="inline-flex items-center gap-2 rounded-lg border border-[#D1D5DB] px-4 py-2 text-sm text-[#111827] hover:bg-[#F9FAFB] disabled:opacity-50"
                        >
                          {busyAction === 'portal' ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                          Administrer i Stripe
                        </button>
                        {summary?.cancelAtPeriodEnd ? (
                          <button
                            type="button"
                            onClick={() => void resumeSubscription()}
                            disabled={busyAction === 'resume'}
                            className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                          >
                            {busyAction === 'resume' ? 'Gjenopptar...' : 'Gjenoppta abonnement'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void cancelSubscription()}
                            disabled={busyAction === 'cancel'}
                            className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700 hover:bg-red-100 disabled:opacity-50"
                          >
                            {busyAction === 'cancel' ? 'Avslutter...' : 'Avslutt abonnement ved periodens slutt'}
                          </button>
                        )}
                      </div>
                    </section>
                    <section className="rounded-2xl border border-[#E5E7EB] bg-white p-5">
                      <h2 className="text-lg font-semibold text-[#111827]">Oppgrader abonnementstier</h2>
                      <p className="mt-1 text-sm text-[#6B7280]">
                        Velg ny plan. Dersom aktivt Stripe-abonnement finnes, oppdateres det direkte.
                      </p>
                      <div className="mt-4 grid gap-3 md:grid-cols-3">
                        {(billing?.availablePlans?.length ? billing.availablePlans : CLIENT_WEBSITE_PLANS.map((plan) => ({
                          id: plan.id,
                          name: plan.name,
                          price: plan.price,
                          description: plan.description,
                          isCurrent: summary?.planId === plan.id,
                          stripePriceConfigured: true,
                        }))).map((plan) => (
                          <div key={plan.id} className={`rounded-xl border p-4 ${plan.isCurrent ? 'border-[#FF5B00] bg-[#FFF7F2]' : 'border-[#E5E7EB] bg-white'}`}>
                            <p className="text-sm font-semibold text-[#111827]">{plan.name}</p>
                            <p className="mt-1 text-sm text-[#6B7280]">{plan.price}</p>
                            <p className="mt-2 text-xs text-[#6B7280]">{plan.description}</p>
                            <button
                              type="button"
                              onClick={() => void upgradePlan(plan.id)}
                              disabled={plan.isCurrent || busyAction === `upgrade:${plan.id}`}
                              className="mt-4 w-full rounded-lg bg-[#111827] px-3 py-2 text-sm text-white hover:bg-[#1F2937] disabled:opacity-50"
                            >
                              {plan.isCurrent
                                ? 'Aktiv plan'
                                : busyAction === `upgrade:${plan.id}`
                                  ? 'Oppgraderer...'
                                  : 'Oppgrader til denne'}
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>
                    <section className="rounded-2xl border border-[#E5E7EB] bg-white p-5">
                      <h2 className="text-lg font-semibold text-[#111827]">Fakturahistorikk og betalinger</h2>
                      {invoices.length === 0 ? (
                        <p className="mt-2 text-sm text-[#6B7280]">Ingen fakturaer eller betalinger registrert enda.</p>
                      ) : (
                        <div className="mt-4 overflow-x-auto">
                          <table className="w-full min-w-[680px] text-sm">
                            <thead>
                              <tr className="text-left text-[#6B7280]">
                                <th className="pb-2 font-medium">Faktura</th>
                                <th className="pb-2 font-medium">Status</th>
                                <th className="pb-2 font-medium">Beløp</th>
                                <th className="pb-2 font-medium">Dato</th>
                                <th className="pb-2 font-medium">Handling</th>
                              </tr>
                            </thead>
                            <tbody>
                              {invoices.map((invoice) => (
                                <tr key={invoice.id} className="border-t border-[#EEF1F5]">
                                  <td className="py-3">{invoice.number || invoice.id}</td>
                                  <td className="py-3">
                                    {BILLING_STATUS_LABELS[invoice.status || (invoice.paid ? 'paid' : 'open')] || invoice.status || (invoice.paid ? 'paid' : 'open')}
                                  </td>
                                  <td className="py-3">
                                    {toMoney(Number(invoice.amountPaid || invoice.amountDue || 0), invoice.currency || summary?.currency || 'nok')}
                                  </td>
                                  <td className="py-3">{toIsoDate(invoice.createdAt)}</td>
                                  <td className="py-3">
                                    {invoice.hostedInvoiceUrl ? (
                                      <a href={invoice.hostedInvoiceUrl} target="_blank" rel="noreferrer" className="text-[#FF5B00] hover:text-[#E55200]">Åpne</a>
                                    ) : (
                                      <span className="text-[#9CA3AF]">Ingen lenke</span>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </section>
                  </div>
                )
              ) : null}

              {activeSection === 'konto' ? (
                <div className="space-y-5 max-w-4xl">
                  <section className="rounded-2xl border border-[#E5E7EB] bg-white p-5">
                    <h2 className="text-lg font-semibold text-[#111827]">Kontoinformasjon</h2>
                    <div className="mt-3 space-y-2 text-sm">
                      <p><span className="text-[#6B7280]">Innlogging:</span> {user?.email || profile?.email || '—'}</p>
                      <p><span className="text-[#6B7280]">Aktiv bedrift:</span> {profile?.businessName || clientData.generalInfo.companyName || '—'}</p>
                      <p><span className="text-[#6B7280]">Bruker-ID:</span> {user?.id || '—'}</p>
                      <p><span className="text-[#6B7280]">Bedrift-ID:</span> {profile?.businessId || activeBusinessId || '—'}</p>
                      <p><span className="text-[#6B7280]">Rolle:</span> {membership?.role === 'owner' ? 'Eier' : membership?.role === 'admin' ? 'Admin' : 'Samarbeidspartner'}</p>
                    </div>
                  </section>
                  <section className="rounded-2xl border border-[#E5E7EB] bg-white p-5">
                    <h2 className="text-lg font-semibold text-[#111827]">Bytt innloggings-e-post</h2>
                    <p className="mt-1 text-sm text-[#6B7280]">
                      E-post brukes bare til innlogging og første invitasjon. Nettside, salg og Website Maker er låst til bedrift-ID.
                    </p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <input type="email" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} placeholder="ny@epost.no" className="rounded-lg border border-[#E5E7EB] px-3 py-2 text-sm outline-none focus:border-[#FF5B00]" />
                      <input type="password" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} placeholder="Nåværende passord" className="rounded-lg border border-[#E5E7EB] px-3 py-2 text-sm outline-none focus:border-[#FF5B00]" />
                    </div>
                    <button type="button" onClick={() => void changeLoginEmail()} disabled={busyAction === 'change-email' || !loginEmail || !loginPassword} className="mt-3 rounded-lg bg-[#111827] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                      {busyAction === 'change-email' ? 'Lagrer...' : 'Oppdater e-post'}
                    </button>
                  </section>
                  <section className="rounded-2xl border border-[#E5E7EB] bg-white p-5">
                    <h2 className="text-lg font-semibold text-[#111827]">Bedrifter på denne brukeren</h2>
                    <ul className="mt-3 space-y-2 text-sm">
                      {businesses.map((row) => (
                        <li key={row.id} className="flex items-center justify-between rounded-lg border border-[#E5E7EB] px-3 py-2">
                          <span>
                            <span className="font-medium">{row.name}</span>
                            <span className="ml-2 text-[#6B7280]">{row.role}</span>
                          </span>
                          {row.id === activeBusinessId ? <span className="text-xs text-[#FF5B00]">Aktiv</span> : null}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                      <input value={newBusinessName} onChange={(e) => setNewBusinessName(e.target.value)} placeholder="Ny bedrift" className="flex-1 rounded-lg border border-[#E5E7EB] px-3 py-2 text-sm outline-none focus:border-[#FF5B00]" />
                      <button type="button" onClick={() => void createBusiness()} disabled={busyAction === 'create-business'} className="rounded-lg border border-[#E5E7EB] px-4 py-2 text-sm font-medium hover:bg-[#F9FAFB] disabled:opacity-50">
                        {busyAction === 'create-business' ? 'Oppretter...' : 'Opprett bedrift'}
                      </button>
                    </div>
                  </section>
                  <section className="rounded-2xl border border-[#E5E7EB] bg-white p-5">
                    <div className="flex items-center gap-2">
                      <Users size={18} />
                      <h2 className="text-lg font-semibold text-[#111827]">Samarbeidspartnere</h2>
                    </div>
                    {canManageMembers ? (
                      <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                        <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="kollega@byra.no" className="flex-1 rounded-lg border border-[#E5E7EB] px-3 py-2 text-sm outline-none focus:border-[#FF5B00]" />
                        <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as 'admin' | 'collaborator')} className="rounded-lg border border-[#E5E7EB] px-3 py-2 text-sm">
                          <option value="collaborator">Samarbeidspartner</option>
                          <option value="admin">Admin</option>
                        </select>
                        <button type="button" onClick={() => void inviteMember()} disabled={busyAction === 'invite' || !inviteEmail} className="rounded-lg bg-[#FF5B00] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
                          {busyAction === 'invite' ? 'Inviterer...' : 'Inviter'}
                        </button>
                      </div>
                    ) : (
                      <p className="mt-3 text-sm text-[#6B7280]">Bare eier eller admin kan invitere.</p>
                    )}
                    <ul className="mt-4 space-y-2 text-sm">
                      {members.map((row) => (
                        <li key={row.id} className="flex items-center justify-between rounded-lg border border-[#E5E7EB] px-3 py-2">
                          <span>
                            <span className="font-medium">{row.email || row.userId || 'Invitert'}</span>
                            <span className="ml-2 text-[#6B7280]">{row.role} · {row.status}</span>
                          </span>
                          {canManageMembers && row.role !== 'owner' ? (
                            <button type="button" onClick={() => void revokeMember(row.id)} disabled={busyAction === `revoke:${row.id}`} className="text-xs text-red-600 hover:underline disabled:opacity-50">
                              Fjern
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {canTransfer ? (
                      <div className="mt-5 border-t border-[#E5E7EB] pt-4">
                        <h3 className="text-sm font-semibold">Overfør eierskap</h3>
                        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                          <select value={transferUserId} onChange={(e) => setTransferUserId(e.target.value)} className="flex-1 rounded-lg border border-[#E5E7EB] px-3 py-2 text-sm">
                            <option value="">Velg medlem</option>
                            {members.filter((row) => row.role !== 'owner' && row.status === 'active' && row.userId).map((row) => (
                              <option key={row.id} value={row.userId}>{row.email} ({row.role})</option>
                            ))}
                          </select>
                          <button type="button" onClick={() => void transferBusiness()} disabled={busyAction === 'transfer' || !transferUserId} className="rounded-lg border border-[#E5E7EB] px-4 py-2 text-sm font-medium disabled:opacity-50">
                            {busyAction === 'transfer' ? 'Overfører...' : 'Overfør'}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </section>
                  <section className="rounded-2xl border border-red-200 bg-red-50/60 p-5">
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="mt-0.5 text-red-500" size={18} />
                      <div>
                        <h2 className="text-lg font-semibold text-red-700">Slett bruker (data beholdes)</h2>
                        <p className="mt-1 text-sm text-red-700/90">Når du avslutter kontoen, fjernes innloggingen din. Kundedata, historikk og leveransedata beholdes.</p>
                        <p className="mt-2 text-xs text-red-700/90">Skriv <strong>SLETT</strong> i feltet under for å bekrefte.</p>
                      </div>
                    </div>
                    <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                      <input value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)} placeholder="Skriv SLETT" className="flex-1 rounded-lg border border-red-300 bg-white px-3 py-2 text-sm outline-none focus:border-red-500" />
                      <button type="button" onClick={() => void deleteAccount()} disabled={deletingAccount || deleteConfirm.trim().toUpperCase() !== 'SLETT'} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
                        {deletingAccount ? 'Avslutter konto...' : 'Avslutt konto'}
                      </button>
                    </div>
                  </section>
                  <p className="text-xs text-[#9CA3AF]">
                    Trenger du hjelp før avslutning? Kontakt oss i{' '}
                    <Link to="/kunde/hjem" className="text-[#FF5B00] hover:text-[#E55200]">chatten i portalen</Link>.
                  </p>
                </div>
              ) : null}
            </div>

            {activeSection === 'kundedata' ? (
              <div className="sticky bottom-0 flex justify-end px-6 md:px-10 py-4 bg-white/90 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => void saveClientData()}
                  disabled={saving}
                  className="bg-[#FF5B00] text-white px-6 py-2.5 rounded-xl text-[14px] font-semibold hover:bg-[#e05000] shadow-md disabled:opacity-60 inline-flex items-center gap-2"
                >
                  {saving ? <Loader2 size={15} className="animate-spin" /> : null}
                  Lagre
                </button>
              </div>
            ) : null}
          </div>
        )}
      </ClientPortalLayout>
    </ClientRouteGuard>
  );
};
