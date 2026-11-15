/**
 * The prompt a developer pastes into Cursor for one Maker run.
 * Business label (emails and phone numbers stripped), ids and counts only: no quotes, transcript text, secrets, email addresses or phone numbers.
 * The first line names CURSOR_PROMPT_MODEL. The editor's own default model is a different one.
 */

/** Claude model the prompt tells Cursor to use. Not the editor default. */
export const CURSOR_PROMPT_MODEL = 'claude-sonnet-5-5';
export const CURSOR_PROMPT_MAX_CHARS = 6000;

const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function idOf(value) {
  const id = text(typeof value === 'string' ? value : value?.id, 80);
  return ID_RE.test(id) ? id : '';
}

function displayLabel(client) {
  const raw = text(client?.businessName || client?.label, 160);
  return raw
    .replace(/[\w.+-]+@[\w.-]+/g, '')
    .replace(/\+?\d[\d\s()-]{6,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitDirectives(directives) {
  if (directives && !Array.isArray(directives) && typeof directives === 'object') {
    return {
      accepted: (directives.acceptedUnapplied || directives.accepted || []).map(idOf).filter(Boolean),
      proposed: (directives.proposedMust || directives.proposed || []).map(idOf).filter(Boolean),
    };
  }
  const accepted = [];
  const proposed = [];
  for (const row of Array.isArray(directives) ? directives : []) {
    const id = idOf(row);
    if (!id) continue;
    const applied = Array.isArray(row.appliedInJobs) ? row.appliedInJobs.length : 0;
    if (row.status === 'accepted' && applied === 0) accepted.push(id);
    else if (row.priority === 'must' && !['accepted', 'rejected', 'done', 'superseded'].includes(row.status)) proposed.push(id);
  }
  return { accepted, proposed };
}

function openChangeIds(list) {
  const ids = [];
  for (const row of Array.isArray(list) ? list : []) {
    if (row && typeof row === 'object' && (row.status === 'done' || row.status === 'rejected')) continue;
    const id = idOf(row);
    if (id) ids.push(id);
  }
  return ids;
}

function servicesOf(input) {
  const list = Array.isArray(input.services) ? input.services : input.client?.sitePlan?.services;
  return (Array.isArray(list) ? list : []).map((item) => text(item, 40)).filter((item) => ID_RE.test(item));
}

/**
 * Markdown for one run. When the text would pass 6,000 characters, whole ids are dropped from the
 * lowest-priority list first (thread asks, then change requests, then proposed must, then
 * accepted directives). A line is never cut through an id.
 */
export function buildCursorPrompt(input = {}) {
  const client = input.client || {};
  const checked = (value, max) => {
    const raw = text(value, max);
    return ID_RE.test(raw) ? raw : '';
  };
  const runId = checked(input.runId || client?.makerRun?.runId, 80);
  const tier = checked(input.tier || client?.sitePlan?.tierId || client?.portalTierId, 40);
  let services = servicesOf(input);
  const { accepted, proposed } = splitDirectives(input.directives);
  const changes = openChangeIds(input.changeRequests);
  const asks = (Array.isArray(input.threadAsks) ? input.threadAsks : []).map((row) => (row && typeof row === 'object' ? idOf(row) : '')).filter(Boolean);
  const counts = `Antall: direktiv ${accepted.length + proposed.length}, endringer ${changes.length}, spørsmål ${asks.length}.`;

  const fixed = () => [
    `Bruk modellen ${CURSOR_PROMPT_MODEL}.`,
    `Klient: ${displayLabel(client)}`,
    `Nivå: ${tier}`,
    `Tjenester: ${services.join(', ')}`,
    `Kjøring: ${runId}`,
    counts,
    `Kjør /start-rediger ${runId}, deretter /rediger.`,
    'Les direktivene fra den lokale Maker når kjøringen starter. Send headeren x-asoldi-local: 1.',
    `Endringer går gjennom POST {{MAKER}}/api/runs/${runId}/custom/edits med source:"agent". Uten headeren svarer Maker 403.`,
    'Mal-uavhengig. Ikke rediger filer i .generated-runs for hånd. Ikke skriv CMS-kode.',
  ];

  while (fixed().join('\n').length > CURSOR_PROMPT_MAX_CHARS && services.length) services.pop();

  const ranked = [
    { label: 'Godkjente direktiv', ids: accepted.slice() },
    { label: 'Foreslåtte must', ids: proposed.slice() },
    { label: 'Åpne endringer', ids: changes.slice() },
    { label: 'Åpne spørsmål', ids: asks.slice() },
  ];

  const render = () => {
    const lines = fixed();
    for (const row of ranked) {
      if (row.ids.length) lines.push(`${row.label}: ${row.ids.join(', ')}`);
    }
    return lines.join('\n');
  };

  let guard = ranked.reduce((sum, row) => sum + row.ids.length, 0) + 1;
  while (render().length > CURSOR_PROMPT_MAX_CHARS && guard > 0) {
    guard -= 1;
    const row = [...ranked].reverse().find((entry) => entry.ids.length);
    if (!row) break;
    row.ids.pop();
  }

  return render();
}
