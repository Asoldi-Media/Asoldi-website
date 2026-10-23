import { guardExternal } from './safe-mode.js';

function cleanEnvValue(key, fallback = '') {
  const value = process.env[key];
  if (!value) return fallback;
  return String(value).trim().replace(/^["']|["']$/g, '').trim();
}

export function getWordPressConfig() {
  return {
    url: cleanEnvValue('WORDPRESS_URL', 'https://asoldi.com'),
    username: cleanEnvValue('WORDPRESS_USERNAME'),
    password: cleanEnvValue('WORDPRESS_APP_PASSWORD'),
  };
}

function getAuthHeader() {
  const config = getWordPressConfig();
  if (!config.username || !config.password) {
    throw new Error('WordPress credentials not configured');
  }
  return `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`;
}

export async function wpFetch(endpoint, options = {}) {
  const config = getWordPressConfig();
  if (!config.url) return { success: false, error: 'WordPress URL not configured' };
  const method = String(options?.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !guardExternal('wordpressWrite', `${method} ${endpoint}`).allowed) {
    return { success: false, error: 'Blocked by hub safe mode (wordpressWrite).', safeMode: true };
  }

  try {
    const response = await fetch(`${config.url}/wp-json/wp/v2${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(config.username && config.password ? { Authorization: getAuthHeader() } : {}),
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, error: text || `HTTP ${response.status}` };
    }

    return { success: true, data: await response.json() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown WordPress error' };
  }
}

export async function testWordPressConnection() {
  const response = await wpFetch('/users/me?context=edit');
  return !!response.success;
}

export async function getWordPressEmployees() {
  const direct = await wpFetch('/users?per_page=100&context=edit&roles=employee');
  if (direct.success && Array.isArray(direct.data) && direct.data.length > 0) return direct;

  const allUsers = await wpFetch('/users?per_page=100&context=edit');
  if (!allUsers.success || !Array.isArray(allUsers.data)) return allUsers;

  const employees = allUsers.data.filter((user) => {
    const roles = Array.isArray(user.roles) ? user.roles : [];
    return roles.some((role) => ['employee', 'ansatt'].includes(String(role).toLowerCase()));
  });

  return { success: true, data: employees };
}

export function wpUserToWorkerData(user) {
  return {
    name: user.name || user.username || user.email,
    email: String(user.email || '').toLowerCase(),
    wordpressId: user.id ?? null,
    wordpressCreatedAt: user.registered_date ? String(user.registered_date).slice(0, 10) : '',
    role: 'caller',
    status: 'active',
    startDate: user.registered_date ? String(user.registered_date).slice(0, 10) : '',
  };
}

export async function syncWordPressEmployees() {
  const response = await getWordPressEmployees();
  if (!response.success) {
    return { success: false, employees: [], synced: 0, error: response.error || 'Failed to fetch employees from WordPress' };
  }

  const employees = (response.data || [])
    .map(wpUserToWorkerData)
    .filter((employee) => employee.email);

  return {
    success: true,
    employees,
    synced: employees.length,
  };
}
