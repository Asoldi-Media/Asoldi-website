// Release passes for tests. A delivery spine switch, and every gated mail kind, runs in auto only once
// the pre-release suite has recorded a pass for it (lib/spine-mode.js). A test that exercises its
// feature in auto therefore starts from settings that hold these passes. The release rule itself is
// tested in scripts/spine-mode.test.mjs and scripts/promotion.test.mjs.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASE_GATED_SWITCHES } from '../../packages/suite/core/delivery/vocab.js';

export const TEST_RELEASE = Object.freeze({ passedAt: '2026-11-01T00:00:00.000Z', suite: 'test', evidence: '', by: 'test' });

/** { <release id>: pass } for the given ids (default: every release-gated switch). */
export function testReleases(ids = RELEASE_GATED_SWITCHES) {
  return Object.fromEntries(ids.map((id) => [id, { ...TEST_RELEASE }]));
}

/** `settings` with the release passes added (a copy; passes already in `settings` win). */
export function withReleases(settings, ids) {
  return { ...settings, releases: { ...testReleases(ids), ...(settings?.releases || {}) } };
}

/** Writes an automation-settings.json that holds only release passes; a saved patch then merges over it. */
export function writeReleasesFile(dataDir, ids) {
  writeFileSync(join(dataDir, 'automation-settings.json'), JSON.stringify({ version: 2, releases: testReleases(ids) }));
}
