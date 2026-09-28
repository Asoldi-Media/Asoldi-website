import React from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'motion/react';
import { Mail, Phone, MapPin } from 'lucide-react';
import { SEO } from '../SEO';
import { BUSINESS, SITE_URL } from '../../config';
import { getAboutPageSchema } from '../../structuredData';

export const LEGAL_LAST_UPDATED = '28. september 2026';

export const LEGAL_PAGES = [
  { path: '/personvern', label: 'Personvernerklæring' },
  { path: '/vilkar', label: 'Vilkår for bruk' },
  { path: '/databehandleravtale', label: 'Databehandleravtale' },
  { path: '/informasjonskapsler', label: 'Informasjonskapsler' },
] as const;

/** A titled top-level section within a legal document. */
export const LegalSection: React.FC<{ id?: string; title: string; children: React.ReactNode }> = ({
  id,
  title,
  children,
}) => (
  <section id={id} className="scroll-mt-28">
    <h2 className="text-2xl md:text-3xl font-medium text-white mb-5 tracking-tight">{title}</h2>
    <div className="space-y-4 text-white/60 text-base md:text-lg font-light leading-relaxed">{children}</div>
  </section>
);

/** A lighter sub-heading used inside a section. */
export const LegalSubheading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <h3 className="text-lg md:text-xl font-medium text-white/90 mt-2">{children}</h3>
);

/** Bulleted list with the brand-orange marker. */
export const LegalList: React.FC<{ items: React.ReactNode[] }> = ({ items }) => (
  <ul className="space-y-2.5 list-disc pl-5 marker:text-[#FF5B00]">
    {items.map((item, i) => (
      <li key={i}>{item}</li>
    ))}
  </ul>
);

/** Highlighted callout box (e.g. Google "Limited Use" disclosure). */
export const LegalCallout: React.FC<{ title?: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="rounded-2xl border border-[#FF5B00]/30 bg-[#FF5B00]/[0.06] p-5 md:p-6">
    {title && <p className="text-white font-medium mb-2">{title}</p>}
    <div className="space-y-3 text-white/70 text-sm md:text-base font-light leading-relaxed">{children}</div>
  </div>
);

interface LegalLayoutProps {
  title: string;
  /** Short SEO + intro description. */
  description: string;
  /** Canonical route, e.g. "/personvern". */
  path: string;
  children: React.ReactNode;
}

export const LegalLayout: React.FC<LegalLayoutProps> = ({ title, description, path, children }) => {
  const otherPages = LEGAL_PAGES.filter((p) => p.path !== path);

  return (
    <main className="bg-[#050505] min-h-screen pt-32 md:pt-40 pb-24 px-6 md:px-10">
      <SEO
        title={`${title} – ${BUSINESS.shortName}`}
        description={description}
        path={path}
        structuredData={getAboutPageSchema(title, description, SITE_URL + path)}
      />

      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <span className="inline-block px-4 py-2 rounded-full border border-white/10 bg-white/5 text-white/70 text-xs md:text-sm font-medium mb-6">
            Juridisk
          </span>
          <h1 className="text-4xl md:text-6xl font-medium text-white tracking-tight leading-[1.05] mb-5">{title}</h1>
          <p className="text-white/50 text-base md:text-lg font-light leading-relaxed">{description}</p>
          <p className="text-white/40 text-sm mt-6">Sist oppdatert: {LEGAL_LAST_UPDATED}</p>
        </motion.div>

        <div className="h-px w-full bg-white/10 my-12" />

        {/* Document body */}
        <article className="space-y-12">{children}</article>

        {/* Controller / contact block */}
        <div className="h-px w-full bg-white/10 my-12" />
        <div className="rounded-3xl border border-white/10 bg-white/[0.03] p-6 md:p-8">
          <h2 className="text-xl md:text-2xl font-medium text-white mb-2 tracking-tight">Kontakt og behandlingsansvarlig</h2>
          <p className="text-white/60 font-light mb-5">
            {BUSINESS.name} (CHAPANA), org.nr. 934 327 497, er behandlingsansvarlig for personopplysninger som
            behandles om besøkende og kunder via {SITE_URL}.
          </p>
          <div className="space-y-3 text-white/60 text-sm md:text-base">
            <div className="flex items-center gap-3">
              <MapPin size={16} className="text-[#FF5B00] shrink-0" />
              <span>{BUSINESS.address.full}</span>
            </div>
            <div className="flex items-center gap-3">
              <Mail size={16} className="text-[#FF5B00] shrink-0" />
              <a href={`mailto:${BUSINESS.email}`} className="hover:text-[#FF5B00] transition-colors">
                {BUSINESS.email}
              </a>
            </div>
            <div className="flex items-center gap-3">
              <Phone size={16} className="text-[#FF5B00] shrink-0" />
              <a href="tel:+4748339191" className="hover:text-[#FF5B00] transition-colors">
                {BUSINESS.phone}
              </a>
            </div>
          </div>
        </div>

        {/* Cross-links to the other legal documents */}
        <div className="mt-10 flex flex-wrap gap-3">
          {otherPages.map((p) => (
            <Link
              key={p.path}
              to={p.path}
              className="px-4 py-2.5 rounded-full border border-white/10 bg-white/5 text-white/70 text-sm hover:border-[#FF5B00]/40 hover:text-white transition-colors"
            >
              {p.label}
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
};
