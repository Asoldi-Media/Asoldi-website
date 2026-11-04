/**
 * The delivery brief contract: scripts/schemas/delivery-brief.schema.json (asoldi.delivery-brief/1,
 * with the facts block asoldi.brief.facts/1), checked with the suite's dependency-free JSON-schema
 * validator. The schema is append-only; its sha256 (line endings normalized) is pinned below, so a
 * changed schema fails the contract test until the pin, the fixtures and every reader that vendors
 * the file are updated together.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateJson } from '../../packages/suite/core/llm/json.js';

export const DELIVERY_BRIEF_SCHEMA_ID = 'asoldi.delivery-brief/1';
export const BRIEF_FACTS_SCHEMA_ID = 'asoldi.brief.facts/1';
export const DELIVERY_BRIEF_SCHEMA_PATH = fileURLToPath(new URL('../../scripts/schemas/delivery-brief.schema.json', import.meta.url));
export const DELIVERY_BRIEF_FIXTURES_DIR = fileURLToPath(new URL('../../scripts/fixtures/delivery-brief/', import.meta.url));

// sha256 of the schema file with CRLF normalized to LF. Change it only together with the schema.
export const DELIVERY_BRIEF_SCHEMA_SHA256 = '8586fb0b764618020e39e0f13db5caa840293a448d13ed7005d6d31c421fb963';

/** sha256 hex of a schema text, line endings normalized (a CRLF checkout hashes like an LF one). */
export function schemaTextHash(text) {
  return createHash('sha256').update(String(text ?? '').replace(/\r\n/g, '\n')).digest('hex');
}

export function readSchemaText(path = DELIVERY_BRIEF_SCHEMA_PATH) {
  return readFileSync(path, 'utf8');
}

let cachedSchema = null;

/** The parsed schema (read once). */
export function deliveryBriefSchema() {
  if (!cachedSchema) cachedSchema = JSON.parse(readSchemaText());
  return cachedSchema;
}

/** { ok, expected, actual } for a schema text against the pinned hash. */
export function checkSchemaHash(text = readSchemaText(), expected = DELIVERY_BRIEF_SCHEMA_SHA256) {
  const actual = schemaTextHash(text);
  return { ok: actual === expected, expected, actual };
}

/** Validates a whole brief. Returns { valid, errors: [{path, message}] }. */
export function validateDeliveryBrief(brief, { schema = deliveryBriefSchema(), maxErrors = 50 } = {}) {
  return validateJson(brief, schema, { maxErrors });
}

/** Validates only a facts block (asoldi.brief.facts/1) against the schema's facts definition. */
export function validateBriefFacts(facts, { schema = deliveryBriefSchema(), maxErrors = 50 } = {}) {
  return validateJson(facts, { ...schema.$defs.facts, $defs: schema.$defs }, { maxErrors });
}
