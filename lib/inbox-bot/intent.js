import * as timeParse from '../workshop-time-parse.js';
import { osloCalendarYmd, osloWallToIso } from '../website-due.js';
import { bookedMeetingAt } from './meeting.js';

/**
 * What the client is asking for, decided from the fresh reply text only (never the subject or the
 * quoted thread). Mutations (book, cancel) need clear words; anything unclear goes to a person.
 *
 * request → intent the writer acts on:
 *   confirm / empty    → none (no reply, nothing changes)
 *   reschedule         → sales_book (dueAt)
 *   reschedule_day     → sales_propose (day)
 *   cancel             → sales_cancel (ask for a new time)
 *   call / not_now     → sales_call
 *   not_interested     → walk_away
 *   question / info    → gather (answer)
 *   contract / other / unclear → none, needs a person
 * `cancel: true` means the booked meeting no longer holds and must be voided.
 */
export const INBOX_REQUESTS = [
  'confirm', 'reschedule', 'reschedule_day', 'cancel', 'question', 'call',
  'not_now', 'not_interested', 'info', 'contract', 'other', 'unclear', 'empty',
];

const L = '(?<![\\p{L}\\p{N}])';
const R = '(?![\\p{L}\\p{N}])';
/** A weekday, also in its definite form ("torsdagen", "denne torsdagen"). */
const WEEKDAY = '(?:(?:mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)(?:en)?|monday|tuesday|wednesday|thursday|friday)';
const SOFT = '(?:dessverre|desverre|nok|likevel|allikevel|uansett)';
/** Words that may sit between "ikke" and what the client cannot attend ("kan ikke være med på møtet"). */
const ATTEND_FILL = `(?:å|til|på|i|være|med|der|dit|lenger|helt|rekke|klare|kunne|få|denne|${SOFT})`;
/** What a "kan ikke" must be about before it cancels: the meeting, its time or its day. */
const ATTEND = `(?:komme|møte|møtet|møtes|delta|stille|være\\s+med|være\\s+der|da|det\\s+tidspunktet|dette\\s+tidspunktet|tidspunktet|den\\s+tiden|den\\s+dagen|i\\s*dag|i\\s*morgen|i\\s+overmorgen|${WEEKDAY}|kl|klokka|klokken|workshop(?:en)?)`;

function cue(source) {
  return new RegExp(source, 'iu');
}

/** Can't make it. A generic "kan/får/klarer ikke" only counts when the meeting, a day or a time follows. */
const CANCEL_RE = cue([
  `${L}(?:kan|får|klarer|rekker|kommer)\\s+(?:(?:jeg|vi|da|så|${SOFT})\\s+){0,3}ikke(?:\\s+${ATTEND_FILL}){0,4}\\s+${ATTEND}${R}`,
  // Subordinate clause order: "(om) at jeg ikke kan i morgen", "siden vi dessverre ikke rekker møtet".
  `${L}(?:jeg|vi)\\s+(?:${SOFT}\\s+){0,2}ikke\\s+(?:kan|får|klarer|rekker|kommer)(?:\\s+${ATTEND_FILL}){0,4}\\s+${ATTEND}${R}`,
  `${L}har\\s+(?:(?:jeg|vi|${SOFT})\\s+){0,2}ikke\\s+(?:anledning|mulighet|tid)${R}(?!\\s+til\\s+å\\s+(?!komme|delta|møte|stille|være))`,
  `${L}passer\\s+(?:(?:${SOFT}|heller)\\s+){0,2}(?:ikke|dårlig)${R}(?!\\s+(?:lenger\\s+)?(?:til|inn|sammen)(?:\\s|$))`,
  `${L}blir\\s+(?:${SOFT}\\s+)?ikke\\s+(?:mulig|noe(?=\\s+(?:møte|av)${R}|\\s*[.!,]|$))`,
  `${L}(?:møtet|tidspunktet|den\\s+tiden|den\\s+dagen)\\s+(?:går|funker|fungerer)\\s+(?:${SOFT}\\s+){0,2}ikke${R}`,
  `${L}da[,.]?\\s+(?:så\\s+)?(?:det\\s+)?(?:går|funker)\\s+(?:${SOFT}\\s+)?ikke${R}`,
  `${L}må\\s+(?:(?:dessverre|desverre|nok|bare)\\s+)?(?:avlyse|utsette|flytte|melde\\s+forfall|droppe\\s+møtet)${R}`,
  `${L}(?:melde[rt]?\\s+forfall|forhindret|avlys\\p{L}*|utsett\\p{L}*)`,
  `${L}(?:er|ble|blitt|ligger)\\s+syk${R}|${L}sykt?e?\\s+barn${R}`,
  `${L}(?:can'?t|cannot|can\\s+not|won'?t\\s+be\\s+able\\s+to|unable\\s+to)\\s+(?:make|attend|join|come|do)${R}`,
  `${L}(?:need|have)\\s+to\\s+(?:cancel|reschedule|move|postpone)${R}`,
].join('|'));

/** A reason the booked day does not work; it cancels only when the booked day or time is named. */
const DIFFICULTY_RE = cue(`${L}(?:vanskelig\\p{L}*|umulig|kolliderer|kollisjon|fullbooket|fullt|ferie|kurs|opptatt|bortreist|på\\s+reise|på\\s+jobb|syk|går\\s+(?:${SOFT}\\s+)?ikke|ikke\\s+går|funker\\s+(?:${SOFT}\\s+)?ikke|fungerer\\s+(?:${SOFT}\\s+)?ikke|ikke\\s+så\\s+(?:bra|godt)|ikke\\s+tid|ikke\\s+anledning|doesn'?t\\s+work|not\\s+available|unavailable|busy|can'?t|cannot)${R}`);

/** Wants another time without saying the old one is impossible. */
const MOVE_RE = cue([
  `${L}flytte${R}|${L}flytter${R}|${L}(?:skyv|skubb)\\p{L}*${R}|${L}bytte\\s+(?:tid|dag|tidspunkt)${R}|${L}endre\\s+(?:tid|tidspunkt|dag|møtet|møtetid)${R}`,
  `${L}(?:en|et)\\s+annen?\\s+(?:dag|tid|gang|tidspunkt)${R}|${L}et\\s+annet\\s+tidspunkt${R}|${L}ny\\s+(?:tid|møtetid|dato)${R}|${L}nytt\\s+tidspunkt${R}|${L}andre\\s+(?:tider|dager|tidspunkt(?:er)?)${R}`,
  `${L}reschedule${R}|${L}another\\s+(?:day|time)${R}|${L}move\\s+(?:it|the\\s+meeting)${R}`,
].join('|'));

/** The client proposes or accepts a time. */
const SCHED_RE = cue([
  `${L}kan\\s+vi\\s+(?:heller\\s+)?(?:ta|flytte|skyve|skubbe|utsette|bytte|endre|møtes|ha|si)${R}`,
  `${L}(?:går|passer|funker|fungerer)\\s+det${R}|${L}går\\s+(?:fint|bra|greit|det\\s+an)${R}`,
  `${L}passer${R}|${L}(?:hadde|ville)\\s+(?:(?:det|vel|nok)\\s+)?passet${R}|${L}passet\\s+(?:bedre|best)${R}`,
  `${L}i\\s+stedet${R}|${L}istedet${R}|${L}istedenfor${R}|${L}heller${R}|${L}foretrekker${R}|${L}foreslår${R}`,
  `${L}hva\\s+med${R}|${L}hva\\s+sier\\s+du\\s+til${R}|${L}ta\\s+(?:det|møtet)${R}|${L}sette\\s+opp${R}|${L}booke?${R}`,
  `${L}er\\s+(?:fint|bra|ok|greit)\\s+for\\s+(?:meg|oss)${R}|${L}ok\\s+for\\s+(?:meg|oss)${R}`,
  `${L}(?:can|could)\\s+we${R}|${L}how\\s+about${R}|${L}what\\s+about${R}|${L}works?\\s+(?:for\\s+(?:me|us)|fine|better)${R}|${L}instead${R}`,
].join('|'));

/**
 * Softer asks and yes cues ("vi kan møtes", "kunne vi", "ok, torsdag kl 12"). They count only when the mail has no
 * incidental word ("åpent", "sender", "tar imot"), so a facts mail that mentions a time still goes to a person.
 */
const SCHED_SOFT_RE = cue([
  `${L}(?:vi\\s+tar|tar\\s+vi)\\s+(?:(?:det|møtet|den|dette)\\s+)?(?:da\\s+)?(?:på\\s+)?(?:${WEEKDAY}|i\\s*morgen|i\\s*overmorgen|kl|klokka|klokken|neste|\\d)`,
  `${L}vi\\s+kan\\s+(?:møtes|ta(?!\\s+(?:imot|med)))${R}|${L}er\\s+det\\s+mulig\\s+å\\s+(?:møtes|ta)${R}|${L}kunne\\s+vi${R}|${L}går\\s+det\\s+(?:an\\s+)?å${R}|${L}passer\\s+for\\s+oss${R}`,
  `${L}ok[,.]?\\s+(?:på\\s+)?${WEEKDAY}${R}(?=[^.!?\\n]{0,30}\\b(?:kl|klokka|klokken)\\b)`,
].join('|'));

const SCHED_ALL_RE = cue([SCHED_RE.source, SCHED_SOFT_RE.source].join('|'));

/** A time in the mail that is about something else ("jeg sender bildene fredag kl 12"). */
const INCIDENTAL_RE = cue(`${L}(?:sender|sende|send|leverer|levere|mailer|kommer\\s+med|tar\\s+imot|har\\s+åpent|åpent|stenger|stengt|åpner|er\\s+ferdig|blir\\s+ferdig|jobber|på\\s+jobb|på\\s+ferie|reiser|er\\s+borte|er\\s+tilbake|ringte|ringer\\s+deg)${R}`);

