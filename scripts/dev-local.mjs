/**
 * Local site runner. Cursor Simple Browser hits http://localhost:3000.
 * An empty terminal used to mean ERR_CONNECTION_REFUSED.
 *
 * Docker sets API_PROXY_TARGET (web → api container) and must only start Vite.
 * On a laptop, start the API (3001) and Vite (3000) together, and restart a
 * child if it exits so a crash does not leave the browser hanging.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { pathToFileURL } from 'node:url';

export function resolveDevPlan(env = process.env) {
  if (String(env.API_PROXY_TARGET || '').trim()) {
    return { processes: ['ui'] };
  }
  return { processes: ['api', 'ui'] };
}

export function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host }, () => {
      socket.end();
      resolve(true);
    });
    socket.setTimeout(400);
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

const COMMANDS = {
  api: {
    label: 'api',
    port: Number(process.env.PORT || 3001),
    args: ['run', 'dev:api'],
  },
  ui: {
    label: 'web',
    port: 3000,
    args: ['run', 'dev:ui'],
  },
};

function npmBin() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function startChild(name, { restart = true } = {}) {
  const spec = COMMANDS[name];
  const child = spawn(npmBin(), spec.args, {
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
    cwd: process.cwd(),
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${spec.label}] exited (${signal || code}). Restarting in 800ms…`);
    if (restart) {
      setTimeout(() => {
        if (!shuttingDown) startChild(name);
      }, 800);
    }
  });
  return child;
}

async function waitForPort(port, label, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  console.error(`[${label}] still not listening on :${port} after ${timeoutMs}ms`);
  return false;
}

let shuttingDown = false;
const children = [];

export async function main() {
  const plan = resolveDevPlan();
  console.log(`Asoldi local: starting ${plan.processes.join(' + ')}`);
  for (const name of plan.processes) {
    const spec = COMMANDS[name];
    if (await portOpen(spec.port)) {
      console.log(`[${spec.label}] already listening on :${spec.port} — leaving it.`);
      continue;
    }
    children.push(startChild(name));
    if (name === 'api' && plan.processes.includes('ui')) {
      await waitForPort(spec.port, spec.label);
    }
  }
  const stop = () => {
    shuttingDown = true;
    for (const child of children) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) void main();
