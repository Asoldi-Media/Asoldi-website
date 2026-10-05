/**
 * Client data intake. Ask only for a missing bucket, in order:
 * products → media → logo → staff → hours → partners.
 * Wording shifts a little per business so it does not feel like a form.
 */

export const SETTINGS_PATH = '/kunde/innstillinger';
export const SIGNER_STAFF_ID = 'ansatt-signer';

export const INTAKE_STEPS = ['products', 'media', 'logo', 'staff', 'hours', 'affiliations'];

export const STEP_LABELS = {
  products: 'Produkter',
  media: 'Media',
  logo: 'Logo',
  staff: 'Ansatte',
  hours: 'Åpningstider',
  affiliations: 'Partnere',
  done: 'Ferdig',
};

const WEEK = [
  { day: 'Mandag', keys: ['mandag', 'man', 'monday', 'mon'] },
  { day: 'Tirsdag', keys: ['tirsdag', 'tir', 'tuesday', 'tue'] },
  { day: 'Onsdag', keys: ['onsdag', 'ons', 'wednesday', 'wed'] },
  { day: 'Torsdag', keys: ['torsdag', 'tor', 'thursday', 'thu'] },
  { day: 'Fredag', keys: ['fredag', 'fre', 'friday', 'fri'] },
  { day: 'Lørdag', keys: ['lordag', 'lor', 'saturday', 'sat'] },
  { day: 'Søndag', keys: ['sondag', 'son', 'sunday', 'sun'] },
];

const DEFAULT_HOURS = [
  { day: 'Mandag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Tirsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Onsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Torsdag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Fredag', opensAt: '08:00', closesAt: '16:00', closed: false },
  { day: 'Lørdag', opensAt: '10:00', closesAt: '14:00', closed: true },
  { day: 'Søndag', opensAt: '10:00', closesAt: '14:00', closed: true },
];

const QUESTIONS = {
  products: [
    () => 'Har dere produkter, tjenester eller en meny jeg kan legge inn? Last opp et dokument, eller skriv listen her.',
    (name) => `La oss starte med det dere tilbyr${name ? ` hos ${name}` : ''}. Last opp en prisliste, eller skriv det rett her.`,
    (name) => `Først vil jeg samle tilbudene deres${name ? ` — ${name}` : ''}. PDF, Word, Excel eller en kort liste fungerer.`,
  ],
  media: [
    (name) => `Hvilke bilder eller videoer skal vi bruke${name ? ` for ${name}` : ''}? Slipp filene her. Tekstfiler legges ikke i mediabiblioteket.`,
    (name) => `Har dere bilder eller video som skal ligge i biblioteket${name ? ` til ${name}` : ''}? Last dem opp her.`,
    (name) => `Send bildene og videoene dere vil at vi skal bruke. Jeg legger dem rett i mediabiblioteket.`,
  ],
  logo: [
    (name) => `Kan du laste opp logoen${name ? ` til ${name}` : ''}? Den går til logofeltet.`,
    (name) => `Har dere en logofil? Last den opp, så legger jeg den på vanlig logoplass.`,
    (name) => `Hvis logoen ikke ligger inne ennå, send bildefilen her.`,
  ],
  staff: [
    (name) => `Lyst til å vise informasjon om ansatte${name ? ` hos ${name}` : ''} på siden? I så fall trenger jeg tittel, navn, nummer og e-post.`,
    (name) => `Skal teamet vises på nettsiden? Skriv navn, stilling, telefon og e-post for hver person, eller si ifra hvis det ikke er aktuelt.`,
    (name) => `Vil dere ha ansatte på siden? Én person per linje: navn, tittel, telefon, e-post.`,
  ],
  staffDetails: [
    () => 'Skriv én person per linje: navn, tittel, telefon, e-post.',
    () => 'Fint. Gi meg navn, stilling, nummer og e-post. Flere personer kan stå på hver sin linje.',
  ],
  hours: [
    (name) => `Når er dere åpne${name ? ` hos ${name}` : ''}? Si gjerne mandag til søndag. Dere kan også si at det ikke er relevant, eller at dere er åpne hele døgnet.`,
    (name) => 'Hva er åpningstidene? Mandag til søndag, døgnåpent, eller ikke relevant for dere.',
    (name) => 'Fortell når dere har åpent gjennom uken. 24/7 og «ikke relevant» er også fine svar.',
  ],
  affiliations: [
    (name) => name
      ? `Har ${name} noen partnere dere jobber med, som skal med på nettsiden?`
      : 'Har dere noen partnere dere jobber med, som skal med på nettsiden?',
    (name) => `Noen samarbeidspartnere vi skal vise${name ? ` for ${name}` : ''}? Skriv navnene, og si fra om de hører i ulike grupper.`,
    () => 'Skal vi ta med partnere eller affiliasjoner? List dem opp, så sorterer jeg dem.',
  ],
  affiliationDetails: [
    () => 'Skriv partnerne. Hvis de hører i ulike grupper, sett gruppenavn foran, for eksempel «Sponsorer: …».',
    () => 'Nevn hvem dere vil ha med, gjerne gruppert hvis det er flere typer.',
  ],
};

