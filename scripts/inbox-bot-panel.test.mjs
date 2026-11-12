import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
process.env.APP_DATA_DIR = mkdtempSync(join(tmpdir(), 'inbox-bot-panel-'));

const { tsImport } = await import('tsx/esm/api');
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const panel = await tsImport('../app/pages/Admin/sections/InboxBotPanel.tsx', import.meta.url);
const store = await import('../lib/inbox-bot/store.js');

const { InboxBotPanel, InboxNeedsReplyPill, SignedContractPill, inboxActivityLabel, inboxActivityText } = panel;

/** A sales card with only the fields the panel reads. */
function card(inboxBot = {}) {
  return {
    id: 'panel-client',
    businessName: 'Panel AS',
    inboxBot: { pendingContracts: 0, stagedElements: 0, contracts: [], elements: [], ...inboxBot },
  };
}

function row(over = {}) {
  return {
    id: `row-${Math.random().toString(16).slice(2, 8)}`,
    kind: 'other',
    status: 'logged',
    intent: '',
    reason: '',
    stage: '',
    summary: '',
    subject: 'Re: møtet',
    receivedAt: '2026-10-29T09:00:00.000Z',
    ...over,
  };
}

function render(component, client, props = {}) {
  return renderToStaticMarkup(createElement(component, { client, ...props }));
}

test('needs_human rows name the stage the bot stayed silent for', () => {
  assert.equal(inboxActivityLabel(row({ status: 'needs_human', reason: 'stage:offer' })), 'Ikke besvart — kunden er i Tilbud');
  assert.equal(inboxActivityLabel(row({ status: 'needs_human', reason: 'stage:signature' })), 'Ikke besvart — kunden er i Venter signering');
  assert.equal(inboxActivityLabel(row({ status: 'needs_human', reason: 'stage:won' })), 'Ikke besvart — kunden er Solgt');
  assert.equal(inboxActivityLabel(row({ status: 'needs_human', reason: 'stage:off' })), 'Ikke besvart — kunden er ikke aktiv i salg');
  assert.equal(inboxActivityLabel(row({ status: 'needs_human', stage: 'signature' })), 'Ikke besvart — kunden er i Venter signering');
});

test('needs_human rows without a stage ask the rep to answer', () => {
  assert.equal(
    inboxActivityLabel(row({ status: 'needs_human', reason: 'question:contract', intent: 'question' })),
    'Spørsmål om kontrakten — trenger svar fra selger',
  );
  assert.equal(inboxActivityLabel(row({ status: 'needs_human', reason: 'unclear', stage: 'offer' })), 'Trenger svar fra selger');
  assert.equal(inboxActivityLabel(row({ status: 'needs_human' })), 'Trenger svar fra selger');
});

test('each newer needs_human reason has its own Norwegian label, also with a `:detail` suffix', () => {
  const labels = {
    'ambiguous-sender': 'Trenger svar fra selger — adressen står på flere kort',
    'stale-mail': 'Trenger svar fra selger — gammel e-post, møtet ble ikke endret',
    'reply-failed': 'Trenger svar fra selger — svaret til kunden ble ikke sendt',
    'void-failed:calendar': 'Trenger svar fra selger — boten fikk ikke tatt bort møtet',
    'no-assigned-rep': 'Trenger svar fra selger — kortet har ingen selger',
    'question-with-booking': 'Bot flyttet møtet — kunden spurte også om noe',
    'time-unclear': 'Trenger svar fra selger — uklart hvilket tidspunkt kunden mener',
    'move-warning:calendar sync failed': 'Bot flyttet møtet — sjekk kalenderen, et steg etterpå feilet',
    'no-meet-link': 'Trenger svar fra selger — kunden spør etter møtelenken',
    'book-failed:no-meeting-row': 'Trenger svar fra selger — boten fikk ikke flyttet møtet',
  };
  for (const [reason, label] of Object.entries(labels)) {
    assert.equal(inboxActivityLabel(row({ status: 'needs_human', reason })), label, reason);
  }
  // The row's own stage never hides the reason the bot gave.
  assert.equal(
    inboxActivityLabel(row({ status: 'needs_human', reason: 'time-unclear', stage: 'meeting' })),
    'Trenger svar fra selger — uklart hvilket tidspunkt kunden mener',
  );
});

test('applied rows say what the bot did', () => {
  assert.equal(inboxActivityLabel(row({ status: 'applied', kind: 'gather', intent: 'question' })), 'Bot svarte');
  assert.equal(inboxActivityLabel(row({ status: 'applied', kind: 'sales_book', intent: 'reschedule' })), 'Bot flyttet møtet');
  assert.equal(inboxActivityLabel(row({ status: 'applied', kind: 'sales_cancel', intent: 'cancel' })), 'Bot avlyste møtet og ba om ny tid');
  assert.equal(inboxActivityLabel(row({ status: 'applied', kind: 'sales_propose' })), 'Bot svarte med ledige tider');
  assert.equal(inboxActivityLabel(row({ status: 'applied', kind: 'sales_call' })), 'Bot svarte og lovet å ta kontakt');
  assert.equal(inboxActivityLabel(row({ status: 'applied', kind: 'something_new' })), 'Bot svarte');
});

