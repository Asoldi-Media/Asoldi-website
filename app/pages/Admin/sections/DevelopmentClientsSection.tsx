import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Loader2, Search, X } from 'lucide-react';
import {
  API,
  developmentAuthHeaders,
  type DevelopmentItem,
} from '../shared';
import { buildClientSearchHaystack, matchesClientSearchQuery, normalizeClientSearchText } from '../clientSearch';
import { RECENT_OVERDUE_MS } from '../../../../lib/sales-next-actions.js';
import { persistDevelopmentBoard, readStoredDevelopmentBoard } from '../../../../lib/development-phase.js';
import { DeveloperClientCard } from '../../developer/DeveloperClientCard';
import { pipelineStatusFromMakerRun } from '../../../../lib/developer-card.js';
import { DeveloperRunQueueBar } from '../../developer/DeveloperRunQueueBar';
import { LOCAL_EDITOR_ORIGIN } from '../../../../lib/maker-editor-origin.js';
import { fetchMakerQueue } from '../../developer/makerQueue';

type Props = {
  hideHeader?: boolean;
};

type BoardId = 'preview' | 'deployment';
type BucketId = 'recentPastDue' | 'upcoming' | 'pastDue' | 'noNextAction';
type BucketTone = 'recent' | 'upcoming' | 'past' | 'none';

const COLLAPSED_STORAGE_KEY = 'asoldi-development-timeline-collapsed';

const PREVIEW_BUCKET_META: Record<BucketId, { title: string; hint: string; tone: BucketTone }> = {
  recentPastDue: {
    title: 'Forfalt (siste 48 timer)',
    hint: 'Nylig forfalt møte eller neste handling — vises øverst slik at du ikke mister dem.',
    tone: 'recent',
  },
  upcoming: {
    title: 'Neste møte',
    hint: 'Kommende møte eller handling, nærmeste først. Samme rekkefølge som Sales.',
    tone: 'upcoming',
  },
  pastDue: {
    title: 'Forfalt',
    hint: 'Mer enn 48 timer etter neste møte eller handling.',
    tone: 'past',
  },
  noNextAction: {
    title: 'Ingen neste handling',
    hint: 'Ingen neste handling eller avtalt møtetid. Sortert alfabetisk.',
    tone: 'none',
  },
};

const DEPLOYMENT_BUCKET_META: Record<BucketId, { title: string; hint: string; tone: BucketTone }> = {
  recentPastDue: {
    title: 'Frist nylig passert',
    hint: 'Leveringsfristen gikk ut de siste 48 timene.',
    tone: 'recent',
  },
  upcoming: {
    title: 'Kommende frist',
    hint: 'Nettsidefrist etter signert kontrakt, nærmeste først.',
    tone: 'upcoming',
  },
  pastDue: {
    title: 'Forfalt frist',
    hint: 'Mer enn 48 timer etter leveringsfristen.',
    tone: 'past',
  },
  noNextAction: {
    title: 'Ingen frist ennå',
    hint: 'Fristen starter når kontrakt er signert. Uten dato sorteres de alfabetisk.',
    tone: 'none',
  },
};

const BUCKET_ORDER: BucketId[] = ['recentPastDue', 'upcoming', 'pastDue', 'noNextAction'];

