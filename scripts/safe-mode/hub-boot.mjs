// Test helper: boot server.js in a child process with a temp data dir and the independent
// egress recorder in enforce mode, so nothing can leave the PC even if a guard fails.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const AUDIT = join(REPO, 'scripts', 'safe-mode', 'egress-audit.cjs').replace(/\\/g, '/');
export const ALLOWLIST = join(REPO, 'scripts', 'safe-mode', 'soak-allowlist.json');

/** Fake values shaped like the live hub .env. */
export const LIVE_LIKE = Object.freeze({
  APP_URL: 'https://asoldi.com',
  RESEND_API_KEY: 're_fake_live_like',
  SMTP_HOST: 'smtp.hostinger.com',
  SMTP_USER: 'contact@asoldi.com',
  SMTP_PASS: 'fake',
  PROD_ADMIN_URL: 'https://asoldi.com',
  PROD_ADMIN_PASSWORD: 'fake-prod-password',
  FIREFLIES_API_KEY: 'fake-ff',
  DEEPSEEK_API_KEY: 'fake-ds',
  ADMIN_SECRET: 'must-not-reach-the-child',
});

export function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Boot server.js. `seed(dataDir)` runs before the child starts. Shell HUB_SAFE_MODE*,
 * HOSTINGER and EMAIL_REDIRECT_TO are dropped so the test decides them.
 */
export async function bootHub(extraEnv = {}, { seed = null } = {}) {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), 'asoldi-hub-boot-'));
  if (typeof seed === 'function') await seed(dataDir);
  const shell = { ...process.env };
  for (const key of Object.keys(shell)) if (/^(HUB_SAFE_MODE|HUB_LISTEN_HOST|HOSTINGER|EMAIL_REDIRECT_TO|WEBSITE_MAKER_|SALES_PREVIEW_PUSH_URL|SALES_MAKER_STATUS|HUB_PUBLIC_URL_FOR_MAKER)/.test(key)) delete shell[key];
  const env = {
    ...shell,
    ...extraEnv,
    PORT: String(port),
    APP_DATA_DIR: dataDir,
    NODE_OPTIONS: `--require="${AUDIT}"`,
    EGRESS_AUDIT_FILE: join(dataDir, 'egress.jsonl'),
    EGRESS_AUDIT_ALLOW: ALLOWLIST,
    EGRESS_AUDIT_ENFORCE: '1',
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  let health = null;
  for (let i = 0; i < 120 && !health; i += 1) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) health = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return {
    base,
    port,
    dataDir,
    health,
    log: () => log,
    egressRows() {
      const file = join(dataDir, 'egress.jsonl');
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    /** Admin bearer token (polls until ensureData has created the admin; stays under the 10-failure login limit). */
    async adminToken(username, password) {
      await new Promise((r) => setTimeout(r, 1000));
      for (let i = 0; i < 8; i += 1) {
        const res = await fetch(`${base}/api/admin/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password }),
        }).catch(() => null);
        const json = res ? await res.json().catch(() => ({})) : {};
        if (json?.token) return json.token;
        await new Promise((r) => setTimeout(r, 750));
      }
      return '';
    },
    async stop() {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 800));
      if (child.exitCode === null) child.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 300));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
