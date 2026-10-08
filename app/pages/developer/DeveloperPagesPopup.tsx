import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { fetchLocalMakerJson } from '../../../lib/maker-browser-client.js';

type PageRow = {
  routePath?: string;
  sourceRoutePath?: string;
  pageTitle?: string;
  pageType?: string;
};

type Props = {
  runId: string;
  businessName?: string;
  pages: PageRow[];
  includedPageRoutes?: string[] | null;
  onClose: () => void;
  onSaved?: () => void;
};

const HOME = '/';

export function DeveloperPagesPopup({
  runId,
  businessName = '',
  pages,
  includedPageRoutes = null,
  onClose,
  onSaved,
}: Props) {
  const [loaded, setLoaded] = useState<PageRow[] | null>(null);
  const [err, setErr] = useState('');
  const list = useMemo(() => {
    const source = loaded || pages;
    return (Array.isArray(source) ? source : []).filter((page) => String(page?.routePath || '').trim());
  }, [loaded, pages]);
  const [draft, setDraft] = useState(() => {
    const next = new Set<string>();
    if (!Array.isArray(includedPageRoutes) || !includedPageRoutes.length) {
      for (const page of list) next.add(String(page.routePath));
    } else {
      const wanted = new Set(includedPageRoutes);
      wanted.add(HOME);
      for (const page of list) {
        const route = String(page.routePath || '');
        const source = String(page.sourceRoutePath || route);
        if (wanted.has(route) || wanted.has(source)) next.add(route);
      }
    }
    next.add(HOME);
    return next;
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if ((Array.isArray(pages) && pages.length) || !runId) return undefined;
    let cancelled = false;
    void fetchLocalMakerJson(`/api/runs/${encodeURIComponent(runId)}/included-pages`, {
      allowPublicOrigin: true,
    }).then((data) => {
      if (cancelled) return;
      const rows = Array.isArray((data as { pages?: PageRow[] }).pages) ? (data as { pages: PageRow[] }).pages : [];
      setLoaded(rows);
      setDraft((prev) => {
        if (prev.size > 1) return prev;
        const next = new Set<string>();
        for (const page of rows) next.add(String(page.routePath || ''));
        next.add(HOME);
        return next;
      });
    }).catch((error) => {
      if (!cancelled) setErr(error instanceof Error ? error.message : 'Kunne ikke lese sidene.');
    });
    return () => {
      cancelled = true;
    };
  }, [pages, runId]);

  function toggle(routePath: string) {
    if (routePath === HOME) return;
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(routePath)) next.delete(routePath);
      else next.add(routePath);
      next.add(HOME);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    setErr('');
    try {
      const everyChecked = list.length > 0 && list.every((page) => draft.has(String(page.routePath)));
      await fetchLocalMakerJson(`/api/runs/${encodeURIComponent(runId)}/included-pages`, {
        method: 'PUT',
        allowPublicOrigin: true,
        body: everyChecked ? { all: true } : { routes: [...draft] },
      });
      onSaved?.();
      onClose();
    } catch (error) {
      setErr(error instanceof Error ? error.message : 'Kunne ikke lagre sidene.');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl bg-[#2a2a2a] border border-white/10 p-4 text-white shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold">Sider</h3>
            <p className="text-xs text-gray-400 mt-1">
              {businessName ? `${businessName} · ` : ''}
              Sidene fra steg 1. Hjem blir alltid med. Steg 1.5 og 2 kjører bare de valgte.
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded-lg text-gray-400 hover:text-white hover:bg-white/10">
            <X size={16} />
          </button>
        </div>
        {err ? (
          <div className="mt-3 rounded-xl border border-red-700/40 bg-red-900/20 px-3 py-2 text-sm text-red-200">{err}</div>
        ) : null}
        {!list.length ? (
          <p className="mt-4 text-sm text-gray-400">Ingen sider er lagret på dette kjøringen ennå.</p>
        ) : (
          <ul className="mt-4 max-h-80 overflow-auto space-y-1">
            {list.map((page) => {
              const route = String(page.routePath || '');
              return (
                <li key={route}>
                  <label className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5 text-sm">
                    <input
                      type="checkbox"
                      checked={draft.has(route)}
                      disabled={route === HOME || busy}
                      onChange={() => toggle(route)}
                    />
                    <span className="truncate">{page.pageTitle || route}</span>
                    <span className="ml-auto text-[11px] text-gray-500 truncate">{route}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy || !list.length}
          className="mt-4 px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm hover:bg-[#e55200] disabled:opacity-50"
        >
          {busy ? 'Lagrer…' : 'Lagre sider'}
        </button>
      </div>
    </div>,
    document.body,
  );
}
