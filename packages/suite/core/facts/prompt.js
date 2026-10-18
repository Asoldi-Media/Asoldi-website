/**
 * System prompt for turning a customer's free text into field operations.
 * The core gives English defaults; a harness passes its own language, labels, extra JSON keys and rules.
 */

export const DEFAULT_MERGE_RULES = `«current» is what the record already holds. Compare with it and set fieldActions for every field you fill:
- add (default): new information on top of what is there ("we also offer …", another review, another page). Write only the new part; we append it.
- replace: the customer corrects or swaps something ("new number", "we moved to …", "not X but Y", "change … to …"). Write the whole new value.
- delete: the customer asks to remove something ("remove", "we no longer have", "drop …"). Write what should go, or an empty string to clear the field.
Single-value fields: a new value is replace. Multi-value fields (phone, email): an extra value is add, a new one instead of the old is replace.
If unsure, use add, so nothing is lost.`;

export const DEFAULT_SOURCE_RULES = {
  email: `
This is an email from the customer (attachments included as text). Meeting times, cancellations, questions to us, greetings and signatures are NOT record facts. Phone and email in a signature belong to the person, not the company; use them only if they say so. If there are no facts about the business, answer with empty fields.`,
};

export const DEFAULT_LABELS = {
  intro: 'You receive what a customer writes and sort it into the record. You never invent facts, and you never ask about things they did not mention.',
  json: 'Answer with JSON:',
  fieldName: '<field name from fields>',
};

/**
 * @param {{schema: {fields: Record<string, {hint?: string}>}, labels?: object, shape?: string[],
 *   mediaLine?: string, footer?: string, mergeRules?: string, sourceRules?: Record<string,string>, source?: string}} options
 *   shape: extra JSON lines (`"key": description`) placed before fieldActions.
 */
export function buildFactPrompt({
  schema,
  labels = {},
  shape = [],
  mediaLine = '',
  footer = '',
  mergeRules = DEFAULT_MERGE_RULES,
  sourceRules = DEFAULT_SOURCE_RULES,
  source = '',
} = {}) {
  const text = { ...DEFAULT_LABELS, ...labels };
  const fieldLines = Object.entries(schema?.fields || {}).map(([key, field]) => `    ${JSON.stringify(key)}: ${JSON.stringify(field.hint || '')}`);
  const lines = [
    ...shape,
    `"fieldActions": { "${text.fieldName}": "add"|"replace"|"delete" }`,
    ...(mediaLine ? [mediaLine] : []),
    `"fields": {\n${fieldLines.join(',\n')}\n  }`,
  ];
  return `${text.intro}
${text.json}
{
${lines.map((line) => `  ${line}`).join(',\n')}
}
${footer}
${mergeRules}${sourceRules?.[source] || ''}`;
}
