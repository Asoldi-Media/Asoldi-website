/**
 * Canonical public legal pages. Offer contracts incorporate these by reference
 * so the signed PDF stays short while asoldi.com holds the full catalogue.
 */
export const SITE_LEGAL_ORIGIN = 'https://asoldi.com';

export const LEGAL_PATHS = {
  vilkar: '/vilkar',
  personvern: '/personvern',
  databehandleravtale: '/databehandleravtale',
  informasjonskapsler: '/informasjonskapsler',
};

export const LEGAL_URLS = {
  vilkar: `${SITE_LEGAL_ORIGIN}${LEGAL_PATHS.vilkar}`,
  personvern: `${SITE_LEGAL_ORIGIN}${LEGAL_PATHS.personvern}`,
  databehandleravtale: `${SITE_LEGAL_ORIGIN}${LEGAL_PATHS.databehandleravtale}`,
  informasjonskapsler: `${SITE_LEGAL_ORIGIN}${LEGAL_PATHS.informasjonskapsler}`,
};