test('logged, skipped and unmatched rows never claim a reply', () => {
  assert.equal(inboxActivityLabel(row({ status: 'logged', kind: 'silent', intent: 'confirm' })), 'Bekreftelse — ingen svar trengs');
  assert.equal(inboxActivityLabel(row({ status: 'logged', kind: 'workshop_time', intent: 'confirm' })), 'Bekreftelse — ingen svar trengs');
  assert.equal(inboxActivityLabel(row({ status: 'logged', kind: 'sales_book' })), 'Bot flyttet møtet (uten svar)');
  assert.equal(inboxActivityLabel(row({ status: 'logged', kind: 'sales_cancel' })), 'Bot avlyste møtet (uten svar)');
  assert.equal(inboxActivityLabel(row({ status: 'logged', kind: 'gather' })), 'Svar ikke sendt');
  assert.equal(inboxActivityLabel(row({ status: 'logged', kind: 'workshop_time' })), 'Lest — ingen svar trengs');
  assert.equal(inboxActivityLabel(row({ status: 'skipped', kind: 'workshop_time' })), 'Hoppet over — eldre e-post i samme tråd');
  assert.equal(inboxActivityLabel(row({ status: 'unmatched', kind: 'other' })), 'Ikke besvart');
});

test('activity text prefers the summary and falls back to the subject for slug summaries', () => {
  assert.equal(inboxActivityText(row({ summary: 'Kunden spør om pris', subject: 'Re: møtet' })), 'Kunden spør om pris');
  assert.equal(inboxActivityText(row({ kind: 'sales_book', summary: 'sales_book', subject: 'Re: møtet torsdag' })), 'Re: møtet torsdag');
  assert.equal(inboxActivityText(row({ kind: 'gather', summary: 'inbox-write', subject: 'Spørsmål' })), 'Spørsmål');
  assert.equal(inboxActivityText(row({ summary: '', subject: '' })), '');
});

test('panel renders with activity alone and lists each row', () => {
  const html = render(InboxBotPanel, card({
    activity: [
      row({ status: 'needs_human', reason: 'stage:offer', summary: 'Kunden spør om tilbudet', subject: 'Re: tilbud' }),
      row({ status: 'applied', kind: 'sales_cancel', summary: 'sales_cancel', subject: 'Kan ikke på torsdag' }),
      row({ status: 'logged', kind: 'silent', intent: 'confirm', summary: 'Takk, ses da', receivedAt: 'ikke en dato' }),
    ],
  }));
  assert.match(html, /E-post fra kunden/);
  assert.match(html, /Ikke besvart — kunden er i Tilbud/);
  assert.match(html, /Kunden spør om tilbudet · /);
  assert.match(html, /Bot avlyste møtet og ba om ny tid/);
  assert.match(html, /Kan ikke på torsdag/);
  assert.doesNotMatch(html, />sales_cancel</);
  assert.match(html, /Bekreftelse — ingen svar trengs/);
  assert.match(html, />Takk, ses da</, 'an unparseable date adds no trailing separator');
  assert.match(html, /text-amber-200[^>]*>Ikke besvart/);
  assert.match(html, /text-emerald-200[^>]*>Bot avlyste/);
  assert.doesNotMatch(html, /Vis PDF/);
});

test('panel stays hidden when there is nothing to show', () => {
  assert.equal(render(InboxBotPanel, card()), '');
  assert.equal(render(InboxBotPanel, card({ activity: [] })), '');
  assert.equal(render(InboxBotPanel, { id: 'bare', businessName: 'Bare AS' }), '');
});

test('signed pill shows the date and kundeprofil, never a PDF button', () => {
  assert.equal(render(SignedContractPill, card()), '');
  const signed = render(SignedContractPill, {
    ...card(),
    progression: { contractSigned: true },
    contractSignedAt: '2026-11-06T11:30:53.280Z',
    portalUserId: 'u1',
  });
  assert.match(signed, /Signert /);
  assert.match(signed, /Kundeprofil/);
  assert.doesNotMatch(signed, /Vis PDF/);
  assert.doesNotMatch(signed, /<button/i);
  const missing = render(SignedContractPill, {
    ...card(),
    progression: { contractSigned: true },
    contractSignedAt: '2026-11-06T11:30:53.280Z',
  });
  assert.match(missing, /Ingen kundeprofil/);
});

