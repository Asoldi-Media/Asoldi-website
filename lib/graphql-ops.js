/**
 * Does a GraphQL document write? Used by the safe-mode guards (Luca accounting, the
 * Fireflies and Luca egress rules). Dependency-free on purpose.
 *
 * A document writes when any top-level operation is a mutation or subscription, when
 * it cannot be read, or when `operationName` does not name one of its queries. Looking
 * only at how the text starts is not enough: 'query A { … } mutation B { … }' with
 * operationName 'B' runs the mutation.
 */

const OPERATION_TYPES = new Set(['query', 'mutation', 'subscription', 'fragment']);

/**
 * Top-level definitions: [{ type: 'query'|'mutation'|'subscription'|'fragment'|'unknown', name }].
 * Comments and strings (including block strings) are skipped; braces and parentheses
 * are tracked so nothing inside a selection set or an argument list is read.
 */
export function graphqlTopLevelDefinitions(source = '') {
  const text = String(source ?? '');
  const definitions = [];
  let braceDepth = 0;
  let parenDepth = 0;
  let pending = null;
  let skipNextName = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i += 1;
      continue;
    }
    if (ch === '"') {
      if (text.startsWith('"""', i)) {
        i += 3;
        while (i < text.length && !(text.startsWith('"""', i) && text[i - 1] !== '\\')) i += 1;
        i += 3;
      } else {
        i += 1;
        while (i < text.length && text[i] !== '"' && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
        i += 1;
      }
      continue;
    }
    if (ch === '{') {
      if (braceDepth === 0 && parenDepth === 0) {
        definitions.push(pending || { type: 'query', name: '' });
        pending = null;
      }
      braceDepth += 1;
      i += 1;
      continue;
    }
    if (ch === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      i += 1;
      continue;
    }
    if (ch === '(') {
      parenDepth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      i += 1;
      continue;
    }
    if (braceDepth === 0 && parenDepth === 0 && (ch === '@' || ch === '$')) {
      skipNextName = true;
      i += 1;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let end = i + 1;
      while (end < text.length && /[_0-9A-Za-z]/.test(text[end])) end += 1;
      const word = text.slice(i, end);
      i = end;
      if (braceDepth !== 0 || parenDepth !== 0) continue;
      if (skipNextName) {
        skipNextName = false;
        continue;
      }
      if (!pending) {
        pending = OPERATION_TYPES.has(word) ? { type: word, name: '' } : { type: 'unknown', name: word };
      } else if (!pending.name && pending.type !== 'unknown') {
        pending.name = word;
      }
      continue;
    }
    i += 1;
  }
  if (pending) definitions.push({ type: 'unknown', name: pending.name });
  return definitions;
}

/** True when running this document (with this operationName) could write. Unknown counts as a write. */
export function graphqlDocumentWrites(query = '', operationName = '') {
  const definitions = graphqlTopLevelDefinitions(query);
  if (!definitions.length) return true;
  if (definitions.some((def) => def.type !== 'query' && def.type !== 'fragment')) return true;
  const operations = definitions.filter((def) => def.type === 'query');
  if (!operations.length) return true;
  const wanted = String(operationName ?? '').trim();
  if (wanted && !operations.some((def) => def.name === wanted)) return true;
  return false;
}
