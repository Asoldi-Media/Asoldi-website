// Delivery check: the mails. Every client gets today's pre-workshop mail once (the safe-mode outbox,
// never a transport) and, with the switches on, the post-workshop mail once as a shadow record within
// two minutes after its due time and none before it. Every mail passes the runtime guard checks
// (no empty field, the client's own address). With every switch off the run adds nothing beyond the
// pre-workshop mail.
import { buildPreWorkshopEmail } from '../../../lib/sales-email.js';
import { checkDeliveryMessage } from '../../../lib/delivery-guards.js';
import { SHADOW_CHANNEL, clientById, lower, outboxItem, outboxRows, recipients, result, shadowEntries } from './lib.mjs';

export const id = 'delivery.outbox';
const WINDOW_MS = 2 * 60_000;

export async function check(ctx) {
  const findings = [];
  const value = {};
  const on = ctx.timeline?.switches === 'on';
  const rows = outboxRows(ctx.dataDir);
  const shadows = shadowEntries(ctx.dataDir);
  // In safe mode every mail stops in the outbox; `transport` only names what would have sent it
  // (shadow records say 'shadow'). That nothing left the PC is the egress log's part.
  value.transports = [...new Set(rows.map((row) => String(row.transport || '')))];
  const settings = { inbox: { internalDomains: ['asoldi.com'], internalSenders: [] } };
  for (const spec of ctx.plan.clients) {
    const client = clientById(ctx.dataDir, spec.id) || {};
    const address = lower(client.contactEmail);
    const subject = buildPreWorkshopEmail(client, {}, { hasTime: false }).subject;
    const toClient = rows.filter((row) => recipients(row).includes(address));
    const legacy = toClient.filter((row) => row.channel !== SHADOW_CHANNEL);
    const preWorkshop = legacy.filter((row) => row.subject === subject);
    const post = shadows.filter((entry) => entry.clientId === spec.id && entry.kind === 'postWorkshop');
    const row = { preWorkshop: preWorkshop.length, otherToClient: legacy.length - preWorkshop.length, postWorkshopShadow: post.length };
    value[spec.id] = row;
    // Today's paths: got-client alone signs nothing, so with every switch off it sends nothing; every
    // other path sends today's pre-workshop mail once, and a regression that stops it must fail here.
    const expectedOff = spec.signing === 'got-client' ? 0 : 1;
    if (on ? preWorkshop.length !== 1 : preWorkshop.length !== expectedOff) findings.push(`${spec.id}: ${preWorkshop.length} pre-workshop mails, expected ${on ? '1' : expectedOff}`);
    if (row.otherToClient) findings.push(`${spec.id}: ${row.otherToClient} other mails reached the outbox for the client`);
    for (const mail of preWorkshop) {
      const verdict = checkDeliveryMessage({ client, message: outboxItem(ctx.dataDir, mail.id) || mail, settings });
      if (!verdict.ok) findings.push(`${spec.id}: the pre-workshop mail fails the guard check: ${verdict.code} (${verdict.reason})`);
    }
    if (!on) {
      if (post.length || toClient.length !== legacy.length) findings.push(`${spec.id}: shadow mails were recorded with every switch off`);
      continue;
    }
    if (post.length !== 1) {
      findings.push(`${spec.id}: ${post.length} post-workshop records, expected 1`);
      continue;
    }
    const due = Date.parse(ctx.timeline?.workshop?.[spec.id]?.dueAt || '');
    const at = Date.parse(post[0].at || '');
    row.postWorkshopAt = post[0].at || '';
    row.postWorkshopDueAt = ctx.timeline?.workshop?.[spec.id]?.dueAt || '';
    if (!Number.isFinite(due)) findings.push(`${spec.id}: no post-workshop due time was stored`);
    else if (!(at >= due && at - due <= WINDOW_MS)) findings.push(`${spec.id}: the post-workshop record at ${post[0].at} is not within 2 minutes after ${row.postWorkshopDueAt}`);
    const item = post[0].outboxId ? outboxItem(ctx.dataDir, post[0].outboxId) : null;
    if (!item) findings.push(`${spec.id}: the post-workshop shadow record has no outbox mail`);
    else {
      if (item.channel !== SHADOW_CHANNEL || item.transport !== 'shadow') findings.push(`${spec.id}: the post-workshop mail is not a shadow record (${item.channel}/${item.transport})`);
      const verdict = checkDeliveryMessage({ client, message: item, settings });
      if (!verdict.ok) findings.push(`${spec.id}: the post-workshop mail fails the guard check: ${verdict.code} (${verdict.reason})`);
    }
  }
  // With every switch off nothing is recorded as a shadow mail, to anyone.
  if (!on) {
    const stray = rows.filter((row) => row.channel === SHADOW_CHANNEL).length;
    if (stray || shadows.length) findings.push(`${stray + shadows.length} shadow mail records exist with every switch off`);
  }
  const before = Number(ctx.timeline?.outboxBeforeDue);
  if (on && Number.isFinite(before)) {
    const early = rows.slice(0, before).filter((row) => row.channel === SHADOW_CHANNEL && shadows.some((entry) => entry.outboxId === row.id && entry.kind === 'postWorkshop'));
    if (early.length) findings.push(`${early.length} post-workshop records were written before their due time`);
  }
  return result(id, on ? ['signing', 'emails.postWorkshop'] : [], findings, value);
}
