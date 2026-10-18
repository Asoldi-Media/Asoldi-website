/** Telegenta 20 Jul – 16 Oct 2026. SSU lists excluded. Hour cells are estimated. */

export const CALL_TIMES_HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15];

export const CALL_TIMES_DAY_COLORS = ['#f87171', '#7dd3fc', '#94a3b8', '#34d399', '#c4b5fd'];

/** @typedef {[string, number, number, number, number, number, number]} DayRow */
/** @typedef {[number, number, number, number]} Cell */

function foldIdentity(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/**
 * Map the logged-in staffer to their own numbers. Never used as a picker of other people.
 * @param {{ name?: string, username?: string, fromEmail?: string } | null} identity
 * @returns {'bard' | 'bhrat' | null}
 */
export function matchCallTimesIndividual(identity) {
  const hay = foldIdentity(`${identity?.name || ''} ${identity?.username || ''} ${identity?.fromEmail || ''}`);
  if (/\bbhrat\b|\bgupta\b/.test(hay)) return 'bhrat';
  if (/\bba+rd\b|\bfransson\b|\bkvalheim\b/.test(hay)) return 'bard';
  return null;
}

export const CALL_TIMES_VIEWS = {
  all: {
    id: 'all',
    avg: 1.07,
    calls: 7199,
    wins: 77,
    hours: 97.3,
    avgSec: 49,
    dates: 55,
    headline: 'Call Thursday and Tuesday, 09:00–14:00.',
    blurb: 'Meetings per 100 calls, not total meetings. Thursday is clearly best. Tuesday is next. Monday is the worst. Put the phone time between 09:00 and 14:00.',
    days: [
      ['Monday', 11, 1100, 15.7, 3, 0.27, 0.34],
      ['Tuesday', 11, 1562, 19.6, 14, 0.9, 1.19],
      ['Wednesday', 12, 1876, 25.7, 17, 0.91, 0.76],
      ['Thursday', 12, 1876, 25.4, 32, 1.71, 1.87],
      ['Friday', 9, 785, 10.8, 11, 1.4, 0.92],
    ],
    grid: [
      { day: 'Mon', cells: [[0, 224, 0, 0], [0, 224, 0, 0], [1, 224, 0.45, 0.64], [2, 224, 0.89, 1.28], [0, 41, 0, 0], [0, 41, 0, 0], [0, 41, 0, 0], [0, 41, 0, 0], [0, 41, 0, 0]] },
      { day: 'Tue', cells: [[0, 327, 0, 0], [6, 327, 1.84, 2.73], [3, 327, 0.92, 1.37], [2, 327, 0.61, 0.91], [0, 51, 0, 0], [2, 51, 3.92, 2.46], [0, 51, 0, 0], [0, 51, 0, 0], [1, 51, 1.96, 1.23]] },
      { day: 'Wed', cells: [[4, 336, 1.19, 1.41], [0, 336, 0, 0], [3, 336, 0.89, 1.05], [3, 336, 0.89, 1.05], [2, 106, 1.88, 1.18], [2, 106, 1.88, 1.18], [1, 106, 0.94, 0.59], [1, 106, 0.94, 0.59], [1, 106, 0.94, 0.59]] },
      { day: 'Thu', cells: [[0, 347, 0, 0], [1, 347, 0.29, 0.36], [8, 347, 2.31, 2.85], [7, 347, 2.02, 2.49], [7, 98, 7.17, 4.5], [3, 98, 3.07, 1.93], [5, 98, 5.12, 3.22], [0, 98, 0, 0], [1, 98, 1.02, 0.64]] },
      { day: 'Fri', cells: [[0, 109, 0, 0], [0, 109, 0, 0], [0, 109, 0, 0], [2, 109, 1.84, 1.53], [2, 70, 2.85, 1.79], [4, 70, 5.71, 3.59], [1, 70, 1.43, 0.9], [2, 70, 2.85, 1.79], [0, 70, 0, 0]] },
      { day: 'All days', cells: [[4, 1343, 0.3, 0.37], [7, 1343, 0.52, 0.65], [15, 1343, 1.12, 1.4], [16, 1343, 1.19, 1.49], [11, 366, 3.01, 1.89], [11, 366, 3.01, 1.89], [7, 366, 1.91, 1.2], [3, 366, 0.82, 0.52], [3, 366, 0.82, 0.52]] },
    ],
    showAdjusted: true,
    advice: [
      'Best day: Thursday (1.87 per 100). 32 of 77 meetings.',
      'Second: Tuesday (1.19). Friday is 0.92 for all reps — below the team average.',
      'Wednesday is below average once you account for who called. Monday is by far the worst (0.34).',
      'Hours: 09:00–14:00. Strongest 11:00–13:00. Before 09:00 and after 14:00 are weak.',
      'Plan: 07:00–09:00 prep. Heaviest dialling 09:00–14:00 on Thursday and Tuesday.',
    ],
  },
  bard: {
    id: 'bard',
    avg: 1.7,
    calls: 3290,
    wins: 56,
    hours: 50.9,
    avgSec: 56,
    dates: 41,
    headline: 'Thursday, then Friday and Wednesday. Dial 09:00–14:00.',
    blurb: 'Individual numbers: 1.70 meetings per 100 calls. Thursday is the best day. Friday and Wednesday beat Tuesday. Almost nothing on Monday.',
    days: [
      ['Monday', 6, 365, 6.5, 2, 0.55, 0.55],
      ['Tuesday', 5, 459, 6.7, 5, 1.09, 1.09],
      ['Wednesday', 11, 956, 14.7, 15, 1.57, 1.57],
      ['Thursday', 11, 879, 13.4, 23, 2.62, 2.62],
      ['Friday', 8, 631, 9.5, 11, 1.74, 1.74],
    ],
    grid: [
      { day: 'Mon', cells: [[0, 41, 0, 0], [0, 41, 0, 0], [1, 41, 2.47, 2.47], [1, 41, 2.47, 2.47], [0, 41, 0, 0], [0, 41, 0, 0], [0, 41, 0, 0], [0, 41, 0, 0], [0, 41, 0, 0]] },
      { day: 'Tue', cells: [[0, 51, 0, 0], [1, 51, 1.96, 1.96], [1, 51, 1.96, 1.96], [0, 51, 0, 0], [0, 51, 0, 0], [2, 51, 3.92, 3.92], [0, 51, 0, 0], [0, 51, 0, 0], [1, 51, 1.96, 1.96]] },
      { day: 'Wed', cells: [[3, 106, 2.82, 2.82], [0, 106, 0, 0], [3, 106, 2.82, 2.82], [2, 106, 1.88, 1.88], [2, 106, 1.88, 1.88], [2, 106, 1.88, 1.88], [1, 106, 0.94, 0.94], [1, 106, 0.94, 0.94], [1, 106, 0.94, 0.94]] },
      { day: 'Thu', cells: [[0, 98, 0, 0], [1, 98, 1.02, 1.02], [2, 98, 2.05, 2.05], [4, 98, 4.1, 4.1], [7, 98, 7.17, 7.17], [3, 98, 3.07, 3.07], [5, 98, 5.12, 5.12], [0, 98, 0, 0], [1, 98, 1.02, 1.02]] },
      { day: 'Fri', cells: [[0, 70, 0, 0], [0, 70, 0, 0], [0, 70, 0, 0], [2, 70, 2.85, 2.85], [2, 70, 2.85, 2.85], [4, 70, 5.71, 5.71], [1, 70, 1.43, 1.43], [2, 70, 2.85, 2.85], [0, 70, 0, 0]] },
      { day: 'All days', cells: [[3, 366, 0.82, 0.82], [2, 366, 0.55, 0.55], [7, 366, 1.91, 1.91], [9, 366, 2.46, 2.46], [11, 366, 3.01, 3.01], [11, 366, 3.01, 3.01], [7, 366, 1.91, 1.91], [3, 366, 0.82, 0.82], [3, 366, 0.82, 0.82]] },
    ],
    showAdjusted: false,
    advice: [
      'Best day: Thursday, 2.62 per 100 (23 meetings from 879 calls).',
      'Next: Friday 1.74, then Wednesday 1.57. Tuesday is 1.09. Monday 0.55.',
      'Hours: 09:00–14:00, strongest 11:00–13:00. 07:00–09:00 and after 14:00 are weak.',
      '50.9 hours on 3,290 calls, 56 seconds a call.',
    ],
  },
  bhrat: {
    id: 'bhrat',
    avg: 0.54,
    calls: 3909,
    wins: 21,
    hours: 46.4,
    avgSec: 43,
    dates: 33,
    headline: 'Thursday and Tuesday mornings. Do not count on Friday.',
    blurb: 'Individual numbers: 0.54 meetings per 100 calls. Wins sit between 07:00 and 11:00. Thursday and Tuesday are the days that work. Friday had 154 calls and 0 meetings.',
    days: [
      ['Monday', 8, 735, 9.2, 1, 0.14, 0.14],
      ['Tuesday', 9, 1103, 12.9, 9, 0.82, 0.82],
      ['Wednesday', 7, 920, 11.0, 2, 0.22, 0.22],
      ['Thursday', 8, 997, 12.1, 9, 0.9, 0.9],
      ['Friday', 1, 154, 1.3, 0, 0, 0],
    ],
    grid: [
      { day: 'Mon', cells: [[0, 184, 0, 0], [0, 184, 0, 0], [0, 184, 0, 0], [1, 184, 0.54, 0.54], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
      { day: 'Tue', cells: [[0, 276, 0, 0], [5, 276, 1.81, 1.81], [2, 276, 0.73, 0.73], [2, 276, 0.73, 0.73], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
      { day: 'Wed', cells: [[1, 230, 0.43, 0.43], [0, 230, 0, 0], [0, 230, 0, 0], [1, 230, 0.43, 0.43], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
      { day: 'Thu', cells: [[0, 249, 0, 0], [0, 249, 0, 0], [6, 249, 2.41, 2.41], [3, 249, 1.2, 1.2], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
      { day: 'Fri', cells: [[0, 39, 0, 0], [0, 39, 0, 0], [0, 39, 0, 0], [0, 39, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
      { day: 'All days', cells: [[1, 977, 0.1, 0.1], [5, 977, 0.51, 0.51], [8, 977, 0.82, 0.82], [7, 977, 0.72, 0.72], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] },
    ],
    showAdjusted: false,
    advice: [
      'Best days: Thursday 0.90 and Tuesday 0.82 per 100. Those two days hold 18 of 21 meetings.',
      'Monday 0.14, Wednesday 0.22, Friday 0 from 154 calls. Do not put volume on Friday.',
      'Every booked meeting is between 07:00 and 11:00, mostly 09:00–11:00. After 11:00 this file has no individual wins.',
      '46.4 hours on 3,909 calls, 43 seconds a call.',
    ],
  },
};

const NAME_RE = /\b(b[åa]+rd|bhrat|alexander|gupta|fransson|kvalheim|farkas|both reps)\b/i;

export function callTimesUserCopy(view) {
  return [view.headline, view.blurb, ...(view.advice || [])].join('\n');
}

export function callTimesCopyHasRepNames(view) {
  return NAME_RE.test(callTimesUserCopy(view));
}

export function hourLabel(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

export function rateIndex(view) {
  return view.showAdjusted ? 3 : 2;
}

export function dayRateIndex(view) {
  return view.showAdjusted ? 6 : 5;
}
