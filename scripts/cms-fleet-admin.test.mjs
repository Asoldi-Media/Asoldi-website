import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const admin = readFileSync(join(here, '../app/pages/Admin/Admin.tsx'), 'utf8');
const shared = readFileSync(join(here, '../app/pages/Admin/shared.ts'), 'utf8');
const fleet = readFileSync(join(here, '../app/pages/Admin/sections/CmsFleetSection.tsx'), 'utf8');
const clients = readFileSync(join(here, '../app/pages/Admin/sections/ClientSitesSection.tsx'), 'utf8');

test('Admin has no separate CMS sidebar page', () => {
  assert.doesNotMatch(shared, /export type Tab = .*'cms'/);
  assert.doesNotMatch(admin, /label="CMS"/);
  assert.doesNotMatch(admin, /tab === 'cms'/);
  assert.doesNotMatch(admin, /CmsFleetSection/);
});

test('client cards show running CMS version and push through local Maker', () => {
  assert.match(clients, /useCmsFleet/);
  assert.match(clients, /CMS \{running \|\| 'unknown'\}/);
  assert.match(clients, /Push CMS/);
  assert.match(clients, /CmsFleetToolbar/);
  assert.match(fleet, /Push CMS to selected/);
  assert.match(fleet, /Push CMS to all/);
  assert.match(fleet, /\/api\/cms-fleet/);
  assert.match(fleet, /fetchLocalMakerJson/);
  assert.match(fleet, /asoldiPageIsOnThisComputer/);
  assert.match(fleet, /CMS push runs from Website Creator on this computer/);
  const loadFleet = fleet.slice(fleet.indexOf('const loadFleet = useCallback'), fleet.indexOf('void loadFleet()'));
  assert.ok(loadFleet.indexOf('asoldiPageIsOnThisComputer') < loadFleet.indexOf('fetchLocalMakerJson'));
  assert.match(fleet, /cms\.site\.json/);
});
