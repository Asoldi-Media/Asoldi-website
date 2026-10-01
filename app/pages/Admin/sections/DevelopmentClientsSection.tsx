import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Loader2, Search, X } from 'lucide-react';
import {
  API,
  developmentAuthHeaders,
  type DevelopmentItem,
} from '../shared';
import { buildClientSearchHaystack, matchesClientSearchQuery, normalizeClientSearchText } from '../clientSearch';
import { RECENT_OVERDUE_MS } from '../../../../lib/sales-next-actions.js';
import { DeveloperClientCard } from '../../developer/DeveloperClientCard';
import { DeveloperRunQueueBar } from '../../developer/DeveloperRunQueueBar';
import {
  LAN_MAKER_URL,
  LOCAL_MAKER_URL,
  openMakerTunnelPopup,
  tunnelPopupMakerOrigin,
  useWebsiteMakerBaseUrl,
} from '../../sales/websiteMaker';

type Props = {
  hideHeader?: boolean;
};

type BucketId = 'recentPastDue' | 'upcoming' | 'pastDue' | 'noNextAction';
type BucketTone = 'recent' | 'upcoming' | 'past' | 'none';

const BUCKET_META: Record<BucketId, { title: string; hint: string; tone: BucketTone }> = {
  recentPastDue: {
    title: 'Forfalt (siste 48 timer)',
    hint: 'Nylig forfalt — vises over listen så du ikke mister dem.',
    tone: 'recent',
  },
  upcoming: {
    title: 'Neste handling / møte',
    hint: 'Kommende møter og handlinger, nærmeste først.',
    tone: 'upcoming',
  },
  pastDue: {
    title: 'Forfalt',
    hint: 'Mer enn 48 timer etter avtalt tid.',
    tone: 'past',
  },
  noNextAction: {
    title: 'Ingen avtalt tid',
    hint: 'Ingen neste handling eller møtetid — alfabetisk.',
    tone: 'none',
  },
};

const BUCKET_ORDER: BucketId[] = ['recentPastDue', 'upcoming', 'pastDue', 'noNextAction'];
const COLLAPSED_STORAGE_KEY = 'asoldi-development-timeline-collapsed';