function compact(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function fold(value = '') {
  return compact(value)
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a');
}

function hashSeed(seed = '') {
  let hash = 0;
  const text = String(seed || 'asoldi');
  for (let i = 0; i < text.length; i += 1) hash = (hash + text.charCodeAt(i) * (i + 1)) % 997;
  return hash;
}

export function variant(seed, options = []) {
  if (!options.length) return '';
  return options[hashSeed(seed) % options.length];
}

export function businessLabel(bank = {}, profile = {}) {
  return compact(
    bank?.businessCard?.companyName
    || bank?.generalInfo?.companyName
    || profile?.businessName
    || '',
  );
}

export function personFirstName(profile = {}) {
  const raw = compact(profile?.name || profile?.fullName || '');
  if (!raw || raw.includes('@')) return '';
  return raw.split(' ')[0];
}

const MORE_QUESTIONS = {
  products: [
    () => 'Er det mer produktinformasjon, eller er dette alt?',
    (name) => `Noe mer å legge inn${name ? ` for ${name}` : ''}, eller er produktlisten ferdig?`,
    () => 'Er du sikker på at det ikke er flere produkter eller tjenester?',
  ],
  media: [
    () => 'Er det flere bilder eller video, eller er dette nok?',
    () => 'Noe mer media, eller skal vi gå videre?',
    () => 'Er du sikker på at det ikke er flere filer?',
  ],
  staff: [
    () => 'Er det flere ansatte, eller er dette alle?',
    () => 'Noen flere på teamet, eller er listen ferdig?',
    () => 'Er du sikker på at det ikke er flere ansatte?',
  ],
  affiliations: [
    () => 'Er det flere partnere, eller er det alle?',
    () => 'Noen flere samarbeid, eller skal vi stoppe her?',
    () => 'Er du sikker på at det ikke er flere partnere?',
  ],
};

export function questionFor(step, name = '') {
  if (step === 'done') return doneMessage(name);
  const options = QUESTIONS[step];
  if (!options) return doneMessage(name);
  const picked = variant(`${name}:${step}`, options);
  return typeof picked === 'function' ? picked(name) : String(picked || '');
}

export function moreQuestion(step, name = '') {
  const options = MORE_QUESTIONS[step];
  if (!options) return '';
  const picked = variant(`${name}:more:${step}`, options);
  return typeof picked === 'function' ? picked(name) : String(picked || '');
}

export function awaitingMore(bank = {}, step = '') {
  return compact(bank?.assistantIntake?.[step]) === 'more';
}

export function promptFor(step, name = '', bank = {}) {
  if (awaitingMore(bank, step)) return moreQuestion(step, name);
  return questionFor(step, name);
}

export function doneMessage(name = '') {
  return variant(name || 'ferdig', [
    `Da har vi det vi trenger${name ? ` om ${name}` : ''}. Det som er samlet inn vises i stegene her. Du kan endre det i bedriftsinformasjonen når du vil.`,
    `Datainnsamlingen er ferdig${name ? ` for ${name}` : ''}. Stegene viser bilder, produkter og resten. Bedriftsinformasjonen er der om du vil redigere.`,
    'Det var alt jeg skulle hente inn. Se gjennom stegene — bedriftsinformasjonen har de samme feltene om du vil justere noe.',
  ]);
}

export function isDecline(text = '') {
  const t = fold(text);
  if (!t || t.length > 80) return false;
  if (/https?:/.test(t) || /\s[a-z0-9-]+\.[a-z]{2,}(?:\/|\s|$)/.test(t)) return false;
  return /^(nei|nope|ingen|hopp over|hopp|skip|ikke relevant|ikke aktuelt|ikke na|har ikke|har ingen|vi har ikke|det har vi ikke|trenger ikke|ikke noe)\b/.test(t);
}

export function isAffirmativeOnly(text = '') {
  return /^(ja|yes|jepp|gjerne|ok|okay|klart|selvsagt|absolutt)(?:\s+takk|\s+gjerne)?[.!]?\s*$/i.test(compact(text));
}

export function isNoMore(text = '') {
  if (isDecline(text)) return true;
  const t = fold(text);
  if (!t || t.length > 140) return false;
  return /^(det er alt|det var alt|det holder|ikke mer|ingen mer|ferdig|nok|det var det|det er nok|alle er med|det er de|det er dem|ikke flere|ingen flere|det er alle|bare det|kun det|det var alle)\b/.test(t);
}

function productCount(bank = {}) {
  let count = 0;
  for (const catalog of bank.productCatalogs || []) {
    for (const category of catalog.categories || []) {
      count += (category.products || []).filter((row) => compact(row?.title || row?.name)).length;
    }
  }
  return count;
}

export function mediaFileCount(bank = {}) {
  const media = bank.media || {};
  const keys = [
    'mainHeroImages', 'galleryImages', 'logos', 'icons', 'uncategorized',
    'teamImages', 'aboutImages', 'locationImages', 'illustrationImages', 'offeringImages',
  ];
  return keys.reduce((sum, key) => sum + (Array.isArray(media[key]) ? media[key].filter(Boolean).length : 0), 0);
}

export function hasLogo(bank = {}) {
  return Boolean(compact(bank?.brandIdentity?.logos?.normal) || (bank?.media?.logos || []).some(Boolean));
}

export function hasListedTeam(bank = {}) {
  return (bank.staff || []).some((row) => {
    if (compact(row?.id) === SIGNER_STAFF_ID) return false;
    return Boolean(compact(row?.name) || compact(row?.title));
  });
}

export function hoursLookCustom(bank = {}) {
  const status = compact(bank?.openingHours?.status);
  if (status === 'set' || status === 'always' || status === 'not-relevant') return true;
  const days = Array.isArray(bank?.openingHours?.days) ? bank.openingHours.days : [];
  if (days.length !== DEFAULT_HOURS.length) return false;
  return days.some((day, index) => {
    const base = DEFAULT_HOURS[index];
    return compact(day?.opensAt) !== base.opensAt
      || compact(day?.closesAt) !== base.closesAt
      || Boolean(day?.closed) !== base.closed;
  });
}

export function hasAffiliations(bank = {}) {
  return (bank.affiliations || []).some((category) => (
    (category?.items || []).some((item) => compact(item?.title) || compact(item?.description))
  ));
}

function flagged(bank, key) {
  const value = compact(bank?.assistantIntake?.[key]);
  return value === 'done' || value === 'skipped';
}

export function nextIntakeStep(bank = {}) {
  if (awaitingMore(bank, 'products') || (!productCount(bank) && !flagged(bank, 'products'))) return 'products';
  if (awaitingMore(bank, 'media') || (!mediaFileCount(bank) && !flagged(bank, 'media'))) return 'media';
  if (!hasLogo(bank) && !flagged(bank, 'logo')) return 'logo';
  if (awaitingMore(bank, 'staff') || (!hasListedTeam(bank) && !flagged(bank, 'staff'))) return 'staff';
  if (!hoursLookCustom(bank) && !flagged(bank, 'hours')) return 'hours';
  if (awaitingMore(bank, 'affiliations') || (!hasAffiliations(bank) && !flagged(bank, 'affiliations'))) return 'affiliations';
  return 'done';
}

function padTime(hour, minute) {
  return `${String(hour).padStart(2, '0')}:${String(minute || '00').padStart(2, '0')}`;
}

function dayIndexesIn(clause = '') {
  const text = fold(clause);
  const found = [];
  WEEK.forEach((day, index) => {
    if (day.keys.some((key) => new RegExp(`(?:^|[^a-z])${key}(?:[^a-z]|$)`).test(text))) found.push(index);
  });
  if (found.length >= 2 && /til|-/.test(text)) {
    const start = Math.min(...found);
    const end = Math.max(...found);
    const span = [];
    for (let index = start; index <= end; index += 1) span.push(index);
    return span;
  }
  return found;
}

export function alwaysOpenDays() {
  return WEEK.map((day) => ({ day: day.day, opensAt: '00:00', closesAt: '23:59', closed: false }));
}

export function closedWeek() {
  return WEEK.map((day) => ({ day: day.day, opensAt: '', closesAt: '', closed: true }));
}

export function parseOpeningHoursAnswer(text = '') {
  const raw = compact(text);
  const folded = fold(raw);
  if (!raw) return { action: 'unclear' };
  if (/24\s*\/\s*7|dognapent|apen hele dognet|alltid apent|apent hele dogn/.test(folded)) {
    return { action: 'always', days: alwaysOpenDays(), status: 'always' };
  }
  if (isDecline(raw) || (/ikke relevant|ikke aktuelt|ingen apning|ingen faste|kun etter avtale|timebestilling/.test(folded) && !/\d{1,2}\s*[-–]\s*\d{1,2}/.test(raw))) {
    return { action: 'not-relevant', days: closedWeek(), status: 'not-relevant' };
  }
  const days = WEEK.map((day) => ({ day: day.day, opensAt: '', closesAt: '', closed: true }));
  const clauses = raw.split(/\n|[,;]|(?=\bog\b)/i).map((part) => compact(part)).filter(Boolean);
  let touched = false;
  for (const clause of clauses.length ? clauses : [raw]) {
    const indexes = dayIndexesIn(clause);
    const closed = /stengt|closed|lukket/i.test(clause);
    const range = clause.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(?:-|–|til)\s*(\d{1,2})(?:[:.](\d{2}))?/);
    const targets = indexes.length ? indexes : (range ? days.map((_, index) => index) : []);
    if (!targets.length) continue;
    touched = true;
    for (const index of targets) {
      if (closed && !range) {
        days[index] = { ...days[index], opensAt: '', closesAt: '', closed: true };
      } else if (range) {
        days[index] = {
          ...days[index],
          opensAt: padTime(range[1], range[2]),
          closesAt: padTime(range[3], range[4]),
          closed: false,
        };
      }
    }
  }
  if (!touched) return { action: 'unclear' };
  return { action: 'set', days, status: 'set' };
}

