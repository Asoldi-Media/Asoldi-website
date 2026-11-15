import React, { useState } from 'react';
import { DeveloperLanguageLockPopup } from '../DeveloperLanguageLockPopup';
import { DeveloperPagesPopup } from '../DeveloperPagesPopup';
import { MakerRunTools } from '../MakerRunTools';
import { authHeaders, developmentAuthHeaders, type SalesMakerRunMeta } from '../../Admin/shared';
import type { BoardItem } from './types';
import { blockingCodesOf, clientIdOf, makerOrigin, stagingCmsHref } from './lanes';
import { boardFetch, readBoardJson } from './useBoardPoll';

const LABELS: Record<string, string> = {
  'needs-language': 'Lås språk',
  'needs-pages': 'Velg sider',
  'needs-template': 'Velg mal',
  'dns-not-switched': 'Sett domene',
  'run-not-on-host': 'Koble Maker-vert',
  'maker-offline': 'Koble Maker-vert',
  'needs-confirm': 'Bekreft tjenester',
  'needs-payment-setup': 'Koble betaling',
};

type HostRow = { hostId: string; label: string; lastHeartbeatAt: string };

/** The popup or form a blocking code opens. Null when the code has no extra target. */
export function fixActionElement(
  code: string,
  item: BoardItem,
  pageHostname: string,
  onClose: () => void,
) {
  const runId = String(item.makerRun?.runId || '');
  const origin = makerOrigin(item.makerPort, pageHostname);
  if (code === 'needs-language') {
    return (
      <DeveloperLanguageLockPopup
        runId={runId}
        businessName={item.businessName || ''}
        websiteMakerBaseUrl={origin}
        authHeaders={{ ...authHeaders(), ...developmentAuthHeaders() }}
        onClose={onClose}
      />
    );
  }
  if (code === 'needs-pages') {
    return (
      <DeveloperPagesPopup
        runId={runId}
        businessName={item.businessName || ''}
        pages={Array.isArray(item.pages) ? item.pages : []}
        onClose={onClose}
      />
    );
  }
  return null;
}

function labelFor(code: string): string {
  return LABELS[code] || `Blokkering ${code}`;
}

/** The fields the existing Maker tools read. Missing strings stay empty. */
function makerRunMeta(item: BoardItem): SalesMakerRunMeta | null {
  const runId = String(item.makerRun?.runId || '').trim();
  if (!runId) return null;
  return {
    runId,
    dashboardUrl: '',
    previewUrl: '',
    latestReadyStep: '',
    latestStepStatus: '',
    exportPath: '',
    statusUpdatedAt: '',
    industry: String(item.industry || ''),
    createdAt: '',
  };
}