/** The client names a day they would rather have ("passer bedre", past tense "hadde passet bedre" too). */
const PREFER_RE = cue(`${L}(?:passe[rt]\\s+(?:bedre|best)|(?:hadde|ville)\\s+(?:(?:det|vel|nok)\\s+)?passet|heller|i\\s+stedet|istedet|isteden|istedenfor|foretrekker|flytte|(?:skyv|skubb)\\p{L}*|bytte|hva\\s+med|kan\\s+vi\\s+ta\\s+det|kan\\s+vi\\s+(?:heller\\s+)?(?:ta|ha|møtes)\\s+(?:det\\s+)?(?:på\\s+)?${WEEKDAY}|how\\s+about|what\\s+about|instead|better)${R}`);

/** A new clock for the booked meeting is asked for, not just named ("kan vi starte kl 10.30", "Ta det kl 10"). */
const NEW_CLOCK_ASK_RE = cue(`${L}(?:kan\\s+vi\\s+(?:heller\\s+)?(?:ta|starte|begynne|møtes|flytte|skyve|skubbe|utsette|bytte|endre|ha|si|gjøre)|(?:skyv|skubb)\\p{L}*|er\\s+det\\s+mulig\\s+å|kunne\\s+vi|går\\s+det\\s+(?:an\\s+)?å|vi\\s+kan\\s+(?:møtes|ta)|(?:vi\\s+tar|tar\\s+vi)|ta\\s+(?:det|møtet)|take\\s+it|passer\\s+det|går\\s+det\\s+an|hva\\s+med|samme\\s+dag(?:en)?|senere|seinere|tidligere|could\\s+we|can\\s+we|how\\s+about|later|earlier|same\\s+day)${R}`);

/** "Kan vi utsette møtet en uke?": the same meeting about a week later. */
const WEEK_LATER_RE = cue([
  `${L}(?:utsette|utsetter|utsett|flytte|flytter|skyve|skyver|skubbe|skubber)\\s+(?:(?:møtet|det|den|alt|oss)\\s+)?(?:med\\s+)?(?:en|ei|1)\\s+uke${R}(?!\\s+(?:frem|fram|tidligere|før))`,
  `${L}(?:en|ei|1)\\s+uke\\s+(?:senere|seinere|etter)${R}|${L}(?:uka|uken)\\s+etter${R}`,
  `${L}(?:postpone|push|move)\\s+(?:(?:it|the\\s+meeting)\\s+)?(?:by\\s+)?(?:a|one)\\s+week${R}|${L}(?:a|one)\\s+week\\s+later${R}`,
].join('|'));

/** A cancel about money or need, not the time ("vi har ikke budsjett", "har valgt et annet byrå"). */
const NO_NEED_RE = cue(`${L}(?:budsjett(?:et)?|ikke\\s+råd|har\\s+ikke\\s+penger|penger\\s+til|dårlig\\s+økonomi|stram\\s+økonomi|økonomien|for\\s+dyrt|blir\\s+dyrt|ikke\\s+behov|trenger\\s+ikke\\s+(?:noen?\\s+)?(?:ny\\s+)?(?:nettside|hjemmeside|hjelp)|annet\\s+byrå|annen\\s+leverandør|et\\s+annet\\s+firma|valgt\\s+(?:en\\s+|et\\s+)?anne[nt]|no\\s+budget|can'?t\\s+afford|don'?t\\s+need)${R}`);

/** "Ingen av disse passer": a no to every offered time, never a pick of one. */
const DECLINE_ALL_RE = cue(`${L}(?:ingen\\s+av|passer\\s+ikke\\s+noen|ingen\\s+(?:av\\s+)?(?:de|disse|dem|tidene|tidspunktene)\\s+passer|none\\s+of|neither)${R}`);

const EMOJI = '\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\u{FE0F}\\u{200D}';
const CONFIRM_LEAD = '(?:ja|jepp|jo|ok|oki|okay|okei|greit|fint|flott|supert?|perfekt|topp|bra|takk|tusen\\s+takk|mottatt|notert|bekreftet?|confirmed|thanks|thank\\s+you|great|perfect|sounds\\s+good|det\\s+går\\s+(?:helt\\s+)?fint|det\\s+passer(?:\\s+(?:fint|bra|perfekt|helt\\s+fint))?|passer\\s+(?:fint|bra|perfekt)|det\\s+stemmer|stemmer)';
const CONFIRM_TAIL = '(?:takk|da|det|skal\\s+du\\s+ha|for\\s+det|det\\s+går\\s+(?:helt\\s+)?fint|går\\s+fint|det\\s+passer(?:\\s+(?:fint|bra|perfekt|helt\\s+fint))?|passer\\s+(?:fint|bra)|det\\s+stemmer|stemmer|supert?|flott|perfekt|bra|greit|fint)';

/** A plain yes or thanks; emoji and punctuation allowed ("Ok 👍", "Takk, det stemmer. Sees!"). */
const CONFIRM_RE = cue([
  `^(?:hei[,!.]?\\s*)?${CONFIRM_LEAD}(?:[\\s,.!${EMOJI}]+${CONFIRM_TAIL})*[\\s.!,${EMOJI}]*(?:vi\\s+se?es[^.!?]*|se?es[^.!?]*|see\\s+you[^.!?]*)?[\\s.!,${EMOJI}]*$`,
  `${L}det\\s+passer\\s+(?:fint|bra|perfekt|utmerket|meg|oss|helt\\s+fint)${R}|^\\s*passer\\s+(?:fint|bra|perfekt)${R}`,
  // "ses" is a common typo for "sees".
  `${L}vi\\s+(?:se?es|snakkes)${R}|${L}(?:se?es|snakkes)\\s+(?:da|på|i|på\\s+møtet)${R}|^\\s*(?:se?es|snakkes)[\\s.!${EMOJI}]*$|${L}see\\s+you${R}|${L}høres\\s+(?:bra|fint|greit)\\s+ut${R}|${L}ser\\s+frem\\s+til${R}`,
  `${L}(?:jeg|vi)\\s+(?:kommer|stiller|er\\s+klar)${R}(?!\\s+ikke)|${L}bekrefter${R}`,
].join('|'));

/** "Torsdag passer fint", "det stemmer", "torsdag skal gå fint", "gleder meg til torsdag": a yes to the booked day itself. */
const BOOKED_OK_RE = cue(`${L}(?:(?<!ikke\\s{1,3})(?:passer|går|funker|fungerer)\\s+(?:(?:helt|veldig|også|fortsatt|fremdeles|nok|sikkert)\\s+){0,2}(?:fint|bra|perfekt|utmerket|greit|fortsatt|fremdeles|likevel|allikevel|for\\s+(?:meg|oss))|(?:skal|vil|bør|kommer\\s+til\\s+å)\\s+(?:nok\\s+)?gå\\s+(?:helt\\s+)?(?:fint|bra|greit)|det\\s+stemmer|stemmer\\s+(?:det|bra|fint)|vi\\s+se?es|se?es|vi\\s+snakkes|snakkes|see\\s+you|gleder\\s+(?:meg|oss)\\s+til|works?\\s+(?:for\\s+(?:me|us)|fine)|bekreft\\p{L}*|confirmed?)${R}`);

const EVENT_CARD_RE = cue(`${L}(?:this\\s+is\\s+a\\s+reminder|you\\s+have\\s+an\\s+upcoming|du\\s+har\\s+et\\s+kommende|join\\s+with\\s+google\\s+meet|has\\s+accepted\\s+this\\s+invitation|har\\s+godtatt\\s+invitasjonen|you\\s+replied\\s+to\\s+this\\s+event)${R}`);

const CALL_RE = cue(`${L}(?:ring\\s+(?:meg|oss|heller|gjerne)|ringe\\s+meg|ringe\\s+oss|kan\\s+(?:du|dere)\\s+ringe|ta\\s+en\\s+(?:telefon|prat\\s+på\\s+telefon)|ta\\s+det\\s+på\\s+telefon|call\\s+me|give\\s+me\\s+a\\s+call|phone\\s+me)${R}`);

const NOT_INTERESTED_RE = cue([
  `${L}(?:ikke\\s+(?:interessert|aktuelt|aktuell)|avlys(?:e)?\\s+(?:alt|hele|det\\s+hele)|dropp(?:er)?\\s+(?:det|hele|møtet)|glem\\s+(?:det|hele)|vi\\s+dropper|ingen\\s+vits|ikke\\s+noe\\s+møte|trenger\\s+ikke\\s+(?:ny\\s+)?nettside|har\\s+(?:allerede\\s+)?(?:en\\s+)?nettside\\s+vi\\s+er\\s+fornøyd\\s+med|not\\s+interested|no\\s+thanks|don'?t\\s+want(?:\\s+the)?\\s+meeting)${R}`,
  `^(?:hei[,!.]?\\s*)?nei[,!.]?\\s+takk${R}(?!\\s+for)`,
].join('|'));

/**
 * "Vi ønsker ikke å gå videre med dette", "vi trekker oss": a no, but only in a plain statement; "hvis vi
 * velger å ikke gå videre, koster det noe?" is a question about it.
 */
const NO_FURTHER_RE = cue(`${L}(?:(?:ønsker|vil|kommer|velger|skal|går)\\s+(?:(?:vi|jeg|dessverre|desverre|nok|derfor|likevel)\\s+){0,2}ikke\\s+(?:til\\s+)?(?:å\\s+)?(?:gå\\s+)?videre|ikke\\s+(?:(?:til\\s+)?å\\s+)?gå\\s+videre|trekker\\s+(?:vi\\s+)?oss|trekke\\s+oss)${R}(?!\\s+(?:før|uten|til\\s+neste))`);
const CONDITIONAL_RE = cue(`${L}(?:hvis|dersom|om\\s+vi|if)${R}`);
/** "Jeg har ombestemt meg": a no only when nothing else in the mail asks for a time. */
const CHANGED_MIND_RE = cue(`${L}ombestemt\\s+(?:meg|oss)${R}`);

