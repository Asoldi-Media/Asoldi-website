// The delivery checks in one call, and what they mean for each release-gated switch.
import { existsSync, readFileSync } from 'node:fs';
import { RELEASE_GATED_SWITCHES } from '../../../packages/suite/core/delivery/vocab.js';
import * as brief from './delivery-brief.mjs';
import * as gate from './delivery-gate.mjs';
import * as jobs from './delivery-jobs.mjs';
import * as outbox from './delivery-outbox.mjs';
import * as stages from './delivery-stages.mjs';

export const DELIVERY_CHECKS = Object.freeze([stages, outbox, gate, brief, jobs]);

// Which checks must pass for a release-gated switch to pass. A switch not listed is not covered by
// this suite and gets no pass.
export const SWITCH_COVERAGE = Object.freeze({
  signing: Object.freeze([stages.id, outbox.id]),
  'delivery.loop': Object.freeze([stages.id, jobs.id]),
  gate: Object.freeze([gate.id]),
  brief: Object.freeze([brief.id]),
  'emails.postWorkshop': Object.freeze([outbox.id]),
});

/** Runs every check; a check that throws is a failed check. */
export async function runDeliveryChecks(ctx) {
  const out = [];
  for (const mod of DELIVERY_CHECKS) {
    try {
      out.push(await mod.check(ctx));
    } catch (error) {
      out.push({ id: mod.id, status: 'fail', covers: [], value: null, findings: [`the check threw: ${String(error?.stack || error).slice(0, 400)}`] });
    }
  }
  return out;
}

/** { <release id>: { status: 'pass' | 'fail' | 'not-covered', checks, findings } } for every gated switch. */
export function switchVerdicts(results) {
  const byId = new Map(results.map((row) => [row.id, row]));
  const out = {};
  for (const switchId of RELEASE_GATED_SWITCHES) {
    const needed = SWITCH_COVERAGE[switchId];
    if (!needed) {
      out[switchId] = { status: 'not-covered', checks: [], findings: [] };
      continue;
    }
    const rows = needed.map((checkId) => byId.get(checkId));
    const ok = rows.every((row) => row && row.status === 'pass');
    out[switchId] = {
      status: ok ? 'pass' : 'fail',
      checks: [...needed],
      findings: rows.flatMap((row) => (row && row.status !== 'pass' ? (row.findings || [`${row.id} ${row.status}`]).slice(0, 5) : row ? [] : ['check missing'])),
    };
  }
  return out;
}

/** {host: count} of an egress log (scripts/safe-mode/egress-audit.cjs or the Maker's), event rows left out. */
export function egressHosts(file) {
  if (!file || !existsSync(file)) return null;
  const hosts = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.event) continue;
    const host = String(row.host || '').trim().toLowerCase();
    if (host) hosts[host] = (hosts[host] || 0) + 1;
  }
  return hosts;
}

const FORBIDDEN_HOSTS = [/(^|\.)asoldi\.com$/, /(^|\.)github\.com$/, /(^|\.)githubusercontent\.com$/];

/** Findings for an egress host list: any production or GitHub host. */
export function egressFindings(hosts, label = 'egress') {
  if (!hosts) return [`${label}: no egress log`];
  return Object.keys(hosts).filter((host) => FORBIDDEN_HOSTS.some((re) => re.test(host))).map((host) => `${label}: reached ${host}`);
}
