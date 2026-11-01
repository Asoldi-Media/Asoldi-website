// What the privacy switches add to the Fireflies linker (lib/fireflies-linking.js onLinked / onUnlinked):
//   privacy.archive.enabled                              archive on link, delete the copy on unlink;
//   fireflies.candidateRanker or fireflies.autoLink on   one ids-only line in the link audit.
// With every switch off these hooks read the settings and write nothing.
import { getAutomationSettings } from '../data/automation-settings.js';
import { isPlaceholderMeetingId } from './offer-meetings.js';
import { appendFirefliesLinkAudit, linkActorKind } from './fireflies-candidate-rank.js';
import { onTranscriptLinked, onTranscriptUnlinked } from './transcript-archive.js';
import { firefliesRankSettings, transcriptArchiveEnabled } from './privacy-settings.js';

function text(value) {
  return String(value ?? '').trim();
}

function currentSettings() {
  try {
    return getAutomationSettings();
  } catch {
    return {};
  }
}

function auditOn(settings) {
  const rank = firefliesRankSettings(settings);
  return rank.rankerEnabled || rank.autoLinkEnabled;
}

export function privacyOnLinked(clientId, meetingId, { ref = {}, input = {} } = {}, { settings = currentSettings(), dataDir, now } = {}) {
  const id = text(meetingId);
  if (!id || isPlaceholderMeetingId(id)) return;
  if (auditOn(settings)) {
    const audit = input?.audit && typeof input.audit === 'object' ? input.audit : {};
    appendFirefliesLinkAudit({
      action: audit.action || 'link',
      meetingId: id,
      clientId,
      by: linkActorKind(ref?.linkedBy || input?.linkedBy),
      rank: audit.rank,
      score: audit.score,
    }, { dataDir, now });
  }
  if (transcriptArchiveEnabled(settings)) onTranscriptLinked(clientId, id, { ref, settings, dataDir, now });
}

export function privacyOnUnlinked(clientId, meetingId, { settings = currentSettings(), dataDir, now } = {}) {
  const id = text(meetingId);
  if (!id || isPlaceholderMeetingId(id)) return;
  if (auditOn(settings)) appendFirefliesLinkAudit({ action: 'unlink', meetingId: id, clientId, by: 'unknown' }, { dataDir, now });
  if (transcriptArchiveEnabled(settings)) onTranscriptUnlinked(clientId, id, { settings, dataDir });
}
