import { osloCalendarYmd, osloWallToIso } from './website-due.js';

// JS \b only knows ASCII letters, so /\btravelt nå\b/ never matched. ure() turns \b into a Unicode word edge.
const WORD_CHAR = '[\\p{L}\\p{N}_]';
const WORD_EDGE = `(?:(?<=${WORD_CHAR})(?!${WORD_CHAR})|(?<!${WORD_CHAR})(?=${WORD_CHAR}))`;

/** RegExp from a source string where \b means a Unicode word edge (always the u flag). */
function ure(source, flags = 'i') {
  return new RegExp(source.replace(/\\b/g, WORD_EDGE), flags.includes('u') ? flags : `${flags}u`);
}

const WEEKDAYS = {
  sondag: 0,
  søndag: 0,
  sunday: 0,
  mandag: 1,
  monday: 1,
  tirsdag: 2,
  tuesday: 2,
  onsdag: 3,
  wednesday: 3,
  torsdag: 4,
  thursday: 4,
  fredag: 5,
  friday: 5,
  lordag: 6,
  lørdag: 6,
  saturday: 6,
};

const MONTHS = {
  januar: 1, january: 1, jan: 1,
  februar: 2, february: 2, feb: 2,
  mars: 3, march: 3, mar: 3,
  april: 4, apr: 4,
  mai: 5, may: 5,
  juni: 6, june: 6, jun: 6,
  juli: 7, july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sept: 9, sep: 9,
  oktober: 10, october: 10, okt: 10, oct: 10,
  november: 11, nov: 11,
  desember: 12, december: 12, des: 12, dec: 12,
};

const HOUR_WORDS = { en: 1, ett: 1, eitt: 1, to: 2, tre: 3, fire: 4, fem: 5, seks: 6, sju: 7, syv: 7, åtte: 8, ni: 9, ti: 10, elleve: 11, tolv: 12 };
const MINUTE_WORDS = { fem: 5, ti: 10, kvart: 15, tjue: 20 };
const DAY_WORDS = { en: 1, ett: 1, to: 2, tre: 3, fire: 4, fem: 5, seks: 6, sju: 7, syv: 7, ti: 10, fjorten: 14, a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10 };

const byLength = (keys) => keys.sort((a, b) => b.length - a.length).join('|');
const WEEKDAY_SRC = byLength(Object.keys(WEEKDAYS));
const MONTH_SRC = byLength(Object.keys(MONTHS));
const HOUR_WORD_SRC = byLength(Object.keys(HOUR_WORDS));
const DAY_WORD_SRC = byLength(Object.keys(DAY_WORDS));
const NOT_MONTH_AHEAD = `(?!\\.?\\s*(?:${MONTH_SRC})(?!\\p{L}))(?![./]\\d)`;

// Earliest/latest meeting clock (wall time, Oslo). Anything outside is not a meeting time.
const FIRST_MINUTE = 7 * 60;
const LAST_MINUTE = 19 * 60;

function compact(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function addDaysYmd(ymd = '', days = 0) {
  const date = new Date(`${ymd}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + Number(days));
  return date.toISOString().slice(0, 10);
}

function osloWeekday(ymd = '') {
  const iso = osloWallToIso(ymd, 12, 0, 0);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return -1;
  return new Date(ms).getUTCDay();
}

function isWeekendYmd(ymd = '') {
  const weekday = osloWeekday(ymd);
  return weekday === 0 || weekday === 6;
}

/** Saturday/Sunday → the Monday after. */
function rollToWeekday(ymd = '') {
  const weekday = osloWeekday(ymd);
  if (weekday === 6) return addDaysYmd(ymd, 2);
  if (weekday === 0) return addDaysYmd(ymd, 1);
  return ymd;
}

function nextWeekdayYmd(fromYmd = '', weekday = 1, { nextWeek = false } = {}) {
  const ymd = fromYmd;
  const todayWeekday = osloWeekday(ymd);
  if (nextWeek) {
    // "onsdag neste uke" = that weekday in the next Monday–Sunday week, not "next one + 7".
    const toMonday = ((1 - todayWeekday + 7) % 7) || 7;
    return addDaysYmd(ymd, toMonday + ((Number(weekday) + 6) % 7));
  }
  let delta = (Number(weekday) - todayWeekday + 7) % 7;
  if (delta === 0) delta = 7;
  return addDaysYmd(ymd, delta);
}

function originDate(now) {
  const ms = now instanceof Date ? now.getTime() : Date.parse(now);
  return Number.isFinite(ms) ? new Date(ms) : new Date();
}

/** Real calendar day or ''. */
function ymdOf(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!(y >= 2000 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return '';
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return '';
  return date.toISOString().slice(0, 10);
}

/** Day + month (+ optional year). A yearless date more than 60 days back means next year. */
function inferYmd(day, month, yearRaw, todayYmd) {
  if (yearRaw) {
    const year = Number(yearRaw);
    return ymdOf(year < 100 ? 2000 + year : year, month, day);
  }
  const year = Number(todayYmd.slice(0, 4));
  const ymd = ymdOf(year, month, day);
  if (!ymd) return '';
  return ymd < addDaysYmd(todayYmd, -60) ? ymdOf(year + 1, month, day) : ymd;
}

/** "den 12." → the next 12th from today. */
function dayOfMonthYmd(dom, todayYmd) {
  const [year, month, today] = todayYmd.split('-').map(Number);
  if (dom >= today) {
    const same = ymdOf(year, month, dom);
    if (same) return same;
  }
  return month === 12 ? ymdOf(year + 1, 1, dom) : ymdOf(year, month + 1, dom);
}

/** Clock-face hour (0-12) → the reading inside business hours ("halv tre" → 14). */
function businessHour(face) {
  const options = face === 0 || face === 12 ? [12] : [face, face + 12];
  return options.find((hour) => hour >= 7 && hour <= 18) ?? options[0];
}

function clockIsMeeting(hour, minute) {
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return false;
  const at = hour * 60 + minute;
  return at >= FIRST_MINUTE && at <= LAST_MINUTE;
}

function hourWord(raw = '') {
  return /^\d+$/.test(raw) ? Number(raw) : HOUR_WORDS[raw];
}

/** "kl 2" means 14:00; "kl 02" stays 02:00 (and is then not a meeting time). */
function klHour(raw = '') {
  const hour = Number(raw);
  return hour >= 1 && hour <= 6 && !raw.startsWith('0') ? hour + 12 : hour;
}

function clockToken(hour, minute, strong) {
  return { kind: 'clock', hour, minute, strong, valid: clockIsMeeting(hour, minute) };
}

/** "halv tre", "kvart på to", "fem over halv ti" → business-hours clock. */
function faceClock(face, minute) {
  if (!Number.isInteger(face) || face < 0) return null;
  if (face > 12) return clockToken(face, minute, true);
  return clockToken(businessHour(face), minute, true);
}

// Normalized text: quoted '>' lines dropped (never the client's own words), one space, newlines kept.
function normalizeBlob(text = '') {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n')
    .replace(/[’‘´`]/g, "'")
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim()
    .toLowerCase();
}

