import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Gift, MessageSquare, UserCircle2, ChevronRight, LogOut, Settings, CreditCard, Building2, Check } from 'lucide-react';
import { useClientAuth } from '../../contexts/ClientAuthContext';
import { ClientReferralModal } from './ClientReferralModal';
import { REFERRAL_REWARD_LABEL } from '../../../lib/client-referral.js';
import { analyticsLevelForPlan, ANALYTICS_LEVEL_NONE } from '../../../lib/website-tiers.js';

type Props = {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
};

function SidebarLink({
  to,
  label,
  active,
  hasChevron = false,
}: {
  to: string;
  label: string;
  active: boolean;
  hasChevron?: boolean;
}) {
  return (
    <Link
      to={to}
      className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
        active ? 'bg-white text-[#111827] shadow-sm' : 'text-[#30353D] hover:bg-white/80'
      }`}
    >
      <span>{label}</span>
      {hasChevron ? <ChevronRight size={14} /> : null}
    </Link>
  );
}

export function ClientPortalLayout({ children, title, subtitle }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const { profile, businesses, activeBusinessId, switchBusiness, clearClientSession } = useClientAuth();
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [businessMenuOpen, setBusinessMenuOpen] = useState(false);
  const [referralOpen, setReferralOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement | null>(null);
  const businessMenuRef = useRef<HTMLDivElement | null>(null);
  const activeBusiness = businesses.find((row) => row.id === activeBusinessId) || businesses[0] || null;

  const isHome = location.pathname === '/kunde' || location.pathname === '/kunde/hjem';
  const isAnalytics = location.pathname.startsWith('/kunde/analyse') || location.pathname.startsWith('/kunde/analytics');
  const isServices = location.pathname.startsWith('/kunde/tjenester');
  const isSettings = location.pathname.startsWith('/kunde/innstillinger');
  const planId = profile?.payment?.planId || profile?.websiteBuilder?.selectedPlanId || '';
  const showAnalytics = analyticsLevelForPlan(planId) !== ANALYTICS_LEVEL_NONE;

  useEffect(() => {
    if (!profileMenuOpen && !businessMenuOpen) return;
    function handleOutsideClick(event: MouseEvent) {
      const target = event.target as Node;
      if (profileMenuRef.current && !profileMenuRef.current.contains(target)) {
        setProfileMenuOpen(false);
      }
      if (businessMenuRef.current && !businessMenuRef.current.contains(target)) {
        setBusinessMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [profileMenuOpen, businessMenuOpen]);

  function logout() {
    clearClientSession();
    navigate('/login');
  }

  async function chooseBusiness(businessId: string) {
    if (!businessId || businessId === activeBusinessId || switching) return;
    setSwitching(true);
    try {
      await switchBusiness(businessId);
      setBusinessMenuOpen(false);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#F8F9FB] text-[#111827]">
      <div className="mx-auto max-w-[1460px] min-h-screen flex">
        <aside className="w-[220px] border-r border-[#E7E9EE] bg-[#F3F4F6] px-4 py-5 flex flex-col">
          <Link
            to="/kunde/hjem"
            className="flex items-center gap-3 mb-8 rounded-xl -mx-1 px-1 py-1 transition-colors hover:bg-white/70"
            aria-label="Til hjem"
          >
            <div className="w-10 h-10 rounded-xl bg-[#FF5B00] text-white flex items-center justify-center font-bold">A</div>
            <div>
              <p className="text-sm font-semibold">Asoldi HUB</p>
              <p className="text-xs text-[#6B7280]">Kundeportal</p>
            </div>
          </Link>

          <nav className="space-y-2">
            <SidebarLink to="/kunde/hjem" label="Hjem" active={isHome} />
            {showAnalytics ? <SidebarLink to="/kunde/analyse" label="Analyse" active={isAnalytics} /> : null}
            <SidebarLink to="/kunde/tjenester" label="Tjenester" active={isServices} hasChevron />
            {isServices ? (
              <div className="ml-3 mt-2 space-y-1 border-l border-[#E5E7EB] pl-3">
                <Link to="/kunde/tjenester" className={`block rounded-md px-2 py-1.5 text-xs ${location.pathname === '/kunde/tjenester' ? 'bg-white text-[#111827] font-medium' : 'text-[#4B5563] hover:bg-white/70'}`}>Nettside</Link>
                <span className="block rounded-md px-2 py-1.5 text-xs text-[#9CA3AF]">E-post (låst)</span>
                <span className="block rounded-md px-2 py-1.5 text-xs text-[#9CA3AF]">Sosiale medier (låst)</span>
              </div>
            ) : null}
          </nav>
          <div className="mt-auto pt-5">
            <SidebarLink to="/kunde/innstillinger" label="Innstillinger" active={isSettings} />
          </div>
        </aside>

        <div className="flex-1 min-w-0">
          <header className="h-[72px] bg-white border-b border-[#E7E9EE] px-6 flex items-center justify-between">
            <div>
              {title ? <h1 className="text-lg font-semibold">{title}</h1> : null}
              {subtitle ? <p className="text-xs text-[#6B7280]">{subtitle}</p> : null}
            </div>
            <div className="flex items-center gap-3">
              <div className="relative" ref={businessMenuRef}>
                <button
                  type="button"
                  onClick={() => setBusinessMenuOpen((prev) => !prev)}
                  className="inline-flex max-w-[240px] items-center gap-2 rounded-full border border-[#E5E7EB] bg-white px-3 py-2 text-sm"
                  aria-label="Bytt bedrift"
                >
                  <Building2 size={14} />
                  <span className="truncate">{activeBusiness?.name || profile?.businessName || 'Bedrift'}</span>
                  <ChevronRight size={12} className="rotate-90 text-[#9CA3AF]" />
                </button>
                {businessMenuOpen ? (
                  <div className="absolute right-0 mt-2 min-w-[260px] rounded-xl border border-[#E5E7EB] bg-white p-2 shadow-lg z-20">
                    <p className="px-2 py-1 text-[11px] uppercase tracking-wide text-[#9CA3AF]">Bedrifter</p>
                    {businesses.map((row) => (
                      <button
                        key={row.id}
                        type="button"
                        disabled={switching}
                        onClick={() => void chooseBusiness(row.id)}
                        className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-[#F9FAFB] disabled:opacity-50"
                      >
                        <span>
                          <span className="block font-medium">{row.name}</span>
                          <span className="block text-[11px] text-[#6B7280]">
                            {row.role === 'owner' ? 'Eier' : row.role === 'admin' ? 'Admin' : 'Samarbeidspartner'}
                          </span>
                        </span>
                        {row.id === activeBusinessId ? <Check size={14} className="text-[#FF5B00]" /> : null}
                      </button>
                    ))}
                    <Link
                      to="/kunde/innstillinger/konto"
                      onClick={() => setBusinessMenuOpen(false)}
                      className="mt-1 block rounded-lg px-3 py-2 text-sm text-[#FF5B00] hover:bg-[#FFF7ED]"
                    >
                      Administrer bedrifter
                    </Link>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => setReferralOpen(true)}
                className="inline-flex items-center gap-2 rounded-full bg-[#FFE7DA] px-4 py-2 text-sm text-[#FF5B00]"
              >
                <Gift size={14} />
                Verv og tjen {REFERRAL_REWARD_LABEL}
              </button>
              <button type="button" className="inline-flex items-center gap-2 rounded-full border border-[#E5E7EB] px-3 py-2 text-sm bg-white">
                <MessageSquare size={14} />
                Chat
              </button>
              <div className="relative" ref={profileMenuRef}>
                <button
                  type="button"
                  onClick={() => setProfileMenuOpen((prev) => !prev)}
                  className="rounded-full border border-[#E5E7EB] p-2 bg-white"
                  aria-label="Bruker"
                >
                  <UserCircle2 size={18} />
                </button>
                {profileMenuOpen ? (
                  <div className="absolute right-0 mt-2 min-w-[240px] rounded-xl border border-[#E5E7EB] bg-white p-3 shadow-lg">
                    <p className="text-sm font-medium">{profile?.name || 'Kunde'}</p>
                    <p className="text-xs text-[#6B7280]">{profile?.email || ''}</p>
                    <div className="mt-3 space-y-1">
                      <Link
                        to="/kunde/innstillinger"
                        onClick={() => setProfileMenuOpen(false)}
                        className="inline-flex w-full items-center gap-2 rounded-lg border border-[#E5E7EB] px-3 py-2 text-sm text-[#374151] hover:bg-[#F9FAFB]"
                      >
                        <Settings size={14} />
                        Innstillinger
                      </Link>
                      <Link
                        to="/kunde/innstillinger/fakturering"
                        onClick={() => setProfileMenuOpen(false)}
                        className="inline-flex w-full items-center gap-2 rounded-lg border border-[#E5E7EB] px-3 py-2 text-sm text-[#374151] hover:bg-[#F9FAFB]"
                      >
                        <CreditCard size={14} />
                        Fakturering
                      </Link>
                      <button
                        type="button"
                        onClick={logout}
                        className="inline-flex w-full items-center gap-2 rounded-lg border border-[#F3D2C0] px-3 py-2 text-sm text-[#B45309] hover:bg-[#FFF7ED]"
                      >
                        <LogOut size={14} />
                        Logg ut
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </header>

          <main className="p-6">{children}</main>
        </div>
      </div>
      <ClientReferralModal open={referralOpen} onClose={() => setReferralOpen(false)} />
    </div>
  );
}
