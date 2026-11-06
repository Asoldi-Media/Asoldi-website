import test from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeCallFollowup,
  looksLikeMeetingMove,
  looksLikeWorkshopScheduling,
  looksUnsureForNow,
  parseClockTime,
  parseDayHint,
  parseExcludedDays,
  parseTimeBand,
  parseTimeDetail,
  parseWorkshopTimeHeuristic,
  resolveInboxWorkshopDueAt,
} from '../lib/workshop-time-parse.js';

// Wednesday 4 Nov 2026 09:00 Oslo (CET). "i morgen" = Thursday 5 Nov.
const WED = new Date('2026-11-04T08:00:00.000Z');
// Friday 30 Oct 2026 10:00 Oslo.
const FRI = new Date('2026-10-30T09:00:00.000Z');

/** Oslo wall time → ISO (CET = UTC+1 for every November/early-December date used here). */
const cet = (ymd, hh, mm = 0) => new Date(`${ymd}T${String(hh - 1).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`).toISOString();
const due = (text, now = WED) => parseWorkshopTimeHeuristic(text, { now })?.dueAt || '';

test('an explicit date wins over the weekday and the day of month is never the hour', () => {
  assert.equal(due('torsdag 12. november kl 14', FRI), cet('2026-11-12', 14));
  assert.equal(due('12. november kl 14', FRI), cet('2026-11-12', 14));
  assert.equal(due('12.11 kl 14', FRI), cet('2026-11-12', 14));
  assert.equal(due('12/11 kl 14:30', FRI), cet('2026-11-12', 14, 30));
  assert.equal(due('12. nov. kl. 10.30', FRI), cet('2026-11-12', 10, 30));
  assert.equal(due('Kan vi ta det fredag 6. november kl 13 i stedet?'), cet('2026-11-06', 13));
  assert.equal(due('Passer det fredag 13. november kl 10?'), cet('2026-11-13', 10));
  assert.equal(due('mandag 16. november kl 10'), cet('2026-11-16', 10));
  assert.equal(due('torsdag 5. nov kl 10'), cet('2026-11-05', 10));
  assert.equal(due('torsdag den 12. kl 14'), cet('2026-11-12', 14));
  assert.equal(due('Ja, torsdag 12. november kl 10 passer'), cet('2026-11-12', 10));
});

test('a weekday that contradicts the date gives null so the bot asks', () => {
  assert.equal(parseWorkshopTimeHeuristic('Kan vi ta det fredag 9. november kl 13?', { now: WED }), null);
  assert.equal(parseWorkshopTimeHeuristic('torsdag 13. november kl 14', { now: FRI }), null);
  const detail = parseTimeDetail('fredag 9. november kl 13', { now: WED });
  assert.equal(detail.conflict, true);
  assert.equal(detail.day, null);
  assert.equal(parseDayHint('fredag 9. november', { now: WED }), null);
});

test('a day number with no clock word is not an hour', () => {
  assert.equal(parseWorkshopTimeHeuristic('Kan vi ta fredag 13?', { now: WED }), null);
  assert.equal(parseWorkshopTimeHeuristic('fredag 6. november passer', { now: WED }), null);
  assert.deepEqual(parseDayHint('fredag 6. november passer', { now: WED }), { ymd: '2026-11-06', band: 'day' });
  assert.equal(parseWorkshopTimeHeuristic('Torsdag, fra 10 til 12 er jeg opptatt, men 13 går', { now: WED }), null);
});

test('HH.MM after kl (or alone as a clock) is never day.month', () => {
  assert.equal(due('Fredag kl 14.30 passer bedre'), cet('2026-11-06', 14, 30));
  assert.equal(due('fredag kl. 14.30'), cet('2026-11-06', 14, 30));
  assert.equal(due('Kan vi ta fredag 14:30?'), cet('2026-11-06', 14, 30));
  assert.equal(due('fredag kl 9'), cet('2026-11-06', 9));
  assert.equal(due('fredag 10.30'), cet('2026-11-06', 10, 30));
  // Clock only, no day: nothing is booked, and nothing becomes 14 March 00:00.
  assert.equal(parseWorkshopTimeHeuristic('kl 14.30', { now: WED }), null);
  assert.equal(parseWorkshopTimeHeuristic('kl. 14.30', { now: WED }), null);
  assert.deepEqual(parseClockTime('kl 14.30'), { hour: 14, minute: 30 });
  assert.deepEqual(parseClockTime('kl. 14.30'), { hour: 14, minute: 30 });
  assert.deepEqual(parseClockTime('14:30'), { hour: 14, minute: 30 });
  assert.deepEqual(parseClockTime('kl 9'), { hour: 9, minute: 0 });
  // February: the old parser booked Sunday 14 March 00:00 from this.
  const feb = new Date('2027-02-10T09:00:00.000Z');
  assert.equal(due('Fredag kl 14.30 passer bedre', feb), '2027-02-12T13:30:00.000Z');
  assert.equal(due('kl 9.30 på fredag', feb), '2027-02-12T08:30:00.000Z');
});

