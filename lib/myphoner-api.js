function cleanEnvValue(key, fallback = '') {
  const value = process.env[key];
  if (!value) return fallback;
  return String(value).trim().replace(/^["']|["']$/g, '').trim();
}

export function getMyPhonerConfig() {
  const personalApiKey = cleanEnvValue('MYPHONER_PERSONAL_API_KEY');
  const sharedApiKey = cleanEnvValue('MYPHONER_API_KEY');
  return {
    apiKey: personalApiKey || sharedApiKey,
    subdomain: cleanEnvValue('MYPHONER_SUBDOMAIN').toLowerCase(),
    campaignIds: cleanEnvValue('MYPHONER_CAMPAIGN_ID')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  };
}

export function getMyPhonerBaseUrl(config = getMyPhonerConfig()) {
  const subdomain = String(config?.subdomain || '').trim().toLowerCase();
  if (!subdomain) return '';
  return `https://${subdomain}.myphoner.com/api/v2`;
}

export function isMyPhonerConfigured(config = getMyPhonerConfig()) {
  return Boolean(String(config?.apiKey || '').trim() && String(config?.subdomain || '').trim());
}

function parseJson(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function buildMyPhonerApiUrl(endpoint, config = getMyPhonerConfig()) {
  const baseUrl = getMyPhonerBaseUrl(config);
  if (!baseUrl) return '';
  const raw = String(endpoint || '').trim();
  if (!raw) return '';
  const expectedHost = `${String(config.subdomain || '').toLowerCase()}.myphoner.com`;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      if (parsed.host.toLowerCase() !== expectedHost) return '';
      if (!parsed.pathname.startsWith('/api/v2/')) return '';
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
    }
    if (raw.startsWith('/api/v2/')) {
      return `https://${expectedHost}${raw}`;
    }
    const normalizedPath = raw.startsWith('/') ? raw : `/${raw}`;
    return `${baseUrl}${normalizedPath}`;
  } catch {
    return '';
  }
}

function normalizeErrorMessage(payload, fallback = '') {
  if (!payload) return fallback;
  if (typeof payload === 'string') return payload;
  if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error.trim();
  if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message.trim();
  if (typeof payload?.errors === 'string' && payload.errors.trim()) return payload.errors.trim();
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function retryDelayMsFromResponse(response, attempt = 0) {
  const reset = response?.headers?.get?.('Ratelimit-Reset') || response?.headers?.get?.('RateLimit-Reset');
  if (reset) {
    const asNumber = Number(reset);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      const resetMs = asNumber > 1e12 ? asNumber : asNumber * 1000;
      const wait = resetMs - Date.now();
      if (Number.isFinite(wait) && wait > 0) return Math.min(120_000, Math.max(1_000, wait));
    }
    const parsed = Date.parse(reset);
    if (Number.isFinite(parsed)) {
      const wait = parsed - Date.now();
      if (wait > 0) return Math.min(120_000, Math.max(1_000, wait));
    }
  }
  const retryAfter = Number(response?.headers?.get?.('Retry-After'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(120_000, Math.max(1_000, retryAfter * 1000));
  }
  return Math.min(60_000, 1000 * 2 ** Math.max(0, Number(attempt) || 0));
}

export async function myPhonerRequest(endpoint, options = {}) {
  const config = options?.config || getMyPhonerConfig();
  if (!isMyPhonerConfigured(config)) {
    return { success: false, status: 0, error: 'MyPhoner env not configured', data: null };
  }
  const url = buildMyPhonerApiUrl(endpoint, config);
  if (!url) {
    return { success: false, status: 0, error: 'Invalid MyPhoner endpoint URL.', data: null };
  }
  const method = String(options?.method || 'GET').toUpperCase();
  const body = options?.body;
  const headers = {
    Authorization: `Token "${config.apiKey}"`,
    Accept: 'application/json',
    ...(options?.headers && typeof options.headers === 'object' ? options.headers : {}),
  };
  if (body !== undefined && body !== null && !('Content-Type' in headers)) {
    headers['Content-Type'] = 'application/json';
  }
  const maxAttempts = Math.max(1, Number(options?.maxAttempts) || 5);
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const response = await fetch(url, {
        method,
        headers,
        body:
          body === undefined || body === null
            ? undefined
            : typeof body === 'string'
              ? body
              : JSON.stringify(body),
      });
      if (response.status === 429 && attempt < maxAttempts - 1) {
        await sleep(retryDelayMsFromResponse(response, attempt));
        continue;
      }
      const text = await response.text().catch(() => '');
      const parsed = parseJson(text);
      if (!response.ok) {
        const fallback = text || `HTTP ${response.status}`;
        return {
          success: false,
          status: response.status,
          error: normalizeErrorMessage(parsed, fallback),
          data: parsed,
        };
      }
      return {
        success: true,
        status: response.status,
        data: parsed,
        rawText: text,
      };
    }
    return { success: false, status: 429, error: 'MyPhoner rate limited', data: null };
  } catch (error) {
    return {
      success: false,
      status: 0,
      error: error instanceof Error ? error.message : 'Unknown MyPhoner error',
      data: null,
    };
  }
}

function normalizeListArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.lists)) return payload.lists;
  return [];
}

function normalizeLeadArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.leads)) return payload.leads;
  return [];
}

export async function listMyPhonerLists(options = {}) {
  const response = await myPhonerRequest('/lists', options);
  if (!response.success) return response;
  return { ...response, data: normalizeListArray(response.data) };
}

export async function listMyPhonerLeadsInList(listId, query = {}, options = {}) {
  const listKey = String(listId || '').trim();
  if (!listKey) return { success: false, status: 0, error: 'listId is required', data: [] };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(String(key), String(value));
  }
  const queryString = params.toString();
  const endpoint = `/lists/${encodeURIComponent(listKey)}/leads${queryString ? `?${queryString}` : ''}`;
  const response = await myPhonerRequest(endpoint, options);
  if (!response.success) return response;
  return { ...response, data: normalizeLeadArray(response.data) };
}

export async function listAllMyPhonerLeadsInList(listId, query = {}, options = {}) {
  const listKey = String(listId || '').trim();
  if (!listKey) return { success: false, status: 0, error: 'listId is required', data: [] };
  const perPage = Math.max(1, Math.min(100, Number(query?.per_page || query?.perPage) || 100));
  const maxPages = Math.max(1, Number(options?.maxPages) || 50);
  const pageDelayMs = Math.max(0, Number(options?.pageDelayMs) || 50);
  const leads = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await listMyPhonerLeadsInList(
      listKey,
      { ...query, per_page: perPage, page },
      options
    );
    if (!response.success) return { ...response, data: leads };
    const chunk = Array.isArray(response.data) ? response.data : [];
    leads.push(...chunk);
    if (typeof options?.onPage === 'function') {
      await options.onPage({ page, chunk, leads });
    }
    if (chunk.length < perPage) break;
    if (pageDelayMs) await sleep(pageDelayMs);
  }
  return { success: true, status: 200, data: leads };
}

export async function getMyPhonerList(listId, options = {}) {
  const listKey = String(listId || '').trim();
  if (!listKey) return { success: false, status: 0, error: 'listId is required', data: null };
  return myPhonerRequest(`/lists/${encodeURIComponent(listKey)}`, options);
}

export async function getMyPhonerListColumns(listId, options = {}) {
  const listKey = String(listId || '').trim();
  if (!listKey) return { success: false, status: 0, error: 'listId is required', data: [] };
  const response = await myPhonerRequest(`/lists/${encodeURIComponent(listKey)}/columns`, options);
  if (!response.success) return { ...response, data: [] };
  const columns = Array.isArray(response.data)
    ? response.data
    : Array.isArray(response.data?.columns)
      ? response.data.columns
      : [];
  return { ...response, data: columns };
}

export async function getMyPhonerListStats(listId, options = {}) {
  const listKey = String(listId || '').trim();
  if (!listKey) return { success: false, status: 0, error: 'listId is required', data: null };
  return myPhonerRequest(`/lists/${encodeURIComponent(listKey)}/stats`, options);
}

export async function createMyPhonerLeadInList(listId, leadFields = {}, options = {}) {
  const listKey = String(listId || '').trim();
  if (!listKey) return { success: false, status: 0, error: 'listId is required', data: null };
  const fields = leadFields && typeof leadFields === 'object' ? leadFields : {};
  return myPhonerRequest(`/lists/${encodeURIComponent(listKey)}/leads`, {
    ...options,
    method: 'POST',
    body: { lead: fields },
  });
}

export async function findMyPhonerLeadsInList(listId, query = {}, options = {}) {
  const listKey = String(listId || '').trim();
  if (!listKey) return { success: false, status: 0, error: 'listId is required', data: [] };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    params.set(String(key), String(value));
  }
  const queryString = params.toString();
  const endpoint = `/lists/${encodeURIComponent(listKey)}/leads/find${queryString ? `?${queryString}` : ''}`;
  const response = await myPhonerRequest(endpoint, options);
  if (!response.success) return { ...response, data: [] };
  return { ...response, data: normalizeLeadArray(response.data) };
}

export function unwrapMyPhonerLead(payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (payload.lead && typeof payload.lead === 'object' && !Array.isArray(payload.lead)) {
    return payload.lead;
  }
  return payload;
}

export async function markMyPhonerLeadWinner(leadId, { comment = '', category = '' } = {}, options = {}) {
  const id = String(leadId || '').trim();
  if (!id) return { success: false, status: 0, error: 'leadId is required', data: null };
  const lead = {};
  if (String(comment || '').trim()) lead.comment = String(comment).trim();
  if (String(category || '').trim()) lead.category = String(category).trim();
  return myPhonerRequest(`/leads/${encodeURIComponent(id)}/winner`, {
    ...options,
    method: 'POST',
    body: { lead },
  });
}

