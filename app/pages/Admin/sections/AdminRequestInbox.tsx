import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { API, authHeaders as defaultAuthHeaders } from '../shared';
import { RequestThreadPanel, type RequestAuthHeaders } from '../../developer/DeveloperRequestThread';

type InboxRow = {
  salesClientId: string;
  businessName: string;
  updatedAt: string;
  unreadForAdmin: number;
  unreadForDeveloper: number;
  lastSnippet: string;
  lastAuthorRole: string;
  lastKind?: string;
  lastKindLabel?: string;
};

type Props = {
  salesClientId?: string;
  authHeaders?: RequestAuthHeaders;
};

function formatWhen(value = '') {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('nb-NO', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AdminRequestInbox({
  salesClientId = '',
  authHeaders,
}: Props) {
  const lockedId = String(salesClientId || '').trim();
  const resolvedHeaders = authHeaders || defaultAuthHeaders();
  const headersRef = useRef(resolvedHeaders);
  headersRef.current = resolvedHeaders;
  const authKey = String(resolvedHeaders.Authorization || '');
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [selectedId, setSelectedId] = useState(lockedId);
  const [loading, setLoading] = useState(!lockedId);
  const [error, setError] = useState('');

  const loadList = useCallback(async () => {
    if (lockedId) return;
    const response = await fetch(`${API}/admin/dev-requests`, { headers: headersRef.current });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.message || 'Kunne ikke laste forespørsler.');
    }
    setRows(Array.isArray(data.threads) ? data.threads : []);
  }, [lockedId, authKey]);

  useEffect(() => {
    if (lockedId) {
      setSelectedId(lockedId);
      return;
    }
    let active = true;
    setLoading(true);
    void loadList()
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : 'Kunne ikke laste forespørsler.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const timer = window.setInterval(() => {
      void loadList().catch(() => undefined);
    }, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [loadList, lockedId]);

  const openId = lockedId || selectedId;

  return (
    <div className="rounded-2xl bg-[#2a2a2a] border border-white/10 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-white">Forespørsler</h3>
        <p className="text-xs text-gray-400 mt-0.5">
          Tråd med kunde og utvikler. Domeneforespørsler og utviklerfiler vises på dette kundekortet.
        </p>
      </div>

      {error ? (
        <p className="text-xs text-red-300">{error}</p>
      ) : null}

      {!lockedId ? (
        <div className="space-y-2">
          {loading ? (
            <p className="text-xs text-gray-400 inline-flex items-center gap-2">
              <Loader2 size={13} className="animate-spin" /> Laster…
            </p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-gray-500">Ingen forespørsler ennå.</p>
          ) : (
            rows.map((row) => (
              <button
                key={row.salesClientId}
                type="button"
                onClick={() => setSelectedId(row.salesClientId)}
                className={`w-full text-left rounded-xl border px-3 py-2 ${
                  openId === row.salesClientId
                    ? 'bg-white/10 border-[#FF5B00]/40'
                    : 'bg-black/20 border-white/10 hover:bg-white/5'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-sm text-white truncate">{row.businessName || row.salesClientId}</span>
                  {row.unreadForAdmin > 0 ? (
                    <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-[#FF5B00] text-white">
                      {row.unreadForAdmin}
                    </span>
                  ) : (
                    <span className="text-[11px] text-gray-500">{formatWhen(row.updatedAt)}</span>
                  )}
                </span>
                {row.lastKindLabel ? (
                  <span className="block text-[11px] text-amber-300 truncate mt-0.5">{row.lastKindLabel}</span>
                ) : row.lastSnippet ? (
                  <span className="block text-[11px] text-gray-400 truncate mt-0.5">{row.lastSnippet}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}

      {openId ? (
        <RequestThreadPanel
          salesClientId={openId}
          authHeaders={resolvedHeaders}
          allowCommit={false}
        />
      ) : null}
    </div>
  );
}