test('"mellom 13.30 og 15" and "fra kl 10 til 12" start at the first clock', () => {
  assert.equal(due('fredag mellom 13.30 og 15'), cet('2026-11-06', 13, 30));
  assert.equal(due('fredag fra kl 10 til 12'), cet('2026-11-06', 10));
  assert.equal(due('fredag mellom 13 og 15'), cet('2026-11-06', 13));
});

test('halv, kvart over and kvart på read inside business hours', () => {
  assert.equal(due('Fredag halv tre?'), cet('2026-11-06', 14, 30));
  assert.equal(due('fredag halv ti'), cet('2026-11-06', 9, 30));
  assert.equal(due('fredag kvart over ti'), cet('2026-11-06', 10, 15));
  assert.equal(due('fredag kvart på to'), cet('2026-11-06', 13, 45));
  assert.equal(due('fredag klokka halv tre'), cet('2026-11-06', 14, 30));
  assert.equal(due('halv åtte på fredag'), cet('2026-11-06', 7, 30));
  assert.equal(due('fredag fem over halv ti'), cet('2026-11-06', 9, 35));
  assert.equal(due('fredag klokka ti'), cet('2026-11-06', 10));
  assert.deepEqual(parseClockTime('halv tre'), { hour: 14, minute: 30 });
});

test('bands: formiddag is morning, ettermiddag/etter lunsj afternoon, "i morgen" is not morning', () => {
  assert.deepEqual(parseDayHint('Fredag formiddag passer', { now: WED }), { ymd: '2026-11-06', band: 'morning' });
  assert.deepEqual(parseDayHint('Fredag etter lunsj?', { now: WED }), { ymd: '2026-11-06', band: 'afternoon' });
  assert.deepEqual(parseDayHint('Kan ikke i morgen, men fredag ettermiddag går fint', { now: WED }), { ymd: '2026-11-06', band: 'afternoon' });
  assert.deepEqual(parseDayHint('Kan ikke i morgen, men tirsdag ettermiddag passer', { now: WED }), { ymd: '2026-11-10', band: 'afternoon' });
  assert.deepEqual(parseDayHint('Ok, sees i morgen!', { now: WED }), { ymd: '2026-11-05', band: 'day' });
  assert.deepEqual(parseDayHint('i morgen tidlig', { now: WED }), { ymd: '2026-11-05', band: 'morning' });
  assert.deepEqual(parseDayHint('onsdag morgen', { now: WED }), { ymd: '2026-11-11', band: 'morning' });
  assert.deepEqual(parseDayHint('God morgen! Fredag passer', { now: WED }), { ymd: '2026-11-06', band: 'day' });
  assert.deepEqual(parseTimeBand('i morgen'), { band: 'day' });
  assert.deepEqual(parseTimeBand('før lunsj'), { band: 'morning' });
});

test('"etter kl 12" / "etter 12" is afternoon with an earliest hour, never a 12:00 booking', () => {
  assert.deepEqual(parseDayHint('Hvem er dere? Ring meg gjerne i morgen etter kl 12', { now: WED }), {
    ymd: '2026-11-05', band: 'afternoon', afterHour: 12,
  });
  assert.deepEqual(parseDayHint('fredag etter 12', { now: WED }), { ymd: '2026-11-06', band: 'afternoon', afterHour: 12 });
  assert.equal(parseWorkshopTimeHeuristic('fredag etter kl 12', { now: WED }), null);
  assert.deepEqual(parseTimeBand('etter kl 12'), { band: 'afternoon', afterHour: 12 });
  assert.deepEqual(parseTimeBand('etter kl 10'), { band: 'day', afterHour: 10 });
  assert.deepEqual(parseTimeBand('før kl 11'), { band: 'morning', beforeHour: 11 });
  assert.equal(parseClockTime('etter kl 12'), null);
});

