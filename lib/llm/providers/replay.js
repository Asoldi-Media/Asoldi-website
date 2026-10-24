/**
 * Replay cassettes for the hub facade (profiles `replay` and `record`).
 *   <dataDir>/ai/cassettes/hub/<sha256>.json   one record per request (core cassetteRecord shape)
 * Records hold prompts and outputs, never keys; they stay on the data disk (never in the repo).
 * `replay:strict` with no cassette throws CassetteMissError (no provider is called).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CassetteMissError, cassettePath } from '../../../packages/suite/core/llm/index.js';
import { writeJsonAtomic } from '../../../data/atomic-json.js';

export const CASSETTE_SCOPE = 'hub';

export function createCassetteStore({ dataDir, scope = CASSETTE_SCOPE } = {}) {
  const root = join(dataDir, 'ai', 'cassettes');
  const pathFor = (key) => join(root, ...cassettePath(scope, key).split('/'));
  return Object.freeze({
    root,
    read(key) {
      let path;
      try {
        path = pathFor(key);
      } catch {
        return null;
      }
      if (!existsSync(path)) return null;
      try {
        const record = JSON.parse(readFileSync(path, 'utf8'));
        return record && typeof record === 'object' && record.response ? record : null;
      } catch {
        return null;
      }
    },
    save(record) {
      const path = pathFor(record?.key);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeJsonAtomic(path, record);
      return path;
    },
  });
}

export function createReplayAdapter({ store }) {
  return async function replayAdapter(call) {
    const record = store.read(call.cassetteKey);
    if (!record) throw new CassetteMissError(`No cassette for "${call.task}" (${String(call.cassetteKey).slice(0, 12)}).`, { task: call.task });
    const response = record.response || {};
    return {
      servedModel: response.servedModel || record.model || 'replay',
      text: response.text ?? '',
      ...(response.data !== undefined ? { data: response.data } : {}),
      ...(response.content !== undefined ? { content: response.content } : {}),
      stopReason: response.stopReason || 'end_turn',
      usage: response.usage || {},
    };
  };
}
