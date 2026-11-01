// Client for the SEO record routes (lib/routes/seo-record-routes.js).
import { API } from '../Admin/shared';

export type AgreedKeyword = {
  phrase: string;
  status: 'proposed' | 'approved' | 'blocked';
  source: string;
  quoteRef?: string;
  flags?: string[];
  at?: string;
  by?: string;
};

export type PlanPhrase = { phrase: string; volume?: number; intent?: string; role?: string; difficulty?: number; qa?: string };

export type SeoRecordView = {
  salesClientId: string;
  agreedKeywords: AgreedKeyword[];
  planSummary: {
    mode?: string | null;
    builtAt?: string | null;
    town?: string;
    counts?: Record<string, number>;
    primaries?: PlanPhrase[];
    candidates?: PlanPhrase[];
    brand?: string[];
    qa?: { status?: string; score?: number | null } | null;
  } | null;
  pageMap: Array<{ route: string; kind?: string; primary?: string; indexable?: boolean }>;
  updatedAt: string | null;
  guidesConsumers: boolean;
  contractText: string | null;
  history: Array<{ at: string; by: string; action: string; phrase?: string }>;
};

export type SeoRecordAnswer = { seoRecorded: boolean; record: SeoRecordView | null };

async function call(path: string, headers: Record<string, string>, init: RequestInit = {}): Promise<SeoRecordAnswer> {
  const response = await fetch(`${API}/admin/sales-clients/${path}`, {
    ...init,
    headers: { ...headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(data?.message || `Søkeordene kunne ikke lastes (${response.status}).`));
  return { seoRecorded: Boolean(data?.seoRecorded), record: (data?.record || null) as SeoRecordView | null };
}

export function fetchSeoRecord(salesClientId: string, headers: Record<string, string>) {
  return call(`${encodeURIComponent(salesClientId)}/seo`, headers);
}

export function approveSeoKeyword(salesClientId: string, phrase: string, headers: Record<string, string>, source = 'developer') {
  return call(`${encodeURIComponent(salesClientId)}/seo/approve`, headers, { method: 'POST', body: JSON.stringify({ phrase, source }) });
}

export function blockSeoKeyword(salesClientId: string, phrase: string, headers: Record<string, string>) {
  return call(`${encodeURIComponent(salesClientId)}/seo/block`, headers, { method: 'POST', body: JSON.stringify({ phrase }) });
}

export function putAgreedKeywords(salesClientId: string, agreedKeywords: AgreedKeyword[], headers: Record<string, string>) {
  return call(`${encodeURIComponent(salesClientId)}/seo`, headers, {
    method: 'PUT',
    body: JSON.stringify({ agreedKeywords: agreedKeywords.map(({ phrase, status, source, quoteRef }) => ({ phrase, status, source, quoteRef })) }),
  });
}