function emailIn(text = '') {
  return (String(text).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i) || [])[0] || '';
}

function phoneIn(text = '') {
  const match = String(text).match(/(?:\+\d{1,3}[\s-]?)?(?:\d[\s-]?){7,11}\d/);
  return compact(match?.[0] || '');
}

export function parseStaffAnswer(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return { action: 'unclear', people: [] };
  if (isDecline(raw)) return { action: 'skip', people: [] };
  if (isAffirmativeOnly(raw)) return { action: 'details', people: [] };
  const people = [];
  for (const line of raw.split(/\n+/)) {
    const email = emailIn(line);
    const phone = phoneIn(line.replace(email, ' '));
    const rest = compact(line.replace(email, ' ').replace(phone, ' '));
    const parts = rest.split(/[,|–—]/).map((part) => compact(part)).filter(Boolean);
    const name = parts[0] || '';
    const title = parts[1] || '';
    if (!name || name.length < 2) continue;
    if (/^(ja|yes|ansatte|team)$/i.test(name) && !title && !email && !phone) continue;
    people.push({ name, title, phone, email: email.toLowerCase() });
  }
  if (!people.length) return { action: 'unclear', people: [] };
  return { action: 'save', people };
}

function splitNames(text = '') {
  return String(text || '')
    .split(/,|\/|&|\bog\b/i)
    .map((part) => compact(part))
    .filter((part) => part.length > 1 && !/^(ja|nei|partnere|partnere:|affiliasjoner)$/i.test(part));
}

