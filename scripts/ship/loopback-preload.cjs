/**
 * Dark-diff loopback guard: loaded with --require before the hub (after the egress recorder, which
 * lets every connection to this machine through). A hub under test may connect to its own port
 * (PORT) and to nothing else on this machine: a connection to any other local port (a dev Maker,
 * a database, another hub) is refused and recorded in DARK_DIFF_LOOPBACK_FILE as
 * { at, host, port, pid }. Unix sockets and named pipes are left alone. Without the env value this
 * file does nothing.
 */
'use strict';
const fs = require('node:fs');
const net = require('node:net');

const file = process.env.DARK_DIFF_LOOPBACK_FILE;
if (file) {
  const own = Number(process.env.PORT);

  const normalize = (host) => {
    let value = String(host || '').trim().toLowerCase();
    if (value.startsWith('[') && value.includes(']')) value = value.slice(1, value.indexOf(']'));
    if (value.startsWith('::ffff:')) value = value.slice(7);
    return value.replace(/\.$/, '');
  };
  const isLoopback = (host) => !host || host === 'localhost' || host === '::1' || host === '0.0.0.0' || host === '::' || /^127\./.test(host) || host.endsWith('.localhost');
  const target = (args) => {
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    if (first && typeof first === 'object') {
      if (first.path) return null;
      return { host: first.host || first.hostname || 'localhost', port: Number(first.port) || 0 };
    }
    if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) || 0 };
  };
  const record = (row) => {
    try {
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...row })}\n`);
    } catch {
      // never break the app
    }
  };

  record({ event: 'guard-start', port: Number.isFinite(own) ? own : null });
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function darkDiffLoopbackConnect(...args) {
    const t = target(args);
    if (!t) return original.apply(this, args);
    const host = normalize(t.host);
    if (!isLoopback(host) || (Number.isFinite(own) && t.port === own)) return original.apply(this, args);
    record({ host, port: t.port });
    const error = Object.assign(new Error(`connect ECONNREFUSED ${host}:${t.port} (dark-diff: only the hub's own port)`), { code: 'ECONNREFUSED', errno: -4078, syscall: 'connect', address: host, port: t.port });
    process.nextTick(() => this.destroy(error));
    return this;
  };
}
