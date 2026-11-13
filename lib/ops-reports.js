// The numbers to judge the inbox bot and the Fireflies live join by, over a window of days. Built from the
// decision log (lib/ops-events.js) and the stores the systems already keep, so the weeks before the log
// existed still get the numbers their stores hold (the baseline). Pure apart from the reads in the *ForHub
// helpers; no mail bodies leave the review list's trimmed lines.
import fs from 'node:fs';
import path from 'node:path';
import { getPersistentDataDir } from '../data/storage-path.js';
import { readLedgerRow } from '../packages/suite/core/llm/index.js';
import { movedSalesPlaceholderIds } from './fireflies-cover.js';

const DAY_MS = 86400000;
const MINUTE_MS = 60000;
const CARD_EVENT_KINDS = new Set(['sales_declined', 'bounce', 'calendar_decline', 'calendar_counter']);
const FAILURE_HEADS = ['reply-failed', 'book-failed', 'void-failed', 'move-warning'];

function text(value = '') {
  return String(value ?? '').trim();
}

function msOf(value) {
  const ms = Date.parse(text(value));
  return Number.isFinite(ms) ? ms : NaN;
}

function trim(value = '', max = 300) {
  const raw = text(value).replace(/\s+/g, ' ');
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/** The p-th percentile (0–100) of a list of numbers, nearest rank; null when empty. */
export function percentile(values = [], p = 50) {
  const list = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!list.length) return null;
  const rank = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1));
  return list[rank];
}

function countBy(list = [], keyOf) {
  const out = {};
  for (const item of list) {
    const key = keyOf(item);
    if (key) out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function windowOf(days, nowMs) {
  const span = Math.max(1, Math.min(90, Number(days) || 7));
  return { days: span, sinceMs: nowMs - span * DAY_MS, since: new Date(nowMs - span * DAY_MS).toISOString(), until: new Date(nowMs).toISOString() };
}

/** AI ledger rows (lib/llm/ledger.js) from `sinceMs` on, read straight from <dataDir>/ai/ledger-YYYY-MM.jsonl. */
export function readAiLedgerRows({ sinceMs = 0, dataDir = getPersistentDataDir() } = {}) {
  const dir = path.join(dataDir, 'ai');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => /^ledger-\d{4}-\d{2}\.jsonl$/.test(name));
  } catch {
    return [];
  }
  const fromMonth = new Date(Math.max(0, sinceMs)).toISOString().slice(0, 7);
  const rows = [];
  for (const name of names) {
    if (name.slice(7, 14) < fromMonth) continue;
    let content = '';
    try {
      content = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = readLedgerRow(JSON.parse(line));
        if (row && msOf(row.at) >= sinceMs) rows.push(row);
      } catch {
        // a torn line is skipped
      }
    }
  }
  return rows;
}

/**
 * The inbox bot over `days`: every client mail it decided on (and every decline or bounce), split by outcome,
 * how fast it answered, what failed, where the word rules and the AI disagreed, what the AI cost, and a
 * review list to judge each decision by.
 */