const ENGLISH_RE = ure('\\b(?:the|we|can|could|meeting|works?|tomorrow|today|next|move|instead|please|monday|tuesday|wednesday|thursday|friday)\\b');
const MOVE_BEFORE_RE = ure('\\b(?:flytt\\p{L}*|endre|bytte|move|change|reschedule)\\b[^.!?\\n]{0,40}$');

// Token rules in priority order: an earlier rule wins any overlap.
const TOKEN_RULES = [
  [ure('(?<!\\d)(20\\d{2})-(\\d{2})-(\\d{2})(?!\\d)', 'gi'), (m) => {
    const ymd = ymdOf(m[1], m[2], m[3]);
    return ymd ? { kind: 'date', ymd, iso: true } : null;
  }],
  // "mellom 13.30 og 15", "fra kl 10 til 12" → the start (not when moving "fra X til Y").
  [ure(`\\b(?:mellom|fra|between|from)\\s+(kl\\.?\\s*|klokka\\s+|klokken\\s+)?(\\d{1,2})(?:[:.](\\d{2}))?\\s*(?:og|til|-|–|and|to)\\s*(?:kl\\.?\\s*)?(\\d{1,2})(?:[:.](\\d{2}))?(?!\\d)${NOT_MONTH_AHEAD}`, 'gi'), (m, ctx) => {
    if (MOVE_BEFORE_RE.test(ctx.blob.slice(Math.max(0, m.index - 60), m.index))) return null;
    const bare = !m[1] && !m[3];
    if (bare && !clockIsMeeting(klHour(m[4]), Number(m[5] || 0))) return null;
    // A bare "fra 10 til 18" is often opening hours, so it only counts next to a day in the same sentence.
    return clockToken(klHour(m[2]), Number(m[3] || 0), !bare);
  }],
  // "etter kl 12", "før 10", "ikke før kl 12" → bounds for slot picking, never a booked clock.
  [ure(`\\b(ikke før|etter|after|før|before|innen|by|senest|tidligst|fra og med|fra)\\s+(?:kl\\.?|klokka|klokken)?\\s*(\\d{1,2})(?:[:.](\\d{2}))?(?!\\d)(?!\\s*(?:dager|dag|døgn|uker|uke|timer|time|min|days|day|weeks|hours|%|kr|år))${NOT_MONTH_AHEAD}`, 'gi'), (m, ctx) => {
    if (m[1] === 'fra' && MOVE_BEFORE_RE.test(ctx.blob.slice(Math.max(0, m.index - 60), m.index))) return null;
    const hour = klHour(m[2]);
    if (hour > 19) return null;
    const after = /^(?:ikke før|etter|after|tidligst|fra og med|fra)$/.test(m[1]);
    return after ? { kind: 'bound', after: hour } : { kind: 'bound', before: hour };
  }],
  [ure(`(?<![\\p{L}\\p{N}])(\\d{1,2})(?:\\.|st|nd|rd|th)?\\s*(?:(?:av|of)\\s+)?(${MONTH_SRC})(?!\\p{L})\\.?(?:\\s*,?\\s*(20\\d{2}))?(?!\\d)`, 'gi'), (m, ctx) => {
    const ymd = inferYmd(m[1], MONTHS[m[2]], m[3], ctx.todayYmd);
    return ymd ? { kind: 'date', ymd } : null;
  }],
  [ure(`(?<!\\p{L})(${MONTH_SRC})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s*(20\\d{2}))?(?![:.]\\d)`, 'gi'), (m, ctx) => {
    const ymd = inferYmd(m[2], MONTHS[m[1]], m[3], ctx.todayYmd);
    return ymd ? { kind: 'date', ymd } : null;
  }],
  [ure(`(?<!\\p{L})(?:(?:kl|klokka|klokken)\\.?\\s*)?(?:(fem|ti|tjue|\\d{1,2})\\s+(over|på)\\s+)?halv\\s+(${HOUR_WORD_SRC}|\\d{1,2})(?![\\p{L}\\p{N}])`, 'gi'), (m) => {
    const shift = m[1] ? (MINUTE_WORDS[m[1]] ?? Number(m[1])) * (m[2] === 'over' ? 1 : -1) : 0;
    return faceClock(hourWord(m[3]) - 1, 30 + shift);
  }],
  [ure(`(?<!\\p{L})(?:(?:kl|klokka|klokken)\\.?\\s*)?(fem|ti|tjue|kvart)\\s+(over|på)\\s+(${HOUR_WORD_SRC}|\\d{1,2})(?![\\p{L}\\p{N}])`, 'gi'), (m) => {
    const hour = hourWord(m[3]);
    const minutes = MINUTE_WORDS[m[1]];
    return m[2] === 'over' ? faceClock(hour, minutes) : faceClock(hour - 1, 60 - minutes);
  }],
  [ure('(?<!\\p{L})(?:kl|klokka|klokken|kloka)\\.?\\s*(\\d{1,2})(?:[:.](\\d{2})|(\\d{2}))?(?!\\d)', 'gi'), (m) => (
    clockToken(klHour(m[1]), Number(m[2] || m[3] || 0), true)
  )],
  [ure(`(?<!\\p{L})(?:kl|klokka|klokken)\\.?\\s+(${HOUR_WORD_SRC})(?!\\p{L})`, 'gi'), (m) => (
    clockToken(businessHour(HOUR_WORDS[m[1]]), 0, true)
  )],
  // "ved 13-tiden", "i ti-tiden" name an hour ("rundt 13" / "ca 12" alone do not).
  [ure(`(?<![\\p{L}\\p{N}])(?:(\\d{1,2})\\s*-?\\s*|(${HOUR_WORD_SRC})-)tiden(?!\\p{L})`, 'gi'), (m) => (
    clockToken(m[1] ? klHour(m[1]) : businessHour(HOUR_WORDS[m[2]]), 0, false)
  )],
  [ure('(?<![\\p{L}\\p{N}:.])(?:at\\s+)?(\\d{1,2})(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)(?!\\p{L})', 'gi'), (m) => {
    let hour = Number(m[1]);
    if (hour > 12) return null;
    if (m[3].startsWith('p') && hour < 12) hour += 12;
    if (m[3].startsWith('a') && hour === 12) hour = 0;
    return clockToken(hour, Number(m[2] || 0), true);
  }],
  [ure('(?<!\\p{L})at\\s+(\\d{1,2})(?:[:.](\\d{2}))?(?!\\d)(?!\\s*(?:%|kr|nok|av|of|days|people|personer|stk))', 'gi'), (m, ctx) => {
    if (!ENGLISH_RE.test(ctx.blob)) return null;
    return clockToken(klHour(m[1]), Number(m[2] || 0), true);
  }],
  [ure('(?<![\\p{N}:.,])(\\d{1,2}):(\\d{2})(?!\\d)', 'gi'), (m) => clockToken(Number(m[1]), Number(m[2]), false)],
  [ure('(?<![\\p{N}.:/,])(\\d{1,2})\\.(\\d{1,2})(?:\\.(20\\d{2}|\\d{2}))?(?!\\d)(?!\\.\\d)', 'gi'), (m) => ({
    kind: 'pair', a: Number(m[1]), b: Number(m[2]), rawB: m[2], year: m[3] || '',
  })],
  [ure('(?<![\\p{N}/.])(\\d{1,2})/(\\d{1,2})(?:/(20\\d{2}|\\d{2}))?(?![\\p{N}/])', 'gi'), (m, ctx) => {
    if (m[0] === '24/7') return null;
    const ymd = inferYmd(m[1], m[2], m[3], ctx.todayYmd);
    return ymd ? { kind: 'date', ymd } : null;
  }],
  [ure(`(?<!\\p{L})(${WEEKDAY_SRC})(?:en|er|s)?(?!\\p{L})`, 'gi'), (m) => ({ kind: 'weekday', weekday: WEEKDAYS[m[1]] })],
  [ure('(?<!\\p{L})(i\\s*overmorgen|overimorgen|day after tomorrow|i\\s*morgen|imorgen|i\\s*morra|imorra|tomorrow|i\\s*dag|idag|today|i\\s*går|igår|yesterday)(?!\\p{L})', 'gi'), (m, ctx) => {
    const phrase = m[1].replace(/\s+/g, '');
    const before = ctx.blob.slice(Math.max(0, m.index - 4), m.index);
    if (/^(?:idag|today)$/.test(phrase) && /for $/.test(before)) return null; // "takk for i dag"
    const offset = /overmorgen|overimorgen|dayafter/.test(phrase) ? 2
      : /morgen|morra|tomorrow/.test(phrase) ? 1
        : /går|yesterday/.test(phrase) ? -1 : 0;
    return { kind: 'relative', offset };
  }],
  [ure(`(?<!\\p{L})(?:om|in)\\s+(\\d{1,3}|${DAY_WORD_SRC})\\s+(dager|dag|døgn|uker|uke|måneder|måned|days|day|weeks|week|months|month)(?!\\p{L})`, 'gi'), (m) => {
    const count = /^\d+$/.test(m[1]) ? Number(m[1]) : DAY_WORDS[m[1]];
    const weeks = /^(?:uke|week)/.test(m[2]);
    const months = /^(?:måned|month)/.test(m[2]);
    const days = count * (weeks ? 7 : months ? 30 : 1);
    if (!Number.isFinite(days) || days < 1 || days > 120) return null;
    return { kind: 'om', days, fuzzy: weeks || months };
  }],
  [ure('(?<!\\p{L})(?:neste uke|neste veke|uka etter|uken etter|next week)(?!\\p{L})', 'gi'), () => ({ kind: 'nextweek' })],
  [ure('(?<!\\p{L})den\\s+(\\d{1,2})\\.?(?!\\d)(?![.:]\\d)(?!\\s*(?:timer|time|min|dager|uker|personer|stk|kr|%))', 'gi'), (m) => ({ kind: 'dom', dom: Number(m[1]) })],
];

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** Every token, highest-priority rule first, no overlaps, sorted by position. */
function scanTokens(ctx) {
  const accepted = [];
  for (const [re, build] of TOKEN_RULES) {
    for (const m of ctx.blob.matchAll(re)) {
      const data = build(m, ctx);
      if (!data) continue;
      const token = { start: m.index, end: m.index + m[0].length, ...data };
      if (!accepted.some((other) => overlaps(other, token))) accepted.push(token);
    }
  }
  return accepted.sort((a, b) => a.start - b.start);
}

