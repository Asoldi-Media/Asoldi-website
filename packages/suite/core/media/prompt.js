// The media brief prompt. Generic: describes one file and where on a small-business
// website it belongs. A harness may append rules and extra JSON fields; it never edits these lines.

export const CORE_PROMPT_VERSION = 4;

export const MEDIA_SECTIONS = [
  'hero',
  'team',
  'about',
  'process',
  'offerings',
  'location',
  'gallery',
  'testimonial',
  'logo',
  'favicon',
  'illustration',
  'decoration',
  'video',
  'audio',
  'skip',
];

export const BRIEF_JSON_TEMPLATE = {
  depicts: '',
  visibleText: [],
  peopleCount: 0,
  facesVisible: false,
  setting: '',
  medium: 'photo',
  primarySection: 'gallery',
  primaryWhy: '',
  alternateSection: '',
  alternateWhy: '',
  doNotUseFor: '',
  distinguishingDetail: '',
  usable: 'use',
  confidence: 0.0,
  logoKind: 'none',
  logoFormat: 'none',
  background: 'unknown',
  subjectKind: 'none',
};

export function measuredPromptBlock(measured = {}) {
  if (!measured || typeof measured !== 'object') return 'Measured: none.';
  const w = Number(measured.width || 0);
  const h = Number(measured.height || 0);
  const size = w > 0 && h > 0 ? `${w}×${h}px, ratio ${Number(measured.ratio || 0).toFixed(2)}, ${measured.aspectClass || 'unknown'}` : 'size unknown';
  const alpha =
    measured.hasAlpha == null
      ? 'transparency unknown'
      : measured.hasAlpha
        ? `${Math.round(Number(measured.alphaCoverage || 0) * 100)}% transparent pixels`
        : 'opaque';
  const bytes = Number(measured.bytes || 0);
  const kb = bytes > 0 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : 'size unknown';
  const lines = [
    'Measured (code — trust this over eyeballing):',
    `- file: ${String(measured.ext || '').replace(/^\./, '').toUpperCase() || 'unknown'}, ${kb}`,
    `- ${size}`,
    `- ${alpha}`,
  ];
  if (Number(measured.frames) > 1) lines.push(`- animated, ${Number(measured.frames)} frames; you see the first frame only`);
  lines.push(
    '- A square ≤192px or a .ico is favicon-shaped. A wide rectangle is a normal wordmark, not a favicon.',
    '- Transparent pixels do not make this an illustration. Cut-out photos are still photos.'
  );
  return lines.join('\n');
}

function kindLine(kind) {
  if (kind === 'video') return 'This file is a video. Describe what is shown and, if speech is present, the topic of the speech. Do not invent dialogue.';
  if (kind === 'audio') {
    return 'This file is audio with no picture. Describe what you hear: speech topic, music, or ambient sound. visibleText stays empty unless words are spoken clearly enough to quote.';
  }
  return 'This file is a still image. Look at the pixels. Do not infer a scene from the file name.';
}

/**
 * @param {object} input
 * @param {{extraRules?: string[], extraFields?: object}} [input.harness]
 * @param {string} [input.textHint] words found inside a vector file (svg <text>/<title>)
 */
