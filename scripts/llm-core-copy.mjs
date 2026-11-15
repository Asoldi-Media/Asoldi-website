// Test helper: a temporary copy of the LLM core (packages/suite/core/llm) with one or more hard rules of
// the data policy taken out, so a test can show that its assertion fails without the rule (a planted
// negative control built at test time). The real core is never changed.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CORE_DIR = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'packages', 'suite', 'core', 'llm');

/** Each rule: the exact source text in policy.js that enforces it, and what the copy holds instead. */
export const HARD_RULES = Object.freeze({
  // Rule 1: DeepSeek never receives personal or transcript data.
  'deepseek-never-personal': ["const NEVER_PERSONAL = new Set(['deepseek']);", 'const NEVER_PERSONAL = new Set([]);'],
  // Rule 2: DeepSeek receives client data only when it is synthetic or redacted.
  'deepseek-client-data': ["const CLIENT_DATA_ONLY_SYNTHETIC_OR_REDACTED = new Set(['deepseek']);", 'const CLIENT_DATA_ONLY_SYNTHETIC_OR_REDACTED = new Set([]);'],
  // Rule 6: images of real-client data go only to Claude.
  'client-images-claude-only': ['  if (!imageVerdict.allowed) return imageVerdict;', ''],
});

/**
 * Imports a copy of the core without the named hard rules.
 * @param {string[]} rules keys of HARD_RULES
 * @returns {Promise<{core: object, dispose: Function}>}
 */
export async function coreWithoutRules(rules = []) {
  const dir = mkdtempSync(join(tmpdir(), 'llm-core-copy-'));
  cpSync(CORE_DIR, join(dir, 'llm'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
  const policyPath = join(dir, 'llm', 'policy.js');
  let source = readFileSync(policyPath, 'utf8');
  for (const rule of rules) {
    const [text, replacement] = HARD_RULES[rule] || [];
    if (!text) throw new Error(`unknown hard rule "${rule}"`);
    const found = source.split(text).length - 1;
    if (found !== 1) throw new Error(`hard rule "${rule}": its source line was found ${found} times in policy.js (expected 1); update HARD_RULES`);
    source = source.replace(text, replacement);
  }
  writeFileSync(policyPath, source);
  const core = await import(pathToFileURL(join(dir, 'llm', 'index.js')).href);
  return { core, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