export function parseAffiliationsAnswer(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return { action: 'unclear', categories: [] };
  if (isDecline(raw)) return { action: 'skip', categories: [] };
  if (isAffirmativeOnly(raw)) return { action: 'details', categories: [] };
  const categories = [];
  let current = { categoryName: 'Partnere', items: [] };
  for (const line of raw.split(/\n+/)) {
    const labeled = line.match(/^([^:]{2,40}):\s*(.+)$/);
    if (labeled) {
      if (current.items.length) categories.push(current);
      current = { categoryName: compact(labeled[1]), items: splitNames(labeled[2]).map((title) => ({ title })) };
      continue;
    }
    current.items.push(...splitNames(line).map((title) => ({ title })));
  }
  if (current.items.length) categories.push(current);
  const usable = categories.filter((category) => category.items.length);
  if (!usable.length) return { action: 'unclear', categories: [] };
  return { action: 'save', categories: usable };
}

const MEDIA_GROUP_LABELS = [
  ['mainHeroImages', 'Hovedbilde'],
  ['aboutImages', 'Om oss'],
  ['teamImages', 'Ansatte'],
  ['locationImages', 'Lokasjon'],
  ['logos', 'Logo'],
  ['icons', 'Ikoner'],
  ['illustrationImages', 'Illustrasjoner'],
  ['offeringImages', 'Tjenester / meny'],
  ['galleryImages', 'Bildegalleri'],
  ['uncategorized', 'Annet'],
];

