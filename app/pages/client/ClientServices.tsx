import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Lock, ArrowRight } from 'lucide-react';
import { ClientRouteGuard } from '../../components/client/ClientRouteGuard';
import { ClientPortalLayout } from '../../components/client/ClientPortalLayout';

export const ClientServices = () => {
  const navigate = useNavigate();
  return (
    <ClientRouteGuard>
      <Helmet>
        <title>Kundeportal – Tjenester</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <ClientPortalLayout title="Tjenester" subtitle="Administrer tjenestene dine">
        <div className="grid md:grid-cols-3 gap-4">
          <ServiceCard
            title="Nettside"
            description="Sett opp produktdata og innhold med AI-assistenten."
            ctaLabel="Åpne"
            onClick={() => navigate('/kunde/ai-assistant')}
          />
          <ServiceCard
            title="E-post"
            description="Kommer snart. Denne modulen åpnes etter nettside-onboarding."
            locked
          />
          <ServiceCard
            title="Sosiale medier"
            description="Kommer snart. Denne modulen åpnes etter nettside-onboarding."
            locked
          />
        </div>
      </ClientPortalLayout>
    </ClientRouteGuard>
  );
};

function ServiceCard({
  title,
  description,
  ctaLabel,
  onClick,
  locked = false,
}: {
  title: string;
  description: string;
  ctaLabel?: string;
  onClick?: () => void;
  locked?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-[#E5E7EB] bg-white p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-[#111827]">{title}</h3>
        {locked ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#F3F4F6] px-2 py-1 text-xs text-[#6B7280]">
            <Lock size={12} />
            Låst
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-[#ECFDF3] px-2 py-1 text-xs text-emerald-700">
            Aktiv
          </span>
        )}
      </div>
      <p className="mt-3 text-sm text-[#6B7280]">{description}</p>
      {!locked ? (
        <button
          type="button"
          onClick={onClick}
          className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[#FF5B00] px-4 py-2 text-sm text-white hover:bg-[#E55200]"
        >
          {ctaLabel || 'Åpne'}
          <ArrowRight size={14} />
        </button>
      ) : null}
    </div>
  );
}