test('relative days with a clock: i dag, i morgen, i overmorgen, neste uke tirsdag', () => {
  assert.equal(due('i dag kl 14'), cet('2026-11-04', 14));
  assert.equal(due('i morgen kl 10'), cet('2026-11-05', 10));
  assert.equal(due('Kan vi ta i morgen kl 14 i stedet?'), cet('2026-11-05', 14));
  assert.equal(due('imorgen kl 10'), cet('2026-11-05', 10));
  assert.equal(due('i overmorgen kl 9'), cet('2026-11-06', 9));
  assert.equal(due('neste uke tirsdag kl 13'), cet('2026-11-10', 13));
  assert.equal(due('Kan vi ta det på mandag kl 9 neste uke?'), cet('2026-11-09', 9));
  assert.equal(due('tirsdag neste uke kl 13', FRI), cet('2026-11-03', 13));
  assert.equal(due('Hei, Kan vi flytte møtet til onsdag neste uke istedet? Gjerne kl. 15. Med vennlig hilsen Ali'), cet('2026-11-11', 15));
  // "takk for i dag" is small talk, not a day.
  assert.equal(due('Takk for i dag, fredag kl 10 passer'), cet('2026-11-06', 10));
});

test('weekends never come from a relative phrase without a weekday', () => {
  // Friday: "i morgen" is Saturday, "i overmorgen" Sunday.
  assert.equal(parseWorkshopTimeHeuristic('i morgen kl 10', { now: FRI }), null);
  assert.equal(parseWorkshopTimeHeuristic('i overmorgen kl 9', { now: FRI }), null);
  assert.deepEqual(parseDayHint('i morgen', { now: FRI }), { ymd: '2026-11-02', band: 'day' });
  assert.deepEqual(parseDayHint('om 3 dager', { now: WED }), { ymd: '2026-11-09', band: 'day' });
  // A named weekend day is the client's own choice and is kept as a day.
  assert.deepEqual(parseDayHint('lørdag passer', { now: WED }), { ymd: '2026-11-07', band: 'day' });
});

test('hours outside 07:00-19:00 are not a meeting time; the next good candidate is used', () => {
  assert.equal(parseWorkshopTimeHeuristic('fredag kl 20', { now: WED }), null);
  assert.equal(parseWorkshopTimeHeuristic('fredag kl 02:00', { now: WED }), null);
  assert.equal(parseWorkshopTimeHeuristic('fredag 06:30', { now: WED }), null);
  assert.equal(due('fredag kl 19'), cet('2026-11-06', 19));
  assert.equal(parseWorkshopTimeHeuristic('fredag 19:30', { now: WED }), null);
  assert.equal(due('fredag kl 2'), cet('2026-11-06', 14));
  assert.equal(due('fredag kl 22 eller kl 14'), cet('2026-11-06', 14));
  assert.equal(due('fredag kl 10 eller kl 14'), cet('2026-11-06', 10));
});

