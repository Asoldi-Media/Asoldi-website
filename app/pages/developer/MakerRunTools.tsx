import React, { useState } from 'react';
import { Copy, ExternalLink, Link2, Loader2, Wand2 } from 'lucide-react';
import { API } from '../Admin/shared';
import type { SalesMakerRunMeta, SalesWebsiteImportMeta } from '../Admin/shared';
import {
  LAN_MAKER_URL,
  buildMakerRunUrl,
  clientHasPublicPreviewSnapshot,
  createRunViaMakerPopup,
  getPublicClientPreviewUrl,
  healStaleLocalMakerBase,
  normalizeHttpBaseUrl,
  normalizeMakerDashboardDraftUrl,
  resolveMakerPreviewUrl,
  resolveOpenInMakerUrl,
} from '../sales/websiteMaker';

type MakerClientLike = {
  id: string;
  makerRun?: SalesMakerRunMeta | null;
  websiteImport?: SalesWebsiteImportMeta | null;
};

type Props = {
  salesClientId: string;
  client: MakerClientLike;
  websiteMakerBaseUrl: string;
  setWebsiteMakerBaseUrl: (value: string) => void;
  authHeaders: Record<string, string>;
  onReload: () => Promise<void> | void;
  onClientUpdated?: (client: Record<string, unknown> | null | undefined) => void;
  onError: (message: string) => void;
  onNotice?: (message: string) => void;
  allowCreate?: boolean;
  allowLink?: boolean;
  variant?: 'full' | 'tools';
};

async function makerRequest(path: string, init: RequestInit, authHeaders: Record<string, string>) {
  const headers: Record<string, string> = {
    ...authHeaders,
    ...(init.headers as Record<string, string> || {}),
  };
  if (init.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(`${API}${path}`, { ...init, headers });
  const data = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    const message = String(
      (data as { message?: string; error?: string })?.message
      || (data as { message?: string; error?: string })?.error
      || `Request failed (${response.status})`
    ).trim();
    throw new Error(message || `Request failed (${response.status})`);
  }
  return data;
}