const SMALL_GAP_RE = /^[\s,]*(?:(?:den|på|the|on)\s+)?$/;
const DATE_LEAD_RE = ure('\\b(?:den|til|fra|innen|etter|før|dato|datoen|frem til|fram til|until|by)\\s+$');

const clockLikePair = (token) => token?.kind === 'pair' && !token.year && token.a <= 23 && token.b <= 59 && token.rawB.length === 2;
const dateLikePair = (token, ctx) => token?.kind === 'pair' && Boolean(inferYmd(token.a, token.b, token.year, ctx.todayYmd));

/**
 * "12.11" is a date before a clock (also "12.03 13.30"), after a date word, as "12.11." or matching
 * a weekday; "10.30" is a clock; "3.5 ansatte" / "versjon 2.10" are neither.
 */
function classifyPair(token, prev, next, ctx) {
  const { a, b, year, rawB } = token;
  const asDate = () => {
    const ymd = inferYmd(a, b, year, ctx.todayYmd);
    return ymd ? { ...token, kind: 'date', ymd } : null;
  };
  const asClock = () => (a <= 23 && b <= 59 && rawB.length === 2 ? { ...token, ...clockToken(a, b, false) } : null);
  const closeTo = (left, right) => SMALL_GAP_RE.test(ctx.blob.slice(left.end, right.start));
  if (year) return asDate();
  if (next?.kind === 'clock' && closeTo(token, next)) return asDate();
  if (clockLikePair(next) && closeTo(token, next) && asDate()) return asDate();
  if (clockLikePair(token) && dateLikePair(prev, ctx) && closeTo(prev, token)) return asClock();
  if (prev && (prev.kind === 'weekday' || prev.kind === 'relative') && SMALL_GAP_RE.test(ctx.blob.slice(prev.end, token.start))) {
    const date = prev.kind === 'weekday' ? asDate() : null;
    if (date && osloWeekday(date.ymd) === prev.weekday) return date;
    return asClock();
  }
  if (DATE_LEAD_RE.test(ctx.blob.slice(Math.max(0, token.start - 12), token.start))) return asDate();
  if (rawB.length === 2 && /^\.(?!\d)/.test(ctx.blob.slice(token.end))) return asDate();
  if (b > 12 || [0, 15, 30, 45].includes(b)) return asClock();
  return null;
}