export async function fetchMyPhonerLeadById(leadId, options = {}) {
  const id = String(leadId || '').trim();
  if (!id) return { success: false, status: 0, error: 'leadId is required', data: null };
  return myPhonerRequest(`/leads/${encodeURIComponent(id)}`, options);
}

export async function fetchMyPhonerCallById(callId, options = {}) {
  const id = String(callId || '').trim();
  if (!id) return { success: false, status: 0, error: 'callId is required', data: null };
  return myPhonerRequest(`/calls/${encodeURIComponent(id)}`, options);
}

export async function fetchMyPhonerLeadEvents(leadId, options = {}) {
  const id = String(leadId || '').trim();
  if (!id) return { success: false, status: 0, error: 'leadId is required', data: null };
  return myPhonerRequest(`/leads/${encodeURIComponent(id)}/events`, options);
}

export function parseMyPhonerResourcePath(resourceUrl, config = getMyPhonerConfig()) {
  const raw = String(resourceUrl || '').trim();
  if (!raw) return '';
  const expectedHost = `${String(config?.subdomain || '').toLowerCase()}.myphoner.com`;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const parsed = new URL(raw);
      if (expectedHost && parsed.host.toLowerCase() !== expectedHost) return '';
      const path = `${parsed.pathname}${parsed.search}`;
      if (!path.startsWith('/api/v2/')) return '';
      return path;
    }
    if (raw.startsWith('/api/v2/')) return raw;
    if (raw.startsWith('/')) return `/api/v2${raw}`;
    return `/api/v2/${raw.replace(/^\/+/, '')}`;
  } catch {
    return '';
  }
}

export function extractMyPhonerIdFromResource(resourcePath = '', kind = 'leads') {
  const matcher = kind === 'calls'
    ? /\/calls\/([^/?#]+)/i
    : kind === 'lists'
      ? /\/lists\/([^/?#]+)/i
      : /\/leads\/([^/?#]+)/i;
  const match = String(resourcePath || '').match(matcher);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

export async function fetchMyPhonerLeadByResource(resourceUrl, options = {}) {
  const resourcePath = parseMyPhonerResourcePath(resourceUrl, options?.config || getMyPhonerConfig());
  if (!resourcePath) return { success: false, status: 0, error: 'Invalid MyPhoner lead resource URL.', data: null };
  return myPhonerRequest(resourcePath, options);
}

export async function fetchMyPhonerCallByResource(resourceUrl, options = {}) {
  const resourcePath = parseMyPhonerResourcePath(resourceUrl, options?.config || getMyPhonerConfig());
  if (!resourcePath) return { success: false, status: 0, error: 'Invalid MyPhoner call resource URL.', data: null };
  return myPhonerRequest(resourcePath, options);
}

export async function createMyPhonerListWebhook({ listId, targetUrl, event }, options = {}) {
  const listKey = String(listId || '').trim();
  const target = String(targetUrl || '').trim();
  const eventName = String(event || '').trim();
  if (!listKey || !target || !eventName) {
    return { success: false, status: 0, error: 'listId, targetUrl, and event are required.', data: null };
  }
  return myPhonerRequest(`/lists/${encodeURIComponent(listKey)}/webhook`, {
    ...options,
    method: 'POST',
    body: {
      webhook: {
        target_url: target,
        event: eventName,
      },
    },
  });
}

export async function createMyPhonerAccountWebhook({ targetUrl, event }, options = {}) {
  const target = String(targetUrl || '').trim();
  const eventName = String(event || '').trim();
  if (!target || !eventName) {
    return { success: false, status: 0, error: 'targetUrl and event are required.', data: null };
  }
  return myPhonerRequest('/webhooks', {
    ...options,
    method: 'POST',
    body: {
      webhook: {
        target_url: target,
        event: eventName,
      },
    },
  });
}

export async function listMyPhonerWebhooks(options = {}) {
  const response = await myPhonerRequest('/webhooks', options);
  if (!response.success) return response;
  const payload = response.data;
  const webhooks = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.webhooks)
      ? payload.webhooks
      : [];
  return { ...response, data: webhooks };
}

export async function deleteMyPhonerWebhook(webhookId, options = {}) {
  const id = String(webhookId || '').trim();
  if (!id) return { success: false, status: 0, error: 'webhookId is required.', data: null };
  return myPhonerRequest(`/webhook/${encodeURIComponent(id)}`, {
    ...options,
    method: 'DELETE',
  });
}

export function extractWebhookId(payload) {
  const rawId =
    payload?.id ??
    payload?.webhook?.id ??
    payload?.webhook_id ??
    payload?.data?.id ??
    '';
  return String(rawId || '').trim();
}

export function parseMyPhonerDateToIso(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const asDate = new Date(raw);
  if (Number.isFinite(asDate.getTime())) return asDate.toISOString();
  const normalized = raw.replace(' UTC', 'Z').replace(' ', 'T');
  const fallbackDate = new Date(normalized);
  if (Number.isFinite(fallbackDate.getTime())) return fallbackDate.toISOString();
  return '';
}