export function inboxBotReport({ days = 7, nowMs = Date.now(), items = [], events = [], clients = [], ledgerRows = [] } = {}) {
  const window = windowOf(days, nowMs);
  const names = new Map((clients || []).map((client) => [text(client.id), text(client.businessName)]));
  const decided = new Map();
  for (const event of events) {
    if (event.type === 'mail.decided' && text(event.messageId)) decided.set(text(event.messageId), event);
  }
  const rows = (items || []).filter((item) => (
    msOf(item.receivedAt) >= window.sinceMs
    && (text(item.messageId).endsWith(':write') || CARD_EVENT_KINDS.has(item.kind))
  ));
  const outcome = { answered: 0, forPerson: 0, noReplyNeeded: 0, skipped: 0 };
  const replyMs = [];
  for (const item of rows) {
    if (item.status === 'applied' || text(item.replyText)) outcome.answered += 1;
    else if (item.status === 'needs_human') outcome.forPerson += 1;
    else if (item.status === 'skipped') outcome.skipped += 1;
    else outcome.noReplyNeeded += 1;
    const replied = msOf(item.repliedAt) - msOf(item.receivedAt);
    if (Number.isFinite(replied) && replied >= 0) replyMs.push(replied);
  }
  const reasonHead = (item) => text(item.reason).split(':')[0];
  const decideLag = events
    .filter((event) => event.type === 'mail.decided' && !event.backfill && Number.isFinite(event.lagMs))
    .filter((event) => msOf(event.at) >= window.sinceMs)
    .map((event) => event.lagMs);
  const copies = events.filter((event) => event.type === 'copy.appended');
  const sends = events.filter((event) => event.type === 'reply.sent');
  const ticks = events.filter((event) => event.type === 'tick');
  const aiRows = (ledgerRows || []).filter((row) => text(row.task).startsWith('inbox.') && msOf(row.at) >= window.sinceMs);
  const aiUsd = aiRows.reduce((sum, row) => sum + (Number(row.usd) || 0), 0);
  const failures = {};
  for (const head of FAILURE_HEADS) failures[head] = rows.filter((item) => reasonHead(item) === head).length;
  failures.replySendErrors = sends.filter((event) => event.ok === false).length;
  failures.sentCopyFailed = copies.filter((event) => event.sent && event.sent.ok === false).length;
  failures.inboxCopyFailed = copies.filter((event) => event.inbox && event.inbox.ok === false).length;
  return {
    window,
    mails: rows.length,
    outcome,
    byAction: countBy(rows.filter((item) => item.status === 'applied'), (item) => text(item.kind)),
    forPersonByReason: countBy(rows.filter((item) => item.status === 'needs_human'), reasonHead),
    latency: {
      replyMedianMs: percentile(replyMs, 50),
      replyP90Ms: percentile(replyMs, 90),
      decideMedianMs: percentile(decideLag, 50),
      decideP90Ms: percentile(decideLag, 90),
    },
    failures,
    aiDisagrees: rows.filter((item) => reasonHead(item) === 'ai-disagrees').length,
    copies: { sent: copies.filter((event) => event.sent?.ok).length, inbox: copies.filter((event) => event.inbox?.ok).length },
    ai: {
      calls: aiRows.length,
      usd: Math.round(aiUsd * 10000) / 10000,
      perMailUsd: rows.length ? Math.round((aiUsd / rows.length) * 10000) / 10000 : 0,
      byTask: countBy(aiRows, (row) => text(row.task)),
    },
    ticks: { count: ticks.length, medianMs: percentile(ticks.map((event) => event.ms), 50), p90Ms: percentile(ticks.map((event) => event.ms), 90) },
    review: rows.slice().reverse().slice(0, 200).map((item) => {
      const event = decided.get(text(item.messageId).replace(/:write$/, '')) || {};
      return {
        at: text(item.receivedAt),
        salesClientId: text(item.salesClientId),
        businessName: names.get(text(item.salesClientId)) || '',
        subject: trim(item.subject, 120),
        clientText: trim(item.text, 300),
        words: text(event.words || item.intent),
        ai: text(event.ai),
        action: text(item.kind),
        status: text(item.status),
        reason: text(item.reason),
        replyText: trim(item.replyText, 500),
        repliedAt: text(item.repliedAt),
        replyMs: Number.isFinite(msOf(item.repliedAt) - msOf(item.receivedAt)) ? msOf(item.repliedAt) - msOf(item.receivedAt) : null,
      };
    }),
  };
}

function sessionStartMs(session) {
  return msOf(session.startAt);
}

/** A real recording with talk on one of the session's cards, started from 30 min before to 2 h after the start. */
function sessionRecorded(session, byId) {
  const start = sessionStartMs(session);
  return (session.slots || []).some((slot) => {
    const client = byId.get(text(slot.clientId));
    return (client?.meetings || []).some((row) => {
      if (text(row.meetingId).startsWith('live:') || text(row.duplicateOf)) return false;
      const talk = Boolean(row.hasTranscript) || Number(row.sentenceCount) >= 10;
      const at = msOf(row.startedAt);
      return talk && at >= start - 30 * MINUTE_MS && at < start + 120 * MINUTE_MS;
    });
  });
}

/**
 * The Fireflies live join over `days`: booked online meetings that are over, how many got recorded, how fast
 * the notetaker was in, sends and rate limits, the open-room window and co-hosts, missing and empty by state,
 * false "ingen opptak" for moved meetings, and rep-owned notetakers seen.
 */
