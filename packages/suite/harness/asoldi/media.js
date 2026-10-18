// Asoldi's push on the shared media categorizer: folder names, the product-info flag,
// and how a brief lands in Kundedata. Data and prompt text only; the core logic is untouched.

export const ASOLDI_MEDIA_PROMPT_VERSION = 5;

/** Website-maker upload fields (primaryField on every brief, on both sides). */
export const SECTION_TO_MAKER_FIELD = {
  hero: 'heroImages',
  team: 'employeeImages',
  about: 'aboutImages',
  process: 'aboutImages',
  offerings: 'menuImages',
  location: 'locationImages',
  gallery: 'generalImages',
  testimonial: 'generalImages',
  logo: 'logo',
  favicon: 'favicon',
  illustration: 'illustrationImages',
  decoration: 'illustrationImages',
  video: 'generalVideos',
  audio: 'generalAudio',
  skip: '',
};

/** Client platform (Kundedata) media buckets. */
export const SECTION_TO_KUNDEDATA_BUCKET = {
  hero: 'mainHeroImages',
  team: 'teamImages',
  about: 'aboutImages',
  process: 'aboutImages',
  offerings: 'offeringImages',
  location: 'locationImages',
  gallery: 'galleryImages',
  testimonial: 'galleryImages',
  illustration: 'illustrationImages',
  decoration: 'icons',
  logo: 'logos',
  favicon: 'icons',
};

/** Every Kundedata media bucket, in the order the client platform lists them. */
export const KUNDEDATA_MEDIA_BUCKETS = [
  'mainHeroImages',
  'aboutImages',
  'teamImages',
  'locationImages',
  'logos',
  'icons',
  'illustrationImages',
  'offeringImages',
  'galleryImages',
  'uncategorized',
];

export function makerFieldForSection(section = '') {
  return SECTION_TO_MAKER_FIELD[section] || '';
}

export const ASOLDI_MEDIA_HARNESS = {
  promptVersion: ASOLDI_MEDIA_PROMPT_VERSION,
  fieldForSection: makerFieldForSection,
  extraFields: { productInfo: false },
  extraRules: [
    '- productInfo: true only when the file is mainly readable sellable items with prices, a menu, a price list, or a product/service sheet. A photo of one dish or one product is false.',
  ],
};

/** Kundedata media bucket for a brief. Unknown, skipped or missing briefs land in "uncategorized". */
export function placementForKundedata(brief) {
  const none = { bucket: 'uncategorized', isLogo: false, favicon: false, productInfo: false };
  if (!brief) return none;
  const section = brief.primarySection;
  const productInfo = brief.productInfo === true;
  const clientMark = brief.logoKind === 'client' || brief.logoKind === 'unknown';
  if (section === 'logo' && clientMark) return { ...none, bucket: 'logos', isLogo: brief.logoKind === 'client', productInfo };
  if (section === 'favicon' && clientMark) return { ...none, bucket: 'icons', favicon: brief.logoKind === 'client', productInfo };
  if (brief.usable === 'skip' || section === 'skip') return { ...none, productInfo };
  return { ...none, bucket: SECTION_TO_KUNDEDATA_BUCKET[section] || 'uncategorized', productInfo };
}
