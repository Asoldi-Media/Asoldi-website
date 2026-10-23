#!/usr/bin/env node
/**
 * npm run dev:safe — the hub on this PC with live keys, in safe mode.
 *
 *   API  http://127.0.0.1:3101   (node server.js, HUB_SAFE_MODE=1)
 *   UI   http://127.0.0.1:3100   (Vite, proxies /api to 3101)
 *   Maker on 3000 is never touched.
 *
 * Options:
 *   --profile <name>     data dir .local-data/<name> (default: default), e.g. golden or soak
 *   --env-file <path>    env file to load (default: <repo>/.env); shell variables win over it
 *   --api-only           start only the API
 *   --egress-audit       preload scripts/safe-mode/egress-audit.cjs (writes <dataDir>/egress.jsonl)
 *   --unsafe-i-know      start even when safe mode would be off (HUB_SAFE_MODE=0)
 *   --api-port / --ui-port  override 3101 / 3100
 *
 * Refuses to start unless safe mode is on. Never prints env values.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { safeModeState } from '../lib/runtime-mode.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_API_PORT = 3101;
export const DEFAULT_UI_PORT = 3100;
export const MAKER_PORT = 3000;

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
}

export function profileName(raw = '') {
  const name = String(raw || 'default').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) throw new Error(`Bad --profile "${name}" (letters, digits, - and _ only).`);
  return name;
}

/**
 * Pure plan: which env each child gets and whether starting is allowed.
 * shellEnv wins over fileEnv (dotenv semantics); the forced block wins over both.
 */
export function planDevSafe({ argv = [], shellEnv = process.env, fileEnv = {}, repoRoot = REPO_ROOT } = {}) {
  const profile = profileName(argValue(argv, '--profile'));
  const apiPort = Number(argValue(argv, '--api-port')) || DEFAULT_API_PORT;
  const uiPort = Number(argValue(argv, '--ui-port')) || DEFAULT_UI_PORT;
  if ([apiPort, uiPort].includes(MAKER_PORT)) throw new Error('Port 3000 belongs to the Maker; pick another.');
  const dataDir = join(repoRoot, '.local-data', profile);
  const merged = { ...fileEnv, ...shellEnv };
  if (!String(merged.HUB_SAFE_MODE ?? '').trim()) merged.HUB_SAFE_MODE = '1';
  const forced = {
    PORT: String(apiPort),
    APP_URL: `http://127.0.0.1:${uiPort}`,
    APP_DATA_DIR: dataDir,
    PERSIST_PRODUCTION_ENV: '0',
    LAN_PREVIEW_AUTOPUBLISH: '0',
    WEBSITE_MAKER_LOCAL_URL: String(merged.WEBSITE_MAKER_LOCAL_URL || '').startsWith('http://127.0.0.1') ? merged.WEBSITE_MAKER_LOCAL_URL : `http://127.0.0.1:${MAKER_PORT}`,
    HUB_PUBLIC_URL_FOR_MAKER: `http://host.docker.internal:${apiPort}`,
  };
  const apiEnv = { ...merged, ...forced };
  delete apiEnv.ADMIN_SECRET;
  if (argv.includes('--egress-audit')) {
    const audit = join(repoRoot, 'scripts', 'safe-mode', 'egress-audit.cjs');
    apiEnv.NODE_OPTIONS = `${String(apiEnv.NODE_OPTIONS || '').trim()} --require="${audit.replace(/\\/g, '/')}"`.trim();
    apiEnv.EGRESS_AUDIT_FILE = join(dataDir, 'egress.jsonl');
  }
  // Vite gets the shell env only: its config can inline env values into the browser bundle.
  const uiEnv = { ...shellEnv, API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` };
  for (const key of Object.keys(fileEnv)) {
    if (!(key in shellEnv)) delete uiEnv[key];
  }
  const state = safeModeState(apiEnv);
  const unsafe = argv.includes('--unsafe-i-know');
  const refusal = !state.on && !unsafe
    ? `dev:safe refuses to start: safe mode would be OFF (${state.reason}). Unset HUB_SAFE_MODE=0, or pass --unsafe-i-know.`
    : '';
  return { ok: !refusal, refusal, profile, apiPort, uiPort, dataDir, apiEnv, uiEnv, state, apiOnly: argv.includes('--api-only') };
}

export function readEnvFile(file) {
  if (!file || !existsSync(file)) return {};
  return dotenv.parse(readFileSync(file, 'utf8'));
}

export function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolvePort) => {
    const socket = net.connect({ port, host }, () => {
      socket.end();
      resolvePort(true);
    });
    socket.setTimeout(400);
    socket.on('timeout', () => {
      socket.destroy();
      resolvePort(false);
    });
    socket.on('error', () => resolvePort(false));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const envFile = resolve(argValue(argv, '--env-file') || join(REPO_ROOT, '.env'));
  const plan = planDevSafe({ argv, shellEnv: process.env, fileEnv: readEnvFile(envFile), repoRoot: REPO_ROOT });
  if (!plan.ok) {
    console.error(plan.refusal);
    return 2;
  }
  for (const port of plan.apiOnly ? [plan.apiPort] : [plan.apiPort, plan.uiPort]) {
    if (await portInUse(port)) {
      console.error(`dev:safe: port ${port} is already in use. Stop that process or pass --api-port/--ui-port.`);
      return 1;
    }
  }
  mkdirSync(plan.dataDir, { recursive: true });
  console.log(`[dev:safe] safe mode ${plan.state.on ? 'ON' : 'OFF (--unsafe-i-know)'} (${plan.state.reason}) allow=${[...plan.state.allow].join(',') || '(none)'}`);
  console.log(`[dev:safe] API http://127.0.0.1:${plan.apiPort}${plan.apiOnly ? '' : `  UI http://127.0.0.1:${plan.uiPort}`}  data=.local-data/${plan.profile}  env=${existsSync(envFile) ? envFile : '(none)'}`);
  const children = [];
  const api = spawn(process.execPath, ['--max-http-header-size=65536', 'server.js'], { cwd: REPO_ROOT, env: plan.apiEnv, stdio: 'inherit' });
  children.push(api);
  if (!plan.apiOnly) {
    const viteBin = join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    const ui = spawn(process.execPath, [viteBin, `--port=${plan.uiPort}`, '--strictPort', '--host=127.0.0.1'], { cwd: REPO_ROOT, env: plan.uiEnv, stdio: 'inherit' });
    children.push(ui);
  }
  const stop = () => {
    for (const child of children) {
      try {
        child.kill('SIGTERM');
      } catch {
        // gone
      }
    }
  };
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  await new Promise((resolveExit) => api.on('exit', resolveExit));
  stop();
  return 0;
}

function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().then((code) => process.exit(code)).catch((error) => {
    console.error(`dev:safe: ${error?.message || error}`);
    process.exit(1);
  });
}