export function firefliesReport({ days = 7, nowMs = Date.now(), clients = [], sessions = {}, events = [], missingRows = [] } = {}) {
  const window = windowOf(days, nowMs);
  const byId = new Map((clients || []).map((client) => [text(client.id), client]));
  const over = Object.values(sessions || {}).filter((session) => {
    const start = sessionStartMs(session);
    const minutes = Number(session.bookedMinutes) || 60;
    return Number.isFinite(start) && start >= window.sinceMs && start + minutes * MINUTE_MS <= nowMs;
  });
  const meetings = over.map((session) => {
    const start = sessionStartMs(session);
    const seenMs = msOf(session.firstSeenActiveAt);
    const attempts = Array.isArray(session.attempts) ? session.attempts : [];
    return {
      key: text(session.key),
      startAt: text(session.startAt),
      title: trim(session.title, 120),
      clients: (session.slots || []).map((slot) => text(slot.clientId)),
      state: text(session.state),
      declined: Boolean(session.declinedAt),
      moved: Boolean(session.detachedAt),
      sends: attempts.filter((attempt) => !attempt.rateLimited).length,
      rateLimited: attempts.filter((attempt) => attempt.rateLimited).length,
      botInMinutes: Number.isFinite(seenMs) ? Math.round((seenMs - start) / MINUTE_MS) : null,
      bots: Array.isArray(session.ffMeetingIds) ? session.ffMeetingIds.length : 0,
      window: text(session.meetWindowState),
      windowError: text(session.meetWindowError),
      recorded: sessionRecorded(session, byId),
    };
  });
  const booked = meetings.filter((row) => !row.declined && !row.moved);
  const botIn = booked.map((row) => row.botInMinutes).filter(Number.isFinite);
  const inWindow = events.filter((event) => msOf(event.at) >= window.sinceMs);
  const access = inWindow.filter((event) => event.type === 'room.access');
  const prepared = inWindow.filter((event) => event.type === 'room.prepared');
  const sent = inWindow.filter((event) => event.type === 'bot.sent');
  const looks = inWindow.filter((event) => event.type === 'look');
  const foreign = inWindow.filter((event) => event.type === 'notetaker.foreign');
  let falseMissing = 0;
  for (const client of clients || []) {
    for (const id of movedSalesPlaceholderIds(client)) {
      const row = (client.meetings || []).find((item) => text(item.meetingId) === id);
      if (row && msOf(row.startedAt) >= window.sinceMs) falseMissing += 1;
    }
  }
  const missing = (missingRows || []).filter((row) => msOf(row.startedAt) >= window.sinceMs);
  return {
    window,
    meetings: booked.length,
    recorded: booked.filter((row) => row.recorded).length,
    recordedRate: booked.length ? Math.round((booked.filter((row) => row.recorded).length / booked.length) * 1000) / 1000 : null,
    botInByT3: booked.filter((row) => Number.isFinite(row.botInMinutes) && row.botInMinutes <= 3).length,
    botInMedianMinutes: percentile(botIn, 50),
    botInP90Minutes: percentile(botIn, 90),
    declined: meetings.filter((row) => row.declined).length,
    moved: meetings.filter((row) => row.moved).length,
    duplicateBots: booked.filter((row) => row.bots > 1).length,
    sends: {
      perMeetingMedian: percentile(booked.map((row) => row.sends), 50),
      total: sent.length,
      failed: sent.filter((event) => event.ok === false).length,
      rateLimited: sent.filter((event) => event.rateLimited).length + booked.reduce((sum, row) => sum + row.rateLimited, 0),
    },
    fireflyApiLooks: { total: looks.length, failed: looks.filter((event) => event.ok === false).length },
    roomWindow: {
      opened: access.filter((event) => event.access === 'OPEN' && event.ok).length,
      openFailed: access.filter((event) => event.access === 'OPEN' && !event.ok).length,
      locked: access.filter((event) => event.access === 'TRUSTED' && event.ok).length,
      lockFailed: access.filter((event) => event.access === 'TRUSTED' && !event.ok).length,
      failReasons: countBy(access.filter((event) => !event.ok), (event) => text(event.reason) || 'error'),
    },
    roomsMade: {
      byHub: prepared.filter((event) => event.via === 'meet-api').length,
      cohostsOk: prepared.filter((event) => event.via === 'meet-api' && event.cohostsOk).length,
      byCalendar: prepared.filter((event) => event.via === 'calendar').length,
      calendarReasons: countBy(prepared.filter((event) => event.via === 'calendar'), (event) => text(event.reason) || 'unknown'),
    },
    missing: { total: missing.length, byState: countBy(missing, (row) => text(row.state)) },
    falseMissingAvoided: falseMissing,
    foreignNotetakers: countBy(foreign, (event) => `${text(event.mailbox)} ${text(event.tool)}`),
    perMeeting: meetings.sort((a, b) => msOf(b.startAt) - msOf(a.startAt)).slice(0, 100),
  };
}
