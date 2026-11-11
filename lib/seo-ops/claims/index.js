import { findRegulatedTerms } from "./check.js";

export { loadClaimsData, CLAIMS_DATA_FILES } from "./data.js";
export * from "./check.js";

/** The substance term a phrase names, or ''. Disease words are not substances. */
export function regulatedTermIn(phrase) {
  const hit = findRegulatedTerms(phrase, { healthContext: false }).find((row) => row.kind === "substance");
  return hit?.term || "";
}

export function isRegulatedPhrase(phrase) {
  return regulatedTermIn(phrase) !== "";
}

const SIGN_OFF_PARTIES = new Set(["asoldi", "client"]);

/**
 * A new plan with one compliance sign-off set. `party` is 'asoldi' or 'client'.
 * The other party's sign-off is left as it was. The input plan is not changed.
 */
export function signOffPlanCompliance(plan, { party, name, at } = {}) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) throw new Error("plan must be an object");
  if (!SIGN_OFF_PARTIES.has(party)) throw new Error("party must be asoldi or client");
  const trimmed = String(name ?? "").trim();
  if (!trimmed || trimmed.length > 120) throw new Error("name must be 1 to 120 characters");
  const raw = String(at ?? "");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) || !Number.isFinite(Date.parse(raw))) throw new Error("at must be an ISO date-time");
  const compliance = { ...(plan.compliance && typeof plan.compliance === "object" && !Array.isArray(plan.compliance) ? plan.compliance : {}) };
  compliance[party] = { name: trimmed, at: new Date(Date.parse(raw)).toISOString() };
  return { ...plan, compliance };
}
