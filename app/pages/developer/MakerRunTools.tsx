import React, { useState } from 'react';
import { Copy, ExternalLink, Link2, Loader2, Wand2 } from 'lucide-react';
import { API } from '../Admin/shared';
import type { SalesMakerRunMeta, SalesWebsiteImportMeta } from '../Admin/shared';
import {
  buildMakerRunUrl,
  clientHasPublicPreviewSnapshot,
  createRunViaMakerPopup,
  openMakerCreatePopup,
  getPublicClientPreviewUrl,
  healStaleLocalMakerBase,
  normalizeHttpBaseUrl,
  normalizeMakerDashboardDraftUrl,
  resolveMakerPreviewUrl,
  resolveOpenInMakerUrl,
} from '../sales/websiteMaker';
import { LOCAL_EDITOR_ORIGIN } from '../../../lib/maker-editor-origin.js';
import { ensureLocalMaker, fetchMakerRunStatus, findMakerRunBySalesClientId } from './makerQueue';
import { makerHandoffFromLiveRun, pipelineStatusFromMakerRun, resolveLatestMakerPreviewStep } from '../../../lib/developer-card.js';

type MakerClientLike = {
  id: string;
  makerRun?: SalesMakerRunMeta | null;
  websiteImport?: SalesWebsiteImportMeta | null;
};

type Props = {
  salesClientId: string;
  client: MakerClientLike;
  websiteMakerBaseUrl: string;
  setWebsiteMakerBaseUrl?: (value: string) => void;
  authHeaders: Record<string, string>;
  onReload: () => Promise<void> | void;
  onClientUpdated?: (client: Record<string, unknown> | null | undefined) => void;
  onError: (message: string) => void;
  onNotice?: (message: string) => void;
  allowCreate?: boolean;
  allowLink?: boolean;
  variant?: 'full' | 'tools' | 'create';
  businessName?: string;
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

export async function createSalesMakerRun({
  salesClientId,
  businessName = '',
  websiteMakerBaseUrl,
  authHeaders,
  forceNewRun = false,
}: {
  salesClientId: string;
  businessName?: string;
  websiteMakerBaseUrl: string;
  authHeaders: Record<string, string>;
  forceNewRun?: boolean;
}) {
  if (!salesClientId) {
    throw new Error('This client is not linked to a sales record, so a Maker run cannot be created.');
  }
  try {
    await ensureLocalMaker();
  } catch {
    // Health ping from asoldi.com is often blocked. The Maker popup is the create path.
  }
  const makerBase =
    healStaleLocalMakerBase(websiteMakerBaseUrl) ||
    normalizeHttpBaseUrl(websiteMakerBaseUrl) ||
    LOCAL_EDITOR_ORIGIN;
  if (!forceNewRun) {
    try {
      const found = await findMakerRunBySalesClientId(salesClientId, businessName);
      const foundId = String(found?.runId || '').trim();
      if (foundId && Number(found?.progressScore || 0) > 0) {
        const live = await fetchMakerRunStatus(makerBase, foundId);
        const handoff = makerHandoffFromLiveRun(live.run || {});
        const data = await makerRequest(`/admin/development/${salesClientId}/sync-maker-run`, {
          method: 'POST',
          body: JSON.stringify({ runId: foundId, handoff }),
        }, authHeaders);
        return {
          runId: foundId,
          client: data?.client as Record<string, unknown> | undefined,
          linkedExisting: true,
        };
      }
    } catch {
      // Fall through and create a new draft when lookup fails.
    }
  }
  const popup = openMakerCreatePopup();
  if (!popup) {
    throw new Error('Popup blocked. Allow popups for this site and try again.');
  }
  try {
    let data = await makerRequest(`/admin/sales/${salesClientId}/create-maker-run`, {
      method: 'POST',
      body: JSON.stringify({ websiteMakerBaseUrl: makerBase, forceNewRun }),
    }, authHeaders);
    if (data?.browserHandoff) {
      const created = await createRunViaMakerPopup(
        String(data.websiteMakerBaseUrl || makerBase),
        data.requestBody && typeof data.requestBody === 'object'
          ? (data.requestBody as Record<string, unknown>)
          : {},
        popup
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
    try {
      if (!popup.closed) popup.close();
    } catch {
      // The Maker window may already have closed itself.
    }
    const runId = String(
      (data?.client as { makerRun?: { runId?: string } } | undefined)?.makerRun?.runId
      || (data?.handoff as { runId?: string } | undefined)?.runId
      || ''
    ).trim();
    return {
      runId,
      client: data?.client as Record<string, unknown> | undefined,
      linkedExisting: false,
    };
  } catch (error) {
    try {
      if (!popup.closed) popup.close();
    } catch {
      // Ignore a popup that is already gone.
    }
    throw error;
  }
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
  businessName = '',
}: Props) {
  const [creating, setCreating] = useState(false);
  const [localError, setLocalError] = useState('');
  const [opening, setOpening] = useState(false);
  const [linking, setLinking] = useState(false);
  const [runIdDraft, setRunIdDraft] = useState('');
  const makerRunId = String(client.makerRun?.runId || '').trim();
  const hasRun = Boolean(makerRunId);
  const publicPreviewUrl = getPublicClientPreviewUrl({
    id: salesClientId,
    websiteImport: client.websiteImport,
  });
  const previewStatus = pipelineStatusFromMakerRun(client.makerRun || {});
  const latestPreviewStep = resolveLatestMakerPreviewStep(previewStatus);
  const makerPreviewUrl = resolveMakerPreviewUrl({
    baseUrl: websiteMakerBaseUrl,
    runId: makerRunId,
    storedPreviewUrl: String(client.makerRun?.previewUrl || ''),
    latestReadyStep: latestPreviewStep === 'custom' ? 'custom' : (latestPreviewStep || String(client.makerRun?.latestReadyStep || '')),
    customSiteExists: Boolean(previewStatus.customSiteExists),
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
    setLocalError('');
    onError('');
    try {
      const created = await createSalesMakerRun({
        salesClientId,
        businessName,
        websiteMakerBaseUrl,
        authHeaders,
        forceNewRun,
      });
      if (created.client && onClientUpdated) onClientUpdated(created.client);
      else await onReload();
      if (created.linkedExisting) onNotice?.('Knyttet til eksisterende Website Maker-run.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed creating website run';
      setLocalError(message);
      onError(message);
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
      if (resolvedBase) setWebsiteMakerBaseUrl?.(resolvedBase);
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
  const createOnly = variant === 'create';
  const createClass = toolsOnly
    ? 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50'
    : 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF5B00] text-white text-xs hover:bg-[#e55200] disabled:opacity-50';

  if (createOnly) {
    if (hasRun || !allowCreate) return null;
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void createMakerRun(false);
        }}
        disabled={creating}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF5B00] text-white text-xs hover:bg-[#e55200] disabled:opacity-50"
      >
        {creating ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
        Start run
      </button>
    );
  }

  return (
    <div className="space-y-2" onClick={(event) => event.stopPropagation()}>
      <div className="flex flex-wrap gap-2">
        {allowCreate && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              void createMakerRun(hasRun);
            }}
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
      {localError ? (
        <p className="text-xs text-red-200">{localError}</p>
      ) : null}
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
