'use strict';
/**
 * Loads a server start file the way the production host does: a CommonJS loader calls
 * require() on the path (LiteSpeed's lsnode.js, Passenger's node loader). require() of an ES
 * module refuses a module graph with a top-level await (ERR_REQUIRE_ASYNC_MODULE), which
 * `node server.js` and import() accept, so only this way of loading shows it.
 *
 *   node scripts/server-load/require-like-host.cjs <start file>
 *
 * SERVER_LOAD_MODE=import loads with import() instead (for comparing with a build that needs it).
 * SERVER_LOAD_ROUTES=<prefix> writes the Express route stack to <prefix>.loaded.txt as soon as
 *   the load returns, to <prefix>.listening.txt once the server listens, and to
 *   <prefix>.settled.txt two seconds later (a route added by late start-up work shows there).
 * Prints "[require-load] loaded" when the load returned, or "[require-load] failed <code>" and
 * exits with 7.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const startFile = path.resolve(process.argv[2] || 'server.js');
const routesPrefix = process.env.SERVER_LOAD_ROUTES || '';
const hostRequire = require('node:module').createRequire(startFile);

let app = null;
try {
  // The app's own express (CommonJS, so the same instance the start file gets).
  const express = hostRequire('express');
  const use = express.application.use;
  express.application.use = function capturingUse(...args) {
    if (!app) app = this;
    return use.apply(this, args);
  };
} catch {
  app = null;
}

function describeLayer(layer, index) {
  if (layer.route) {
    const methods = Object.keys(layer.route.methods).sort().join(',');
    const handlers = layer.route.stack.map((entry) => `${entry.method || '*'}:${entry.name || 'anonymous'}`).join(' ');
    return `${index}\troute\t${methods}\t${JSON.stringify(layer.route.path)}\t${handlers}`;
  }
  return `${index}\tuse\t${layer.name || 'anonymous'}\t${layer.regexp}`;
}

function writeRoutes(moment) {
  if (!routesPrefix) return;
  const stack = app && app._router ? app._router.stack : [];
  fs.writeFileSync(`${routesPrefix}.${moment}.txt`, `${stack.map(describeLayer).join('\n')}\n`);
}

const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function observedListen(...args) {
  this.once('listening', () => {
    writeRoutes('listening');
    console.log('[require-load] listening');
    if (routesPrefix) setTimeout(() => writeRoutes('settled'), 2000);
  });
  return listen.apply(this, args);
};

function failed(error) {
  console.log(`[require-load] failed ${error && error.code ? error.code : 'error'}`);
  console.error(error && error.stack ? error.stack : error);
  process.exit(7);
}

if (process.env.SERVER_LOAD_MODE === 'import') {
  import(pathToFileURL(startFile).href).then(() => {
    writeRoutes('loaded');
    console.log('[require-load] loaded');
  }, failed);
} else {
  try {
    require(startFile);
    writeRoutes('loaded');
    console.log('[require-load] loaded');
  } catch (error) {
    failed(error);
  }
}