function itemRankMs(item: DevelopmentItem) {
  const raw = String(item.rankAt || item.nextActionAt || item.meetingAt || '').trim();
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Same 48-hour window as the Sales board: upcoming → recently overdue (kept on top for
// 48h) → overdue → no time (alphabetical).
function groupDevelopmentItems(items: DevelopmentItem[], nowMs: number) {
  const groups: Record<BucketId, DevelopmentItem[]> = {
    recentPastDue: [],
    upcoming: [],
    pastDue: [],
    noNextAction: [],
  };
  for (const item of items) {
    const ms = itemRankMs(item);
    if (ms == null) groups.noNextAction.push(item);
    else if (ms >= nowMs) groups.upcoming.push(item);
    else if (nowMs - ms <= RECENT_OVERDUE_MS) groups.recentPastDue.push(item);
    else groups.pastDue.push(item);
  }
  const byMs = (a: DevelopmentItem, b: DevelopmentItem) => (itemRankMs(a) || 0) - (itemRankMs(b) || 0);
  groups.upcoming.sort(byMs);
  groups.recentPastDue.sort(byMs);
  groups.pastDue.sort(byMs);
  groups.noNextAction.sort((a, b) =>
    String(a.businessName || '').localeCompare(String(b.businessName || ''), 'nb-NO', { sensitivity: 'base' })
  );
  return groups;
}

function bucketToneClass(tone: BucketTone) {
  if (tone === 'recent') return 'border-amber-300 bg-amber-50 text-amber-900';
  if (tone === 'upcoming') return 'border-emerald-200 bg-emerald-50 text-emerald-900';
  if (tone === 'past') return 'border-red-200 bg-red-50 text-red-800';
  return 'border-neutral-200 bg-neutral-50 text-neutral-700';
}


export function DevelopmentClientsSection({ hideHeader = false }: Props) {
  const [previewItems, setPreviewItems] = useState<DevelopmentItem[]>([]);
  const [deploymentItems, setDeploymentItems] = useState<DevelopmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [startingMakerTunnel, setStartingMakerTunnel] = useState(false);
  const { websiteMakerBaseUrl, setWebsiteMakerBaseUrl } = useWebsiteMakerBaseUrl();
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'' | 'preview' | 'deployment'>('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [collapsedBuckets, setCollapsedBuckets] = useState<Record<string, boolean>>(() => {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  function toggleBucket(id: string) {
    setCollapsedBuckets((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        window.localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Ignore storage issues — collapse state is a convenience only.
      }
      return next;
    });
  }

  function applySearch(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setSearchQuery(normalizeClientSearchText(searchInput));
  }

  function clearSearch() {
    setSearchInput('');
    setSearchQuery('');
    setKindFilter('');
  }

  const hasActiveFilters = Boolean(searchQuery || kindFilter);
  const itemMatchesSearch = useCallback(
    (item: DevelopmentItem) => {
      if (!searchQuery) return true;
      const haystack = buildClientSearchHaystack([
        item.businessName,
        item.contactPerson,
        item.contactEmail,
        item.contactPhone,
        item.meetingPlace,
        item.websiteDomain,
        item.siteKey,
        item.industry,
        item.notes,
      ]);
      return matchesClientSearchQuery(haystack, searchQuery);
    },
    [searchQuery]
  );
  const previewGroups = useMemo(
    () => groupDevelopmentItems(previewItems.filter(itemMatchesSearch), nowMs),
    [previewItems, itemMatchesSearch, nowMs]
  );
  const deploymentGroups = useMemo(
    () => groupDevelopmentItems(deploymentItems.filter(itemMatchesSearch), nowMs),
    [deploymentItems, itemMatchesSearch, nowMs]
  );
  const visiblePreviewCount = previewItems.filter(itemMatchesSearch).length;
  const visibleDeploymentCount = deploymentItems.filter(itemMatchesSearch).length;
  const visibleItems = useMemo(() => {
    const list: DevelopmentItem[] = [];
    if (kindFilter !== 'deployment') list.push(...previewItems.filter(itemMatchesSearch));
    if (kindFilter !== 'preview') list.push(...deploymentItems.filter(itemMatchesSearch));
    return list;
  }, [deploymentItems, itemMatchesSearch, kindFilter, previewItems]);
  const visibleSelectableIds = visibleItems.map((item) => item.id);
  const allVisibleSelected = Boolean(visibleSelectableIds.length && visibleSelectableIds.every((id) => selectedIds.includes(id)));
  const selectedClients = visibleItems
    .filter((item) => selectedIds.includes(item.id))
    .map((item) => ({
      id: item.id,
      salesClientId: String(item.salesClientId || '').trim(),
      runId: String(item.makerRun?.runId || '').trim(),
      businessName: String(item.businessName || '').trim(),
    }));

  function toggleClientSelected(itemId: string) {
    setSelectedIds((prev) => (prev.includes(itemId) ? prev.filter((id) => id !== itemId) : [...prev, itemId]));
  }

  function toggleSelectAllVisible() {
    if (allVisibleSelected) {
      const hide = new Set(visibleSelectableIds);
      setSelectedIds((prev) => prev.filter((id) => !hide.has(id)));
      return;
    }
    setSelectedIds((prev) => [...new Set([...prev, ...visibleSelectableIds])]);
  }

  function handleClientCardClick(event: React.MouseEvent<HTMLElement>, itemId: string) {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('button, a, input, select, textarea, label, audio, details, summary')) return;
    if (window.getSelection()?.toString()) return;
    toggleClientSelected(itemId);
  }

  function renderGroupedCards(
    kind: 'preview' | 'deployment',
    groups: Record<BucketId, DevelopmentItem[]>
  ) {
    return (
      <div className="space-y-3">
        {BUCKET_ORDER.map((bucketId) => {
          const items = groups[bucketId];
          const bucketKey = `${kind}:${bucketId}`;
          const collapsed = Boolean(collapsedBuckets[bucketKey]);
          const meta = BUCKET_META[bucketId];
          return (
            <div key={bucketKey} className="space-y-3">
              <button
                type="button"
                onClick={() => toggleBucket(bucketKey)}
                className={`w-full rounded-xl border px-3 py-2.5 text-left ${bucketToneClass(meta.tone)}`}
              >
                <span className="flex items-center justify-between gap-3">
                  <span>
                    <span className="block text-sm font-semibold">{meta.title}</span>
                    <span className="block text-[11px] opacity-80 mt-0.5">{meta.hint}</span>
                  </span>
                  <span className="inline-flex items-center gap-2 shrink-0">
                    <span className="text-sm font-semibold tabular-nums">{items.length}</span>
                    <ChevronDown size={16} className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                  </span>
                </span>
              </button>
              {!collapsed && items.length > 0 && (
                <div className="space-y-4">
                  {items.map((item) => (
                    <React.Fragment key={item.id}>
                      <DeveloperClientCard
                        item={item}
                        kind={kind}
                        busyKey={busyKey}
                        selected={selectedIds.includes(item.id)}
                        websiteMakerBaseUrl={websiteMakerBaseUrl}
                        setWebsiteMakerBaseUrl={setWebsiteMakerBaseUrl}
                        onToggleSelected={() => toggleClientSelected(item.id)}
                        onCardClick={(event) => handleClientCardClick(event, item.id)}
                        onToggleStep={(entry, stepKey) => void toggleStep(entry, stepKey)}
                        onReload={loadItems}
                        onClientUpdated={patchDevelopmentClient}
                        onError={setError}
                        onNotice={setNotice}
                      />
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  const patchDevelopmentClient = useCallback((client) => {
    const salesClientId = String(client?.id || '').trim();
    if (!salesClientId) return;
    const apply = (items) => items.map((item) => (
      String(item.salesClientId || '') === salesClientId
        ? {
            ...item,
            makerRun: client.makerRun ?? item.makerRun,
            websiteImport: client.websiteImport ?? item.websiteImport,
            developerQa: client.developerQa ?? item.developerQa,
            workshop: client.workshop ?? item.workshop,
          }
        : item
    ));
    setPreviewItems(apply);
    setDeploymentItems(apply);
  }, []);

  const loadItems = useCallback(async () => {
    setError('');
    try {
      const response = await fetch(`${API}/admin/development`, {
        headers: developmentAuthHeaders(),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || 'Failed loading development clients');
      }
      const deployment = Array.isArray(data.deploymentItems)
        ? data.deploymentItems
        : (Array.isArray(data.items) ? data.items : []);
      setDeploymentItems(deployment);
      setPreviewItems(Array.isArray(data.previewItems) ? data.previewItems : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed loading development clients');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  async function toggleStep(item: DevelopmentItem, key: keyof DevelopmentItem['development']) {
    setBusyKey(`${item.id}:${key}`);
    setError('');
    try {
      const response = await fetch(`${API}/admin/development/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        headers: { ...developmentAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key,
          value: !item.development?.[key],
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || 'Failed updating development step');
      }
      if (Array.isArray(data.previewItems) || Array.isArray(data.deploymentItems) || Array.isArray(data.items)) {
        setPreviewItems(Array.isArray(data.previewItems) ? data.previewItems : previewItems);
        setDeploymentItems(
          Array.isArray(data.deploymentItems)
            ? data.deploymentItems
            : (Array.isArray(data.items) ? data.items : deploymentItems)
        );
      } else {
        await loadItems();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed updating development step');
    } finally {
      setBusyKey(null);
    }
  }

  async function startMakerTunnel() {
    setStartingMakerTunnel(true);
    setError('');
    try {
      const tunnelHost = tunnelPopupMakerOrigin(websiteMakerBaseUrl);
      const tunnelUrl = await openMakerTunnelPopup(tunnelHost);
      setWebsiteMakerBaseUrl(tunnelUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start Website Maker tunnel');
    } finally {
      setStartingMakerTunnel(false);
    }
  }

  const empty = !loading && previewItems.length === 0 && deploymentItems.length === 0;

  return (
    <div className="space-y-6">
      {!hideHeader && (
        <div>
          <h2 className="text-lg font-semibold text-white">Utvikling</h2>
          <p className="text-gray-400 text-sm">
            Preview-nettsider for aktive salgskunder, og deployment etter kontrakt er signert.
          </p>
        </div>
      )}

      <div className="rounded-2xl bg-[#2a2a2a] border border-white/10 p-4 space-y-2">
        <div className="text-xs font-semibold text-gray-200 uppercase tracking-wide">Website Maker URL</div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={websiteMakerBaseUrl}
            onChange={(e) => setWebsiteMakerBaseUrl(e.target.value)}
            placeholder={LAN_MAKER_URL}
            className="flex-1 px-3 py-2 rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm"
          />
          <button
            type="button"
            onClick={() => setWebsiteMakerBaseUrl(LAN_MAKER_URL)}
            className="px-3 py-2 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
          >
            Office LAN
          </button>
          <button
            type="button"
            onClick={() => setWebsiteMakerBaseUrl(LOCAL_MAKER_URL)}
            className="px-3 py-2 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
          >
            This computer
          </button>
          <button
            type="button"
            onClick={() => void startMakerTunnel()}
            disabled={startingMakerTunnel}
            className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
          >
            {startingMakerTunnel ? <Loader2 size={13} className="animate-spin" /> : null}
            Start tunnel
          </button>
        </div>
        <p className="text-[11px] text-gray-500">
          Opprett run, åpne Maker og Maker preview skjer her — ikke i Sales.
        </p>
      </div>

      <form onSubmit={applySearch} className="rounded-2xl bg-[#2a2a2a] border border-white/10 p-4">
        <label className="text-xs font-semibold text-gray-200 uppercase tracking-wide">Search and filter</label>
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Business, contact, domain, or area (e.g. oslo area)"
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm"
              />
            </div>
            <select
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value as '' | 'preview' | 'deployment')}
              className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
            >
              <option value="">Preview + deployment</option>
              <option value="preview">Preview websites</option>
              <option value="deployment">Deployment</option>
            </select>
            <button
              type="submit"
              className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[#FF5B00] text-white text-sm hover:bg-[#e55200]"
            >
              <Search size={14} />
              Search
            </button>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={clearSearch}
                className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15"
              >
                <X size={14} />
                Clear
              </button>
            )}
          </div>
          <p className="text-[11px] text-gray-400">
            Sorted by next action / meeting time. Recently overdue clients stay on top for 48 hours, then move to{' '}
            <span className="text-red-300">Forfalt</span>. Click a section header to collapse it.
            {hasActiveFilters ? ` Showing ${visiblePreviewCount} preview and ${visibleDeploymentCount} deployment client(s).` : ''}
          </p>
        </div>
      </form>

      {error && (
        <div className="rounded-xl border border-red-700/40 bg-red-900/20 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-xl border border-emerald-700/40 bg-emerald-900/20 px-3 py-2 text-sm text-emerald-200">
          {notice}
        </div>
      )}

      <DeveloperRunQueueBar
        websiteMakerBaseUrl={websiteMakerBaseUrl}
        selectedClients={selectedClients}
        visibleCount={visibleSelectableIds.length}
        allVisibleSelected={allVisibleSelected}
        onToggleSelectAll={toggleSelectAllVisible}
        onClearSelection={() => setSelectedIds([])}
        onError={setError}
        onNotice={setNotice}
      />

      {loading ? (
        <div className="min-h-[160px] flex items-center justify-center text-gray-400">
          <Loader2 className="animate-spin mr-2" size={18} /> Loading development clients…
        </div>
      ) : empty ? (
        <p className="text-gray-400 text-center py-8">
          Ingen preview- eller deployment-kunder ennå. Nye salgskunder vises under Preview websites.
        </p>
      ) : (
        <>
          {kindFilter !== 'deployment' && (
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Preview website runs</h3>
                <p className="text-xs text-gray-400 mt-1">
                  Aktive salgskunder. Lag preview-run her slik at sales bare åpner den offentlige URL-en.
                </p>
              </div>
              {previewItems.length === 0 ? (
                <p className="text-sm text-gray-500">Ingen preview-kunder akkurat nå.</p>
              ) : visiblePreviewCount === 0 ? (
                <p className="text-sm text-gray-500">Ingen preview-kunder matcher søket.</p>
              ) : (
                renderGroupedCards('preview', previewGroups)
              )}
            </section>
          )}

          {kindFilter !== 'preview' && (
            <section className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-white">Deployment website runs</h3>
                <p className="text-xs text-gray-400 mt-1">
                  Signerte kontrakter: Hostinger, GitHub, V1 og ferdig nettside.
                </p>
              </div>
              {deploymentItems.length === 0 ? (
                <p className="text-sm text-gray-500">Ingen deployment-kunder akkurat nå.</p>
              ) : visibleDeploymentCount === 0 ? (
                <p className="text-sm text-gray-500">Ingen deployment-kunder matcher søket.</p>
              ) : (
                renderGroupedCards('deployment', deploymentGroups)
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
