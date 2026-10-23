/**
 * First import in server.js: load .env, then decide safe mode and (when on) install
 * the egress guard before any other module can open a connection.
 *
 * ESM evaluates imports in order, so ./load-env.js runs before ./safe-mode.js pulls in
 * data/storage-path.js. The later dotenv.config() in server.js is a no-op re-read.
 */
import './load-env.js';
import { installSafeMode } from './safe-mode.js';
import './safe-mode-ai.js';

export const bootSafeModeState = installSafeMode();
