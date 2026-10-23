import { clientIpFromRequest } from "./auth-hardening.js";
import { noteSecurityEvent } from "./security-counters.js";
import { createSiteRequestLimits, formFieldsProblem } from "./site-public-guards.js";

// The site key in /api/client-forms/:siteKey is public (it is in the form HTML), so every caller is
// anonymous. Per 10 minutes: 8 forms per (site, address; an IPv6 /64 counts as one address). Past
// 120 forms for one site the hub counts and logs it but still delivers, so callers from many
// addresses cannot switch a site's form off; 1000 per site is the hard ceiling that protects the
// owner's inbox and the hub's mail sender. A call with the site's valid credential (the client CMS
// passing on its visitors' forms) counts in a per-site bucket of its own (600).
const FORM_WINDOW_MS = 10 * 60 * 1000;
const formLimits = createSiteRequestLimits({ windowMs: FORM_WINDOW_MS, perSiteAddress: 8, perSite: 120, perSiteHard: 1000, perSiteCredential: 600 });
const busyNoticeAt = new Map();

function compact(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

/** Tests only. */
export function resetClientFormLimitsForTests() {
  formLimits.reset();
  busyNoticeAt.clear();
}

/** Counts every form past the soft site cap; logs at most once per site and window. */
function noteBusySite(siteId) {
  noteSecurityEvent("client-form-site-busy");
  const now = Date.now();
  if (now - (busyNoticeAt.get(siteId) || 0) < FORM_WINDOW_MS) return;
  busyNoticeAt.set(siteId, now);
  console.warn(`[client-forms] site ${String(siteId).slice(0, 40)} received more than 120 forms in 10 minutes; still delivering up to 1000.`);
}

const SKIP_FIELDS = new Set([
  "site_key",
  "_gotcha",
  "gotcha",
  "honeypot",
  "website",
  "g-recaptcha-response",
]);

export function extractFormFields(body = {}) {
  const input = body && typeof body === "object" ? body : {};
  const fields = {};
  for (const [key, value] of Object.entries(input)) {
    const name = compact(key);
    if (!name || SKIP_FIELDS.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) {
      fields[name] = value.map((entry) => compact(entry)).filter(Boolean).join(", ");
    } else if (typeof value === "object" && value) {
      continue;
    } else {
      fields[name] = compact(value);
    }
  }
  return fields;
}

export function looksLikeBot(body = {}) {
  return Boolean(compact(body?._gotcha || body?.gotcha || body?.honeypot || body?.website));
}

export function setClientFormCors(req, res) {
  const origin = compact(req.get("origin")) || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function assertClientFormAllowed(req, { siteId = "", credentialValid = false } = {}) {
  const verdict = formLimits.take({ siteId: String(siteId || ""), address: clientIpFromRequest(req) || "unknown", credentialValid });
  if (verdict.overSoft) noteBusySite(String(siteId || ""));
  if (!verdict.ok) {
    const error = new Error("Too many form submissions. Try again later.");
    error.status = 429;
    error.retryAfterSec = verdict.retryAfterSec;
    throw error;
  }
}

/** Throws a 413 error when the extracted fields are over the field count or size limits. */
export function assertClientFormSize(fields) {
  const problem = formFieldsProblem(fields);
  if (!problem) return;
  const error = new Error("The form is too large.");
  error.status = 413;
  error.code = problem;
  throw error;
}

export function resolveFormRecipient(site = {}, fallback = "") {
  return (
    compact(site?.contactEmail) ||
    compact(fallback) ||
    compact(process.env.BOOKING_INBOX_EMAIL) ||
    compact(process.env.SALES_CONTACT_EMAIL) ||
    "kontakt@asoldi.com"
  );
}

/**
 * The sendEmail payload for a client form or CMS owner notice.
 * Without owner routing (routing.mode empty) it is exactly the legacy payload.
 * With routing (lib/owner-recipients.js resolveFormRouting) it goes to the owner,
 * with the routing's BCC and subject prefix.
 */
export function buildClientFormMail({ site, fields, pageUrl, routing = null }) {
  const email = buildFormEmail({ site, fields, pageUrl });
  const replyTo = replyToFromFields(fields);
  if (!routing || !routing.mode) {
    return {
      to: resolveFormRecipient(site),
      subject: email.subject,
      text: email.text,
      html: email.html,
      replyTo: replyTo || undefined,
    };
  }
  const payload = {
    to: routing.to,
    subject: `${routing.subjectPrefix || ""}${email.subject}`,
    text: email.text,
    html: email.html,
    replyTo: replyTo || undefined,
  };
  if (routing.bcc !== undefined) payload.bcc = routing.bcc;
  return payload;
}

export function buildFormEmail({ site, fields, pageUrl }) {
  const name = compact(site?.name) || compact(site?.domain) || "Client site";
  const domain = compact(site?.domain);
  const lines = Object.entries(fields).map(([key, value]) => `- ${key}: ${value || "(empty)"}`);
  const text = [
    `New contact form on ${name}${domain ? ` (${domain})` : ""}.`,
    pageUrl ? `Page: ${pageUrl}` : "",
    "",
    lines.join("\n") || "(No fields)",
  ]
    .filter((line, index, all) => line || index === all.length - 1)
    .join("\n");
  return {
    subject: `[${name}] New website inquiry`,
    text,
    html: `<pre style="font-family:sans-serif;white-space:pre-wrap;">${text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")}</pre>`,
  };
}

export function replyToFromFields(fields = {}) {
  const candidates = [
    fields.email,
    fields.Email,
    fields.epost,
    fields["E-post"],
    fields.mail,
    fields["your-email"],
  ];
  const email = candidates.map((value) => compact(value)).find((value) => /@/.test(value));
  return email || "";
}

export function wantsJsonResponse(req) {
  const accept = compact(req.get("accept")).toLowerCase();
  const requested = compact(req.get("x-requested-with")).toLowerCase();
  return accept.includes("application/json") || requested === "xmlhttprequest";
}

export function thankYouHtml({ name = "us", redirectUrl = "" } = {}) {
  const safeName = compact(name).replace(/</g, "");
  const redirect = compact(redirectUrl);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Message sent</title>
    ${redirect ? `<meta http-equiv="refresh" content="4;url=${redirect}">` : ""}
    <style>
      body { font-family: sans-serif; background: #111; color: #f4f4f4; display: grid; min-height: 100vh; place-items: center; margin: 0; }
      main { max-width: 36rem; padding: 2rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Thanks — we received your message.</h1>
      <p>${safeName} will get back to you shortly.</p>
      ${redirect ? `<p><a href="${redirect}" style="color:#9cf">Return to the website</a></p>` : ""}
    </main>
  </body>
</html>`;
}
