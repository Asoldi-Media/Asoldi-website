// Delivery check: the brief. With brief in auto every client has a stored brief (version 1 or later)
// with at least one directive; every directive carries a quote and a meeting, and the quote is found
// again in that meeting's transcript by the brief's own verifier (lib/delivery-brief/verify-quotes.js).
// The brief holds no run of 20 or more words from a transcript (only short quotes).
// ctx.transcripts: { clientId: [{ meetingId, text }] } (the transcripts the run seeded).
import { createQuoteVerifier } from '../../../lib/delivery-brief/verify-quotes.js';
import { latestBrief, result } from './lib.mjs';

export const id = 'delivery.brief';
const RUN_WORDS = 20;

function words(value) {
  return String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

/** True when `haystack` holds a run of RUN_WORDS consecutive words of `source`. */
export function holdsLongRun(haystack, source) {
  const target = ` ${words(haystack).join(' ')} `;
  const list = words(source);
  for (let i = 0; i + RUN_WORDS <= list.length; i += 1) {
    if (target.includes(` ${list.slice(i, i + RUN_WORDS).join(' ')} `)) return true;
  }
  return false;
}

export async function check(ctx) {
  if (ctx.timeline?.switches !== 'on') return result(id, [], [], null, { skipped: 'the brief is off in this run' });
  const findings = [];
  const value = {};
  for (const spec of ctx.plan.clients) {
    const brief = latestBrief(ctx.dataDir, spec.id);
    const transcripts = Array.isArray(ctx.transcripts?.[spec.id]) ? ctx.transcripts[spec.id] : [];
    const byMeeting = new Map(transcripts.map((row) => [String(row.meetingId), String(row.text || '')]));
    const directives = Array.isArray(brief?.directives) ? brief.directives : [];
    const row = { version: Number(brief?.version) || 0, directives: directives.length, verified: 0, droppedUnverified: Number(brief?.stats?.droppedUnverifiedQuotes) || 0 };
    value[spec.id] = row;
    if (!brief) {
      findings.push(`${spec.id}: no brief was built`);
      continue;
    }
    if (!directives.length) findings.push(`${spec.id}: the brief has no directive`);
    for (const directive of directives) {
      const text = byMeeting.get(String(directive.meetingId || ''));
      if (!directive.quote || !directive.meetingId) {
        findings.push(`${spec.id}: directive ${directive.id} has no quote or meeting`);
        continue;
      }
      if (text === undefined) {
        findings.push(`${spec.id}: directive ${directive.id} names a meeting the run did not seed`);
        continue;
      }
      const verdict = createQuoteVerifier(text).verify(directive.quote, { speaker: String(directive.speaker || '') });
      if (verdict.ok && verdict.quote) row.verified += 1;
      else findings.push(`${spec.id}: the quote of directive ${directive.id} is not in its transcript`);
    }
    const body = JSON.stringify(brief);
    for (const [meetingId, text] of byMeeting) {
      if (holdsLongRun(body, text)) findings.push(`${spec.id}: the brief holds a run of ${RUN_WORDS} words from meeting ${meetingId}`);
    }
  }
  return result(id, ['brief'], findings, value);
}
