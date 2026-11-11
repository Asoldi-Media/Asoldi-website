// Delivery check: the gate. With the gate in shadow every signed client has an evaluated gate (the
// developer route answers it): askable dev lines stay within 12 (8 on tier 1), a plan without a shop
// gets no shop line, and where the run has expected-line labels (<labelsDir>/<fixture>/
// gate-expected.json, schema asoldi.gate-expected/1) the lines score an overall F1 of at least
// ctx.minF1 (default 0.9; scripts/eval/gate-f1.mjs scoring). The gates are written to
// <outDir>/gate-actual/<fixture>/gate-actual.json so gate-f1.mjs --actual can score them again.
// A client is scored on the gate once it is signed (plan gateAt 'signed') or, by default, once its
// workshop is held: the point its labels describe.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scoreClient, summarize } from '../../eval/gate-f1.mjs';
import { readJson, result } from './lib.mjs';

export const id = 'delivery.gate';
const SHOP_LINES = ['products', 'seller', 'shipping', 'returns', 'payment'];

export async function check(ctx) {
  if (ctx.timeline?.switches !== 'on') return result(id, [], [], null, { skipped: 'the gate is off in this run' });
  const findings = [];
  const value = { clients: {} };
  const counts = new Map();
  let labelled = 0;
  for (const spec of ctx.plan.clients) {
    // The gate at the point the client's data describes: once signed, or with the workshop held (the default).
    const at = spec.gateAt === 'signed' ? 'signed' : 'workshop-held';
    const gate = at === 'signed' ? ctx.timeline?.gatesAtSigning?.[spec.id] : ctx.timeline?.gates?.[spec.id];
    const row = { at, status: gate?.status || 0, mode: gate?.mode || '', lines: gate?.lines?.length || 0, askable: gate?.askable || 0, askableDev: gate?.askableDev || 0 };
    value.clients[spec.id] = row;
    if (!gate || gate.status !== 200) {
      findings.push(`${spec.id}: the gate route answered ${gate?.status || 'nothing'}`);
      continue;
    }
    if (gate.mode !== 'shadow') findings.push(`${spec.id}: gate mode ${gate.mode}, expected shadow`);
    if (!gate.lines.length) findings.push(`${spec.id}: the gate has no lines`);
    const limit = spec.tier === 'tier-1-standard' ? 8 : 12;
    if (row.askableDev > limit) findings.push(`${spec.id}: ${row.askableDev} askable dev lines, at most ${limit}`);
    if (spec.tier !== 'tier-3-ecommerce') {
      const shop = gate.lines.filter((line) => SHOP_LINES.includes(line.id)).map((line) => line.id);
      if (shop.length) findings.push(`${spec.id}: shop lines on a plan without a shop: ${shop.join(', ')}`);
    }
    const fixture = String(spec.fixture || spec.id);
    if (ctx.outDir) {
      const dir = join(ctx.outDir, 'gate-actual', fixture);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'gate-actual.json'), `${JSON.stringify({ client: fixture, lines: gate.lines }, null, 2)}\n`);
    }
    const labelFile = ctx.labelsDir ? join(ctx.labelsDir, fixture, 'gate-expected.json') : '';
    if (labelFile && existsSync(labelFile)) {
      const expected = readJson(labelFile, { lines: [] });
      scoreClient(expected, { lines: gate.lines }, counts);
      row.f1 = Math.round(summarize(scoreClient(expected, { lines: gate.lines })).overall.f1 * 1000) / 1000;
      labelled += 1;
    }
  }
  if (labelled) {
    const overall = summarize(counts).overall;
    value.f1 = Math.round(overall.f1 * 1000) / 1000;
    value.precision = Math.round(overall.precision * 1000) / 1000;
    value.recall = Math.round(overall.recall * 1000) / 1000;
    value.labelled = labelled;
    const min = Number.isFinite(Number(ctx.minF1)) ? Number(ctx.minF1) : 0.9;
    if (!(overall.f1 >= min)) findings.push(`gate lines F1 ${value.f1} on ${labelled} labelled clients is below ${min}`);
  }
  return result(id, ['gate'], findings, value);
}
