// Per-client mode of a delivery automation switch. 'auto' reaches only clients on the
// pilot list; every other included client runs in shadow, also while the pilot list is
// empty. This file is identical in every branch that adds it; change it only on the
// integration branch.
import { effectiveModeForClient, getAutomationSettings } from '../data/automation-settings.js';

export function spineModeForClient(switchPath, client, options = {}) {
  const settings = options.settings || getAutomationSettings({ dataDir: options.dataDir });
  const mode = effectiveModeForClient(switchPath, client, { ...options, settings });
  if (mode !== 'auto') return mode;
  const pilots = Array.isArray(settings.pilotClientIds) ? settings.pilotClientIds : [];
  return pilots.includes(String(client?.id || '')) ? 'auto' : 'shadow';
}