export function buildMediaBriefPrompt({
  businessName = '',
  industry = '',
  businessWhat = '',
  fileName = '',
  kind = 'image',
  measured = null,
  textHint = '',
  harness = {},
} = {}) {
  const business = [businessName, industry && `(${industry})`, businessWhat].filter(Boolean).join(' ').slice(0, 320);
  const extraRules = (Array.isArray(harness.extraRules) ? harness.extraRules : []).filter(Boolean);
  const template = { ...BRIEF_JSON_TEMPLATE, ...(harness.extraFields || {}) };
  return [
    'You write a placement brief for ONE media file that will be used while building a small-business website.',
    'A developer will put this file beside a specific section. Be concrete enough that two similar files would not get the same brief.',
    kindLine(kind),
    business ? `Client hint (do not invent things that are not in the file): ${business}.` : 'No client hint.',
    `File name (a hint only, often wrong): ${fileName || 'unknown'}.`,
    ...(textHint ? [`Words written inside this vector file (read from its source, may include hidden labels): ${textHint}.`] : []),
    measuredPromptBlock(measured),
    'Rules:',
    '- depicts: one or two sentences of only what is visible or audible. Name the subject (dish, room, tool, garment, vehicle, machine). No marketing adjectives.',
    '- visibleText: exact readable words, in the original language. [] if none or too blurry to read. Never guess a letter.',
    '- peopleCount: people whose body is in frame. Hands alone count as people only if a person is clearly working. -1 if it is a crowd you cannot count. Statues, mannequins, and photos of photos are not extra people.',
    '- facesVisible: true only if at least one face is sharp enough that you could tell two people apart.',
    '- setting: where this is, in a few words (open kitchen pass, hotel bedroom, museum gallery, street facade, plain studio backdrop).',
    '- medium: photo (camera image, including a cut-out photo), illustration (drawn/flat art, circular typographic badges, spinning text rings, watermarks — not a photograph of a person), logo (a brand mark or wordmark meant to identify a business — a photo of a sign on a building is still a photo), icon (a small simple UI, social, or payment glyph), video, audio, other.',
    '- logoKind: client if this file IS the brand mark (a motif that fits the business counts even when the name is not readable — scissors for a salon named Cutters). partner if readable words name a different business. none if it is not a logo. unknown if it looks like a mark but you cannot tell whose. A photo of a person, product, place, or sign is none even when the brand is printed on it.',
    '- logoFormat: wordmark (wide name lockup), mark (symbol only), favicon (tiny square app/site icon), none.',
    '- background: transparent | solid | photo | unknown. Use measured transparency when provided.',
    '- subjectKind: employee (staff who are the subject), customer (reviewer, testimonial portrait, quote graphic of a client), product, place, graphic, none.',
    '- If readable words name a brand that is NOT the client, logoKind must be partner and primarySection must NOT be logo or favicon. Use offerings or gallery. An icon-only client mark with no readable name is still client, not partner.',
    '- primarySection is where to USE the file, picked from this list only:',
    '  hero — first screen. Needs a wide, clear view of the business itself. A tight crop of one object is usually not a hero.',
    '  team — beside copy that introduces people. A portrait, or staff who are the subject. Faces that are sharp enough to tell people apart belong here even if the file was downloaded from a gallery/menu folder. A room with a tiny passer-by is not team.',
    '  process — beside a how-we-work section. Hands or a machine mid-task. A finished beauty shot of the product is not process.',
    '  about — story, history, community, behind the scenes that is not a headshot and not one product.',
    '  offerings — one sellable thing a menu, services, or rooms card can name. That thing is the subject, not a background detail.',
    '  location — a place a visitor would recognize: facade, entrance, a whole room. A plate of food is not location.',
    '  testimonial — a review screenshot, certificate, award, quote graphic, or a person who is clearly a customer rather than staff.',
    '  gallery — a strong photo that does not argue for one section.',
    '  logo, favicon, illustration, decoration (UI chrome, arrows, social glyphs — not content), video, audio, skip (blur, pixel, broken, empty).',
    '- primaryWhy: one sentence a developer can act on. Name the section and the visible fact. Good: "Place this beside a team section that introduces the kitchen, because two cooks in black jackets are plating at the pass and both faces are readable." Bad: "Nice photo, good for the hero."',
    '- alternateSection / alternateWhy: a second honest fit, or empty strings if there is no second fit.',
    '- doNotUseFor: the most tempting wrong section, and the visible reason it fails.',
    '- distinguishingDetail: the one detail that separates this file from a similar one (a colour, a tool, a readable name, a count, a crop).',
    '- usable: use (clear enough to publish), weak (only if nothing better exists), skip (unusable).',
    '- confidence: 0 to 1. Below 0.5 when the file is tiny, blurry, or you are guessing.',
    ...extraRules,
    `Return JSON only: ${JSON.stringify(template)}`,
  ].join('\n');
}
