/**
 * Test-only egress guard, loaded with `node --import` into a hub booted by a test:
 * every TCP connection to anything but loopback is refused (the socket errors) and
 * logged as "[egress-guard] blocked <host>:<port>". HTTP, HTTPS, fetch (undici),
 * SMTP and IMAP clients all connect through net.Socket, so none of them can reach a
 * live system even if a real credential slipped into the child's environment.
 */
import net from 'node:net';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

function isLoopback(host) {
  const name = String(host || 'localhost').trim().toLowerCase();
  return LOOPBACK.has(name) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name) || name.endsWith('.localhost');
}

/** { host, port } from any connect() call shape, or null for a local pipe / unix socket. */
function target(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0]; // net.connect() passes normalized [options, cb]
  if (first && typeof first === 'object') {
    if (first.path) return null;
    return { host: first.host ?? 'localhost', port: first.port };
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null; // pipe path
  return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
}

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const to = target(args);
  if (to && !isLoopback(to.host)) {
    process.stderr.write(`[egress-guard] blocked ${to.host}:${to.port}\n`);
    const error = Object.assign(new Error(`egress blocked by test guard: ${to.host}`), { code: 'EGRESS_BLOCKED' });
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return originalConnect.apply(this, args);
};