/** One inline action per blocking code. Language and pages reuse the existing popups. */
export function BlockingFixActions({
  item,
  codes,
  openCode = '',
  pageHostname = '',
  onChanged,
}: {
  item: BoardItem;
  codes?: string[];
  openCode?: string;
  pageHostname?: string;
  onChanged?: () => void;
}) {
  const list = codes && codes.length ? codes : blockingCodesOf(item);
  const [open, setOpen] = useState(openCode);
  const [domain, setDomain] = useState(item.websiteDomain || '');
  const [hosts, setHosts] = useState<HostRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const salesId = clientIdOf(item);
  const origin = makerOrigin(item.makerPort, pageHostname);
  const runId = String(item.makerRun?.runId || '');

  async function loadHosts() {
    setBusy(true);
    setError('');
    try {
      const response = await boardFetch('/admin/maker-hosts');
      const body = await readBoardJson<{ hosts?: Array<Record<string, unknown>> }>(response);
      if (!response.ok || !body) {
        setError('Vertlisten kunne ikke hentes.');
        setHosts([]);
        return;
      }
      const rows = Array.isArray(body.hosts) ? body.hosts : [];
      setHosts(rows.map((row) => ({
        hostId: String(row.hostId || ''),
        label: String(row.label || row.hostId || ''),
        lastHeartbeatAt: String(row.lastHeartbeatAt || ''),
      })).filter((row) => row.hostId));
    } catch {
      setError('Vertlisten kunne ikke hentes.');
      setHosts([]);
    } finally {
      setBusy(false);
    }
  }

  function choose(code: string) {
    setOpen(code);
    setError('');
    if (code === 'run-not-on-host' || code === 'maker-offline') void loadHosts();
  }

  async function saveDomain() {
    if (!runId) {
      setError('Ingen kjøring er koblet til kortet.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await boardFetch(`/admin/development/maker-run/${encodeURIComponent(runId)}/domain`, {
        method: 'POST',
        body: JSON.stringify({ websiteDomain: domain, salesClientId: salesId }),
      });
      if (!response.ok) setError('Domenet ble ikke lagret.');
      else onChanged?.();
    } catch {
      setError('Domenet ble ikke lagret.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmServices() {
    if (!salesId) return;
    setBusy(true);
    setError('');
    try {
      const response = await boardFetch(`/admin/sales/${encodeURIComponent(salesId)}/site-plan/confirm`, { method: 'POST' });
      if (!response.ok) setError('Tjenestene ble ikke bekreftet.');
      else onChanged?.();
    } catch {
      setError('Tjenestene ble ikke bekreftet.');
    } finally {
      setBusy(false);
    }
  }

  const showPortal = typeof document !== 'undefined';
  const paymentHref = stagingCmsHref(item);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {list.map((code) => (
          <button
            key={code}
            type="button"
            data-testid={`blocking-fix-${code}`}
            aria-expanded={open === code}
            onClick={() => choose(code)}
            className="rounded-md border border-amber-700/50 bg-amber-950/40 px-2 py-1 text-[11px] text-amber-100"
          >
            {labelFor(code)}
          </button>
        ))}
      </div>
      {showPortal && (open === 'needs-language' || open === 'needs-pages')
        ? fixActionElement(open, item, pageHostname, () => setOpen(''))
        : null}
      {open === 'needs-template' ? (
        <div className="rounded-xl border border-white/10 p-3 space-y-2">
          <p className="text-[11px] text-gray-400">Importer nytt eller velg eksisterende mal</p>
          {origin && salesId ? (
            <MakerRunTools
              salesClientId={salesId}
              client={{ id: salesId, makerRun: makerRunMeta(item) }}
              websiteMakerBaseUrl={origin}
              authHeaders={{ ...authHeaders(), ...developmentAuthHeaders() }}
              onReload={() => onChanged?.()}
              onError={setError}
              allowCreate
              allowLink={false}
              variant="create"
              businessName={item.businessName || ''}
            />
          ) : (
            <p className="text-[11px] text-gray-500">Kortet mangler port, så malvelgeren er ikke åpnet.</p>
          )}
        </div>
      ) : null}
      {open === 'dns-not-switched' ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void saveDomain();
          }}
        >
          <input
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            aria-label="Domene"
            placeholder="eksempel.no"
            className="min-w-0 flex-1 rounded-lg bg-[#1a1a1a] border border-white/10 px-2 py-1 text-xs"
          />
          <button type="submit" disabled={busy} className="rounded-lg bg-white/10 px-2 py-1 text-xs">Lagre domene</button>
        </form>
      ) : null}
      {open === 'run-not-on-host' || open === 'maker-offline' ? (
        <ul className="text-xs text-gray-200 space-y-1">
          {(hosts || []).map((host) => (
            <li key={host.hostId}>{host.label}{host.lastHeartbeatAt ? ` · ${host.lastHeartbeatAt}` : ''}</li>
          ))}
          {hosts && hosts.length === 0 ? <li>Ingen verter (0 av 0).</li> : null}
        </ul>
      ) : null}
      {open === 'needs-confirm' ? (
        <button type="button" disabled={busy} onClick={() => void confirmServices()} className="rounded-lg bg-[#FF5B00] px-2 py-1 text-xs text-white">
          Bekreft tjenester
        </button>
      ) : null}
      {open === 'needs-payment-setup' ? (
        paymentHref ? (
          <a href={paymentHref} className="text-xs text-[#FF5B00] underline">Åpne staging-CMS for betaling</a>
        ) : (
          <p className="text-[11px] text-gray-500">Kortet har ikke et offentlig domene for betaling.</p>
        )
      ) : null}
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
    </div>
  );
}
