// The privacy and media switches in automation-settings.json, read in one place. Every switch is
// off by default; with all of them off nothing in this area writes data or answers on a new route.
import { getAutomationSettings } from '../data/automation-settings.js';

function node(settings, path) {
  return path.split('.').reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), settings);
}

function resolved(settings) {
  if (settings && typeof settings === 'object') return settings;
  try {
    return getAutomationSettings();
  } catch {
    return null;
  }
}

function enabled(settings, path) {
  return node(resolved(settings), path) === true;
}

/** privacy.archive.enabled: transcripts are archived on link and deleted on unlink. */
export function transcriptArchiveEnabled(settings) {
  return enabled(settings, 'privacy.archive.enabled');
}

/** privacy.purge: { enabled, mode: 'shadow' | 'auto' }. Anything but an explicit 'auto' is shadow. */
export function purgeSettings(settings) {
  const value = node(resolved(settings), 'privacy.purge') || {};
  return { enabled: value.enabled === true, mode: value.mode === 'auto' ? 'auto' : 'shadow' };
}

/** media.signedUrls.enabled: the media manifest and its signed download route. */
export function signedMediaEnabled(settings) {
  return enabled(settings, 'media.signedUrls.enabled');
}

/** media.rightsConfirm.enabled: the per-upload rights checkbox in the client portal. */
export function rightsConfirmEnabled(settings) {
  return enabled(settings, 'media.rightsConfirm.enabled');
}

/** fireflies.candidateRanker and fireflies.autoLink, with their defaults filled in. */
export function firefliesRankSettings(settings) {
  const base = resolved(settings) || {};
  const ranker = node(base, 'fireflies.candidateRanker') || {};
  const auto = node(base, 'fireflies.autoLink') || {};
  const minScore = Number(ranker.candidateMinScore);
  const window = Number(auto.slotWindowMinutes);
  return {
    rankerEnabled: ranker.enabled === true,
    candidateMinScore: Number.isFinite(minScore) ? minScore : 40,
    autoLinkEnabled: auto.enabled === true,
    // An exact attendee e-mail is always required; the setting can only make it stricter.
    requireExactAttendeeEmail: true,
    slotWindowMinutes: Number.isFinite(window) ? Math.max(0, Math.min(window, 240)) : 30,
    internalDomains: Array.isArray(base?.inbox?.internalDomains) ? base.inbox.internalDomains.map((d) => String(d).toLowerCase()) : ['asoldi.com'],
  };
}

/** A route answer for a switch that is off: 404 {code:'disabled'}. */
export function sendDisabled(res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).json({ code: 'disabled', message: 'Not enabled.' });
}
