/**
 * Password rules for the client CMS admin that the hub sets (Superadmin → client admin user).
 *
 * The hub keeps only a bcrypt hash, and the client CMS adopts that hash on its next config
 * heartbeat, so the CMS never sees the plain password and cannot check it. The hub therefore
 * refuses weak passwords before hashing, with the same rules as the CMS admin itself
 * (website-cms: 8 to 1024 characters, and not a known default). A password longer than the
 * CMS sign-in accepts would lock the client admin out, so it is refused too.
 *
 * No dependencies: the admin UI imports this file too, so it can show the message before saving.
 * data/hub.js re-exports these names; this file is the only copy of the rule.
 */

export const CLIENT_ADMIN_MIN_PASSWORD_LENGTH = 8;
/** The longest password the CMS sign-in accepts (website-cms MAX_PASSWORD_LENGTH). */
export const CLIENT_ADMIN_MAX_PASSWORD_LENGTH = 1024;

/** Lower-case, compared after trimming. The CMS lists (1.7.x and 2.x) plus the hub's own defaults. */
export const CLIENT_ADMIN_KNOWN_DEFAULT_PASSWORDS = Object.freeze([
  'changeme',
  'change-me',
  'admin',
  'password',
  'passord',
  '12345678',
  '123456789',
  'administrator',
]);

export const CLIENT_ADMIN_PASSWORD_TOO_SHORT = `Passordet må ha minst ${CLIENT_ADMIN_MIN_PASSWORD_LENGTH} tegn.`;
export const CLIENT_ADMIN_PASSWORD_TOO_LONG = `Passordet kan ha høyst ${CLIENT_ADMIN_MAX_PASSWORD_LENGTH} tegn.`;
export const CLIENT_ADMIN_PASSWORD_TOO_COMMON = 'Dette passordet er for enkelt å gjette. Velg et annet passord.';

/**
 * Why a new client admin password is refused (Norwegian, for the admin UI), or '' when it is fine.
 * Spaces at the ends do not count towards the minimum; the maximum counts every character,
 * as the CMS sign-in does.
 */
export function clientAdminPasswordProblem(value) {
  if (typeof value !== 'string') return CLIENT_ADMIN_PASSWORD_TOO_SHORT;
  const trimmed = value.trim();
  if (trimmed.length < CLIENT_ADMIN_MIN_PASSWORD_LENGTH) return CLIENT_ADMIN_PASSWORD_TOO_SHORT;
  if (value.length > CLIENT_ADMIN_MAX_PASSWORD_LENGTH) return CLIENT_ADMIN_PASSWORD_TOO_LONG;
  if (CLIENT_ADMIN_KNOWN_DEFAULT_PASSWORDS.includes(trimmed.toLowerCase())) return CLIENT_ADMIN_PASSWORD_TOO_COMMON;
  return '';
}
