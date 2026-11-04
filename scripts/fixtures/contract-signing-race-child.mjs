// One of two processes that sign the same client at the same moment (scripts/contract-signing.test.mjs).
// APP_DATA_DIR is the shared data folder; argv: <clientId> <startAtMs>. Mail goes to the safe-mode outbox.
const [clientId, startAt] = process.argv.slice(2);
const { installSafeMode } = await import('../../lib/safe-mode.js');
installSafeMode({ env: { ...process.env, HUB_SAFE_MODE: '1' }, dataDir: process.env.APP_DATA_DIR, log: null });
const signing = await import('../../lib/contract-signing.js');
const wait = Number(startAt) - Date.now();
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
const result = await signing.markContractSigned(clientId, { source: 'progression', actor: `race-${process.pid}` });
process.stdout.write(`${JSON.stringify({
  ok: result.ok,
  mode: result.mode,
  alreadySigned: result.alreadySigned === true,
  mailed: result.mailed === true,
  siteId: result.site?.id || '',
  reason: result.reason || '',
})}\n`);