/** A dot that is no sentence end (stand-in character while splitting). */
const KEPT_DOT = '․';
const DOT_MONTH_AHEAD = `(?=\\s*${'(?:januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|aug|sept?|okt|nov|des)'}(?![\\p{L}]))`;
const DATE_DOT_RES = [
  /(?<=\d)\.(?=\d)/gu, // "25.11", "10.30"
  new RegExp(`(?<=\\d)\\.${DOT_MONTH_AHEAD}`, 'giu'), // "26. november"
  /(?<![\p{L}])(?:kl|klokka|klokken)\./giu, // "kl. 13"
  /(?<=\d)\.(?=\s+(?:kl|klokka|klokken)(?![\p{L}]))/giu, // "27. kl 10"
  /(?<=\bden\s\d{1,2})\./giu, // "den 27."
  /(?<![\p{L}])(?:jan|feb|mar|apr|jun|jul|aug|sept?|okt|nov|des)\./giu, // "26. nov."
];

/** Dots inside dates and after "kl" are not sentence ends; they are swapped for KEPT_DOT. */
function protectDots(text = '') {
  return DATE_DOT_RES.reduce((out, re) => out.replace(re, (hit) => hit.replace(/\./g, KEPT_DOT)), String(text || ''));
}

function sentencesOf(lined = '') {
  return protectDots(lined).split(/(?<=[!?])\s+|(?<=(?<![Kk]l)\.)\s+|\n+/)
    .map((part) => part.trim().replaceAll(KEPT_DOT, '.')).filter(Boolean);
}

/**
 * "… at jeg ikke kan i morgen kl 14. Kan vi ta det fredag?": another day asked for in a sentence of its own,
 * next to a can't-come about the booked time. Null when no sentence asks for a day other than the booked one.
 */
function askedOtherDay(lined = '', { bookedYmd = '', origin = new Date() } = {}) {
  for (const sentence of sentencesOf(lined)) {
    if (!PREFER_RE.test(sentence) && !SCHED_ALL_RE.test(sentence)) continue;
    let day = null;
    try {
      day = timeParse.parseDayHint(sentence, { now: origin });
    } catch {
      day = null;
    }
    if (day?.ymd && day.ymd !== bookedYmd && Date.parse(`${day.ymd}T23:59:59Z`) >= origin.getTime()) return day;
  }
  return null;
}

/** A plain-statement "vi går ikke videre" in some sentence that is not a question or an "if". */
function saysNoFurther(lined = '') {
  return sentencesOf(lined).some((part) => NO_FURTHER_RE.test(part) && !/\?/.test(part) && !CONDITIONAL_RE.test(part));
}

/** "ikke aktuelt akkurat nå, ta kontakt over nyttår" is a later follow-up, not a no. */
const NOT_NOW_RE = cue(`${L}(?:akkurat\\s+nå|for\\s+øyeblikket|per\\s+nå|ikke\\s+nå|i\\s+første\\s+omgang|over\\s+(?:nyttår|jul|påske|sommeren|ferien)|etter\\s+(?:jul|nyttår|påske|sommeren|ferien|helgen)|til\\s+høsten|i\\s+høst|neste\\s+måned|ta\\s+(?:gjerne\\s+)?kontakt\\s+(?:igjen\\s+)?(?:om|senere|neste|litt|over|etter|i|til)|later|next\\s+(?:month|year))${R}`);

const UNSURE_RE = cue(`${L}(?:vet\\s+ikke\\s+(?:helt\\s+)?(?:nå|ennå|enda|helt|når|hvordan)|ikke\\s+vet\\s+(?:nå|ennå|enda|når)|usikker|må\\s+(?:sjekke|se\\s+på|tenke|snakke\\s+med|høre\\s+med)|kommer\\s+tilbake\\s+(?:til\\s+deg|med|når)|gir\\s+(?:deg\\s+)?beskjed|mye\\s+(?:å\\s+gjøre|på\\s+gang)|travelt|senere\\s+i\\s+(?:uka|uken|måneden)|not\\s+sure|get\\s+back\\s+to\\s+you)${R}`);

const QUESTION_WORD_RE = cue(`(?:^|[.!?]\\s*)(?:hei[,!]?\\s*)?(?:hva|hvem|hvor|hvordan|hvorfor|hvilke[nt]?|når|kan\\s+(?:du|dere|jeg)|er\\s+det|blir\\s+det|må\\s+(?:vi|jeg)|trenger\\s+(?:vi|jeg)|skal\\s+(?:vi|jeg)|what|who|where|how|why|when|is\\s+it|do\\s+(?:you|we|i))${R}`);

/** Offer, contract, payment: a person answers those. */
const CONTRACT_RE = cue(`${L}(?:kontrakt\\p{L}*|avtalen|signer\\p{L}*|signatur|underskr\\p{L}*|tilbud(?:et)?|faktura\\p{L}*|betal\\p{L}*|bindingstid|oppsigelse|si\\s+opp|angrerett|refusjon|contract|invoice|offer|payment)${R}`);

const FACT_RE = cue(`${L}(?:åpningstid\\p{L}*|åpent|adresse|telefon|tlf|org\\.?\\s*nr|organisasjonsnummer|logo|bilder?|meny|tjenester|priser|e-?post)${R}`);

/** A long mail that is still about the meeting is for a person, not the facts filer. */
const ABOUT_MEETING_RE = cue(`${L}(?:${WEEKDAY}|passer|møte\\p{L}*)${R}`);

/** "men kl 14 samme dag går fint", "kan vi ta det kl 13 i stedet?": a new clock on the booked day. */
const SAME_DAY_CLOCK_RE = cue(`${L}(?:samme\\s+dag(?:en)?|same\\s+day|i\\s+stedet|istedet|isteden|instead)${R}|${L}men\\s+[^.!?\\n]*(?:passer|går\\s+(?:fint|bra|greit)|funker|fungerer|kan\\s+(?:jeg|vi)|er\\s+(?:fint|greit|ok))`);

/** "uke 48", "i uke 48 da": a week number and filler, nothing else. */
const WEEK_ONLY_RE = cue(`^(?:[\\s,.!?]*(?:i|på|ok|okay|da|ta|igjen|kanskje)\\b)*[\\s,.]*(?:uke|veke|week)\\s*\\d{1,2}(?:[\\s,.!?]+(?:da|igjen|i\\s+stedet|kanskje))*[\\s.!?]*$`);
/** Several times in a mail that also says some of them are taken. */
const ALT_TAKEN_RE = cue(`${L}(?:har\\s+(?:et\\s+)?møte|har\\s+(?:noe|avtale\\p{L}*)|opptatt|opptatte|fullbooket|er\\s+borte|kan\\s+ikke|går\\s+ikke|passer\\s+ikke|funker\\s+ikke)${R}`);
const NEXT_WEEK_RE = cue(`${L}(?:neste\\s+uke|next\\s+week)${R}`);
const WEEKDAY_RE = cue(`${L}${WEEKDAY}${R}`);

/** Day words a clause can name, to tell "syk i dag" from the booked day ("torsdagen" counts as Thursday). */
const DAY_WORDS_RE = new RegExp(`${L}(?:i\\s*dag|i\\s*morgen|i\\s+overmorgen|(?:mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)(?:en)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)${R}`, 'giu');

