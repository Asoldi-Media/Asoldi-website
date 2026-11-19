// "Legg Kari på inviten": a client asking the bot to add a person to the booked meeting. The request is
// read from the client's new words (never the quoted thread), the person is found among the people on the
// mail (Cc, To), the card's stored guests and the thread's "Name <address>" pairs, and the guest sentence
// is cut out so the rest of the mail is classified on its own ("kan vi skyve til torsdag kl 12?").
// Pure text work: no card changes happen here.
import { parseEmailAddress } from './match-client.js';

/** The mailbox the bot reads; never a guest. */
const BOT_MAILBOX = 'alexander@asoldi.com';
const MAX_UNRESOLVED = 5;

const EMAIL_SRC = '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+';
const EMAIL_G = new RegExp(EMAIL_SRC, 'g');

// What the invite is called: "på inviten", "i møtet", "to the invite".
const TARGET_NB = '(?:inviten|invitasjonen|invitasjon|invite|møteinvitasjonen|kalenderinvitasjonen|kalenderinnkallingen|kalender|kalenderen|innkallingen|møteinnkallingen|møtet|møte)';
const TARGET_RE = new RegExp(`\\s+(?:på|i|til|inn\\s+i|inn\\s+på)\\s+(?:den\\s+|vår\\s+|denne\\s+|deres\\s+|selve\\s+)?${TARGET_NB}\\b|\\s+(?:to|on|in|onto)\\s+(?:the\\s+|this\\s+|our\\s+)?(?:calendar\\s+)?(?:invite|invitation|meeting|call|thread|event)\\b`, 'iu');
// "(CC)", "på kopi", "i kopi", "cc": the people already on Cc.
const MARKER_SRC = '\\(\\s*(?:cc|c\\.c\\.|kopi)\\s*\\)|\\b(?:på|i|som)\\s+(?:cc|kopi)\\b|(?<![\\p{L}@.])cc(?![\\p{L}@.])|(?<![\\p{L}])kopi(?![\\p{L}])';
const MARKER_RE = new RegExp(MARKER_SRC, 'iu');
const MARKER_G = new RegExp(MARKER_SRC, 'giu');
const MARKER_ONLY_RE = /^\(?\s*(?:cc|c\.c\.|kopi|på\s+kopi|i\s+kopi|cc'?d?)\s*\)?[.!]*$/iu;

// Words in front of the cue verb that belong to the guest sentence ("Fint om du", "kan du også", "please").
const LEAD_WORDS = '(?:fint|supert|bra|greit|flott|snilt|hyggelig|takk|og|men|så|ellers|forresten|btw|også|kan|kunne|vil|ville|må|bør|skal|du|dere|vi|jeg|man|om|hvis|at|gjerne|vennligst|please|can|could|would|you|husk|å|vær|snill|ønsker|ber|skulle|gidder|hadde|nice|if|it|be|great|also|just)';
const LEAD_RE = new RegExp(`(?:^|(?<=[\\s,;(]))(?:${LEAD_WORDS}\\s+){1,6}$`, 'iu');
// A leftover that says nothing else once these are gone is dropped with the sentence.
const FILLER_LEFTOVER_RE = /(?<![\p{L}])(?:og|også|fint|supert|bra|greit|flott|snilt|men|så|ellers|forresten|btw|gjerne|and|also|nice|great)(?![\p{L}])/giu;

const PRONOUN_SELF = new Set(['meg', 'oss', 'deg', 'jeg', 'vi', 'du', 'dere', 'seg', 'me', 'us', 'you', 'myself', 'i', 'det', 'den', 'dette', 'noe', 'alt', 'som', 'hvem', 'en', 'et', 'ei', 'min', 'mi', 'vår', 'vårt', 'vore']);
const PRONOUN_THIRD = new Set(['han', 'hun', 'ham', 'henne', 'him', 'her', 'he', 'she']);
const GENERIC_RE = /^(?:(?:min|mi|vår|vårt|my|our|en|ei|et|vedkommende|kollega\p{L}*|sjef\p{L}*|kontakt\p{L}*|partner\p{L}*|assistent\p{L}*|rådgiver\p{L}*|regnskapsfør\p{L}*|kunde\p{L}*|dem|de|alle|begge|them|colleague\p{L}*|everyone|everybody|both|boss|manager|assistant)\s*)+$/iu;
const NOT_A_NAME = new Set(['mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag', 'januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember', 'kl', 'klokka', 'klokken', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'i', 'morgen', 'dag', 'uke', 'neste', 'denne', 'deg', 'meg', 'oss', 'noe', 'noen', 'alt', 'mer', 'litt', 'rette', 'side', 'grunn', 'mulig', 'tid', 'tiden', 'et', 'en', 'ei']);

function fold(value = '') {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
}

function text(value = '') {
  return String(value ?? '').trim();
}

function validEmail(value = '') {
  const email = text(value).toLowerCase();
  return /^[^\s@<>",]+@[^\s@<>",]+\.[^\s@<>",]+$/.test(email) ? email : '';
}

function cleanName(value = '') {
  return text(value).replace(/^["'<(]+|["'>)]+$/g, '').replace(/\s+/g, ' ').trim();
}

function personTokens(name = '', email = '') {
  const tokens = new Set(fold(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  for (const part of fold(email.split('@')[0]).split(/[._+-]+/)) if (part) tokens.add(part);
  return tokens;
}

/** The card's own addresses (contact, client, website). */
export function cardOwnAddresses(client = {}) {
  return [client?.clientEmail, client?.contactEmail, client?.websiteEmail]
    .map((value) => parseEmailAddress(value))
    .filter(Boolean);
}

/** Never a guest: the bot's mailbox, our own staff, Fireflies, the sender, the card's own addresses. */
export function isExcludedGuestAddress(email = '', { from = '', client = {} } = {}) {
  const address = validEmail(email);
  if (!address) return true;
  if (address === BOT_MAILBOX || /@asoldi\.com$/.test(address)) return true;
  if (/@(?:[a-z0-9-]+\.)*fireflies\.ai$/.test(address) || /^fireflies[.@+-]/.test(address)) return true;
  if (address === parseEmailAddress(from)) return true;
  return cardOwnAddresses(client).includes(address);
}

/** "Name <address>" pairs in the quoted thread, so a name from the first mail still resolves in the second. */
function threadPairs(threadText = '') {
  const pairs = [];
  const re = /(?:^|[:;\n,])\s*"?([^<>\n:;,"]{2,60}?)"?\s*<\s*(mailto:)?([^<>\s]+@[^<>\s]+?)\s*>/gu;
  for (const match of String(threadText || '').matchAll(re)) {
    const email = validEmail(match[3]);
    if (email) pairs.push({ name: cleanName(match[1]), email });
  }
  return pairs;
}

function buildPeople({ cc = [], toList = [], client = {}, threadText = '' } = {}) {
  const byEmail = new Map();
  const add = (row, source) => {
    const email = validEmail(row?.email);
    if (!email) return;
    const name = cleanName(row?.name);
    const known = byEmail.get(email);
    if (known) {
      if (!known.name && name) known.name = name;
      if (source === 'cc') known.cc = true;
      return;
    }
    byEmail.set(email, { email, name, cc: source === 'cc' });
  };
  for (const row of Array.isArray(cc) ? cc : []) add(row, 'cc');
  for (const row of Array.isArray(toList) ? toList : []) add(row, 'to');
  for (const row of Array.isArray(client?.meetingGuests) ? client.meetingGuests : []) add(row, 'guest');
  for (const row of threadPairs(threadText)) add(row, 'thread');
  const people = [...byEmail.values()];
  for (const person of people) person.tokens = personTokens(person.name, person.email);
  return people;
}

/** One name, first name or local part → the single person it fits, null, or 'ambiguous'. */
function resolveLabel(label = '', people = []) {
  const words = fold(label).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;
  const hits = people.filter((person) => words.every((word) => person.tokens.has(word)));
  if (hits.length === 1) return hits[0];
  return hits.length > 1 ? 'ambiguous' : null;
}

function looksLikeName(label = '') {
  const tokens = text(label).split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 3) return false;
  return tokens.every((token) => /^\p{Lu}[\p{L}'’-]*\.?$/u.test(token) && !NOT_A_NAME.has(fold(token).replace(/\.$/, '')));
}

// Where a guest clause ends inside a sentence: before a new clause that is about something else.
const CLAUSE_STOP_RE = /,\s*(?:og\s+|men\s+)?(?=(?:kan|kunne|vil|ville|må|skal|er|har|jeg|vi|du|dere|det|hva|når|hvor|hvis|så|ellers|takk|mvh|passer|fint|flott|and|but|can|could|would|will|please|thanks)(?![\p{L}]))|\s+(?:og|men)\s+(?=(?:kan|kunne|vil|ville|må|skal|er|har|jeg|vi|du|dere|det|hva|når|hvor|hvis|passer|and|but|can|could|would|will)(?![\p{L}]))|\s+(?:slik\s+at|så\s+(?:at|de|han|hun)|for\s+at|siden|fordi|som\s+(?:er|har|jobber|sitter)|so\s+that|because|since)(?![\p{L}])/iu;

/** The clause the cue starts: up to a sentence end or the start of another clause. */
function clauseEnd(body = '', from = 0) {
  const rest = body.slice(from);
  let end = rest.length;
  const sentence = rest.search(/[!?;\n]|\.(?=\s|$)/);
  if (sentence >= 0) end = sentence;
  const stop = rest.slice(0, end).search(CLAUSE_STOP_RE);
  if (stop >= 0) end = stop;
  return from + end;
}

/** The people in the words after a verb ("Kari på inviten", "kari@x.example og Per", "kollegaen min (CC)"). */
function personsFromTail(tail = '', ctx = {}, { forceMarker = false } = {}) {
  const { people = [] } = ctx;
  let rest = text(tail);
  const marker = forceMarker || MARKER_RE.test(rest);
  rest = rest.replace(MARKER_G, ' ');
  const target = TARGET_RE.exec(rest);
  if (target) rest = rest.slice(0, target.index);
  const found = []; // { person, spoken }
  const unresolved = [];
  let generic = '';
  let ignoredSelf = false;

  // Addresses written out come first; the name in front of one belongs to it.
  const withoutEmails = rest.replace(new RegExp(`(?:(?:\\p{Lu}[\\p{L}'’-]*\\s+){1,3})?<?\\s*(${EMAIL_SRC})\\s*>?`, 'gu'), (all, address) => {
    const email = validEmail(address);
    if (email) {
      const named = rest.match(new RegExp(`((?:\\p{Lu}[\\p{L}'’-]*\\s+){1,3})<?\\s*${address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'));
      const known = people.find((person) => person.email === email);
      found.push({ email, name: known?.name || cleanName(named?.[1]) });
    }
    return ' ';
  });

  const parts = withoutEmails
    .replace(/(?<![\p{L}])(?:også|gjerne|inn|too|as well|please)(?![\p{L}])/giu, ' ')
    .split(/\s*(?:,|&|\+|(?<![\p{L}])og(?![\p{L}])|(?<![\p{L}])and(?![\p{L}]))\s*/iu)
    .map((part) => text(part).replace(/^(?:med|til|også|gjerne)\s+/iu, '').replace(/\s+(?:med|til)$/iu, ''))
    .filter(Boolean);

  for (const part of parts) {
    const key = fold(part);
    const words = key.split(/\s+/);
    if (words.every((word) => PRONOUN_SELF.has(word))) {
      ignoredSelf = true;
      continue;
    }
    if (GENERIC_RE.test(part) || words.every((word) => PRONOUN_THIRD.has(word))) {
      generic = generic || part;
      continue;
    }
    const hit = resolveLabel(part, people);
    if (hit && hit !== 'ambiguous') {
      found.push({ email: hit.email, name: hit.name });
      continue;
    }
    if (hit === 'ambiguous' || looksLikeName(part) || (target && words.length <= 4 && !words.some((word) => NOT_A_NAME.has(word)))) {
      unresolved.push(part);
    }
  }
  return { found, unresolved, marker, generic, hasTarget: Boolean(target), ignoredSelf, hadParts: parts.length > 0 };
}

/** Turn the raw tail result into guests: generic words and "(CC)" mean everyone on Cc. */
function settle(result, ctx) {
  const { found, unresolved, marker, generic, hasTarget } = result;
  const guests = [...found];
  const missing = [...unresolved];
  const named = guests.length > 0 || missing.length > 0;
  if (generic || (marker && !named)) {
    const onCc = ctx.people.filter((person) => person.cc && !isExcludedGuestAddress(person.email, ctx));
    if (onCc.length) guests.push(...onCc.map((person) => ({ email: person.email, name: person.name })));
    else if (generic || hasTarget || marker) missing.push(generic || 'personen på kopi');
  }
  return { guests, missing };
}

const VERBS_AFTER = [
  { re: /(?<![\p{L}])legg(?:e|er|es)?(?:\s+(?:du|dere))?(?:\s+gjerne)?(?:\s+også)?(?:\s+til)?(?=\s)/iu, weak: false },
  { re: /(?<![\p{L}])inkluder(?:e|er)?(?:\s+gjerne)?(?:\s+også)?(?=\s)/iu, weak: false },
  { re: /(?<![\p{L}])inviter(?:e|er)?(?:\s+gjerne)?(?:\s+også)?(?=\s)/iu, weak: false },
  { re: /(?<![\p{L}])ta(?:\s+gjerne)?(?:\s+også)?(?:\s+gjerne)?\s+med(?=\s)/iu, weak: false },
  { re: /(?<![\p{L}])send(?:e|er)?(?:\s+gjerne)?\s+(?:invitasjonen|inviten|innkallingen|møteinvitasjonen|kalenderinvitasjonen|møteinnkallingen)(?:\s+også)?(?:\s+gjerne)?\s+til(?=\s)/iu, weak: false },
  { re: /(?<![\p{L}])sett(?:e|er)?(?=\s)/iu, weak: true },
  { re: /(?<![\p{L}])(?:please\s+)?(?:add|invite|include)(?=\s)/iu, weak: false },
  { re: /(?<![\p{L}])loop\s+in(?=\s)/iu, weak: false },
];

// "Kari blir med", "Kari skal også være med", "kan Kari også bli med".
const BEFORE_RES = [
  /((?:[^\s,;.!?]+\s+){0,3}[^\s,;.!?]+)\s+(?:blir|skal|vil|kommer\s+til\s+å\s+bli)\s+(?:også\s+)?(?:være\s+)?med(?![\p{L}])/iu,
  /(?<![\p{L}])(?:kan|kunne|får)\s+((?:[^\s,;.!?]+\s+){0,2}?[^\s,;.!?]+?)\s+(?:også\s+)?(?:bli|være)\s+med(?![\p{L}])/iu,
];

function nextCue(body = '', ctx = {}, { forceMarker = false } = {}) {
  let best = null;
  const consider = (candidate) => {
    if (candidate && (!best || candidate.start < best.start)) best = candidate;
  };

  for (const verb of VERBS_AFTER) {
    const match = verb.re.exec(body);
    if (!match) continue;
    const verbEnd = match.index + match[0].length;
    const end = clauseEnd(body, verbEnd);
    const tail = body.slice(verbEnd, end);
    const parsed = personsFromTail(tail, ctx, { forceMarker });
    // "sett fra", "legg til rette" are not guests: a weak verb needs the invite or Cc named.
    if (verb.weak && !(parsed.hasTarget || parsed.marker)) continue;
    const { guests, missing } = settle(parsed, ctx);
    if (!guests.length && !missing.length && !parsed.ignoredSelf) continue;
    consider({ start: match.index, end, guests, missing });
  }

  for (const re of BEFORE_RES) {
    const match = re.exec(body);
    if (!match) continue;
    const label = match[1];
    const labelStart = match.index + match[0].indexOf(label);
    const marker = MARKER_RE.test(label) || forceMarker;
    const cleaned = label.replace(MARKER_G, ' ').replace(/\s+/g, ' ').trim();
    const groups = cleaned.split(/\s+(?:og|and)\s+|\s*,\s*|\s*&\s*/iu).map((group) => text(group)).filter(Boolean);
    const guests = [];
    const missing = [];
    let earliest = Infinity;
    let sawSelf = false;
    for (const group of groups) {
      const tokens = group.split(/\s+/);
      let done = false;
      for (let take = Math.min(3, tokens.length); take >= 1 && !done; take -= 1) {
        const phrase = tokens.slice(tokens.length - take).join(' ');
        const key = fold(phrase);
        if (key.split(/\s+/).every((word) => PRONOUN_SELF.has(word))) {
          sawSelf = true;
          done = true;
          break;
        }
        const email = validEmail(phrase.replace(/^[<(]|[>)]$/g, ''));
        const hit = email ? { email, name: ctx.people.find((person) => person.email === email)?.name || '' } : resolveLabel(phrase, ctx.people);
        if (hit && hit !== 'ambiguous') {
          guests.push({ email: hit.email, name: hit.name });
          done = true;
        } else if (take === 1 && PRONOUN_THIRD.has(key)) {
          const onCc = ctx.people.filter((person) => person.cc && !isExcludedGuestAddress(person.email, ctx));
          if (onCc.length === 1) guests.push({ email: onCc[0].email, name: onCc[0].name });
          else missing.push(phrase);
          done = true;
        } else if (hit === 'ambiguous' || (take === Math.min(2, tokens.length) && looksLikeName(phrase)) || (take === 1 && looksLikeName(phrase))) {
          if (hit === 'ambiguous' || looksLikeName(phrase)) {
            missing.push(phrase);
            done = true;
          }
        }
        if (done) {
          const offset = label.indexOf(phrase);
          if (offset >= 0) earliest = Math.min(earliest, labelStart + offset);
        }
      }
    }
    if (!guests.length && !missing.length && !sawSelf) continue;
    if (marker && !guests.length && !missing.length) continue;
    const start = Number.isFinite(earliest) ? earliest : labelStart;
    consider({ start, end: match.index + match[0].length, guests, missing });
  }
  return best;
}

/** Cut the cue and the filler words in front of it out of a segment; the rest is returned. */
function cutCue(body = '', cue) {
  let start = cue.start;
  const before = body.slice(0, start);
  const lead = LEAD_RE.exec(before);
  if (lead) start -= lead[0].length;
  const left = body.slice(0, start).replace(/[\s,;:-]+$/u, '');
  const right = body.slice(cue.end);
  return `${left}${right}`.replace(/\s+([.!?,;])/g, '$1').replace(/^[\s,;:-]+/u, '').replace(/[ \t]{2,}/g, ' ').trim();
}

function hasSubstance(rest = '') {
  const stripped = rest.replace(FILLER_LEFTOVER_RE, ' ').replace(/[^\p{L}\p{N}]+/gu, '');
  return stripped.length > 0;
}

function splitSegments(source = '') {
  const segments = [];
  const n = source.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    if (ch === '\n') {
      let j = i;
      while (j < n && source[j] === '\n') j += 1;
      segments.push({ body: source.slice(start, i), trail: source.slice(i, j) });
      start = j;
      i = j;
    } else if (ch === '.' || ch === '!' || ch === '?') {
      let j = i;
      while (j < n && '.!?'.includes(source[j])) j += 1;
      if (j >= n || /\s/.test(source[j])) {
        let k = j;
        while (k < n && (source[k] === ' ' || source[k] === '\t')) k += 1;
        segments.push({ body: source.slice(start, j), trail: source.slice(j, k) });
        start = k;
        i = k;
      } else {
        i = j;
      }
    } else {
      i += 1;
    }
  }
  if (start < n) segments.push({ body: source.slice(start), trail: '' });
  return segments;
}

/**
 * Read an "add this person to the meeting" request out of the client's new words.
 *
 * @param {string} body the client's fresh text (no quoted thread)
 * @param {{from?: string, cc?: Array<{name: string, email: string}>, toList?: Array<{name: string, email: string}>, client?: object, threadText?: string}} options
 * @returns {{asked: boolean, guests: Array<{email: string, name: string}>, unresolved: string[], strippedText: string}}
 */
export function extractGuestRequest(body = '', { from = '', cc = [], toList = [], client = {}, threadText = '' } = {}) {
  const source = String(body ?? '');
  const ctx = { people: buildPeople({ cc, toList, client, threadText }), from, client };
  const segments = splitSegments(source);
  const guests = new Map();
  const unresolved = [];
  let asked = false;
  let previousWasGuest = false;
  const kept = [];

  for (const segment of segments) {
    const trimmed = segment.body.trim();
    if (previousWasGuest && MARKER_ONLY_RE.test(trimmed)) {
      // "(CC)" on its own after the guest sentence belongs to it.
      previousWasGuest = false;
      continue;
    }
    previousWasGuest = false;
    let current = segment.body;
    let hit = null;
    for (let pass = 0; pass < 3; pass += 1) {
      const cue = nextCue(current, ctx);
      if (!cue) break;
      asked = true;
      hit = hit || {};
      for (const guest of cue.guests) {
        const email = validEmail(guest.email);
        if (!email || isExcludedGuestAddress(email, ctx)) continue;
        if (!guests.has(email)) guests.set(email, { email, name: cleanName(guest.name) });
        else if (!guests.get(email).name && guest.name) guests.get(email).name = cleanName(guest.name);
      }
      for (const label of cue.missing) {
        const clean = cleanName(label);
        if (clean && !unresolved.includes(clean) && unresolved.length < MAX_UNRESOLVED) unresolved.push(clean);
      }
      current = cutCue(current, cue);
    }
    if (hit) {
      previousWasGuest = true;
      if (hasSubstance(current)) kept.push({ body: current, trail: segment.trail });
      continue;
    }
    kept.push({ body: segment.body, trail: segment.trail });
  }

  if (!asked) {
    return { asked: false, guests: [], unresolved: [], strippedText: source.trim() };
  }
  const strippedText = kept.map((row) => `${row.body}${row.trail}`).join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { asked: true, guests: [...guests.values()], unresolved, strippedText };
}