test('preview-accept contracts list the date, not Vis PDF', () => {
  const html = render(InboxBotPanel, card({
    contracts: [{
      id: 'c-preview',
      fileName: 'generated.pdf',
      receivedAt: '2026-11-06T11:30:53.280Z',
      summary: 'Signert på forhåndsvisningen',
      from: 'kunde@example.no',
      status: 'accepted',
      signedVerdict: 'preview_accept',
    }],
  }));
  assert.match(html, /Signert med kundeprofil/);
  assert.doesNotMatch(html, /Vis PDF/);
});

test('panel keeps contracts and adds the activity section below them', () => {
  const html = render(InboxBotPanel, card({
    contracts: [{
      id: 'c1', fileName: 'kontrakt.pdf', receivedAt: '2026-10-28T09:00:00.000Z', summary: 'Signert kontrakt',
      from: 'kunde@example.no', subject: 'Kontrakt', status: 'accepted', signedVerdict: 'likely',
    }],
    activity: [row({ status: 'applied', kind: 'gather', summary: 'Svarte om pris' })],
  }));
  assert.match(html, /Vis PDF/);
  assert.ok(html.indexOf('Vis PDF') < html.indexOf('E-post fra kunden'));
  assert.match(html, /Bot svarte/);
});

test('needs-reply pill shows only when needsHuman > 0 and carries the latest summary', () => {
  assert.equal(render(InboxNeedsReplyPill, card({ needsHuman: 0, activity: [row({ status: 'needs_human' })] })), '');
  assert.equal(render(InboxNeedsReplyPill, card()), '');
  const html = render(InboxNeedsReplyPill, card({
    needsHuman: 2,
    activity: [
      row({ status: 'applied', kind: 'gather', summary: 'Bot svarte om pris' }),
      row({ status: 'needs_human', reason: 'stage:signature', summary: 'Kunden lurer på oppstart' }),
      row({ status: 'needs_human', reason: 'stage:offer', summary: 'Eldre spørsmål' }),
    ],
  }), { className: 'shrink-0' });
  assert.match(html, /E-post venter svar/);
  assert.match(html, /title="Kunden lurer på oppstart"/);
  assert.match(html, /border-amber-400\/50 bg-amber-500\/20 text-amber-100/);
  assert.match(html, /rounded-full/);
  assert.match(html, /shrink-0/);
});

test('needs-reply pill falls back to the subject, then the label, then a generic title', () => {
  const subject = render(InboxNeedsReplyPill, card({
    needsHuman: 1,
    activity: [row({ status: 'needs_human', reason: 'stage:won', summary: 'needs_human', subject: 'Når starter vi?' })],
  }));
  assert.match(subject, /title="Når starter vi\?"/);
  const label = render(InboxNeedsReplyPill, card({
    needsHuman: 1,
    activity: [row({ status: 'needs_human', reason: 'stage:won', summary: '', subject: '' })],
  }));
  assert.match(label, /title="Ikke besvart — kunden er Solgt"/);
  const generic = render(InboxNeedsReplyPill, card({ needsHuman: 1, activity: [] }));
  assert.match(generic, /title="Kunden har sendt en e-post som venter svar"/);
});

test('store payload renders straight into the panel and pill', () => {
  const id = 'panel-store-client';
  const receivedAt = new Date().toISOString();
  store.appendInboxItem({
    kind: 'gather', salesClientId: id, messageId: 'panel-1:write', status: 'applied',
    summary: 'gather', subject: 'Spørsmål om pris', receivedAt,
  });
  store.appendInboxItem({
    kind: 'question', salesClientId: id, messageId: 'panel-2', status: 'needs_human',
    reason: 'stage:offer', stage: 'offer', intent: 'question', summary: 'Kunden vil endre tilbudet', subject: 'Re: tilbud', receivedAt,
  });
  const inboxBot = store.presentInboxForClient(id);
  assert.equal(inboxBot.needsHuman, 1);
  assert.equal(inboxBot.activity.length, 2);
  const client = { id, businessName: 'Store AS', inboxBot };
  const html = render(InboxBotPanel, client);
  assert.match(html, /Ikke besvart — kunden er i Tilbud/);
  assert.match(html, /Kunden vil endre tilbudet/);
  assert.match(html, /Bot svarte/);
  assert.match(html, /Spørsmål om pris/);
  assert.ok(html.indexOf('Ikke besvart') < html.indexOf('Bot svarte'), 'newest row first');
  assert.match(render(InboxNeedsReplyPill, client), /title="Kunden vil endre tilbudet"/);
});

test('both rep card headers render the needs-reply pill next to the signed pill', () => {
  for (const file of ['SalesFocusBoard.tsx', 'SalesClientsSection.tsx']) {
    const src = readFileSync(join(root, 'app/pages/Admin/sections', file), 'utf8');
    assert.match(src, /import \{ InboxNeedsReplyPill, SignedContractPill \} from '\.\/InboxBotPanel';/, file);
    assert.match(src, /<SignedContractPill client=\{client\}[^>]*\/>\s*<InboxNeedsReplyPill client=\{client\}[^>]*\/>/, file);
  }
});
