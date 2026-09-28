import { readFileSync, existsSync } from 'fs';
import bcrypt from 'bcryptjs';
import { getDataFilePath, ensurePersistentDataDir, writeDataJson } from './storage-path.js';

const USERS_PATH = getDataFilePath('users.json');
const ADMIN_PATH = getDataFilePath('admin.json');

const SALT_ROUNDS = 12;

function ensureDataDir() {
  ensurePersistentDataDir();
}

function readUsers() {
  ensureDataDir();
  if (!existsSync(USERS_PATH)) return [];
  try {
    return JSON.parse(readFileSync(USERS_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function writeUsers(users) {
  ensureDataDir();
  writeDataJson(USERS_PATH, users);
}

function readAdmin() {
  ensureDataDir();
  if (!existsSync(ADMIN_PATH)) return null;
  try {
    return JSON.parse(readFileSync(ADMIN_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeAdmin(admin) {
  ensureDataDir();
  writeDataJson(ADMIN_PATH, admin);
}

export async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export async function getAdmin() {
  return readAdmin();
}

export async function setAdminCredentials(username, password) {
  const hash = await hashPassword(password);
  // Keep the sender profile (name / fromEmail / phone) — only the credentials change here.
  const current = readAdmin() || {};
  writeAdmin({ ...current, username, passwordHash: hash });
}

export async function verifyAdmin(username, password) {
  const admin = readAdmin();
  if (!admin || admin.username !== username) return false;
  return verifyPassword(password, admin.passwordHash);
}

export async function getAllUsers() {
  return migrateEmployeeProducts(seedKnownPhones(readUsers()));
}

/**
 * Phone numbers that must exist on the live install even though the data dir is never part of a deploy.
 * Seeded once (only when the user has no number yet); later edits in admin → Users win.
 */
const SEED_PHONES = {
  'alexander@asoldi.com': '+4792331098',
};

function seedKnownPhones(users) {
  let changed = false;
  for (const user of users) {
    const seeded = SEED_PHONES[String(user?.username || '').trim().toLowerCase()];
    if (seeded && !normalizePhone(user.phone)) {
      user.phone = seeded;
      changed = true;
    }
  }
  if (changed) writeUsers(users);
  return users;
}

/** Digits with a leading "+"; bare 8-digit Norwegian numbers get +47. '' when nothing usable is left. */
export function normalizePhone(value = '') {
  let digits = String(value ?? '').trim().replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  const plus = digits.startsWith('+');
  digits = digits.replace(/\D/g, '');
  if (!digits) return '';
  if (!plus && digits.length === 8) return `+47${digits}`;
  if (digits.length < 6 || digits.length > 15) return '';
  return `+${digits}`;
}

export async function getUserById(id) {
  const users = seedKnownPhones(readUsers());
  return users.find((u) => u.id === id) || null;
}

export async function getUserByUsername(username) {
  const users = seedKnownPhones(readUsers());
  return users.find((u) => u.username.toLowerCase() === username.toLowerCase()) || null;
}

const DEFAULT_ROLE = 'none';
const ROLES = ['employee', 'client', 'sales', 'developer', 'none'];
const DEFAULT_EMPLOYEE_PRODUCT = 'asoldi';
const EMPLOYEE_PRODUCTS = ['asoldi', 'ssu'];

function normalizeRole(r) {
  return ROLES.includes(r) ? r : DEFAULT_ROLE;
}

function normalizeEmployeeProduct(user) {
  if (normalizeRole(user.role) !== 'employee') return undefined;
  return EMPLOYEE_PRODUCTS.includes(user.employeeProduct) ? user.employeeProduct : DEFAULT_EMPLOYEE_PRODUCT;
}

function migrateEmployeeProducts(users) {
  let changed = false;
  for (const user of users) {
    if (user.role === 'employee' && !EMPLOYEE_PRODUCTS.includes(user.employeeProduct)) {
      user.employeeProduct = DEFAULT_EMPLOYEE_PRODUCT;
      changed = true;
    }
  }
  if (changed) writeUsers(users);
  return users;
}

export function toPublicUser(u) {
  const role = normalizeRole(u.role);
  const publicUser = {
    id: u.id,
    username: u.username,
    createdAt: u.createdAt,
    role,
    name: String(u.name || '').trim(),
    fromEmail: String(u.fromEmail || '').trim().toLowerCase(),
    phone: normalizePhone(u.phone),
  };
  if (role === 'employee') {
    publicUser.employeeProduct = normalizeEmployeeProduct(u);
  }
  return publicUser;
}

const GENERIC_STAFF_LOCAL = new Set(['admin', 'asoldi', 'asoldicom', 'contact', 'user']);

/** Email / local-part keys so damian@asoldi.com and the admin sender for that inbox count as the same person. */
export function staffIdentityKeys(profile = {}) {
  const keys = new Set();
  const add = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) return;
    keys.add(raw);
    if (raw.includes('@')) {
      const local = raw.split('@')[0];
      const compact = local.replace(/[^a-z0-9]/g, '');
      if (local && !GENERIC_STAFF_LOCAL.has(compact)) keys.add(local);
      return;
    }
    const compact = raw.replace(/[^a-z0-9]/g, '');
    if (!GENERIC_STAFF_LOCAL.has(compact)) keys.add(`${raw}@asoldi.com`);
  };
  add(profile.username);
  add(profile.fromEmail);
  return [...keys];
}

export function profilesShareStaffIdentity(left = {}, right = {}) {
  const keys = new Set(staffIdentityKeys(left));
  return staffIdentityKeys(right).some((key) => keys.has(key));
}

function firstNameLocal(value = '') {
  const first = String(value || '').trim().split(/\s+/)[0] || '';
  const compact = first.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!compact || GENERIC_STAFF_LOCAL.has(compact)) return '';
  return first.toLowerCase();
}

function findLinkedUser(admin = {}, extraUsername = '') {
  const users = seedKnownPhones(readUsers());
  const named = firstNameLocal(admin.name);
  const probe = {
    username: admin.username || extraUsername,
    fromEmail: admin.fromEmail
      || (String(extraUsername).includes('@') ? extraUsername : '')
      || (named ? `${named}@asoldi.com` : ''),
  };
  return users.find((user) => profilesShareStaffIdentity(user, probe)) || null;
}

function userIsAdminInbox(user, admin) {
  if (!user || !admin) return false;
  if (profilesShareStaffIdentity(user, admin)) return true;
  const linked = findLinkedUser(admin);
  return Boolean(linked && linked.id === user.id);
}

function syncAdminFromUser(user, { phone = false, name = false } = {}) {
  const admin = readAdmin();
  if (!admin || !userIsAdminInbox(user, admin)) return;
  let changed = false;
  if (phone) {
    const next = normalizePhone(user.phone);
    if (next !== normalizePhone(admin.phone)) {
      admin.phone = next;
      changed = true;
    }
  }
  if (name) {
    const next = String(user.name || '').trim();
    if (next && next !== String(admin.name || '').trim()) {
      admin.name = next;
      changed = true;
    }
  }
  if (changed) writeAdmin(admin);
}

function syncUsersFromAdmin(admin, { phone = false, name = false } = {}) {
  const users = readUsers();
  let changed = false;
  for (const user of users) {
    if (!userIsAdminInbox(user, admin)) continue;
    if (phone) {
      const next = normalizePhone(admin.phone);
      if (next !== normalizePhone(user.phone)) {
        user.phone = next;
        changed = true;
      }
    }
    if (name) {
      const next = String(admin.name || '').trim();
      if (next && next !== String(user.name || '').trim()) {
        user.name = next;
        changed = true;
      }
    }
  }
  if (changed) writeUsers(users);
}

/**
 * Phone/name for the person who is sending: admin.json when logged in as admin, otherwise the Users row.
 * If those two records are the same inbox, a number saved on either side is used.
 */
export function linkedSenderProfile({ role = '', userId = '', username = '' } = {}) {
  const admin = readAdmin() || {};
  if (String(role).toLowerCase() === 'admin') {
    const linked = findLinkedUser(admin, username);
    return {
      name: String(admin.name || linked?.name || '').trim(),
      fromEmail: String(admin.fromEmail || '').trim().toLowerCase(),
      phone: normalizePhone(admin.phone) || normalizePhone(linked?.phone),
      username: String(admin.username || username || '').trim(),
    };
  }
  const users = seedKnownPhones(readUsers());
  const user = (userId && users.find((entry) => entry.id === userId))
    || (username && users.find((entry) => String(entry.username || '').toLowerCase() === String(username).toLowerCase()))
    || null;
  const linkedAdmin = user && profilesShareStaffIdentity(user, admin) ? admin : null;
  return {
    name: String(user?.name || linkedAdmin?.name || '').trim(),
    fromEmail: String(user?.fromEmail || '').trim().toLowerCase(),
    phone: normalizePhone(user?.phone) || normalizePhone(linkedAdmin?.phone),
    username: String(user?.username || username || '').trim(),
  };
}

export async function createUser(username, password, role = DEFAULT_ROLE, extra = {}) {
  const users = readUsers();
  const existing = await getUserByUsername(username);
  if (existing) return { ok: false, error: 'Username already exists' };
  const id = String(Date.now());
  const passwordHash = await hashPassword(password);
  const userRole = normalizeRole(role);
  const name = String(extra.name || '').trim();
  const fromEmail = String(extra.fromEmail || '').trim().toLowerCase();
  const phone = normalizePhone(extra.phone);
  const created = {
    id,
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
    role: userRole,
    ...(name ? { name } : {}),
    ...(fromEmail ? { fromEmail } : {}),
    ...(phone ? { phone } : {}),
  };
  users.push(created);
  writeUsers(users);
  syncAdminFromUser(created, { phone: Boolean(phone), name: Boolean(name) });
  return { ok: true, user: toPublicUser(created) };
}

export async function updateUserProfile(id, patch = {}) {
  const users = readUsers();
  const i = users.findIndex((u) => u.id === id);
  if (i === -1) return { ok: false, error: 'User not found' };
  if (patch.name !== undefined) users[i].name = String(patch.name || '').trim();
  if (patch.fromEmail !== undefined) users[i].fromEmail = String(patch.fromEmail || '').trim().toLowerCase();
  if (patch.phone !== undefined) users[i].phone = normalizePhone(patch.phone);
  writeUsers(users);
  syncAdminFromUser(users[i], {
    phone: patch.phone !== undefined,
    name: patch.name !== undefined,
  });
  return { ok: true, user: toPublicUser(users[i]) };
}

export function publicAdminSender(admin = {}) {
  return {
    name: String(admin?.name || '').trim(),
    fromEmail: String(admin?.fromEmail || '').trim().toLowerCase(),
    phone: normalizePhone(admin?.phone),
    username: String(admin?.username || '').trim(),
  };
}

export async function getAdminSender() {
  return publicAdminSender(readAdmin() || {});
}

export async function updateAdminSender(patch = {}) {
  const admin = readAdmin() || {};
  if (patch.name !== undefined) admin.name = String(patch.name || '').trim();
  if (patch.fromEmail !== undefined) admin.fromEmail = String(patch.fromEmail || '').trim().toLowerCase();
  if (patch.phone !== undefined) admin.phone = normalizePhone(patch.phone);
  writeAdmin(admin);
  syncUsersFromAdmin(admin, {
    phone: patch.phone !== undefined,
    name: patch.name !== undefined,
  });
  return publicAdminSender(admin);
}

export async function updateUserPassword(id, newPassword) {
  const users = readUsers();
  const i = users.findIndex((u) => u.id === id);
  if (i === -1) return { ok: false, error: 'User not found' };
  users[i].passwordHash = await hashPassword(newPassword);
  writeUsers(users);
  return { ok: true };
}

export async function updateUserUsername(id, newUsername) {
  const users = readUsers();
  const i = users.findIndex((u) => u.id === id);
  if (i === -1) return { ok: false, error: 'User not found' };
  const existing = users.find((u) => u.username.toLowerCase() === newUsername.toLowerCase() && u.id !== id);
  if (existing) return { ok: false, error: 'Username already exists' };
  users[i].username = newUsername;
  writeUsers(users);
  return { ok: true };
}

export async function updateUserRole(id, role) {
  const users = readUsers();
  const i = users.findIndex((u) => u.id === id);
  if (i === -1) return { ok: false, error: 'User not found' };
  users[i].role = normalizeRole(role);
  if (users[i].role === 'employee') {
    if (!EMPLOYEE_PRODUCTS.includes(users[i].employeeProduct)) {
      users[i].employeeProduct = DEFAULT_EMPLOYEE_PRODUCT;
    }
  } else {
    delete users[i].employeeProduct;
  }
  writeUsers(users);
  return { ok: true };
}

export async function updateUserEmployeeProduct(id, product) {
  if (!EMPLOYEE_PRODUCTS.includes(product)) {
    return { ok: false, error: 'Invalid employee product' };
  }
  const users = readUsers();
  const i = users.findIndex((u) => u.id === id);
  if (i === -1) return { ok: false, error: 'User not found' };
  if (normalizeRole(users[i].role) !== 'employee') {
    return { ok: false, error: 'User is not an employee' };
  }
  users[i].employeeProduct = product;
  writeUsers(users);
  return { ok: true };
}

export async function deleteUser(id) {
  const users = readUsers();
  const filtered = users.filter((u) => u.id !== id);
  if (filtered.length === users.length) return { ok: false, error: 'User not found' };
  writeUsers(filtered);
  return { ok: true };
}

export async function deactivateUserKeepingData(id, reason = 'self-service-deactivation') {
  const users = readUsers();
  const index = users.findIndex((u) => u.id === id);
  if (index === -1) return { ok: false, error: 'User not found' };
  const existing = users[index] || {};
  users[index] = {
    ...existing,
    role: 'none',
    deactivatedAt: existing.deactivatedAt || new Date().toISOString(),
    deactivatedReason: String(reason || 'self-service-deactivation'),
    previousRole: existing.previousRole || existing.role || 'none',
  };
  writeUsers(users);
  return { ok: true };
}

export async function verifyEmployee(username, password) {
  const user = await getUserByUsername(username);
  if (!user) return { ok: false };
  const valid = await verifyPassword(password, user.passwordHash);
  const role = normalizeRole(user.role);
  if (!valid || role !== 'employee') return { ok: false };
  return {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      role,
      employeeProduct: normalizeEmployeeProduct(user),
    },
  };
}

export async function verifyStaff(username, password) {
  const user = await getUserByUsername(username);
  if (!user) return { ok: false };
  const valid = await verifyPassword(password, user.passwordHash);
  const role = normalizeRole(user.role);
  if (!valid || (role !== 'employee' && role !== 'sales' && role !== 'developer')) return { ok: false };
  return {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      role,
      employeeProduct: role === 'employee' ? normalizeEmployeeProduct(user) : undefined,
    },
  };
}

export async function verifyClient(username, password) {
  const user = await getUserByUsername(username);
  if (!user) return { ok: false };
  const valid = await verifyPassword(password, user.passwordHash);
  const role = normalizeRole(user.role);
  if (!valid || role !== 'client') return { ok: false };
  return {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      role,
    },
  };
}