function mediaGroups(bank = {}) {
  const media = bank.media || {};
  return MEDIA_GROUP_LABELS.map(([key, label]) => ({
    key,
    label,
    urls: (Array.isArray(media[key]) ? media[key] : []).map((url) => compact(url)).filter(Boolean),
  })).filter((group) => group.urls.length);
}

function listedPeople(bank = {}) {
  return (bank.staff || []).filter((row) => {
    if (compact(row?.id) === SIGNER_STAFF_ID) return false;
    return Boolean(compact(row?.name) || compact(row?.title));
  }).map((row) => ({
    name: compact(row?.name),
    title: compact(row?.title),
    imageUrl: compact(row?.imageUrl),
  }));
}

function hoursReview(bank = {}) {
  const status = compact(bank?.openingHours?.status);
  if (status === 'not-relevant') return { filled: true, summary: 'Ikke relevant', lines: ['Ikke relevant'] };
  if (status === 'always') return { filled: true, summary: 'Døgnåpent', lines: ['Døgnåpent'] };
  if (!hoursLookCustom(bank)) return { filled: false, summary: '', lines: [] };
  const lines = (Array.isArray(bank?.openingHours?.days) ? bank.openingHours.days : []).map((day) => {
    const name = compact(day?.day);
    if (!name) return '';
    if (day?.closed) return `${name}: stengt`;
    const opens = compact(day?.opensAt);
    const closes = compact(day?.closesAt);
    return closes ? `${name}: ${opens}–${closes}` : `${name}: ${opens}`;
  }).filter(Boolean);
  return { filled: true, summary: lines[0] || 'Satt', lines };
}

function partnerGroups(bank = {}) {
  return (bank.affiliations || []).map((category) => ({
    label: compact(category?.categoryName) || 'Partnere',
    items: (category?.items || []).map((item) => compact(item?.title)).filter(Boolean),
  })).filter((group) => group.items.length);
}

export function intakeReview(bank = {}) {
  const groups = mediaGroups(bank);
  const mediaCount = groups.reduce((sum, group) => sum + group.urls.length, 0);
  const logo = compact(bank?.brandIdentity?.logos?.normal) || (bank?.media?.logos || []).map((url) => compact(url)).find(Boolean) || '';
  const people = listedPeople(bank);
  const hours = hoursReview(bank);
  const partners = partnerGroups(bank);
  const count = productCount(bank);
  const current = nextIntakeStep(bank);
  const rows = [
    {
      step: 'products',
      filled: count > 0,
      summary: count ? `${count} ${count === 1 ? 'produkt' : 'produkter'}` : '',
    },
    {
      step: 'media',
      filled: mediaCount > 0,
      summary: mediaCount ? `${mediaCount} ${mediaCount === 1 ? 'fil' : 'filer'}` : '',
      groups,
    },
    {
      step: 'logo',
      filled: Boolean(logo),
      summary: logo ? 'Logo lagret' : '',
      url: logo,
    },
    {
      step: 'staff',
      filled: people.length > 0,
      summary: people.length ? `${people.length} ${people.length === 1 ? 'person' : 'personer'}` : '',
      people,
    },
    {
      step: 'hours',
      filled: hours.filled,
      summary: hours.summary,
      lines: hours.lines,
    },
    {
      step: 'affiliations',
      filled: partners.some((group) => group.items.length),
      summary: partners.length
        ? `${partners.reduce((sum, group) => sum + group.items.length, 0)} partnere`
        : '',
      groups: partners,
    },
  ];
  return {
    current,
    steps: rows.map((row) => ({
      ...row,
      label: STEP_LABELS[row.step],
      status: row.filled
        ? 'filled'
        : (flagged(bank, row.step) ? 'skipped' : (current === row.step ? 'current' : 'waiting')),
    })),
  };
}

export function withIntakeFlag(bank = {}, key, value) {
  return {
    ...bank,
    assistantIntake: {
      ...(bank.assistantIntake || {}),
      [key]: value,
    },
  };
}