function itemRankMs(item: DevelopmentItem, kind: BoardId = 'deployment') {
  const raw = String(
    item.rankAt
    || (kind === 'preview' ? (item.nextActionAt || item.meetingAt) : '')
    || item.websiteDue?.dueAt
    || ''
  ).trim();
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Same 48-hour window as the Sales board: upcoming → recently overdue (kept on top for
// 48h) → overdue → no time (alphabetical).
function groupDevelopmentItems(items: DevelopmentItem[], nowMs: number, kind: BoardId = 'deployment') {
  const groups: Record<BucketId, DevelopmentItem[]> = {
    recentPastDue: [],
    upcoming: [],
    pastDue: [],
    noNextAction: [],
  };
  for (const item of items) {
    const ms = itemRankMs(item, kind);
    if (ms == null) groups.noNextAction.push(item);
    else if (ms >= nowMs) groups.upcoming.push(item);
    else if (nowMs - ms <= RECENT_OVERDUE_MS) groups.recentPastDue.push(item);
    else groups.pastDue.push(item);
  }
  const byMs = (a: DevelopmentItem, b: DevelopmentItem) => (itemRankMs(a, kind) || 0) - (itemRankMs(b, kind) || 0);
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
  const websiteMakerBaseUrl = LOCAL_EDITOR_ORIGIN;
  const [queueItems, setQueueItems] = useState<Array<Record<string, unknown>>>([]);
  const [queueMemory, setQueueMemory] = useState<Record<string, unknown> | null>(null);
  const [board, setBoard] = useState<BoardId>(() => readStoredDevelopmentBoard('preview'));
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [runFilter, setRunFilter] = useState<'' | 'with-run' | 'without-run'>('');
  const [stepFilter, setStepFilter] = useState('');
  const [dueFilter, setDueFilter] = useState<'' | 'started' | 'waiting' | 'overdue' | 'upcoming'>('');
  const [onlyWithRequests, setOnlyWithRequests] = useState(false);
  const [threadMap, setThreadMap] = useState<Record<string, { lastKindLabel: string }>>({});
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
    setRunFilter('');
    setStepFilter('');
    setDueFilter('');
    setOnlyWithRequests(false);
  }

  function chooseBoard(next: BoardId) {
    setBoard(next);
    setSelectedIds([]);
    if (next === 'preview') setDueFilter('');
    persistDevelopmentBoard(next);
  }

  const hasActiveFilters = Boolean(searchQuery || runFilter || stepFilter || dueFilter || onlyWithRequests);
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
  const itemVisible = useCallback(
    (item: DevelopmentItem) => {
      if (!itemMatchesSearch(item)) return false;
      const hasRun = Boolean(String(item.makerRun?.runId || '').trim());
      if (runFilter === 'with-run' && !hasRun) return false;
      if (runFilter === 'without-run' && hasRun) return false;
      if (stepFilter) {
        const status = pipelineStatusFromMakerRun(item.makerRun || {});
        const ready = stepFilter === '1' ? status.step1Ready
          : stepFilter === 'lang' ? status.languageLocked
            : stepFilter === '1.5' ? status.step15Ready
              : stepFilter === '2.1' ? status.generateTextReady
                : stepFilter === '2.2' ? status.injectMediaReady
                  : false;
        if (!ready) return false;
      }
      if (board === 'deployment' && dueFilter) {
        const started = Boolean(item.websiteDue?.started && item.websiteDue?.dueAt);
        const dueMs = started ? Date.parse(String(item.websiteDue?.dueAt || '')) : NaN;
        if (dueFilter === 'started' && !started) return false;
        if (dueFilter === 'waiting' && started) return false;
        if (dueFilter === 'overdue' && !(started && Number.isFinite(dueMs) && dueMs < nowMs)) return false;
        if (dueFilter === 'upcoming' && !(started && Number.isFinite(dueMs) && dueMs >= nowMs)) return false;
      }
      if (!onlyWithRequests) return true;
      const id = String(item.salesClientId || item.id || '').trim();
      return Boolean(threadMap[id]);
    },
    [board, itemMatchesSearch, runFilter, stepFilter, dueFilter, nowMs, onlyWithRequests, threadMap]
  );
  const previewGroups = useMemo(
    () => groupDevelopmentItems(previewItems.filter(itemVisible), nowMs, 'preview'),
    [previewItems, itemVisible, nowMs]
  );
  const deploymentGroups = useMemo(
    () => groupDevelopmentItems(deploymentItems.filter(itemVisible), nowMs, 'deployment'),
    [deploymentItems, itemVisible, nowMs]
  );
  const visiblePreviewCount = previewItems.filter(itemVisible).length;
  const visibleDeploymentCount = deploymentItems.filter(itemVisible).length;
  const visibleItems = useMemo(() => {
    const source = board === 'preview' ? previewItems : deploymentItems;
    return source.filter(itemVisible);
  }, [board, deploymentItems, itemVisible, previewItems]);
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
          const meta = (kind === 'preview' ? PREVIEW_BUCKET_META : DEPLOYMENT_BUCKET_META)[bucketId];
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
                        queueItems={queueItems}
                        requestLabel={
                          threadMap[String(item.salesClientId || item.id || '')]?.lastKindLabel
                          || (threadMap[String(item.salesClientId || item.id || '')] ? 'Forespørsel' : '')
                        }
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

  const loadThreads = useCallback(async () => {
    try {
      const response = await fetch(`${API}/admin/dev-requests`, {
        headers: developmentAuthHeaders(),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return;
      const next: Record<string, { lastKindLabel: string }> = {};
      for (const row of Array.isArray(data.threads) ? data.threads : []) {
        const id = String(row.salesClientId || '').trim();
        if (!id) continue;
        next[id] = { lastKindLabel: String(row.lastKindLabel || '') };
      }
      setThreadMap(next);
    } catch {
      // Keep the development list even if request threads fail.
    }
  }, []);

  useEffect(() => {
    void loadItems();
    void loadThreads();
  }, [loadItems, loadThreads]);

  const refreshQueue = useCallback(async () => {
    const data = await fetchMakerQueue(websiteMakerBaseUrl, developmentAuthHeaders()) as {
      items?: Array<Record<string, unknown>>;
      memory?: Record<string, unknown>;
    };
    setQueueItems(Array.isArray(data.items) ? data.items : []);
    setQueueMemory(data.memory && typeof data.memory === 'object' ? data.memory : null);
  }, [websiteMakerBaseUrl]);

  useEffect(() => {
    void refreshQueue().catch(() => {});
    const timer = window.setInterval(() => {
      void refreshQueue().catch(() => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [refreshQueue]);

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

  const empty = !loading && (board === 'preview' ? previewItems.length === 0 : deploymentItems.length === 0);

  return (
    <div className="space-y-6">
      {!hideHeader && (
        <div>
          <h2 className="text-lg font-semibold text-white">Utvikling</h2>
          <p className="text-gray-400 text-sm">
            Forhåndsvisning er salgskunder i møterekkefølge. Utvikler er signerte kontrakter med leveringsfrist.
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => chooseBoard('preview')}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${board === 'preview' ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-gray-300 hover:bg-white/15'}`}
        >
          Forhåndsvisning
        </button>
        <button
          type="button"
          onClick={() => chooseBoard('deployment')}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${board === 'deployment' ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-gray-300 hover:bg-white/15'}`}
        >
          Utvikler
        </button>
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
              value={runFilter}
              onChange={(event) => setRunFilter(event.target.value as '' | 'with-run' | 'without-run')}
              className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
            >
              <option value="">Alle run</option>
              <option value="with-run">Har website-run</option>
              <option value="without-run">Ingen website-run</option>
            </select>
            <select
              value={stepFilter}
              onChange={(event) => setStepFilter(event.target.value)}
              className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
            >
              <option value="">Alle steg</option>
              <option value="1">Steg 1 klar</option>
              <option value="lang">Språk låst</option>
              <option value="1.5">Steg 1.5 klar</option>
              <option value="2.1">Steg 2.1 klar</option>
              <option value="2.2">Steg 2.2 klar</option>
            </select>
            {board === 'deployment' ? (
            <select
              value={dueFilter}
              onChange={(event) => setDueFilter(event.target.value as '' | 'started' | 'waiting' | 'overdue' | 'upcoming')}
              className="rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
            >
              <option value="">Alle frister</option>
              <option value="waiting">Venter på signert kontrakt</option>
              <option value="upcoming">Kommende frist</option>
              <option value="overdue">Forfalt frist</option>
              <option value="started">Har fristdato</option>
            </select>
            ) : null}
            <label className="inline-flex items-center gap-2 rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyWithRequests}
                onChange={(event) => setOnlyWithRequests(event.target.checked)}
                className="h-4 w-4 accent-[#FF5B00]"
              />
              Med forespørsel
            </label>
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
            {board === 'preview'
              ? 'Forhåndsvisning er sortert som Sales: neste møte eller handling, nærmeste først. Nylig forfalt ligger øverst i 48 timer.'
              : 'Utvikler er sortert etter nettsidefrist. Fristen starter når salg huker av signert kontrakt.'}
            {' '}Click a section header to collapse it.
            {hasActiveFilters ? ` Showing ${board === 'preview' ? visiblePreviewCount : visibleDeploymentCount} client(s).` : ''}
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
        items={queueItems}
        memory={queueMemory}
        onRefreshQueue={refreshQueue}
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
          {board === 'preview'
            ? 'Ingen forhåndsvisningskunder ennå. Aktive salgskunder uten signert kontrakt vises her.'
            : 'Ingen utviklerkunder ennå. Signerte kontrakter flyttes hit fra forhåndsvisning.'}
        </p>
      ) : board === 'preview' ? (
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Forhåndsvisning</h3>
            <p className="text-xs text-gray-400 mt-1">
              Samme kunder som Sales, i møterekkefølge. UI-en er utviklerkortet — lag preview-run slik at sales åpner den offentlige URL-en.
            </p>
          </div>
          {visiblePreviewCount === 0 ? (
            <p className="text-sm text-gray-500">Ingen forhåndsvisningskunder matcher søket.</p>
          ) : (
            renderGroupedCards('preview', previewGroups)
          )}
        </section>
      ) : (
        <section className="space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Utvikler</h3>
            <p className="text-xs text-gray-400 mt-1">
              Signerte kontrakter: pipeline, Hostinger, GitHub, V1 og ferdig nettside.
            </p>
          </div>
          {visibleDeploymentCount === 0 ? (
            <p className="text-sm text-gray-500">Ingen utviklerkunder matcher søket.</p>
          ) : (
            renderGroupedCards('deployment', deploymentGroups)
          )}
        </section>
      )}
    </div>
  );
}