test('negated days: the positive day wins, the cancelled day is exposed separately', () => {
  assert.equal(due('Fredag er ikke aktuelt, men mandag kl 12 passer'), cet('2026-11-09', 12));
  assert.deepEqual(parseExcludedDays('Fredag er ikke aktuelt, men mandag kl 12 passer', { now: WED }), ['2026-11-06']);
  assert.deepEqual(parseDayHint('kan ikke tirsdag, men onsdag går', { now: WED }), { ymd: '2026-11-11', band: 'day' });
  assert.deepEqual(parseExcludedDays('kan ikke tirsdag, men onsdag går', { now: WED }), ['2026-11-10']);
  assert.equal(parseDayHint('kan ikke torsdag', { now: WED }), null);
  assert.deepEqual(parseExcludedDays('kan ikke torsdag', { now: WED }), ['2026-11-05']);
  assert.equal(due('Jeg kan ikke torsdag kl 10. Fredag kl 13 passer.'), cet('2026-11-06', 13));
  assert.equal(due('Jeg kan ikke da, mandag kl 10 passer'), cet('2026-11-09', 10));
  assert.deepEqual(parseExcludedDays('kan ikke neste uke', { now: WED }), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13']);
  assert.deepEqual(parseExcludedDays('Fredag passer fint', { now: WED }), []);
  assert.deepEqual(parseExcludedDays('Kan ikke mandag, men neste uke går fint', { now: WED }), ['2026-11-09']);
});

test('cancellations that name the booked time give no positive time and exclude that day', () => {
  const cases = [
    'Kan ikke i morgen',
    'Jeg kan ikke møte på torsdag, beklager',
    'Kan dessverre ikke komme i morgen.',
    'Jeg kan ikke torsdag kl 10, beklager',
    'Får ikke til møtet torsdag kl 10, kan vi ta det en annen gang?',
    'Kan dessverre ikke delta på møtet torsdag kl. 10:00',
    'Rekker ikke møtet i morgen, har fått en jobb inn.',
    'Beklager, men jeg må avlyse møtet i morgen.',
    "Something came up, I can't make the meeting tomorrow.",
  ];
  for (const text of cases) {
    assert.equal(parseWorkshopTimeHeuristic(text, { now: WED }), null, text);
    assert.equal(parseDayHint(text, { now: WED }), null, text);
    assert.deepEqual(parseExcludedDays(text, { now: WED }), ['2026-11-05'], text);
  }
  assert.equal(parseWorkshopTimeHeuristic('Får ikke til møtet, kan vi ta det en annen gang?', { now: WED }), null);
  assert.deepEqual(parseExcludedDays('Får ikke til møtet, kan vi ta det en annen gang?', { now: WED }), []);
});

test('"kan ikke kl 10, men kl 14" keeps the clock; a day named with the rejected clock anchors it', () => {
  assert.equal(parseWorkshopTimeHeuristic('Jeg kan ikke kl 10, men kl 14 samme dag går', { now: WED }), null);
  assert.deepEqual(parseClockTime('Jeg kan ikke kl 10, men kl 14 samme dag går'), { hour: 14, minute: 0 });
  assert.equal(due('Torsdag kl 10 passer ikke, men kl 14 går'), cet('2026-11-05', 14));
  assert.deepEqual(parseExcludedDays('Torsdag kl 10 passer ikke, men kl 14 går', { now: WED }), []);
  assert.equal(due('Kan vi ta torsdag kl 14 i stedet for kl 10?'), cet('2026-11-05', 14));
  assert.equal(due('Kan vi flytte møtet fra torsdag til fredag kl 13?'), cet('2026-11-06', 13));
  assert.equal(due('flytte fra kl 10 til kl 14 på torsdag'), cet('2026-11-05', 14));
});

test('suggestions that only look negative still book', () => {
  assert.equal(due('Kan vi ikke heller ta fredag kl 13?'), cet('2026-11-06', 13));
  assert.equal(due('Passer det ikke bedre med fredag kl 13?'), cet('2026-11-06', 13));
});

test('English: Friday at 1pm, tomorrow at 10, Monday 2 pm, next Tuesday at 13:00', () => {
  assert.equal(due('Can we move it to Friday at 1pm?'), cet('2026-11-06', 13));
  assert.equal(due('Friday at 1pm'), cet('2026-11-06', 13));
  assert.equal(due('tomorrow at 10'), cet('2026-11-05', 10));
  assert.equal(due('Monday 2 pm'), cet('2026-11-09', 14));
  assert.equal(due('next Tuesday at 13:00'), cet('2026-11-10', 13));
  assert.equal(due("I can't do Friday, but Monday at 10 works"), cet('2026-11-09', 10));
  assert.deepEqual(parseExcludedDays("I can't do Friday, but Monday at 10 works", { now: WED }), ['2026-11-06']);
});

test('quoted lines, opening hours and a time in another sentence without a clock word are ignored', () => {
  assert.equal(parseWorkshopTimeHeuristic('> Påminnelse: møte torsdag 12. nov kl 10:00\n\nKan ikke, beklager', { now: WED }), null);
  assert.equal(parseDayHint('> Påminnelse: møte torsdag 12. nov kl 10:00\n\nKan ikke, beklager', { now: WED }), null);
  assert.equal(parseWorkshopTimeHeuristic('Torsdag passer. Vi har åpent man-fre 10:00-18:00.', { now: WED }), null);
  assert.equal(parseWorkshopTimeHeuristic('Torsdag passer. Vi er 4 stk, 10:00 er fint for meg', { now: WED }), null);
});

test('decimals, prices, versions and deadlines are not meeting days or times', () => {
  const noise = [
    'Vi har 3.5 ansatte og omsetning på 2.3 mill',
    'Versjon 2.10 av appen funker ikke',
    'Hei! Prisen er kr 1.500 per måned. Tlf 92 80 78 81. Storgata 12, 0155 Oslo',
    'Hei, vi er åpne 24/7 og har 15 års erfaring',
  ];
  for (const text of noise) {
    const detail = parseTimeDetail(text, { now: WED });
    assert.equal(detail.dueAt, '', text);
    assert.equal(detail.day, null, text);
    assert.deepEqual(detail.excludedDays, [], text);
  }
  assert.equal(parseWorkshopTimeHeuristic('Send gjerne tilbudet innen fredag kl 12', { now: WED }), null);
  assert.equal(parseDayHint('Send gjerne tilbudet innen fredag', { now: WED }), null);
  // A numeric date still counts with a date word or the "12.11." form.
  assert.deepEqual(parseDayHint('Passer det den 12.11?', { now: WED }), { ymd: '2026-11-12', band: 'day' });
  assert.deepEqual(parseDayHint('Vi kan ta det 12.11. om du vil', { now: WED }), { ymd: '2026-11-12', band: 'day' });
});

test('iterates every candidate instead of giving up on the first bad one', () => {
  // Old parser: first number after the weekday was "5" → hour 5 → rejected → null.
  assert.equal(due('torsdag 5. nov kl 10'), cet('2026-11-05', 10));
  // First clock has no usable day (yesterday), the next one does.
  assert.equal(due('I går kl 10 var travelt. Fredag kl 13 passer.'), cet('2026-11-06', 13));
});

test('ISO and full numeric dates; a past numeric date stays in the past for the caller to drop', () => {
  assert.equal(due('2026-11-12 10:00'), cet('2026-11-12', 10));
  assert.equal(due('When: mandag 19. oktober 2026 15:00 – 16:00\nJoin with Google Meet'), '2026-10-19T13:00:00.000Z');
  assert.equal(due('12.11.2026 kl 14', FRI), cet('2026-11-12', 14));
  assert.equal(due('Kan vi ta det 2.10 kl 14?', new Date('2026-10-15T12:00:00.000Z')), '2026-10-02T12:00:00.000Z');
  // A yearless date far behind today means next year.
  assert.equal(due('5. januar kl 10', new Date('2026-12-10T09:00:00.000Z')), '2027-01-05T09:00:00.000Z');
});

test('DST: the same wall clock maps to the right UTC on both sides of the October change', () => {
  const now = new Date('2026-10-20T09:00:00.000Z');
  assert.equal(due('fredag 23. oktober kl 10', now), '2026-10-23T08:00:00.000Z');
  assert.equal(due('mandag 26. oktober kl 10', now), '2026-10-26T09:00:00.000Z');
  assert.equal(due('mandag kl 10', new Date('2026-10-22T09:00:00.000Z')), '2026-10-26T09:00:00.000Z');
  assert.equal(due('mandag 30. mars 2026 kl 10', now), '2026-03-30T08:00:00.000Z');
});

test('existing shapes: confidence, day hint fields, resolveInboxWorkshopDueAt', () => {
  const parsed = parseWorkshopTimeHeuristic('Kan vi ta workshopen tirsdag kl 10?', { now: new Date('2026-10-07T10:00:00.000Z') });
  assert.deepEqual(Object.keys(parsed).sort(), ['confidence', 'dueAt']);
  assert.equal(parsed.dueAt, '2026-10-13T08:00:00.000Z');
  assert.ok(parsed.confidence > 0.5 && parsed.confidence <= 1);
  assert.deepEqual(parseDayHint('onsdag passer bra', { now: new Date('2026-10-10T12:00:00.000Z') }), { ymd: '2026-10-14', band: 'day' });
  assert.deepEqual(parseDayHint('ring meg om 3 dager og sjekk opp', { now: new Date('2026-10-10T12:00:00.000Z') }), { ymd: '2026-10-13', band: 'day' });
  assert.equal(parseWorkshopTimeHeuristic('kanskje neste uke', { now: WED }), null);
  assert.equal(parseWorkshopTimeHeuristic('', { now: WED }), null);
  assert.equal(parseDayHint('', { now: WED }), null);
  assert.deepEqual(parseExcludedDays('', { now: WED }), []);
  assert.equal(resolveInboxWorkshopDueAt('Hei, takk for tilbudet', '2026-10-13T08:00:00.000Z'), '');
  assert.equal(resolveInboxWorkshopDueAt('Fredag kl 13 passer', '', { now: WED }), cet('2026-11-06', 13));
  assert.equal(resolveInboxWorkshopDueAt('Passer det med møtetid?', '2026-11-06T12:00:00.000Z', { now: WED }), '2026-11-06T12:00:00.000Z');
  const detail = parseTimeDetail('Kan ikke torsdag, men fredag kl 13', { now: WED });
  assert.deepEqual(detail, {
    dueAt: cet('2026-11-06', 13),
    confidence: 0.85,
    day: { ymd: '2026-11-06', band: 'day' },
    clock: { hour: 13, minute: 0 },
    excludedDays: ['2026-11-05'],
    conflict: false,
    weekOnly: false,
  });
});

// Monday 3 Mar 2031 09:15 Oslo (CET): the review's reproduction clock.
const MON31 = new Date('2031-03-03T08:15:00.000Z');

test('review: a weekday, a bare day of month and a clock book that date ("onsdag 12 kl 9"); a wrong pair gives null', () => {
  assert.equal(due('Hei! Kan vi heller ta onsdag 12 kl 9?', MON31), '2031-03-12T08:00:00.000Z');
  assert.equal(due('Hei, kan vi ta tirsdag 18 kl 10 i stedet?', MON31), '2031-03-18T09:00:00.000Z');
  assert.equal(due('Kan vi ta fredag 14 kl 13 i stedet?', MON31), '2031-03-14T12:00:00.000Z');
  assert.equal(parseWorkshopTimeHeuristic('Kan vi ta onsdag 13 kl 9?', { now: MON31 }), null);
  assert.equal(parseTimeDetail('Kan vi ta onsdag 13 kl 9?', { now: MON31 }).conflict, true);
  // November 2026: the 11th and 18th are Wednesdays, the 12th is a Thursday.
  assert.equal(due('onsdag 11 kl 9'), cet('2026-11-11', 9));
  assert.equal(due('onsdag 18 klokka ti'), cet('2026-11-18', 10));
  assert.equal(due('onsdag 18 13:30'), cet('2026-11-18', 13, 30));
  assert.equal(due('Wednesday 18 at 9'), cet('2026-11-18', 9));
  assert.equal(parseWorkshopTimeHeuristic('onsdag 12 kl 9', { now: WED }), null);
  // Still no hour or date from a bare number without a clock word.
  assert.equal(parseWorkshopTimeHeuristic('Kan vi ta fredag 13?', { now: WED }), null);
});

test('review: "DD.MM HH.MM" is a date and a clock again, "N-tiden" is an hour, "samme dag" keeps the named day', () => {
  assert.equal(due('Kan vi ta 12.03 13.30?', MON31), '2031-03-12T12:30:00.000Z');
  assert.equal(due('Passer 07.03 14.00?', MON31), '2031-03-07T13:00:00.000Z');
  assert.equal(due('12.03 14.00 i stedet?', MON31), '2031-03-12T13:00:00.000Z');
  assert.equal(due('07.03 13.30 passer', MON31), '2031-03-07T12:30:00.000Z');
  assert.equal(due('Kan vi flytte til 12.03. 13.30?', MON31), '2031-03-12T12:30:00.000Z');
  assert.equal(due('12.11 13.20'), cet('2026-11-12', 13, 20));
  assert.equal(due('fredag 07.03 14.00', MON31), '2031-03-07T13:00:00.000Z');
  assert.equal(parseWorkshopTimeHeuristic('torsdag 07.03 14.00', { now: MON31 }), null);
  assert.equal(parseTimeDetail('10.30 11.30', { now: WED }).day, null);
  assert.equal(due('kan vi flytte møtet til tirsdag ved 13-tiden?', MON31), '2031-03-04T12:00:00.000Z');
  assert.equal(due('i morgen ved 10-tiden'), cet('2026-11-05', 10));
  assert.equal(due('tirsdag i ti-tiden'), cet('2026-11-10', 10));
  assert.equal(due('Torsdag kl 10 passer dårlig. Kan vi ta kl 14 samme dag?'), cet('2026-11-05', 14));
  assert.deepEqual(parseExcludedDays('Torsdag kl 10 passer dårlig. Kan vi ta kl 14 samme dag?', { now: WED }), []);
  // Bare hours without a clock word stay unread (the spec): the bot offers times instead.
  for (const text of ['fredag 10', 'tirsdag rundt 13', 'fredag ca 12', 'tirsdag 14 eller 15', 'Ja fredag 9 er fint']) {
    assert.equal(parseWorkshopTimeHeuristic(text, { now: WED }), null, text);
  }
});

test('review: "er fullt", "går ikke", "funker ikke", "blir vanskelig" make that day negative', () => {
  const thursday = [
    'Torsdag er fullt',
    'Torsdag er helt fullt',
    'Torsdag er det fullt hos oss',
    'Torsdag er dessverre helt fullbooket',
    'torsdag er opptatt',
    'Torsdag er helt opptatt hos meg',
    'Torsdag går ikke',
    'torsdag funker ikke',
    'Torsdag blir vanskelig',
    'torsdag blir litt vanskelig',
    'Torsdag er vanskelig',
    'Torsdag, det går ikke',
    'Torsdag kl 10, det passer ikke for meg',
  ];
  for (const text of thursday) {
    assert.deepEqual(parseExcludedDays(text, { now: WED }), ['2026-11-05'], text);
    assert.equal(parseDayHint(text, { now: WED }), null, text);
  }
  assert.deepEqual(parseExcludedDays('Fredag er uaktuelt', { now: WED }), ['2026-11-06']);
  assert.equal(due('Torsdag er fullt, men fredag kl 13 passer'), cet('2026-11-06', 13));
  assert.deepEqual(parseExcludedDays('Torsdag er fullt, men fredag kl 13 passer', { now: WED }), ['2026-11-05']);
  assert.equal(due('Torsdag blir vanskelig. Fredag kl 13?'), cet('2026-11-06', 13));
  assert.equal(due('Torsdag kl 10, det går ikke. Fredag kl 13?'), cet('2026-11-06', 13));
  assert.equal(due("Thursday is fully booked, Friday at 1pm works"), cet('2026-11-06', 13));
  // Not a "no": "fullt mulig", "fullt forståelig", and a contrast before the negative clause.
  assert.equal(due('fredag er fullt mulig kl 13'), cet('2026-11-06', 13));
  assert.equal(due('Det er fullt forståelig. Fredag kl 13?'), cet('2026-11-06', 13));
  assert.deepEqual(parseExcludedDays('Torsdag, men fredag går ikke', { now: WED }), ['2026-11-06']);
  assert.deepEqual(parseDayHint('Torsdag, det passer fint', { now: WED }), { ymd: '2026-11-05', band: 'day' });
});

test('"neste uke" alone stays the Monday of next week, flagged weekOnly so it never matches an offered Monday', () => {
  assert.deepEqual(parseDayHint('neste uke passer', { now: WED }), { ymd: '2026-11-09', band: 'day' });
  assert.equal(parseTimeDetail('neste uke passer', { now: WED }).weekOnly, true);
  assert.equal(parseTimeDetail('mandag passer', { now: WED }).weekOnly, false);
  assert.equal(parseTimeDetail('neste uke tirsdag', { now: WED }).weekOnly, false);
  assert.equal(parseTimeDetail('Hei', { now: WED }).weekOnly, false);
});

test('Unicode word edges: "akkurat nå" and "travelt nå" now match', () => {
  assert.equal(/\btravelt nå\b/.test('travelt nå'), false, 'JS \\b is ASCII-only (the reason for the fix)');
  assert.equal(looksUnsureForNow('Ikke interessert akkurat nå'), true);
  assert.equal(looksUnsureForNow('Det er travelt nå.'), true);
  assert.equal(looksUnsureForNow('travelt nå'), true);
  assert.equal(looksUnsureForNow('Hva koster det?'), false);
  assert.equal(looksLikeCallFollowup('ring meg onsdag morgen'), true);
  assert.equal(looksLikeWorkshopScheduling('Passer lørdag?'), true);
  assert.equal(looksLikeWorkshopScheduling('Hei, takk for tilbudet'), false);
  assert.equal(looksLikeMeetingMove('Jeg må flytte møtet'), true);
  // Weekday names with å/ø neighbours still match.
  assert.deepEqual(parseDayHint('På fredag går det fint', { now: WED }), { ymd: '2026-11-06', band: 'day' });
});