/** A date written out ("13. mars", "13.03", "13/3"); "kl 10.30" and "10.00" are clocks, not dates. */
const MONTH_WORD = '(?:januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember|jan|feb|mar|apr|jun|jul|aug|sept?|okt|nov|des|january|february|march|june|july|october|december)';
const DATE_WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}.:,])\\d{1,2}\\.?\\s*${MONTH_WORD}(?!\\p{L})`, 'iu');
const DATE_NUM_RE = /(?<![\p{L}\p{N}.:,])(?<!(?:kl|klokka|klokken)\.?\s{0,2})(\d{1,2})[./](\d{1,2})(?:[./]\d{2,4})?(?![\p{N}:])/giu;

function hasExplicitDate(text = '') {
  if (DATE_WORD_RE.test(text)) return true;
  return [...String(text || '').matchAll(DATE_NUM_RE)].some((match) => {
    const day = Number(match[1]);
    const month = Number(match[2]);
    return day >= 1 && day <= 31 && month >= 1 && month <= 12;
  });
}

/** "Torsdagen etter (kl 10)": the Thursday after, or Thursday after 10? Never read on its own. */
const FOLLOWING_WEEKDAY_RE = cue(`${L}(?:mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)en\\s+etter${R}`);

const ANY_DAY_RE = cue(`${DAY_WORDS_RE.source}|${L}(?:uke|uka|uken|week|helg(?:a|en)?|weekend|månedsskiftet)${R}`);

/** Any day at all: a weekday, a relative day, a date or a week ("neste uke"). */
function namesAnyDay(text = '') {
  return ANY_DAY_RE.test(text) || hasExplicitDate(text);
}

/** A can't-come clause about the meeting itself ("kan ikke komme", "rekker ikke kl 10"), not just a state ("jeg er syk"). */
const MEETING_REF_RE = cue(`${L}(?:møte\\p{L}*|meeting|tidspunkt\\p{L}*|den\\s+tiden|den\\s+dagen|kl|klokka|klokken|da|komme|delta|stille|være\\s+med|være\\s+der|avlys\\p{L}*|utsett\\p{L}*|flytte|forfall|workshop\\p{L}*)${R}`);

/** "fra 10 til 11" (bare hours): the old and the new clock. */
const FROM_TO_RE = /(?<![\p{L}])fra\s+(?:kl\.?\s*|klokka\s+)?(\d{1,2})(?:[:.](\d{2}))?\s+til\s+(?:kl\.?\s*|klokka\s+)?(\d{1,2})(?:[:.](\d{2}))?(?![\p{N}])/iu;
/** A sentence about a chat, a call or lunch is not the meeting's new clock. */
const OTHER_TALK_RE = cue(`${L}(?:prat|samtale|telefon\\p{L}*|ring\\p{L}*|lunsj|lunch)${R}`);

/** The client says they are busy at the time named ("jeg har tannlege torsdag kl 12", "er vi på kurs"). */
const BUSY_TIME_RE = cue(`${L}(?:har\\s+(?:allerede\\s+)?(?:et\\s+|en\\s+|ett\\s+)?(?:annet\\s+|annen\\s+)?(?:møte\\p{L}*|avtale\\p{L}*|tannlege\\p{L}*|time|kurs|frokost|lunsj|middag|julebord|fest|besøk|presentasjon)|er\\s+(?:jeg|vi)\\s+(?:allerede\\s+)?(?:på|i|borte|opptatt|bortreist)|opptatt|opptatte|fullbooket|bortreist|julebord)${R}`);
/** "Jeg vil ikke flytte til torsdag kl 12", "du trenger ikke flytte det": the time is named to turn it down. */
const NEGATED_MOVE_RE = cue(`${L}(?:vil\\s+ikke|trenger\\s+ikke|slipper|ikke\\s+(?:flytt\\p{L}*|skyv\\p{L}*|skubb\\p{L}*|endr\\p{L}*|bytt\\p{L}*|utsett\\p{L}*)|no\\s+need|don'?t\\s+(?:need|want))${R}`);
/** Where the message ends and a sign-off, a P.S. or a signature starts. */
const SIGNOFF_LINE_RE = /(?:^|\n)[ \t]*(?:p\.?\s?s\.?(?![\p{L}])|--+(?=\s|$)|mvh\.?(?![\p{L}])|hilsen(?![\p{L}])|vennlig\s+hilsen|med\s+vennlig\s+hilsen|best\s+regards|regards)/iu;
const CLOCK_WORD_RE = /(?:(?<![\p{L}])(?:kl|klokka|klokken)\.?\s*\d|(?<![\p{N}])\d{1,2}[:.]\d{2}(?![\p{N}]))/iu;

/**
 * A weekday and clock that is named but not asked for: the client is busy then, turns it down, makes it conditional,
 * says another day suits, or it only sits after the sign-off ("Mvh Ola / Telefontid: torsdag kl 12–14"). Returns
 * 'unclear' (a person reads it), 'weak' (a time next to a chat, a call or lunch: the AI keeps its veto) or ''.
 */
function namedNotAsked(lined = '', { dueAt = '', origin = new Date(), bookedYmd = '' } = {}) {
  if (!dueAt) return '';
  const at = (part) => timeDetail(part, origin).dueAt || '';
  const hits = (part) => CLOCK_WORD_RE.test(part) && sameSlot(at(part), dueAt);
  // "Onsdag går fint, men hvis dere vil flytte, torsdag kl 12 passer også": the booked day is affirmed, not given up.
  if (bookedYmd && ymdOf(dueAt) !== bookedYmd && yesToBookedElsewhere(lined, { bookedYmd, origin })) return 'unclear';
  const cut = lined.search(SIGNOFF_LINE_RE);
  if (cut > 0 && !sameSlot(at(lined.slice(0, cut)), dueAt)) return 'unclear';
  for (const sentence of sentencesOf(lined)) {
    if ((CONDITIONAL_RE.test(sentence) || NEGATED_MOVE_RE.test(sentence)) && hits(sentence)) return 'unclear';
  }
  let weak = false;
  for (const clause of lined.split(/[.!?;\n,:]+|\s+(?:men|but|så)\s+/iu).map((part) => part.trim()).filter(Boolean)) {
    if (BUSY_TIME_RE.test(clause) && hits(clause)) return 'unclear';
    if (OTHER_TALK_RE.test(clause) && hits(clause)) weak = true;
  }
  return weak ? 'weak' : '';
}
const WEEKDAY_NUMBER = {
  søndag: 0, mandag: 1, tirsdag: 2, onsdag: 3, torsdag: 4, fredag: 5, lørdag: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

function compact(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

/** Line breaks kept: the time parser treats each line as its own sentence. */
function keepLines(value = '') {
  return String(value || '').replace(/\r\n?/g, '\n').trim();
}

/** Soft wraps joined: a line that goes on in lower case or with a digit continues the line above. */
function joinSoftWraps(lined = '') {
  return lined.replace(/([^\n])[ \t]*\n[ \t]*(?=[\p{Ll}\p{N}])/gu, '$1 ');
}

function ymdOf(iso = '') {
  return iso ? osloCalendarYmd(iso) : '';
}

function addDaysYmd(ymd = '', days = 0) {
  const date = new Date(`${ymd}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Everything the parser reads from one text: { dueAt, day, clock, excludedDays }. Never throws. */
function timeDetail(text = '', now = new Date()) {
  try {
    if (typeof timeParse.parseTimeDetail === 'function') return timeParse.parseTimeDetail(text, { now }) || {};
    return {
      dueAt: timeParse.parseWorkshopTimeHeuristic(text, { now })?.dueAt || '',
      day: timeParse.parseDayHint(text, { now }),
      clock: typeof timeParse.parseClockTime === 'function' ? timeParse.parseClockTime(text) : null,
      excludedDays: excludedDaysOf(text, now),
    };
  } catch {
    return {};
  }
}

/**
 * The time read with line breaks kept, with soft wraps joined and as one line must agree. A soft-wrapped
 * "…på torsdag\nkl 10 likevel. Kan vi ta fredag kl 13?" pairs the orphan "kl 10" with "fredag"; the
 * one-line text reads 13:00. Hard breaks between capitalised lines ("Torsdag passer ikke\nFredag kl 13
 * går fint") are the client's own sentences, so only a time that both line readings share may differ
 * from the one-line reading by being absent there.
 */
function timesDisagree({ lined = '', fresh = '', parsedAt = '', origin = new Date() } = {}) {
  const unwrapped = joinSoftWraps(lined);
  const joined = unwrapped === lined ? parsedAt : (timeDetail(unwrapped, origin).dueAt || '');
  if (Boolean(parsedAt) !== Boolean(joined) || (parsedAt && !sameSlot(parsedAt, joined))) return true;
  if (!parsedAt || fresh === lined || fresh === unwrapped) return false;
  const flat = timeDetail(fresh, origin).dueAt || '';
  return Boolean(flat) && !sameSlot(parsedAt, flat);
}

function osloWeekdayOfYmd(ymd = '') {
  const iso = osloWallToIso(ymd, 12, 0, 0);
  return iso ? new Date(iso).getUTCDay() : -1;
}

/** Whether a clause names the booked day ("torsdag", "møtet", "i morgen" the day before) or another day. */
function clauseDays(clause = '', { bookedYmd = '', todayYmd = '' } = {}) {
  let bookedDay = /(?<![\p{L}])(?:møtet|meeting)(?![\p{L}])/iu.test(clause);
  let otherDay = false;
  for (const match of clause.matchAll(DAY_WORDS_RE)) {
    const word = match[0].toLowerCase().replace(/\s+/g, '').replace(/^(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag)en$/u, '$1');
    let ymd = '';
    if (word === 'idag' || word === 'today') ymd = todayYmd;
    else if (word === 'iovermorgen') ymd = addDaysYmd(todayYmd, 2);
    else if (word === 'imorgen' || word === 'tomorrow') ymd = addDaysYmd(todayYmd, 1);
    const hit = ymd ? ymd === bookedYmd : WEEKDAY_NUMBER[word] === osloWeekdayOfYmd(bookedYmd);
    if (hit) bookedDay = true;
    else otherDay = true;
  }
  return { bookedDay, otherDay };
}

/**
 * "Jeg er syk i dag, men torsdag skal gå fint" (Monday, meeting Thursday) and "Jeg er syk, men torsdag skal
 * gå fint": every can't-come clause is about another day or names no day and not the meeting, and the
 * booked day is named with a yes. Returns the other clauses, else ''.
 */
function cancelOnOtherDayOnly(lined = '', { bookedYmd = '', origin = new Date() } = {}) {
  if (!bookedYmd) return '';
  const todayYmd = osloCalendarYmd(origin.toISOString());
  const clauses = lined.split(/[.!?;\n]+|,?\s+(?:men|but)\s+/iu).map((part) => part.trim()).filter(Boolean)
    .map((clause) => ({ clause, cancel: CANCEL_RE.test(clause), ...clauseDays(clause, { bookedYmd, todayYmd }) }));
  const cancels = clauses.filter((row) => row.cancel);
  const aboutMeeting = (row) => row.bookedDay || (!row.otherDay && MEETING_REF_RE.test(row.clause));
  if (!cancels.length || cancels.some(aboutMeeting)) return '';
  const rest = clauses.filter((row) => !row.cancel);
  const yes = rest.some((row) => row.bookedDay && BOOKED_OK_RE.test(row.clause) && !DIFFICULTY_RE.test(row.clause));
  return yes ? rest.map((row) => row.clause).join('. ') : '';
}

/** "Jeg kan ikke komme, men torsdag går fint": a clause without a can't-come cue says yes to the booked day. */
function yesToBookedElsewhere(lined = '', { bookedYmd = '', origin = new Date() } = {}) {
  if (!bookedYmd) return false;
  const todayYmd = osloCalendarYmd(origin.toISOString());
  return lined.split(/[.!?;\n]+|,?\s+(?:men|but)\s+/iu).map((part) => part.trim()).filter(Boolean)
    .some((clause) => !CANCEL_RE.test(clause) && clauseDays(clause, { bookedYmd, todayYmd }).bookedDay
      && BOOKED_OK_RE.test(clause) && !DIFFICULTY_RE.test(clause));
}

/** An offered slot inside the part of the day the client asked for ("etter lunsj" never picks 09:00). */
function fitsBand(iso = '', day = {}) {
  const hour = Number(osloClockOf(iso).slice(0, 2));
  if (!Number.isFinite(hour)) return false;
  if (day?.band === 'afternoon' && hour < 12) return false;
  if (day?.band === 'morning' && hour >= 12) return false;
  if (Number.isFinite(day?.afterHour) && hour < day.afterHour) return false;
  if (Number.isFinite(day?.beforeHour) && hour >= day.beforeHour) return false;
  return true;
}

function sameSlot(left = '', right = '') {
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 120000;
}

function osloWeekdayClock(iso = '') {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Oslo',
  }).format(new Date(ms));
}

function osloClockOf(iso = '') {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Oslo' }).format(new Date(ms));
}

/**
 * "tirsdag kl. 14:00" on the meeting day repeats the booked meeting even if the parser lands a week later.
 * A date written out ("torsdag 13. mars kl 10", "13.03") that is not the booked date never does.
 */
function repeatsBooked(dueAt = '', booked = '', text = '') {
  if (sameSlot(dueAt, booked)) return true;
  if (/neste\s+uke|next\s+week|om\s+en\s+uke/i.test(text) || hasExplicitDate(text)) return false;
  const a = osloWeekdayClock(dueAt);
  return Boolean(a) && a === osloWeekdayClock(booked) && Math.abs(Date.parse(dueAt) - Date.parse(booked)) <= 7 * 86400000;
}

/** Text without greetings and real sign-offs, to judge whether a mail is just a time. Line breaks stay. */
function coreText(text = '') {
  return keepLines(text).replace(/[ \t]+/g, ' ')
    .replace(/^(?:hei|hallo|hi|hello|god\s+(?:morgen|dag|kveld))[\s,!.]*(?:\p{L}+[,!.])?/iu, '')
    .replace(/^(?:tusen\s+)?takk(?:\s+for\s+(?:det|sist|svar(?:et)?))?[\s,.!]*/iu, '')
    .replace(/(?:mvh|med\s+vennlig\s+hilsen|hilsen|vennlig\s+hilsen|best\s+regards|regards)[\s\S]*$/iu, '')
    .replace(/(?:^|[\s,.!])(?:tusen\s+)?takk(?:\s+(?:for\s+(?:det|sist|svar(?:et)?)|skal\s+du\s+ha))?[\s.!]*$/iu, '')
    .trim();
}

/** More than one sentence left after greetings: a time in it is rarely the whole message. */
function sentenceCount(text = '') {
  return protectDots(text).split(/[.!?\n]+/).map((part) => part.trim()).filter(Boolean).length;
}

/**
 * "Fint om du legger Kari på inviten.", "Ta gjerne med Kari", "(CC)": a guest request, not part of the time.
 * Dropped before judging whether the rest of the mail is just a time.
 */
const GUEST_SENTENCE_RE = cue([
  `${L}ta\\s+(?:gjerne\\s+)?med${R}`,
  `${L}legg\\p{L}*\\s+(?:gjerne\\s+)?(?:til|inn)${R}`,
  `${L}(?:legg|sett|ta|inviter)\\p{L}*\\s+(?:gjerne\\s+|også\\s+)?(?!(?:det|den|dette|møtet|alt|oss|meg|inn|opp|på|med|til)${R})[^.!?\\n]{1,40}?\\s+(?:på|til|med\\s+på)\\s+(?:inviten|invitasjonen|invitasjon|møtet|kalender\\p{L}*|mailen|tråden)${R}`,
  `${L}inviter\\p{L}*${R}`,
  `${L}(?:skal|vil|kommer)\\s+også\\s+(?:være\\s+)?med${R}`,
  `${L}(?:cc|bcc|kopi\\s+til)${R}|@\\S+\\.\\S+`,
].join('|'));

function withoutGuestSentences(text = '') {
  return sentencesOf(text)
    .filter((part) => !GUEST_SENTENCE_RE.test(part))
    .join('\n').replace(/\(\s*(?:cc|bcc)\s*\)/giu, '').trim();
}

/**
 * A name-and-title block after a blank line ("Ola Nordmann / Daglig leder / +47 ...") is a signature, not part of the
 * time. Only short lines that ask, propose or name a day or clock are never one.
 */
const SIGNATURE_LINE_RE = cue(`@|https?:|www\\.|\\+?\\d[\\d\\s-]{6,}$|^(?:mvh|hilsen|vennlig\\s+hilsen|med\\s+vennlig\\s+hilsen|sendt\\s+fra|best\\s+regards|regards|sent\\s+from)${R}|${L}(?:daglig\\s+leder|leder|sjef|konsulent|rådgiver|manager|ceo|cto|direktør|eier|partner|selger|markedssjef|prosjektleder|styreleder|gründer|founder|as|asa|ans)${R}`);
const NAME_LINE_RE = /^\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*){0,3}$/u;
const SIGNATURE_VERB_RE = /(?:^|\s)(?:er|har|kan|vil|skal|må|blir|kommer|går|passer|tar|is|are|will|can|has)(?:\s|$)/iu;
function signatureLike(line = '') {
  return NAME_LINE_RE.test(line) || SIGNATURE_LINE_RE.test(line);
}

// A long title line ("Head of Finance & Accounting Manager | økonomisjef") is still a signature line;
// a long line with a verb ("Daglig leder kan ikke komme ...") is a sentence.
function longSentence(line = '') {
  return line.length > 40 && (!SIGNATURE_LINE_RE.test(line) || SIGNATURE_VERB_RE.test(line));
}
function sentenceLike(line = '') {
  return /[?!]|\.\s*$/.test(line) || longSentence(line) || SCHED_ALL_RE.test(line) || MOVE_RE.test(line)
    || CANCEL_RE.test(line) || PREFER_RE.test(line) || DIFFICULTY_RE.test(line) || QUESTION_WORD_RE.test(line)
    || WEEKDAY_RE.test(line) || /\b(?:kl|klokka|klokken)\b|\d{1,2}[:.]\d{2}/iu.test(line) || hasExplicitDate(line);
}
function blockIsSignature(block = '') {
  const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
  return !lines.some(sentenceLike) && lines.every(signatureLike);
}

function withoutSignatureBlock(text = '') {
  const blocks = String(text || '').split(/\n[ \t]*\n/);
  // A block is dropped only when every line looks like a signature; "Kari er syk" stays and blocks the booking.
  const keep = blocks.filter((block, index) => index === 0 || !blockIsSignature(block));
  return keep.join('\n\n').trim();
}

/**
 * What is left of a mail after the guest sentence was cut out is only a signature
 * ("Ola Nordmann / Head of Finance | økonomisjef / Mobile: +47 ..."): nothing else to answer.
 */
export function isSignatureOnly(text = '') {
  const source = String(text || '').replace(/^--\s*$/gm, '').trim();
  if (!source) return true;
  const lines = source.split('\n').map((line) => line.trim()).filter(Boolean);
  // "Nei" or "Avlys" on its own line is an answer, not a name.
  if (lines.some((line) => /^(?:nei|ikke|no|not|avlys|stopp|stop)(?![\p{L}])/iu.test(line))) return false;
  // One bare word ("Ok", "Takk") is left to the classifier; a signature is a name plus a title, phone or "Mvh".
  if (lines.length < 2 && !SIGNATURE_LINE_RE.test(lines[0])) return false;
  return source.split(/\n[ \t]*\n/).every((block) => !block.trim() || blockIsSignature(block));
}

/** "Torsdag kl 12?", "Torsdag kl 12 da?", "25.11 kl 13": nothing but a day and a clock (and filler words). */
const BARE_FILLER = `(?:${WEEKDAY}|i\\s*morgen|i\\s*overmorgen|imorgen|i\\s*dag|neste\\s+uke|kl|klokka|klokken|den|på|da|så|ok|okay|igjen|kanskje|ellers|eller|og|i\\s+stedet|istedet|isteden|heller)`;
function isBareTimeProposal(text = '') {
  const rest = protectDots(text).toLowerCase()
    .replace(new RegExp(`${L}(?:${BARE_FILLER}|${MONTH_WORD})${R}`, 'giu'), ' ')
    .replace(/[\d․:./–-]+/g, ' ');
  return rest.replace(/[\s?!.,;()]+/g, '') === '';
}

function excludedDaysOf(text, now) {
  if (typeof timeParse.parseExcludedDays !== 'function') return [];
  try {
    const out = timeParse.parseExcludedDays(text, { now });
    return Array.isArray(out) ? out.map((row) => (typeof row === 'string' ? row : row?.ymd)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** "kan ikke kl 10, men kl 14 samme dag går fint" → the booked day at the new clock, else ''. */
function sameDayNewClock(text, { booked = '', bookedYmd = '', nowMs = 0, clock: parsedClock } = {}) {
  if (!bookedYmd || !SAME_DAY_CLOCK_RE.test(compact(text))) return '';
  const clock = parsedClock !== undefined ? parsedClock
    : (typeof timeParse.parseClockTime === 'function' ? timeParse.parseClockTime(text) : null);
  if (!clock || !Number.isFinite(clock.hour)) return '';
  const dueAt = osloWallToIso(bookedYmd, clock.hour, clock.minute || 0, 0);
  if (!dueAt || Date.parse(dueAt) <= nowMs || osloClockOf(dueAt) === osloClockOf(booked)) return '';
  return dueAt;
}

function clockOf(text = '') {
  try {
    const clock = typeof timeParse.parseClockTime === 'function' ? timeParse.parseClockTime(text) : null;
    return clock && Number.isFinite(clock.hour) ? { hour: clock.hour, minute: clock.minute || 0 } : null;
  } catch {
    return null;
  }
}

/**
 * The new clock a mail with no day asks for: "Kan vi flytte møtet til kl 11?", "Kan vi flytte fra 10 til 11?"
 * (the "til" one), "Jeg rekker ikke kl 10. Kl 12 da?", "Ta det kl 10 du". Only a sentence that asks (a question,
 * "kan vi …", "ta det …", "passer det …") counts, never "er på jobb til kl 17". Returns { hour, minute }, { unclear: true } when the
 * sentences name different clocks or "fra" is not the booked clock, or null.
 */
function askedClockWithoutDay(lined = '', booked = '') {
  const bookedClock = osloClockOf(booked);
  const found = [];
  for (const sentence of sentencesOf(lined)) {
    if (INCIDENTAL_RE.test(sentence) || OTHER_TALK_RE.test(sentence)) continue;
    const range = sentence.match(FROM_TO_RE);
    if (range) {
      // "opptatt fra 10 til 11" is not a move; "flytte fra 10 til 11" is.
      if (!MOVE_RE.test(sentence) && !NEW_CLOCK_ASK_RE.test(sentence) && !/(?<![\p{L}])(?:utsett\p{L}*|skyv\p{L}*|skubb\p{L}*|flytt\p{L}*)/iu.test(sentence)) continue;
      const from = `${range[1].padStart(2, '0')}:${range[2] || '00'}`;
      const to = clockOf(`kl ${range[3]}${range[4] ? `:${range[4]}` : ''}`);
      if (!to || (bookedClock && from !== bookedClock)) return { unclear: true };
      found.push(to);
      continue;
    }
    const asks = /\?/.test(sentence) || NEW_CLOCK_ASK_RE.test(sentence) || MOVE_RE.test(sentence) || SCHED_ALL_RE.test(sentence);
    const clock = asks ? clockOf(sentence) : null;
    if (clock) found.push(clock);
  }
  const distinct = uniq(found.map((clock) => `${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`));
  if (distinct.length > 1) return { unclear: true };
  return found[0] || null;
}

function uniq(list = []) {
  return [...new Set(list.filter(Boolean))].sort();
}

export function looksLikeWalkAway(text = '') {
  return NOT_INTERESTED_RE.test(String(text || '')) || saysNoFurther(keepLines(text));
}

export function looksLikeCancel(text = '') {
  return CANCEL_RE.test(String(text || ''));
}

/** A calendar card or reminder echo, not a human writing. */
export function looksLikeCalendarEcho(text = '') {
  return EVENT_CARD_RE.test(compact(text));
}

/** The words of a yes to one of the offered times ("tar den første", "velger nr 2"). */
const PICK_YES_RE = cue(`${L}(?:tar|velger|ta|velge|tar\\s+vi|ok|takk|fint|bra|greit)${R}`);

const ORDINALS = { første: 0, andre: 1, annen: 1, tredje: 2, siste: -1 };
const ORDINAL_RES = [
  // Not "den første uken i desember" / "den siste dagen": an ordinal in front of a period noun is no pick.
  cue(`${L}(?:den|det|de)\\s+(første|andre|annen|tredje|siste)${R}(?!\\s+(?:uke|uka|uken|ukene|dag|dagen|dagene|måned|måneden|gang|gangen|del|delen|halvdel\\p{L}*|halvår\\p{L}*|kvartal\\p{L}*|helg\\p{L}*|(?:av|i)\\s+(?:${MONTH_WORD}|uken|måneden)))`),
  cue(`${L}(første|andre|annen|tredje|siste)\\s+(?:forslaget|forslag|alternativet|alternativ|tiden|tidspunktet|tidspunkt|muligheten|mulighet|av\\s+dem|av\\s+de|av\\s+tidene)${R}`),
  cue(`${L}(?:nr\\.?|nummer|alternativ|forslag|alt\\.?|option)\\s*(\\d)${R}`),
];

/** "Den første", "Det andre forslaget", "Siste alternativ", "nr 2": the offered slot meant, in offer order. */
function pickedOffer(text = '', offered = []) {
  if (!offered.length) return null;
  for (const re of ORDINAL_RES) {
    const hit = String(text || '').match(re);
    if (!hit) continue;
    const raw = hit[1].toLowerCase();
    const index = /^\d$/.test(raw) ? Number(raw) - 1 : ORDINALS[raw];
    const at = index === -1 ? offered.length - 1 : index;
    if (at >= 0 && at < offered.length) return { iso: offered[at], index: at };
    return null;
  }
  return null;
}

/**
 * "Den første passer ikke, men den siste går": the clauses that turn down one offered time are dropped, the rest is
 * what the client picks. Returns { rest, declined } (declined = indexes of the turned-down times), or null.
 */
function withoutDeclinedOrdinals(lined = '', offered = []) {
  const parts = String(lined || '').split(/(,?\s+(?:men|but)\s+|[.!?;\n]+|,\s+)/iu);
  const kept = [];
  const declined = [];
  for (let index = 0; index < parts.length; index += 2) {
    const clause = parts[index].trim();
    if (!clause) continue;
    const hit = pickedOffer(clause, offered);
    if (hit && (/(?<![\p{L}])(?:ikke|dårlig|umulig|aldri|not)(?![\p{L}])/iu.test(clause) || DIFFICULTY_RE.test(clause) || CANCEL_RE.test(clause))) {
      declined.push(hit.index);
    } else {
      kept.push(clause);
    }
  }
  return declined.length && kept.length ? { rest: kept.join('. '), declined } : null;
}

/**
 * Two or three times named with "eller" ("tirsdag kl 10 eller onsdag kl 14"): the parser's candidates, future only,
 * the first one being the time read. Empty when the mail has no "eller", names the booked meeting, or has just one time.
 */
function alternativesOf(candidates = [], { text = '', dueAt = '', booked = '', nowMs = 0, excludedDays = [] } = {}) {
  if (!dueAt || !/(?<![\p{L}])(?:eller|or)(?![\p{L}])/iu.test(text) || !Array.isArray(candidates)) return [];
  const list = [...new Set(candidates)].filter((iso) => Date.parse(iso) > nowMs && !excludedDays.includes(ymdOf(iso))).slice(0, 3);
  if (list.length < 2 || !sameSlot(list[0], dueAt)) return [];
  if (booked && list.some((iso) => repeatsBooked(iso, booked, text))) return [];
  return list;
}

/**
 * @param {string} text fresh reply text (no subject, no quoted thread)
 * @param {object} client sales card
 * @param {{now?: Date, offeredSlots?: string[]}} options now = the mail's date (relative words); offeredSlots = the bot's last offer
 */
export function classifyInboxRequest(text = '', client = {}, { now = new Date(), offeredSlots = [], _inner = false } = {}) {
  const fresh = compact(text);
  const lined = keepLines(text);
  const origin = now instanceof Date ? now : new Date(now);
  const nowMs = origin.getTime();
  const question = /\?/.test(fresh) || QUESTION_WORD_RE.test(fresh);
  // Set once the cues are read: a can't-come cue that the other-day exemption did not lift.
  let cantCome = false;
  // Set once the cues are read: the words say the booked meeting itself does not work (not just "another time").
  let rejectsBooked = false;
  const out = (request, intent, extra = {}) => {
    // Never a confirmation when the same mail says the client cannot come: a person reads it.
    if (request === 'confirm' && cantCome) {
      return out('unclear', 'none', { reason: 'booked-day-unclear', bookedNamed: Boolean(extra.bookedNamed) });
    }
    return {
      request,
      intent,
      dueAt: '',
      day: null,
      cancel: false,
      echo: false,
      unsure: false,
      excludedDays: [],
      reason: '',
      question,
      bookedNamed: false,
      rejectsBooked,
      ...extra,
    };
  };
  if (!fresh) return out('empty', 'none', { echo: true });

  const detail = timeDetail(lined, origin);
  const parsedAt = detail.dueAt || '';
  // A soft wrap must not move the clock to another day: every reading of the time has to agree.
  const timeConflict = timesDisagree({ lined, fresh, parsedAt, origin });
  let dueAt = parsedAt;
  const pastDue = Boolean(dueAt) && Date.parse(dueAt) <= nowMs;
  if (pastDue) dueAt = '';
  let day = detail.day || null;
  const excludedDays = Array.isArray(detail.excludedDays)
    ? detail.excludedDays.map((row) => (typeof row === 'string' ? row : row?.ymd)).filter(Boolean)
    : [];
  if (day?.ymd && (excludedDays.includes(day.ymd) || Date.parse(`${day.ymd}T23:59:59Z`) < nowMs)) day = null;
  if (dueAt && excludedDays.includes(ymdOf(dueAt))) dueAt = '';
  if (day?.ymd && ((NEXT_WEEK_RE.test(fresh) && !WEEKDAY_RE.test(fresh)) || (detail.weekOnly && detail.weekNumber))) day = { ...day, week: true };
  // "tirsdag 24.11 i uke 49": the date and the week disagree, so nothing is read.
  const weekConflict = Boolean(detail.weekConflict);

  const booked = bookedMeetingAt(client);
  const bookedFuture = Boolean(booked) && Date.parse(booked) > nowMs;
  const bookedYmd = bookedFuture ? ymdOf(booked) : '';
  const offered = (Array.isArray(offeredSlots) ? offeredSlots : []).filter((iso) => Date.parse(iso) > nowMs);
  const offeredDays = uniq(offered.map(ymdOf));

  // "Den første passer ikke, men den siste går" / "Nr 1 passer ikke, nr 3 passer": the no is about one offered time,
  // the pick of another one stands.
  if (offered.length && !_inner) {
    const split = withoutDeclinedOrdinals(lined, offered);
    if (split) {
      const inner = classifyInboxRequest(split.rest, client, { now, offeredSlots, _inner: true });
      if (inner.request === 'reschedule' && inner.pick && !split.declined.includes(inner.pick - 1)) return inner;
    }
  }

  let cancelCue = CANCEL_RE.test(fresh);
  let difficulty = DIFFICULTY_RE.test(fresh);
  // "Jeg er syk i dag, men torsdag skal gå fint": the can't-come words are about another day.
  const otherDayText = cancelCue && bookedFuture ? cancelOnOtherDayOnly(lined, { bookedYmd, origin }) : '';
  if (otherDayText) {
    cancelCue = false;
    difficulty = DIFFICULTY_RE.test(compact(otherDayText));
  }
  const moveCue = MOVE_RE.test(fresh);
  const incidentalWords = INCIDENTAL_RE.test(fresh);
  const schedCue = SCHED_RE.test(fresh) || (!incidentalWords && SCHED_SOFT_RE.test(fresh));
  const incidental = incidentalWords && !SCHED_RE.test(fresh);
  const core = coreText(lined);
  // A guest sentence ("Fint om du legger Kari på inviten. (CC)") is not part of the time.
  const timeCore = withoutSignatureBlock(withoutGuestSentences(withoutSignatureBlock(core)));
  // A list of days and clocks ("tirsdag kl 10 eller onsdag kl 14 eller fredag kl 9") is still just a time.
  const bareOnly = Boolean(timeCore) && timeCore.length <= 120 && isBareTimeProposal(timeCore);
  const justATime = Boolean(timeCore) && (timeCore.length <= 40 || bareOnly) && sentenceCount(timeCore) <= 1 && !incidental;
  // "Torsdag kl 12?": a day and a clock alone, asked or not, is a new time.
  const bareProposal = justATime && bareOnly;
  // "Jeg har ombestemt meg" is a no only when nothing in the mail asks for a time or a day.
  const changedMind = CHANGED_MIND_RE.test(fresh) && !question && !dueAt && !day && !excludedDays.length
    && !moveCue && !schedCue && !PREFER_RE.test(fresh) && !CONFIRM_RE.test(fresh);
  const walkAway = NOT_INTERESTED_RE.test(fresh) || saysNoFurther(lined) || changedMind;
  const laterCue = NOT_NOW_RE.test(fresh);
  const notNow = laterCue || UNSURE_RE.test(fresh);
  const callCue = CALL_RE.test(fresh);
  const contract = CONTRACT_RE.test(fresh);
  const confirmCue = CONFIRM_RE.test(fresh);
  const bookedOk = confirmCue || BOOKED_OK_RE.test(fresh);
  // A time names the booked meeting only at its own clock; "torsdag kl 14" when it is at 10 is a new time.
  const bookedNamed = bookedFuture && (dueAt ? repeatsBooked(dueAt, booked, fresh) : (day?.ymd === bookedYmd && !day?.week));
  const newClockOnBooked = bookedFuture && Boolean(dueAt) && !bookedNamed && ymdOf(dueAt) === bookedYmd;
  const bookedNeg = bookedFuture && excludedDays.includes(bookedYmd);
  cantCome = cancelCue || (bookedNeg && !otherDayText);
  // "Jeg kan ikke onsdag, kan vi ta lørdag?" rejects the booked meeting; "kan vi heller ta lørdag?" does not.
  rejectsBooked = cantCome || difficulty;
  // A can't-come clause next to a yes to the booked day in another clause: neither a cancel nor a confirm.
  const mixedYes = cancelCue && bookedFuture && yesToBookedElsewhere(lined, { bookedYmd, origin });
  // "Torsdag blir vanskelig" / "torsdag funker ikke": the booked day no longer works.
  const cantBooked = (!question || moveCue) && (bookedNeg || (bookedNamed && difficulty && !bookedOk));
  const cancelling = cancelCue || cantBooked;
  // A named cancelled day that is not the booked one means they decline offered times, not the meeting.
  const cancelHitsBooked = bookedFuture && (cancelling || moveCue)
    && (!excludedDays.length || excludedDays.includes(bookedYmd));
  const base = { excludedDays, day };

  // The line-kept, soft-wrap-joined and one-line readings name different times: a person decides.
  if (timeConflict && (schedCue || moveCue || cancelling) && !EVENT_CARD_RE.test(fresh)) {
    return out('unclear', 'none', { ...base, reason: 'time-unclear' });
  }

  // "Jeg har møte tirsdag kl 10 eller onsdag kl 14, men torsdag kl 12 går fint": a time named as taken must never
  // be booked as the first alternative; a person reads it.
  if (Array.isArray(detail.candidates) && detail.candidates.length > 1 && ALT_TAKEN_RE.test(fresh) && !EVENT_CARD_RE.test(fresh)) {
    return out('unclear', 'none', { ...base, reason: 'time-unclear' });
  }

  // "Torsdagen etter kl 10": the Thursday a week on at 10, or Thursday after 10? A person decides.
  if (FOLLOWING_WEEKDAY_RE.test(fresh) && (schedCue || moveCue || cancelling || bookedOk || dueAt || day)) {
    return out('unclear', 'none', { ...base, reason: 'time-unclear' });
  }

  if (weekConflict && !EVENT_CARD_RE.test(fresh)) {
    return out('unclear', 'none', { ...base, reason: 'time-unclear' });
  }

  if (walkAway && !dueAt) {
    if (laterCue) return out('not_now', 'sales_call', { ...base, unsure: true, cancel: bookedFuture });
    if (callCue) return out('call', 'sales_call', { ...base, day: null, cancel: bookedFuture });
    return out('not_interested', 'walk_away', { ...base, day: null, cancel: bookedFuture });
  }

  // "Må dessverre avlyse. Vi har ikke budsjett …": a no about money or need, not the time; never "which day suits?".
  if (cancelCue && NO_NEED_RE.test(fresh) && !dueAt && !moveCue && !laterCue && !callCue && !PREFER_RE.test(fresh)
    && !(day?.ymd && day.ymd !== bookedYmd)) {
    return out('not_interested', 'walk_away', { ...base, day: null, cancel: bookedFuture, reason: 'no-need' });
  }

  // "Ingen av disse passer": never book one of them; offer other days, or a person decides.
  if (DECLINE_ALL_RE.test(fresh)) {
    if (bookedFuture) return out('unclear', 'none', { ...base, reason: 'decline-all' });
    // "Ingen av tidene passer. Torsdag neste uke kl 14?": a clear time we did not offer is booked like any other.
    if (dueAt && !difficulty && !offered.some((iso) => sameSlot(iso, dueAt))) {
      return out('reschedule', 'sales_book', { ...base, dueAt, day: { ymd: ymdOf(dueAt), band: 'day' } });
    }
    const named = dueAt ? { ymd: ymdOf(dueAt), band: 'day' } : day;
    // A weekday the client asks for ("har dere noe mandag ettermiddag?") stays offerable even if we offered
    // another time that day; a week ("noe neste uke?") only anchors the search.
    const askedYmd = named?.ymd && !named.week && !difficulty ? named.ymd : '';
    const avoid = uniq([...excludedDays, ...offeredDays.filter((ymd) => ymd !== askedYmd), difficulty && named?.ymd ? named.ymd : '']);
    const keep = named?.ymd && (named.week || !avoid.includes(named.ymd)) ? named : null;
    return out('reschedule_day', 'sales_propose', { excludedDays: avoid, day: keep, reason: 'decline-all' });
  }

  // A calendar card or reminder pasted back ("Join with Google Meet") repeats the meeting; it asks nothing.
  if (EVENT_CARD_RE.test(fresh) && !/\?/.test(fresh) && !cancelCue && !moveCue) return out('confirm', 'none', { echo: true });

  // "Den første går fint", "Siste alternativ", "nr 2": a pick of the times we offered.
  const picked = pickedOffer(fresh, offered);
  // Never a pick inside an "if" ("hvis den første går fint …") or a bare question ("er den første ledig?").
  if (picked && (!dueAt || sameSlot(dueAt, picked.iso)) && !CONDITIONAL_RE.test(fresh) && !(question && !schedCue && !confirmCue) && !cancelling && !difficulty && !DECLINE_ALL_RE.test(fresh)
    && (confirmCue || bookedOk || schedCue || justATime || PICK_YES_RE.test(fresh))) {
    return out('reschedule', 'sales_book', { ...base, dueAt: picked.iso, day: { ymd: ymdOf(picked.iso), band: 'day' }, cancel: bookedFuture, pick: picked.index + 1 });
  }

  // "Tirsdag kl 10 eller onsdag kl 14": up to three alternatives in the order written; the writer books the first that fits.
  const alternatives = alternativesOf(detail.candidates, { text: fresh, dueAt, booked: bookedFuture ? booked : '', nowMs, excludedDays });
  const bookOut = (extra = {}) => out('reschedule', 'sales_book', {
    ...base, dueAt, day: { ymd: ymdOf(dueAt), band: 'day' }, cancel: bookedFuture, ...(alternatives.length > 1 ? { candidates: alternatives } : {}), ...extra,
  });

  if (dueAt) {
    if (bookedNamed) {
      if (mixedYes) return out('unclear', 'none', { ...base, reason: 'booked-day-unclear', bookedNamed: true });
      if (cancelling || difficulty) {
        const other = askedOtherDay(lined, { bookedYmd, origin });
        if (other) return out('reschedule_day', 'sales_propose', { ...base, day: other, cancel: true, bookedNamed: true });
        return out('cancel', 'sales_cancel', { ...base, day: null, cancel: true, bookedNamed: true });
      }
      if (question) return out('question', 'gather', { bookedNamed: true });
      if (bookedOk) return out('confirm', 'none', { echo: true, bookedNamed: true });
      return out('unclear', 'none', { ...base, reason: 'booked-day-unclear', bookedNamed: true });
    }
    const matchesOffer = offered.some((iso) => sameSlot(iso, dueAt));
    // A time that is only named ("jeg har tannlege torsdag kl 12, men onsdag går fint") is never booked by the words.
    const namedOnly = matchesOffer ? '' : namedNotAsked(lined, { dueAt, origin, bookedYmd });
    if (namedOnly === 'unclear') return out('unclear', 'none', { ...base, reason: 'time-unclear' });
    // "Kan vi ta torsdag kl 14 i stedet?" / "kl 10 går ikke, men kl 14 passer": the booked day at a new clock is
    // booked like any new time, but only when the client asks for it; "torsdag kl 14 passer fint" may just
    // misremember the time.
    if (newClockOnBooked) {
      if (cancelling || difficulty || moveCue || matchesOffer || bareProposal || PREFER_RE.test(fresh) || NEW_CLOCK_ASK_RE.test(fresh)) {
        return bookOut({ day: { ymd: bookedYmd, band: 'day' }, cancel: true });
      }
      if (question) return out('question', 'gather');
      return out('unclear', 'none', { ...base, reason: 'time-unclear' });
    }
    if (schedCue || moveCue || cancelling || matchesOffer || bareProposal) return bookOut(namedOnly === 'weak' && !bareProposal ? { weak: true } : {});
    // Only "short and not a question" carried it ("Torsdag kl 12 lunsj"): weak, so a model that reads it as
    // something else still sends it to a person.
    if (justATime && !question) return bookOut({ weak: true });
  }

  // A time that has already passed ("2.10 kl 14" in mid-October): offer new times, never book it.
  if (pastDue && (schedCue || moveCue || justATime) && !cancelling) {
    // An earlier clock on the meeting day itself: the meeting still stands later today, so a person answers.
    if (bookedFuture && ymdOf(parsedAt) === bookedYmd) return out('unclear', 'none', { ...base, reason: 'time-unavailable' });
    return out('reschedule_day', 'sales_propose', { ...base, day: null, reason: 'time-passed' });
  }

  // "Kan vi utsette møtet en uke?": offer days around a week after the booked meeting, never before it.
  if (bookedFuture && WEEK_LATER_RE.test(fresh) && (!day || day.ymd === bookedYmd)) {
    return out('reschedule_day', 'sales_propose', {
      ...base,
      day: { ymd: addDaysYmd(bookedYmd, 7), band: day?.band || 'day', week: true },
      cancel: true,
    });
  }

  // "Kan vi flytte møtet til kl 13 samme dag?" / "kan vi ta det kl 13 i stedet?": the booked day at the new clock.
  const asksNewClock = cancelling || moveCue || NEW_CLOCK_ASK_RE.test(fresh);
  if (bookedFuture && asksNewClock && !callCue && !excludedDays.includes(bookedYmd) && (!day || day.ymd === bookedYmd)) {
    const sameDay = sameDayNewClock(lined, { booked, bookedYmd, nowMs, clock: detail.clock ?? null });
    if (sameDay) {
      return out('reschedule', 'sales_book', { ...base, dueAt: sameDay, day: { ymd: bookedYmd, band: 'day' }, cancel: true });
    }
  }

  // "Kan vi flytte møtet til kl 11?", "Ta det kl 10 du", "Jeg rekker ikke kl 10. Kl 12 da?": no day is named
  // at all, so the new clock is on the booked day. Never a cancel; booked like any new time.
  if (bookedFuture && asksNewClock && !callCue && !excludedDays.length && !day && !namesAnyDay(fresh)) {
    const clock = askedClockWithoutDay(lined, booked);
    if (clock?.unclear) return out('unclear', 'none', { ...base, reason: 'time-unclear' });
    if (clock) {
      const at = osloWallToIso(bookedYmd, clock.hour, clock.minute || 0, 0);
      if (at && osloClockOf(at) === osloClockOf(booked)) {
        // "Kan vi flytte møtet til kl 10?" when it already is at 10: unclear what they mean.
        if (moveCue || cancelling) return out('unclear', 'none', { ...base, reason: 'time-unclear' });
      } else if (!at || Date.parse(at) <= nowMs) {
        // A clock earlier today than now, on the meeting day: the meeting still stands, a person answers.
        return out('unclear', 'none', { ...base, reason: 'time-unavailable' });
      } else {
        return out('reschedule', 'sales_book', { ...base, dueAt: at, day: { ymd: bookedYmd, band: 'day' }, cancel: true });
      }
    }
  }

  // "Jeg kan ikke komme, men torsdag går fint": a no and a yes to the same meeting. Never void it on that.
  if (mixedYes && (!day || day.ymd === bookedYmd)) {
    return out('unclear', 'none', { ...base, reason: 'booked-day-unclear', bookedNamed: true });
  }

  if (cancelling || moveCue) {
    if (day?.ymd && day.ymd !== bookedYmd) {
      return out('reschedule_day', 'sales_propose', { ...base, cancel: cancelHitsBooked || bookedFuture });
    }
    if (callCue) return out('call', 'sales_call', { ...base, cancel: cancelHitsBooked });
    if (notNow) return out('not_now', 'sales_call', { ...base, unsure: true, cancel: cancelHitsBooked });
    return out('cancel', 'sales_cancel', { ...base, day: null, cancel: cancelHitsBooked, bookedNamed });
  }

  // "Ring meg i morgen" / "vet ikke ennå, kanskje neste uke" name a day for a follow-up, not a meeting.
  if (day?.ymd && !callCue && !notNow) {
    if (bookedNamed) {
      if (difficulty && bookedOk) return out('unclear', 'none', { ...base, reason: 'booked-day-unclear', bookedNamed: true });
      if (question) return out('question', 'gather', { bookedNamed: true });
      if (bookedOk) return out('confirm', 'none', { echo: true, bookedNamed: true });
      return out('unclear', 'none', { ...base, reason: 'booked-day-unclear', bookedNamed: true });
    }
    // An offered day counts only when it is named as a yes ("fredag passer"), never "fredag er fullt",
    // and never "neste uke passer" (a week is not its Monday).
    const positive = !difficulty && (bookedOk || schedCue || (justATime && !question));
    const onDay = day.week ? [] : offered.filter((iso) => ymdOf(iso) === day.ymd);
    // "Onsdag passer, men helst etter lunsj" never books the 09:00 we offered: offer that day's afternoon instead.
    const sameDayOffers = onDay.filter((iso) => fitsBand(iso, day));
    if (sameDayOffers.length === 1 && positive) {
      return out('reschedule', 'sales_book', { ...base, dueAt: sameDayOffers[0], cancel: bookedFuture });
    }
    if (sameDayOffers.length > 1 && positive) return out('reschedule_day', 'sales_propose', { ...base, cancel: false });
    if (onDay.length && positive) return out('reschedule_day', 'sales_propose', { ...base, cancel: false });
    // "uke 48", "Passer uke 48?", "Kan vi ta uke 48?": a week, so the writer offers times in it.
    if (day.week && detail.weekNumber && !difficulty) {
      const asksWeek = schedCue || PREFER_RE.test(fresh);
      const weekEnd = addDaysYmd(day.ymd, (7 - osloWeekdayOfYmd(day.ymd)) % 7);
      // The named week holds the booked meeting: never a void; a yes or a question is about that meeting.
      if (bookedFuture && bookedYmd >= day.ymd && bookedYmd <= weekEnd && (asksWeek || bookedOk || question || justATime)) {
        if (question) return out('question', 'gather', { bookedNamed: true });
        if (bookedOk && !PREFER_RE.test(fresh)) return out('confirm', 'none', { echo: true, bookedNamed: true });
        return out('unclear', 'none', { ...base, reason: 'booked-day-unclear', bookedNamed: true });
      }
      // "uke 48" alone, or a week asked for; an unrelated week mention ("Hva gjør dere i uke 48?") is not a request.
      const bareWeek = justATime && WEEK_ONLY_RE.test(timeCore);
      if (asksWeek || (!question && (bookedOk || bareWeek))) {
        return out('reschedule_day', 'sales_propose', { ...base, cancel: bookedFuture });
      }
      if (question) return out('question', 'gather');
    }
    if (difficulty || confirmCue) {
      return out('unclear', 'none', { ...base, reason: bookedFuture ? 'day-differs-from-booked' : 'day-without-meeting' });
    }
    if (PREFER_RE.test(fresh) || ((schedCue || justATime) && !bookedFuture)) {
      return out('reschedule_day', 'sales_propose', { ...base, cancel: bookedFuture });
    }
    if (schedCue || justATime) return out('unclear', 'none', { ...base, reason: 'day-differs-from-booked' });
  }

  if (confirmCue && !question) {
    // "Ja takk" to an offer with nothing booked: which time? A person asks.
    if (!bookedFuture && offered.length) return out('unclear', 'none', { reason: 'yes-to-offer' });
    return out('confirm', 'none', { echo: true });
  }
  if (callCue) return out('call', 'sales_call', { ...base });
  if (notNow) return out('not_now', 'sales_call', { ...base, unsure: true, cancel: laterCue && bookedFuture });
  if (contract) return out('contract', 'none', { reason: 'question:contract' });
  if (question) return out('question', 'gather');
  if (FACT_RE.test(fresh) || (core.length > 60 && !ABOUT_MEETING_RE.test(fresh))) return out('info', 'gather');
  return out('other', 'none', { reason: 'unclear' });
}
