import dotenv from 'dotenv';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getPersistentDataDir } from '../data/storage-path.js';

export const PRODUCTION_ENV_BACKUP_FILE = 'production.env';

/** Keys that belong on the Hostinger Environment variables tab for asoldi.com. */
export const PRODUCTION_ENV_KEYS = [
  'APP_URL',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'ADMIN_SECRET',
  'CMS_SITE_KEY',
  'CMS_DESIRED_PACKAGE_VERSION',
  'CLIENT_GOOGLE_CLIENT_ID',
  'CLIENT_GOOGLE_CLIENT_SECRET',
  'CLIENT_GOOGLE_REDIRECT_URI',
  'CLIENT_SOCIAL_DEV_MODE',
  'GOOGLE_MAPS_API_KEY',
  'GOOGLE_PLACES_API_KEY',
  'VITE_GOOGLE_MAPS_API_KEY',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REDIRECT_URI',
  'GOOGLE_CALENDAR_ID',
  'GOOGLE_CALENDAR_TIMEZONE',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'SMTP_REPLY_TO',
  'SMTP_BCC',
  'SMTP_FALLBACK_HOST',
  'SMTP_FALLBACK_PORT',
  'SMTP_FALLBACK_USER',
  'SMTP_FALLBACK_PASS',
  'SMTP_FALLBACK_FROM',
  'SMTP_FALLBACK_REPLY_TO',
  'RESEND_API_KEY',
  'RESEND_FROM',
  'SALES_EMAIL_COPY_TO',
  'SALES_EMAIL_AUTOSEND',
  'SALES_NOTIFY_EMAIL',
  'BOOKING_INBOX_EMAIL',
  'BOOKING_REPLY_TO',
  'SALES_CONTACT_EMAIL',
  'WORDPRESS_URL',
  'WORDPRESS_USERNAME',
  'WORDPRESS_APP_PASSWORD',
  'MYPHONER_API_KEY',
  'MYPHONER_PERSONAL_API_KEY',
  'MYPHONER_SUBDOMAIN',
  'MYPHONER_CAMPAIGN_ID',
  'MYPHONER_WEBHOOK_SECRET',
  'MYPHONER_WEBHOOK_BASE_URL',
  'MYPHONER_WEBHOOK_RECONCILE_ENABLED',
  'MYPHONER_WEBHOOK_RECONCILE_MS',
  'MYPHONER_WEBHOOK_REPLAY_WINDOW_MS',
  'MYPHONER_RECORDING_DOWNLOAD_ENABLED',
  'MYPHONER_DEFAULT_SALES_OWNER_KEY',
  'MYPHONER_SSU_LIST_IDS',
  'MYPHONER_SSU_WINS_LIST_IDS',
  'MYPHONER_SSU_WINS_LIST_NAME',
  'MYPHONER_SSU_WINS_SYNC_ENABLED',
  'SERPAPI_API_KEY',
  'SERP_API_KEY',
  'GEMINI_API_KEY',
  'LUCA_API_KEY',
  'LUCA_COMPANY_ID',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_CURRENCY',
  'STRIPE_PRICE_TIER_1_STANDARD',
  'STRIPE_PRICE_TIER_2_SEO',
  'STRIPE_PRICE_TIER_3_ECOMMERCE',
  'WEBSITE_MAKER_API_KEY',
  'WEBSITE_MAKER_BASE_URL',
  'WEBSITE_MAKER_STATUS_CALLBACK_TOKEN',
  'WEBSITE_MAKER_STATUS_CALLBACK_URL',
  'SALES_MAKER_STATUS_CALLBACK_TOKEN',
  'SALES_PREVIEW_PUSH_URL',
  'SALES_PREVIEW_PUBLIC_BASE',
  'FATHOM_WEBHOOK_TOKEN',
  'FATHOM_WEBHOOK_SECRET',
  'FATHOM_WEBHOOK_SECRETS',
  'FATHOM_NOTIFY_EMAIL',
  'FIREFLIES_WEBHOOK_TOKEN',
  'FIREFLIES_WEBHOOK_SECRET',
  'FIREFLIES_WEBHOOK_SECRETS',
  'FIREFLIES_API_KEY',
  'FIREFLIES_NOTETAKER_EMAIL',
  'FIREFLIES_NOTIFY_EMAIL',
  'FIREFLIES_MEDIA_MAX_MB',
  'HUB_MEDIA_MAX_MB',
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_MODEL',
  'DATAFORSEO_AUTH',
  'DATAFORSEO_LOGIN',
  'DATAFORSEO_PASSWORD',
  'DATAFORSEO_MAPS_BUDGET_USD',
  'DATAFORSEO_MAPS_DEPTH',
  'MAPS_RANKING_INTERVAL_DAYS',
  'CLIENT_GOOGLE_BUSINESS_REDIRECT_URI',
  'GOOGLE_BUSINESS_REDIRECT_URI',
];

export function getProductionEnvBackupPath(dataDir = getPersistentDataDir()) {
  return join(dataDir, PRODUCTION_ENV_BACKUP_FILE);
}

export function isDurableEnvHost(env = process.env) {
  const flag = String(env.PERSIST_PRODUCTION_ENV || '').trim();
  if (flag === '0') return false;
  if (flag === '1') return true;
  if (String(env.HOSTINGER || '').trim()) return true;
  const cwd = String(process.cwd() || '').replace(/\\/g, '/');
  if (/\/domains\/[^/]+\/nodejs\/?$/i.test(cwd)) return true;
  return /asoldi\.com/i.test(String(env.APP_URL || ''));
}

export function parseEnvFile(text = '') {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function serializeEnvFile(map = {}) {
  const lines = [
    '# Durable asoldi.com env backup. Lives in ~/.asoldi-website-data, not in Git.',
    '# Hostinger Environment variables remain the source you edit. This file only',
    '# fills gaps after a deploy that wiped the panel. Never commit this file.',
    '',
  ];
  for (const key of PRODUCTION_ENV_KEYS) {
    const value = map[key];
    if (value === undefined || value === null || value === '') continue;
    const text = String(value);
    const escaped =
      /[\n\r#"']/.test(text) || /\s/.test(text) ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : text;
    lines.push(`${key}=${escaped}`);
  }
  return `${lines.join('\n')}\n`;
}

export function readProductionEnvBackup(filePath = getProductionEnvBackupPath()) {
  if (!existsSync(filePath)) return {};
  try {
    return parseEnvFile(readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

export function mergeProductionEnv(existing = {}, live = process.env) {
  const next = { ...existing };
  for (const key of PRODUCTION_ENV_KEYS) {
    const value = String(live[key] ?? '').trim();
    if (value) next[key] = value;
  }
  return next;
}

export function applyPersistentProductionEnv({
  env = process.env,
  filePath = getProductionEnvBackupPath(),
} = {}) {
  if (!isDurableEnvHost(env)) {
    return { applied: false, reason: 'not-production-host', keys: 0 };
  }
  dotenv.config({ path: filePath, override: false });
  const merged = mergeProductionEnv(readProductionEnvBackup(filePath), env);
  const body = serializeEnvFile(merged);
  writeFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 });
  const keys = Object.keys(merged).filter((key) => PRODUCTION_ENV_KEYS.includes(key));
  if (keys.length) {
    console.log(`[env] durable backup ${filePath} keys=${keys.length}`);
  }
  return { applied: true, reason: 'ok', keys: keys.length };
}
