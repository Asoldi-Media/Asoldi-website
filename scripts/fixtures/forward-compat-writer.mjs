// Child process for scripts/forward-compat-revert.test.mjs.
// Runs the hub's data layer from --code-root (the current tree or an older commit) against
// APP_DATA_DIR and performs ordinary writes: one client update, a makerRun merge, a hubSite merge,
// a site update (plain and with a cms patch), a CMS heartbeat, the delivery-phase reconcile, an
// offer update and a product edit on that offer.
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const index = process.argv.indexOf('--code-root');
const codeRoot = index === -1 ? process.cwd() : process.argv[index + 1];
const load = (rel) => import(pathToFileURL(join(codeRoot, rel)).href);

const sales = await load('data/sales.js');
const hub = await load('data/hub.js');
const offers = await load('data/sales-offers.js');
const done = [];

sales.updateSalesClient('fc-client', { notes: 'touched by the older code' });
done.push('updateSalesClient');
if (typeof sales.setSalesMakerRun === 'function') {
  sales.setSalesMakerRun('fc-client', { latestReadyStep: '2', steps: { 2: 'ready' } });
  done.push('setSalesMakerRun');
}
sales.updateSalesClient('fc-client', { hubSite: { liveUrl: 'https://forward-compat.test' } });
done.push('updateSalesClient(hubSite)');
hub.updateSite('fc-site', { name: 'Touched site' });
done.push('updateSite');
if (typeof hub.recordHeartbeat === 'function') {
  hub.recordHeartbeat('fc-site-key', { packageVersion: '2.2.0' }, { verified: true });
  done.push('recordHeartbeat');
}
if (typeof hub.reconcileDeliveryPhases === 'function') {
  hub.reconcileDeliveryPhases(sales.getSalesClients());
  done.push('reconcileDeliveryPhases');
}
offers.updateSalesOffer('fc-offer', { adminNote: 'touched by the older code' });
done.push('updateSalesOffer');
// A rep's product edit as the composer sends it: the stored product (same id) without the keys
// this code does not know, at a new price. The stored product keys must survive it.
offers.updateSalesOffer('fc-offer', {
  products: offers.normalizeOfferProducts([{ id: 'p-Site', kind: 'custom', name: 'Site', priceExMva: 2099 }], { strict: true }),
});
done.push('updateSalesOffer(products)');
hub.updateSite('fc-site', { cms: { githubRepo: 'org/repo-2' } });
done.push('updateSite(cms)');
console.log(JSON.stringify({ ok: true, done }));