export function MakerRunTools({
  salesClientId,
  client,
  websiteMakerBaseUrl,
  setWebsiteMakerBaseUrl,
  authHeaders,
  onReload,
  onClientUpdated,
  onError,
  onNotice,
  allowCreate = true,
  allowLink = true,
  variant = 'full',
}: Props) {
  const [creating, setCreating] = useState(false);
  const [opening, setOpening] = useState(false);
  const [linking, setLinking] = useState(false);
  const [runIdDraft, setRunIdDraft] = useState('');
  const makerRunId = String(client.makerRun?.runId || '').trim();
  const hasRun = Boolean(makerRunId);
  const publicPreviewUrl = getPublicClientPreviewUrl({
    id: salesClientId,
    websiteImport: client.websiteImport,
  });
  const makerPreviewUrl = resolveMakerPreviewUrl({
    baseUrl: websiteMakerBaseUrl,
    runId: makerRunId,
    storedPreviewUrl: String(client.makerRun?.previewUrl || ''),
    latestReadyStep: String(client.makerRun?.latestReadyStep || ''),
  });
  const makerDashboardUrl = resolveOpenInMakerUrl({
    baseUrl: websiteMakerBaseUrl,
    runId: makerRunId,
    storedDashboardUrl: normalizeMakerDashboardDraftUrl(String(client.makerRun?.dashboardUrl || '').trim()),
    intakeStatus: String(client.makerRun?.intakeStatus || ''),
    latestReadyStep: String(client.makerRun?.latestReadyStep || ''),
  });

  async function createMakerRun(forceNewRun = false) {
    if (forceNewRun) {
      const confirmed = window.confirm('Do you want to delete the other run request?');
      if (!confirmed) return;
    }
    setCreating(true);
    onError('');
    try {
      const makerBase =
        healStaleLocalMakerBase(websiteMakerBaseUrl) ||
        normalizeHttpBaseUrl(websiteMakerBaseUrl) ||
        LAN_MAKER_URL;
      if (makerBase !== websiteMakerBaseUrl) setWebsiteMakerBaseUrl(makerBase);
      let data = await makerRequest(`/admin/sales/${salesClientId}/create-maker-run`, {
        method: 'POST',
        body: JSON.stringify({ websiteMakerBaseUrl: makerBase, forceNewRun }),
      }, authHeaders);
      if (data?.browserHandoff) {
        const created = await createRunViaMakerPopup(
          String(data.websiteMakerBaseUrl || makerBase),
          data.requestBody && typeof data.requestBody === 'object'
            ? (data.requestBody as Record<string, unknown>)
            : {}
        );
        data = await makerRequest(`/admin/sales/${salesClientId}/create-maker-run`, {
          method: 'POST',
          body: JSON.stringify({
            websiteMakerBaseUrl: makerBase,
            forceNewRun,
            browserCreated: created,
          }),
        }, authHeaders);
      }
      const resolvedBase = normalizeHttpBaseUrl(String(data?.websiteMakerBaseUrl || '')) || makerBase;
      if (resolvedBase) setWebsiteMakerBaseUrl(resolvedBase);
      if (data?.client && onClientUpdated) onClientUpdated(data.client as Record<string, unknown>);
      else await onReload();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed creating website run');
    } finally {
      setCreating(false);
    }
  }

  async function openInMaker() {
    if (!makerRunId) {
      onError('No Website Maker run is linked to this client yet.');
      return;
    }
    onError('');
    const fallbackUrl = makerDashboardUrl || buildMakerRunUrl(websiteMakerBaseUrl, makerRunId, 'dashboard');
    if (!fallbackUrl) {
      onError('Could not resolve Website Maker URL for this client.');
      return;
    }
    // Open first. Refreshing the handoff asks Maker for the full run, and that
    // waits behind whatever step is already running.
    window.open(fallbackUrl, '_blank');
    setOpening(true);
    try {
      const data = await makerRequest(`/admin/sales/${salesClientId}/refresh-maker-handoff`, {
        method: 'POST',
        body: JSON.stringify({ websiteMakerBaseUrl, runId: makerRunId }),
      }, authHeaders);
      const resolvedBase = normalizeHttpBaseUrl(String(data?.websiteMakerBaseUrl || ''));
      if (resolvedBase) setWebsiteMakerBaseUrl(resolvedBase);
      if (data?.client && onClientUpdated) onClientUpdated(data.client as Record<string, unknown>);
      else await onReload();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Opened Maker, but the stored link could not be refreshed.');
    } finally {
      setOpening(false);
    }
  }

  async function linkMakerRun() {
    const runId = String(runIdDraft || '').trim();
    if (!runId) {
      onError('Enter an existing Website Maker run ID before linking.');
      return;
    }
    setLinking(true);
    onError('');
    try {
      const data = await makerRequest(`/admin/sales/${salesClientId}/link-maker-run`, {
        method: 'POST',
        body: JSON.stringify({ runId, websiteMakerBaseUrl }),
      }, authHeaders);
      setRunIdDraft('');
      if (data?.client && onClientUpdated) onClientUpdated(data.client as Record<string, unknown>);
      else await onReload();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed linking Website Maker run');
    } finally {
      setLinking(false);
    }
  }

  async function copyPublicUrl() {
    try {
      await navigator.clipboard.writeText(publicPreviewUrl);
      onNotice?.(`Copied ${publicPreviewUrl}`);
    } catch {
      onError(`Could not copy. Paste this: ${publicPreviewUrl}`);
    }
  }

  const toolsOnly = variant === 'tools';
  const createClass = toolsOnly
    ? 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50'
    : 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF5B00] text-white text-xs hover:bg-[#e55200] disabled:opacity-50';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {allowCreate && (
          <button
            type="button"
            onClick={() => void createMakerRun(hasRun)}
            disabled={creating}
            className={createClass}
          >
            {creating ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
            {hasRun ? 'New run' : 'Create run'}
          </button>
        )}
        {!toolsOnly && (
          <button
            type="button"
            onClick={() => void openInMaker()}
            disabled={!hasRun || opening}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
          >
            {opening ? <Loader2 size={13} className="animate-spin" /> : <ExternalLink size={13} />}
            Open in maker
          </button>
        )}
        <button
          type="button"
          onClick={() => makerPreviewUrl && window.open(makerPreviewUrl, '_blank')}
          disabled={!hasRun || !makerPreviewUrl}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
        >
          <ExternalLink size={13} />
          Maker preview
        </button>
        {!toolsOnly && (
          <button
            type="button"
            onClick={() => window.open(publicPreviewUrl, '_blank')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
            title={publicPreviewUrl}
          >
            <ExternalLink size={13} />
            Open preview
          </button>
        )}
        <button
          type="button"
          onClick={() => void copyPublicUrl()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
        >
          <Copy size={13} />
          Copy public URL
        </button>
      </div>
      {allowLink && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={runIdDraft}
            onChange={(e) => setRunIdDraft(e.target.value)}
            placeholder={hasRun ? `Linked run: ${makerRunId}` : 'Existing run ID (optional)'}
            className="px-3 py-1.5 rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-xs min-w-[180px] flex-1"
          />
          <button
            type="button"
            onClick={() => void linkMakerRun()}
            disabled={linking}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
          >
            {linking ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
            Link run
          </button>
        </div>
      )}
      <p className="text-[11px] text-gray-500 break-all">
        Public URL: <span className="text-gray-300">{publicPreviewUrl}</span>
        {clientHasPublicPreviewSnapshot(client) ? ' (live on asoldi.com)' : ' (updates after a Maker step)'}
      </p>
    </div>
  );
}
