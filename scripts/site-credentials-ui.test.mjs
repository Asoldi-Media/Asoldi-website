// Manage clients and the Security card show the site credential state from the admin routes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (name) => readFileSync(new URL(`../app/pages/Admin/sections/${name}`, import.meta.url), 'utf8');
const panel = read('SiteCredentials.tsx');
const sites = read('ClientSitesSection.tsx');
const security = read('SecurityCard.tsx');

test('the site credential UI reads and changes only the admin routes, with the admin token', () => {
  for (const path of ['/api/hub/site-credentials', '/api/hub/site-credentials/settings', '/site-credential/revoke']) assert.ok(panel.includes(path), path);
  assert.match(panel, /authHeaders\(\)/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML|innerHTML/);
  assert.doesNotMatch(panel, /\.hash\b|hash:|x-site-credential/, 'no hash or credential is ever shown');
});

test('each site row shows enrolled, enrolled at and the proof domain, with a revoke button', () => {
  assert.match(panel, /Server credential: enrolled \{when\(info\.enrolledAt\)\}/);
  assert.match(panel, /proof from \$\{info\.proofDomain\}/);
  assert.match(panel, />\s*Revoke\s*</);
  assert.match(panel, /Server credential: not enrolled/);
  assert.match(sites, /<SiteCredentialStatus site=\{site\} info=\{credentials\.byId\.get\(String\(site\.id\)\)\}/);
});

test('the Security card has the enrollment switch and the counts', () => {
  assert.match(security, /<SiteCredentialsPanel \/>/);
  assert.match(panel, /Switch enrollment on/);
  assert.match(panel, /re-enrollments/);
});
