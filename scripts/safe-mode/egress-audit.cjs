/**
 * Independent egress recorder for the safe-mode soak.
 *
 *   NODE_OPTIONS=--require=./scripts/safe-mode/egress-audit.cjs node server.js
 *
 * Patches net.Socket#connect (every TCP/TLS connection: fetch, http, https,
 * nodemailer, IMAP) BEFORE the app loads. The app's own safe-mode guard wraps this
 * patch, so a line here means the connection got past the app guard.
 *
 * Env:
 *   EGRESS_AUDIT_FILE     JSONL output ({at, host, port, listed, blocked, pid})
 *   EGRESS_AUDIT_ALLOW    path to a JSON allowlist ({ "hosts": [...] }) or a comma list
 *   EGRESS_AUDIT_ENFORCE  '1': also refuse unlisted hosts (safety net while soaking)
 *
 * This file shares no code with lib/safe-mode-egress.js on purpose: the soak must
 * not trust the guard it is testing.
 */
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const file = process.env.EGRESS_AUDIT_FILE || path.join(process.cwd(), '.local-data', 'egress.jsonl');
const enforce = String(process.env.EGRESS_AUDIT_ENFORCE || '') === '1';

function loadAllow(raw) {
  const value = String(raw || '').trim();
  if (!value) return [];
  try {
    if (fs.existsSync(value)) {
      const parsed = JSON.parse(fs.readFileSync(value, 'utf8'));
      return (Array.isArray(parsed) ? parsed : parsed.hosts || []).map((entry) => String(entry).toLowerCase());
    }
  } catch {
    return [];
  }
  return value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

const allow = loadAllow(process.env.EGRESS_AUDIT_ALLOW);

function normalize(host) {
  let value = String(host || '').trim().toLowerCase();
  if (value.startsWith('[') && value.includes(']')) value = value.slice(1, value.indexOf(']'));
  if (value.startsWith('::ffff:')) value = value.slice(7);
  return value.replace(/\.$/, '');
}

function isLoopback(host) {
  return !host || host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host) || host.endsWith('.localhost');
}

function listed(host) {
  if (isLoopback(host)) return true;
  return allow.some((pattern) => {
    if (pattern.startsWith('*.')) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
    return host === pattern;
  });
}

function target(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') {
    if (first.path) return null;
    return { host: first.host || first.hostname || 'localhost', port: Number(first.port) || 0 };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) || 0 };
}

try {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Liveness marker: proves the recorder ran inside this process (the soak checks the hub's pid).
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), event: 'audit-start', pid: process.pid, enforce, allow: allow.length })}\n`);
} catch {
  // reported on first write
}

const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function egressAuditConnect(...args) {
  const t = target(args);
  if (!t) return original.apply(this, args);
  const host = normalize(t.host);
  const ok = listed(host);
  const blocked = enforce && !ok;
  try {
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), host, port: t.port, listed: ok, blocked, pid: process.pid })}\n`);
  } catch {
    // never break the app
  }
  if (blocked) {
    const error = Object.assign(new Error(`egress-audit: unlisted host ${host}`), { code: 'EEGRESSAUDIT' });
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return original.apply(this, args);
};
