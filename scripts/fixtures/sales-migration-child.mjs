// A second hub process reading the sales store while another process holds its lock
// (scripts/contract-signing.test.mjs). APP_DATA_DIR is the shared data folder. It prints "ready"
// once its modules are loaded, reads one line (a start time in ms) from stdin, waits for that
// moment, reads the sales store, and prints one JSON line with the client count.
const sales = await import('../../data/sales.js');
process.stdout.write('ready\n');
const startAt = Number(await new Promise((resolve) => {
  let buf = '';
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    if (buf.includes('\n')) resolve(buf.trim());
  });
}));
const wait = startAt - Date.now();
if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
const clients = sales.getSalesClients();
process.stdout.write(`${JSON.stringify({ count: clients.length })}\n`);
process.exit(0);
