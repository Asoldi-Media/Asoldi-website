/**
 * Password rules for the client CMS admin that the hub sets (Superadmin → client admin user).
 *
 * The hub keeps only a bcrypt hash, and the client CMS adopts that hash on its next config
 * heartbeat, so the CMS never sees the plain password and cannot check it. The hub therefore
 * refuses weak passwords before hashing, with the same rules as the CMS admin itself
 * (website-cms: at least 8 characters, and not a known default).
 *
 * No dependencies: the admin UI imports this file too, so it can show the message before saving.
 */

export const CLIENT_ADMIN_MIN_PASSWORD_LENGTH = 8;

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
export const CLIENT_ADMIN_PASSWORD_TOO_COMMON = 'Dette passordet er for enkelt å gjette. Velg et annet passord.';

/** Why a new client admin password is refused (Norwegian, for the admin UI), or null when it is fine. */
export function clientAdminPasswordProblem(value) {
  if (typeof value !== 'string') return CLIENT_ADMIN_PASSWORD_TOO_SHORT;
  const trimmed = value.trim();
  if (trimmed.length < CLIENT_ADMIN_MIN_PASSWORD_LENGTH) return CLIENT_ADMIN_PASSWORD_TOO_SHORT;
  if (CLIENT_ADMIN_KNOWN_DEFAULT_PASSWORDS.includes(trimmed.toLowerCase())) return CLIENT_ADMIN_PASSWORD_TOO_COMMON;
  return null;
}
