import React from 'react';
import { useLocation } from 'react-router-dom';
import { LegalLayout, LegalList, LegalSection, LegalSubheading } from '../../components/legal/LegalLayout';
import { useCatalogLegalDoc } from '../../data/catalogLegalTexts.js';
import { Vilkar as VilkarStatic } from './Vilkar';
import { Personvern as PersonvernStatic } from './Personvern';
import { Databehandleravtale as DatabehandleravtaleStatic } from './Databehandleravtale';

type Block = { type: 'p' | 'h3'; text: string } | { type: 'list'; items: string[] };
type CatalogDoc = {
  title: string;
  description: string;
  path: string;
  catalogVersion: number;
  dpaVersion: string;
  date: string;
  sections: { id: string; title: string; blocks: Block[] }[];
};

function versionNote(doc: CatalogDoc) {
  const dpa = doc.path === '/databehandleravtale' ? ` Databehandleravtalen har versjon ${doc.dpaVersion}.` : '';
  return `Versjon ${doc.catalogVersion} av vilkårskatalogen, publisert ${doc.date}.${dpa}`;
}

/**
 * A legal page rendered from the clause catalog when GET /api/legal/texts/:doc answers 200.
 * Until then, while the legal switch is off, on any error and for ?versjon=legacy, the page shows
 * its static text unchanged. ?versjon=<n> shows an archived version.
 */
export const CatalogLegalPage: React.FC<{ doc: string; Static: React.FC }> = ({ doc, Static }) => {
  const { search } = useLocation();
  const version = new URLSearchParams(search).get('versjon') || '';
  const catalog = useCatalogLegalDoc(doc, version) as CatalogDoc | null;
  if (!catalog) return <Static />;
  return (
    <LegalLayout title={catalog.title} description={catalog.description} path={catalog.path}>
      <p className="text-white/40 text-sm">{versionNote(catalog)}</p>
      {catalog.sections.map((section) => (
        <LegalSection key={section.id} id={section.id} title={section.title}>
          {section.blocks.map((block, index) => {
            if (block.type === 'list') return <LegalList key={index} items={block.items} />;
            if (block.type === 'h3') return <LegalSubheading key={index}>{block.text}</LegalSubheading>;
            return <p key={index}>{block.text}</p>;
          })}
        </LegalSection>
      ))}
    </LegalLayout>
  );
};

export const Vilkar = () => <CatalogLegalPage doc="vilkar" Static={VilkarStatic} />;
export const Personvern = () => <CatalogLegalPage doc="personvern" Static={PersonvernStatic} />;
export const Databehandleravtale = () => <CatalogLegalPage doc="databehandleravtale" Static={DatabehandleravtaleStatic} />;
