import { google } from 'googleapis';
import { applyGoogleRequestDeadline } from './google-request-deadline.js';

const GOOGLE_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function sanitizeText(value = '') {
  return String(value ?? '').trim();
}

function getConfig() {
  return {
    clientId: sanitizeText(process.env.CLIENT_GOOGLE_CLIENT_ID),
    clientSecret: sanitizeText(process.env.CLIENT_GOOGLE_CLIENT_SECRET),
    redirectUri: sanitizeText(process.env.CLIENT_GOOGLE_REDIRECT_URI),
    appUrl: sanitizeText(process.env.APP_URL),
  };
}

export function isClientGoogleConfigured() {
  const { clientId, clientSecret } = getConfig();
  return Boolean(clientId && clientSecret);
}

export function getClientGoogleStatus(req) {
  const config = getConfig();
  return {
    configured: isClientGoogleConfigured(),
    redirectUri: isClientGoogleConfigured() ? resolveClientGoogleRedirectUri(req) : '',
    appUrl: config.appUrl,
  };
}

export function resolveClientGoogleRedirectUri(req) {
  const config = getConfig();
  if (config.redirectUri) return config.redirectUri;
  const base = config.appUrl || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}/api/client/auth/google/callback`;
}

function createOAuthClient(redirectUri) {
  const { clientId, clientSecret } = getConfig();
  if (!clientId || !clientSecret) {
    throw new Error('Google login is not configured. Missing CLIENT_GOOGLE_CLIENT_ID/SECRET.');
  }
  return applyGoogleRequestDeadline(new google.auth.OAuth2(clientId, clientSecret, redirectUri));
}

export function createClientGoogleAuthUrl(state, redirectUri) {
  const oauthClient = createOAuthClient(redirectUri);
  return oauthClient.generateAuthUrl({
    access_type: 'online',
    prompt: 'select_account',
    scope: GOOGLE_SCOPES,
    state: sanitizeText(state),
  });
}

export async function exchangeClientGoogleCode(code, redirectUri) {
  const oauthClient = createOAuthClient(redirectUri);
  const trimmedCode = sanitizeText(code);
  if (!trimmedCode) throw new Error('Missing OAuth code.');
  const { tokens } = await oauthClient.getToken(trimmedCode);
  if (!tokens?.access_token) throw new Error('Failed to exchange OAuth code for tokens.');
  oauthClient.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: 'v2', auth: oauthClient });
  const { data } = await oauth2.userinfo.get();
  const email = sanitizeText(data?.email).toLowerCase();
  if (!email) throw new Error('Google account did not return an email address.');
  if (data?.verified_email === false) {
    throw new Error('Google email address is not verified.');
  }
  return {
    email,
    name: sanitizeText(data?.name),
    picture: sanitizeText(data?.picture),
  };
}