// "torsdag 12." or a bare "onsdag 12" right before a clock ("kl 9", "klokka ti", "at 9", "13:30").
const WEEKDAY_DOM_RE = /^(\s+(?:den\s+)?)(\d{1,2})(?:\.(?!\d)|(?=\s+(?:(?:kl|klokka|klokken|kloka)\.?\s*\d|(?:klokka|klokken|kloka)\s+\p{L}|at\s+\d|\d{1,2}[:.]\d{2}(?!\d))))/u;

/** "torsdag 12." / "onsdag 12 kl 9" → the next 12th (checked against the weekday later, so a wrong pair gives null). */
function addWeekdayDayOfMonth(tokens, ctx) {
  const extra = [];
  for (const token of tokens) {
    if (token.kind !== 'weekday') continue;
    const m = ctx.blob.slice(token.end).match(WEEKDAY_DOM_RE);
    if (!m) continue;
    const dom = { start: token.end + m[1].length, end: token.end + m[0].length, kind: 'dom', dom: Number(m[2]) };
    if (!tokens.some((other) => overlaps(other, dom))) extra.push(dom);
  }
  return [...tokens, ...extra].sort((a, b) => a.start - b.start);
}

/** Positions where a sentence ends (not inside "12. nov.", "kl. 14" or "14.30"). */
const ABBREVIATIONS = new Set(['kl', 'ca', 'nov', 'okt', 'des', 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'dec', 'man', 'tir', 'tirs', 'ons', 'tor', 'tors', 'fre', 'lør', 'lor', 'søn', 'son', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun', 'nr', 'tlf', 'tel', 'evt', 'bl', 'osv', 'dvs', 'eks', 'ref', 'pr', 'st']);
const MONTH_AHEAD_RE = ure(`^\\s*(?:${MONTH_SRC})(?!\\p{L})`);

function sentenceCuts(blob) {
  const cuts = [];
  for (let i = 0; i < blob.length; i += 1) {
    const ch = blob[i];
    if (ch === '!' || ch === '?' || ch === ';' || ch === '\n') {
      cuts.push(i);
      continue;
    }
    if (ch !== '.') continue;
    const next = blob[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    const before = blob.slice(Math.max(0, i - 12), i);
    const word = before.match(/\p{L}+$/u)?.[0] || '';
    if (word && ABBREVIATIONS.has(word)) continue;
    if (/\d$/.test(before) && MONTH_AHEAD_RE.test(blob.slice(i + 1))) continue;
    if (/(?<![\d.])\d{1,2}\.\d{1,2}$/.test(before) && /^\s\d{1,2}[:.]\d{2}(?!\d)/.test(blob.slice(i + 1))) continue; // "12.03. 13.30"
    cuts.push(i);
  }
  return cuts;
}

const CONTRAST_RE = ure('\\b(?:men|but|derimot|ellers|heller|however|otherwise)\\b', 'giu');

function clauseCuts(blob, sentences) {
  const cuts = [...sentences];
  for (let i = 0; i < blob.length; i += 1) {
    if (blob[i] === ',' && !(/\d/.test(blob[i - 1] || '') && /\d/.test(blob[i + 1] || ''))) cuts.push(i);
  }
  for (const m of blob.matchAll(CONTRAST_RE)) if (m.index > 0) cuts.push(m.index - 1);
  return [...new Set(cuts)].sort((a, b) => a - b);
}

function indexIn(cuts, pos) {
  let index = 0;
  for (const cut of cuts) {
    if (cut < pos) index += 1;
    else break;
  }
  return index;
}

// "kan ikke", "får ikke til", "passer dårlig", "er opptatt", "can't" make the whole clause negative.
const FILLER = '(?:\\s+(?:jeg|eg|vi|dere|du|nok|dessverre|desverre|faktisk|jo|altså|uansett|likevel|da|det|den|meg|oss|helt|bare|vel))*';
const NEG_CUE_RE = ure([
  `\\bkan${FILLER}\\s+ikke\\b`,
  `\\b(?:får|fikk|rekker|rakk|klarer|klarte|kommer|møter|deltar|kunne|går|gikk|passer|blir|funker|fungerer)${FILLER}\\s+ikke\\b`,
  `\\bhar${FILLER}\\s+ikke\\s+(?:anledning|mulighet|tid)\\b`,
  '\\bpasser\\s+(?:\\p{L}+\\s+)?dårlig\\b',
  '\\bikke\\s+(?:aktuelt|mulig|ledig|tilgjengelig|anledning|mulighet)\\b',
  '\\b(?:opptatt|bortreist|utilgjengelig|uaktuel\\p{L}*|avlys\\p{L}*|avbestill\\p{L}*|kanseller\\p{L}*|cancel\\p{L}*)\\b',
  // "torsdag er (helt) fullt", "fredag blir (litt) vanskelig" — but not "fullt mulig" / "fullt forståelig".
  `\\b(?:er|blir|var|ble)${FILLER}\\s+(?:full|fullt|fullbooket|fullbooka|fulltegnet|booket opp|booka opp|stappfull\\p{L}*)\\b(?!\\s+(?:mulig|ut|greit|forståelig|forstått|ok|i orden|fart))`,
  `\\b(?:er|blir|var|ble)${FILLER}\\s+(?:(?:litt|veldig|for|ganske|svært|kjempe)\\s+)?(?:vanskelig|vanskeleg|vrient|problematisk|umulig|dårlig)\\b`,
  '\\b(?:fully booked|booked up)\\b|\\b(?:is|would be|will be)\\s+(?:difficult|tricky|hard)\\b',
  "\\b(?:can'?t|cannot|can not|couldn'?t|unable|unavailable|busy)\\b",
  "\\b(?:won'?t|will not)\\s+(?:be able|work)\\b",
  "\\b(?:doesn'?t|does not|don'?t|do not)\\s+work\\b",
  '\\bnot\\s+(?:available|possible|able)\\b',
].join('|'));
// Suggestions that only look negative ("kan vi ikke heller ta fredag?", "ikke noe problem").
const NOT_NEGATIVE_RE = ure("\\bkan\\s+(?:vi|dere|du)\\s+ikke\\s+(?:bare\\s+|heller\\s+)*(?:ta|flytte|møtes|gjøre|sette|ha|se)\\b|\\b(?:passer|går)\\s+det\\s+ikke\\s+(?:bedre|fint|an)\\b|\\bhvorfor ikke\\b|\\bikke (?:noe )?problem\\b|\\bikke så farlig\\b|\\bwhy not\\b|\\bno problem\\b", 'giu');
// Opening hours in a signature ("åpent man-fre 10:00-18:00") are not a meeting offer.
const OPENING_HOURS_RE = ure('\\b(?:åpent|åpningstid\\p{L}*|stengt|stenger|open|opening hours|man-fre|mon-fri)\\b');
const DIRECT_NEG_RE = ure('(?:^|[^\\p{L}])(?:ikke|not)\\s+(?:(?:på|den|om|on|at|this|next|neste|til|to)\\s+)?$');
// "i stedet for kl 10" (the old time) and "innen fredag kl 12" (a deadline) are not the time they want.
const INSTEAD_RE = ure('\\b(?:i\\s*stede[nt]?\\s*for|istedenfor|istedetfor|instead of|rather than|innen|senest|by|before|før)\\b', 'giu');
const MOVE_FROM_RE = ure('\\b(?:flytt\\p{L}*|endre|bytte|move|change|reschedule)\\b(?:(?!\\b(?:til|to)\\b)[^.!?\\n]){0,40}?\\b(?:fra|from)\\b((?:(?!\\b(?:til|to)\\b)[^.!?\\n]){1,40}?)\\b(?:til|to)\\b', 'giud');
const OLD_LEAD_RE = /^\s*(?:(?:på|den|om|on|at|møtet|the meeting|the)\s+)*$/u;
const OLD_CHAIN_RE = /^[\s,]*(?:(?:på|den|at|on)\s+)?$/u;

/** Tokens a client moves away from: "i stedet for kl 10", "flytte fra torsdag til fredag". */
function markOld(refs, blob) {
  const old = new Set();
  for (const m of blob.matchAll(INSTEAD_RE)) {
    let cursor = m.index + m[0].length;
    let lead = OLD_LEAD_RE;
    for (const ref of refs) {
      if (ref.start < cursor) continue;
      if (!lead.test(blob.slice(cursor, ref.start))) break;
      old.add(ref);
      cursor = ref.end;
      lead = OLD_CHAIN_RE;
    }
  }
  for (const m of blob.matchAll(MOVE_FROM_RE)) {
    const [from, to] = m.indices[1];
    for (const ref of refs) if (ref.start >= from && ref.end <= to) old.add(ref);
  }
  return old;
}

function weekdayDayRef(token, nextWeek, ctx) {
  return {
    ...token,
    kind: 'day',
    source: 'weekday',
    nextWeek,
    ymd: nextWeekdayYmd(ctx.todayYmd, token.weekday, { nextWeek }),
  };
}

/** Day references: merged "torsdag 12. november", lone weekdays, relative days. Clock/bound tokens pass through. */
function buildRefs(tokens, ctx) {
  const out = [];
  const used = new Set();
  const sentenceOf = (pos) => indexIn(ctx.sentences, pos);
  const clauseOf = (pos) => indexIn(ctx.clauses, pos);
  // "neste uke tirsdag" / "tirsdag neste uke": the week phrase only shifts that weekday.
  const nextWeekFor = new Set();
  for (const token of tokens) {
    if (token.kind !== 'weekday') continue;
    const week = tokens.find((other) => other.kind === 'nextweek' && !used.has(other) && (
      clauseOf(other.start) === clauseOf(token.start)
      || (sentenceOf(other.start) === sentenceOf(token.start) && /^[\s,]*(?:på\s+)?$/u.test(ctx.blob.slice(Math.min(token.end, other.end), Math.max(token.start, other.start))))
    ));
    if (!week) continue;
    used.add(week);
    nextWeekFor.add(token);
  }
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (used.has(token)) continue;
    if (token.kind === 'weekday') {
      const next = tokens[i + 1];
      const prev = out.at(-1);
      if (next && (next.kind === 'date' || next.kind === 'dom') && /^[\s,]*(?:den\s+)?$/u.test(ctx.blob.slice(token.end, next.start))) {
        const ymd = next.kind === 'date' ? next.ymd : dayOfMonthYmd(next.dom, ctx.todayYmd);
        used.add(next);
        out.push({ start: token.start, end: next.end, kind: 'day', source: next.iso ? 'iso' : 'merged', ymd, conflict: !ymd || osloWeekday(ymd) !== token.weekday });
        continue;
      }
      if (prev?.kind === 'day' && (prev.source === 'date' || prev.source === 'iso') && /^[\s,(]*$/u.test(ctx.blob.slice(prev.end, token.start))) {
        prev.end = token.end;
        prev.source = 'merged';
        prev.conflict = osloWeekday(prev.ymd) !== token.weekday;
        continue;
      }
      out.push(weekdayDayRef(token, nextWeekFor.has(token), ctx));
      continue;
    }
    if (token.kind === 'date') {
      out.push({ ...token, kind: 'day', source: token.iso ? 'iso' : 'date' });
      continue;
    }
    if (token.kind === 'dom') {
      const ymd = dayOfMonthYmd(token.dom, ctx.todayYmd);
      if (ymd) out.push({ ...token, kind: 'day', source: 'dom', ymd });
      continue;
    }
    if (token.kind === 'relative') {
      out.push({ ...token, kind: 'day', source: 'relative', relative: true, past: token.offset < 0, ymd: addDaysYmd(ctx.todayYmd, token.offset) });
      continue;
    }
    if (token.kind === 'om') {
      out.push({ ...token, kind: 'day', source: 'om', relative: true, ymd: addDaysYmd(ctx.todayYmd, token.days) });
      continue;
    }
    if (token.kind === 'nextweek') {
      out.push({ ...token, kind: 'day', source: 'nextweek', relative: true, fuzzy: true, ymd: nextWeekdayYmd(ctx.todayYmd, 1, { nextWeek: true }) });
      continue;
    }
    out.push(token);
  }
  return out;
}

const BARE_DAY_REST_RE = ure('^[\\s,.:;–-]*(?:(?:på|om|den|og|eller|hva med|når det gjelder|angående|ang)\\b[\\s,.:;–-]*)*$');
const CONTRAST_START_RE = ure('^\\s*(?:men|but|derimot|ellers|heller|however|otherwise)\\b');

/** "Torsdag (kl 10), det går ikke": a clause holding only a day/clock takes the "no" of the next clause in the sentence (not after "men"). */
function markBareDayClauses(refs, { blob, clauseStart, clauseEnd, sentences }, negative) {
  clauseStart.forEach((start, index) => {
    const next = index + 1;
    if (negative.has(index) || !negative.has(next) || indexIn(sentences, start) !== indexIn(sentences, clauseStart[next])) return;
    const named = refs.filter((ref) => (ref.kind === 'day' || ref.kind === 'clock') && ref.start >= start && ref.end <= clauseEnd[index]);
    if (!named.some((ref) => ref.kind === 'day') || CONTRAST_START_RE.test(blob.slice(clauseStart[next], clauseEnd[next]))) return;
    let rest = blob.slice(start, clauseEnd[index]);
    for (const ref of [...named].reverse()) rest = rest.slice(0, ref.start - start) + rest.slice(ref.end - start);
    if (BARE_DAY_REST_RE.test(rest)) negative.add(index);
  });
}

/** Shared parse: tokens with polarity ('pos' | 'neg' | 'old'), clauses and the positive text. */
function analyze(text = '', now = new Date()) {
  const blob = normalizeBlob(text);
  const todayYmd = osloCalendarYmd(originDate(now).toISOString());
  const sentences = sentenceCuts(blob);
  const clauses = clauseCuts(blob, sentences);
  const ctx = { blob, todayYmd, sentences, clauses };
  if (!blob) return { ...ctx, days: [], clocks: [], bounds: [], positiveText: '' };
  let tokens = addWeekdayDayOfMonth(scanTokens(ctx), ctx);
  tokens = tokens.map((token, i) => (token.kind === 'pair' ? classifyPair(token, tokens[i - 1], tokens[i + 1], ctx) : token)).filter(Boolean);
  const refs = buildRefs(tokens, ctx);
  const old = markOld(refs, blob);
  const negative = new Set();
  const clauseStart = [0, ...clauses.map((cut) => cut + 1)];
  const clauseEnd = [...clauses, blob.length];
  clauseStart.forEach((start, index) => {
    const slice = blob.slice(start, clauseEnd[index]).replace(NOT_NEGATIVE_RE, ' ');
    if (NEG_CUE_RE.test(slice)) negative.add(index);
  });
  markBareDayClauses(refs, { blob, clauseStart, clauseEnd, sentences }, negative);
  for (const ref of refs) {
    const clause = indexIn(clauses, ref.start);
    ref.sentence = indexIn(sentences, ref.start);
    ref.clause = clause;
    if (old.has(ref)) ref.polarity = 'old';
    else if (ref.kind === 'clock' && OPENING_HOURS_RE.test(blob.slice(clauseStart[clause], ref.start))) ref.polarity = 'old';
    else if (negative.has(clause) || DIRECT_NEG_RE.test(blob.slice(clauseStart[clause], ref.start))) ref.polarity = 'neg';
    else ref.polarity = 'pos';
  }
  const clocks = refs.filter((ref) => ref.kind === 'clock');
  const days = refs.filter((ref) => ref.kind === 'day');
  // "Torsdag kl 10 passer ikke": the clause rejects the clock, so the day may still anchor "men kl 14".
  for (const day of days) {
    day.timeNegated = day.polarity === 'neg' && clocks.some((clock) => clock.polarity === 'neg' && clock.clause === day.clause);
  }
  let positiveText = '';
  clauseStart.forEach((start, index) => {
    const piece = blob.slice(start, clauseEnd[index] + 1);
    positiveText += negative.has(index) ? ' '.repeat(piece.length) : piece;
  });
  return {
    ...ctx,
    days,
    clocks,
    bounds: refs.filter((ref) => ref.kind === 'bound' && ref.polarity === 'pos'),
    positiveText,
  };
}

const GOOD_MORNING_RE = ure('\\bgod\\s*morgen\\b|\\bgood morning\\b', 'giu');
const RELATIVE_DAY_RE = ure('\\b(?:i\\s*overmorgen|overimorgen|i\\s*morgen\\b(?!\\s+tidlig)|imorgen\\b(?!\\s+tidlig)|i\\s*morra|imorra)\\b', 'giu');
const MORNING_RE = ure('formiddag|\\bmorgen|tidlig på dagen|\\bmorning\\b|før lunsj|før lunch|before lunch');
const AFTERNOON_RE = ure('ettermiddag|etter lunsj|etter lunch|afternoon|after lunch');

function boundsOf(ctx) {
  const afters = ctx.bounds.filter((bound) => bound.after != null).map((bound) => bound.after);
  const befores = ctx.bounds.filter((bound) => bound.before != null).map((bound) => bound.before);
  const out = {};
  if (afters.length) out.afterHour = Math.max(...afters);
  if (befores.length) out.beforeHour = Math.min(...befores);
  return out;
}

/** 'morning' | 'afternoon' | 'day' from the clauses the client did not reject ("i morgen" is not morning). */
function bandOf(ctx, bounds = boundsOf(ctx)) {
  const plain = ctx.positiveText.replace(GOOD_MORNING_RE, ' ').replace(RELATIVE_DAY_RE, ' ');
  const morning = MORNING_RE.test(plain) || (bounds.beforeHour != null && bounds.beforeHour <= 12);
  const afternoon = AFTERNOON_RE.test(plain) || (bounds.afterHour != null && bounds.afterHour >= 12);
  if (morning && !afternoon) return 'morning';
  if (afternoon && !morning) return 'afternoon';
  return 'day';
}

const SAME_DAY_RE = ure('\\b(?:samme dag(?:en)?|same day)\\b');

function sentenceText(ctx, index) {
  const start = index > 0 ? ctx.sentences[index - 1] + 1 : 0;
  return ctx.blob.slice(start, ctx.sentences[index] ?? ctx.blob.length);
}

function anchorFor(clock, ctx) {
  const before = (list) => list.filter((day) => day.end <= clock.start).at(-1);
  const after = (list) => list.find((day) => day.start >= clock.end);
  const pool = ctx.days.filter((day) => day.polarity === 'pos' && !day.fuzzy);
  const same = pool.filter((day) => day.sentence === clock.sentence);
  const local = before(same) || after(same);
  if (local) return local;
  const soft = ctx.days.filter((day) => day.timeNegated && day.sentence === clock.sentence);
  const softPick = before(soft) || after(soft);
  if (softPick) return softPick;
  // "Torsdag kl 10 passer dårlig. Kan vi ta kl 14 samme dag?" → the day named earlier, even with the rejected clock.
  if (SAME_DAY_RE.test(sentenceText(ctx, clock.sentence))) {
    const named = before(ctx.days.filter((day) => day.timeNegated || (day.polarity === 'pos' && !day.fuzzy)));
    if (named) return named;
  }
  if (!clock.strong) return null;
  return before(pool) || after(pool) || null;
}

function confidenceOf(day) {
  if (day.source === 'iso') return 0.95;
  if (day.source === 'merged' || day.source === 'date') return 0.9;
  if (day.source === 'weekday') return day.nextWeek ? 0.8 : 0.85;
  if (day.source === 'relative') return 0.85;
  return 0.75;
}

/** First positive meeting clock that has a day; iterates past bad candidates. */
function pickTime(ctx) {
  for (const clock of ctx.clocks) {
    if (clock.polarity !== 'pos' || !clock.valid) continue;
    const day = anchorFor(clock, ctx);
    if (!day || day.past || day.conflict) continue;
    if (day.relative && isWeekendYmd(day.ymd)) continue;
    const dueAt = osloWallToIso(day.ymd, clock.hour, clock.minute, 0);
    if (dueAt) return { dueAt, confidence: confidenceOf(day), day, clock };
  }
  return null;
}

const DAY_PRIORITY = [
  (day) => ['iso', 'date', 'merged', 'dom', 'weekday'].includes(day.source),
  (day) => day.source === 'om',
  (day) => day.source === 'relative' && day.offset === 2,
  (day) => day.source === 'relative' && day.offset === 1,
  (day, todayOk) => day.source === 'relative' && day.offset === 0 && todayOk,
  (day) => day.source === 'nextweek',
];

function pickDay(ctx) {
  const positive = ctx.days.filter((day) => day.polarity === 'pos' && !day.past && !day.conflict);
  // "i dag" alone is too often small talk ("mye å gjøre i dag"); it counts with a clock, band or bound.
  const todayOk = ctx.clocks.some((clock) => clock.polarity === 'pos') || ctx.bounds.length > 0 || bandOf(ctx) !== 'day';
  for (const test of DAY_PRIORITY) {
    const hit = positive.find((day) => test(day, todayOk));
    if (hit) return hit;
  }
  return null;
}

function hasConflict(ctx) {
  return ctx.days.some((day) => day.conflict && day.polarity === 'pos');
}

function excludedOf(ctx, anchored = []) {
  const keep = new Set([
    ...ctx.days.filter((day) => day.polarity === 'pos' && !day.fuzzy).map((day) => day.ymd),
    ...anchored.filter(Boolean).map((day) => day.ymd),
  ]);
  const out = new Set();
  for (const day of ctx.days) {
    if (day.polarity !== 'neg' || day.conflict || day.past || !day.ymd) continue;
    const span = day.source === 'nextweek' ? [0, 1, 2, 3, 4].map((offset) => addDaysYmd(day.ymd, offset)) : [day.ymd];
    for (const ymd of span) if (!keep.has(ymd)) out.add(ymd);
  }
  return [...out].sort();
}

export function looksLikeWorkshopScheduling(text = '') {
  const blob = compact(text).toLowerCase();
  if (!blob) return false;
  if (ure('\\b(?:mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag|kl\\.?\\s*\\d{1,2})\\b').test(blob)) return true;
  return /workshop|workshopen|tidspunkt|passer det|kan vi ta|booke møte|møtetid/.test(blob);
}

export function looksLikeCallFollowup(text = '') {
  const blob = compact(text).toLowerCase();
  return /ringe meg|ring meg|kan dere ringe|ta en telefon|avtale nærmere|ikke helt vet|vet ikke helt|usikker på tid/.test(blob)
    || looksUnsureForNow(blob);
}

const UNSURE_RE = ure('\\bakkurat nå\\b|\\bfor øyeblikket\\b|\\bkanskje\\b|\\bvi hører\\b|\\bvet ikke (?:nå|ennå|enda|helt|når)|\\bikke vet (?:nå|ennå|enda|når)|\\busikker (?:på|nå)|\\bmå (?:sjekke|se på|tenke)|\\bkommer tilbake (?:til deg|med|når)|\\bgir (?:deg )?beskjed|\\bta (?:gjerne )?kontakt (?:igjen )?(?:i morgen|om|neste uke|senere|litt senere)|\\bmye (?:å gjøre|på gang) nå|\\btravelt nå\\b|\\bsenere i (?:uka|uken|måneden)');

/** Client can't commit to a time yet ("vet ikke ennå", "kommer tilbake til deg", "ta kontakt om noen dager"). */
export function looksUnsureForNow(text = '') {
  return UNSURE_RE.test(compact(text).toLowerCase());
}

export function looksLikeMeetingMove(text = '') {
  const blob = compact(text).toLowerCase();
  return /kan ikke|klar(er)? ikke|må flytte|passer ikke|annen (dag|tid)|utsatt|avlyse/.test(blob)
    || looksLikeWorkshopScheduling(blob);
}

/**
 * Everything the parser reads from one reply (Europe/Oslo).
 * { dueAt, confidence, day: {ymd, band, afterHour?, beforeHour?}|null, clock: {hour, minute}|null, excludedDays: [ymd], conflict, weekOnly }
 * weekOnly: the day is only "neste uke" (its Monday), not a weekday the client chose.
 */
export function parseTimeDetail(text = '', { now = new Date() } = {}) {
  const ctx = analyze(text, now);
  const conflict = hasConflict(ctx);
  const bounds = boundsOf(ctx);
  const band = bandOf(ctx, bounds);
  const time = conflict ? null : pickTime(ctx);
  const dayRef = conflict ? null : (time?.day || pickDay(ctx));
  let day = null;
  if (dayRef) {
    const ymd = dayRef.relative && !dayRef.fuzzy ? rollToWeekday(dayRef.ymd) : dayRef.ymd;
    day = { ymd, band, ...bounds };
  }
  const firstClock = ctx.clocks.find((clock) => clock.polarity === 'pos' && clock.valid);
  const clock = time?.clock || firstClock;
  return {
    dueAt: time?.dueAt || '',
    confidence: time?.confidence || 0,
    day,
    clock: clock ? { hour: clock.hour, minute: clock.minute } : null,
    excludedDays: excludedOf(ctx, [time?.day]),
    conflict,
    weekOnly: dayRef?.source === 'nextweek',
  };
}

/**
 * Weekday, date or relative day (+ band) without needing a clock. Returns { ymd, band, afterHour?, beforeHour? } or null.
 * "neste uke" alone gives the Monday of next week as a week anchor: it is not "mandag passer", so a caller
 * matching it against offered slots must check parseTimeDetail(...).weekOnly first.
 */
export function parseDayHint(text = '', { now = new Date() } = {}) {
  return parseTimeDetail(text, { now }).day;
}

/** Days the client says they cannot do ("kan ikke torsdag", "fredag er ikke aktuelt") → sorted ['YYYY-MM-DD']. */
export function parseExcludedDays(text = '', { now = new Date() } = {}) {
  return parseTimeDetail(text, { now }).excludedDays;
}

/** First clock the client offers, with or without a day ("kl 14 samme dag") → { hour, minute } or null. */
export function parseClockTime(text = '') {
  return parseTimeDetail(text).clock;
}

/** Part of day the client wants → { band: 'morning'|'afternoon'|'day', afterHour?, beforeHour? }. */
export function parseTimeBand(text = '') {
  const ctx = analyze(text, new Date());
  const bounds = boundsOf(ctx);
  return { band: bandOf(ctx, bounds), ...bounds };
}

/**
 * Pull an Oslo workshop datetime from free text. Requires a clock time and a day.
 * Returns { dueAt, confidence } or null (also null when a weekday contradicts the date).
 */
export function parseWorkshopTimeHeuristic(text = '', { now = new Date() } = {}) {
  const detail = parseTimeDetail(text, { now });
  return detail.dueAt ? { dueAt: detail.dueAt, confidence: detail.confidence } : null;
}

export function resolveInboxWorkshopDueAt(text = '', claimedDueAt = '', { now } = {}) {
  const parsed = parseWorkshopTimeHeuristic(text, { now });
  if (parsed?.dueAt) return parsed.dueAt;
  const claimed = compact(claimedDueAt);
  if (!claimed || Number.isNaN(Date.parse(claimed))) return '';
  if (!looksLikeWorkshopScheduling(text)) return '';
  return claimed;
}
