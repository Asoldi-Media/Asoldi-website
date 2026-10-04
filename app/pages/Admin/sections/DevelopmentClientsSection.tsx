import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Filter, Loader2, Search, Users, X } from 'lucide-react';
import {
  API,
  developmentAuthHeaders,
  type DeveloperOwnerOption,
  type DevelopmentItem,
} from '../shared';
import {
  canUploadDeveloperHandoff,
  canWorkDevelopmentClient,
  sameDeveloperOwner,
} from '../../../../lib/developer-assignment.js';
import { buildClientSearchHaystack, matchesClientSearchQuery, normalizeClientSearchText } from '../clientSearch';
import { DEVELOPER_RECENT_OVERDUE_MS } from '../../../../lib/developer-goals.js';
import { DeveloperClientCard } from '../../developer/DeveloperClientCard';
import { pipelineStatusFromMakerRun } from '../../../../lib/developer-card.js';
import { DeveloperRunQueueBar } from '../../developer/DeveloperRunQueueBar';
import { LOCAL_EDITOR_ORIGIN } from '../../../../lib/maker-editor-origin.js';
import { fetchMakerQueue } from '../../developer/makerQueue';

type Props = {
  hideHeader?: boolean;
};

type BucketId = 'recentPastDue' | 'upcoming' | 'pastDue' | 'noNextAction';
type BucketTone = 'recent' | 'upcoming' | 'past' | 'none';

const COLLAPSED_STORAGE_KEY = 'asoldi-development-timeline-collapsed';

const BUCKET_META: Record<BucketId, { title: string; hint: string; tone: BucketTone }> = {
  recentPastDue: {
    title: 'Forfalt (siste 2 uker)',
    hint: 'Nylig forfalt møte, handling eller frist — vises øverst i to uker.',
    tone: 'recent',
  },
  upcoming: {
    title: 'Neste',
    hint: 'Kommende møte, handling eller leveringsfrist, nærmeste først.',
    tone: 'upcoming',
  },
  pastDue: {
    title: 'Forfalt',
    hint: 'Mer enn to uker etter neste møte, handling eller frist.',
    tone: 'past',
  },
  noNextAction: {
    title: 'Ingen neste handling',
    hint: 'Ingen neste handling, avtalt møtetid eller frist. Sortert alfabetisk.',
    tone: 'none',
  },
};

const BUCKET_ORDER: BucketId[] = ['recentPastDue', 'upcoming', 'pastDue', 'noNextAction'];

function itemRankMs(item: DevelopmentItem) {
  const raw = String(item.rankAt || '').trim();
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

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
    else if (nowMs - ms <= DEVELOPER_RECENT_OVERDUE_MS) groups.recentPastDue.push(item);
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
  const [developmentItems, setDevelopmentItems] = useState<DevelopmentItem[]>([]);
  const [previewItems, setPreviewItems] = useState<DevelopmentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const websiteMakerBaseUrl = LOCAL_EDITOR_ORIGIN;
  const [queueItems, setQueueItems] = useState<Array<Record<string, unknown>>>([]);
  const [queueMemory, setQueueMemory] = useState<Record<string, unknown> | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [runFilter, setRunFilter] = useState<'' | 'with-run' | 'without-run'>('');
  const [stepFilter, setStepFilter] = useState('');
  const [dueFilter, setDueFilter] = useState<'' | 'started' | 'waiting' | 'overdue' | 'upcoming'>('');
  const [onlyWithRequests, setOnlyWithRequests] = useState(false);
  const [ownerFilter, setOwnerFilter] = useState('');
  const [headerPanel, setHeaderPanel] = useState<'filter' | null>(null);
  const [viewer, setViewer] = useState<{ isAdmin: boolean; accountKey: string; username: string }>({
    isAdmin: false,
    accountKey: '',
    username: '',
  });
  const [developers, setDevelopers] = useState<DeveloperOwnerOption[]>([]);
  const [bulkAssignOwnerId, setBulkAssignOwnerId] = useState('');
  const [assignBusy, setAssignBusy] = useState(false);
  const headerShellRef = useRef<HTMLDivElement | null>(null);
  const itemsRef = useRef<DevelopmentItem[]>([]);
  const uploadingHandoffRef = useRef<Set<string>>(new Set());
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
      const currentlyCollapsed = prev[id] !== false;
      const next = { ...prev, [id]: currentlyCollapsed ? false : true };
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
    setOwnerFilter('');
  }

  const hasActiveFilters = Boolean(searchQuery || runFilter || stepFilter || dueFilter || onlyWithRequests || ownerFilter);
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
      if (viewer.isAdmin && ownerFilter === 'unassigned' && item.developerOwnerId) return false;
      if (viewer.isAdmin && ownerFilter && ownerFilter !== 'unassigned' && !sameDeveloperOwner(item.developerOwnerId, ownerFilter)) return false;
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
      if (dueFilter) {
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
    [itemMatchesSearch, runFilter, stepFilter, dueFilter, nowMs, onlyWithRequests, threadMap, viewer.isAdmin, ownerFilter]
  );
  const items = useMemo(
    () => [...developmentItems, ...previewItems],
    [developmentItems, previewItems]
  );
  const visibleDevelopmentItems = useMemo(
    () => developmentItems.filter(itemVisible),
    [developmentItems, itemVisible]
  );
  const visiblePreviewItems = useMemo(
    () => previewItems.filter(itemVisible),
    [previewItems, itemVisible]
  );
  const developmentGroups = useMemo(
    () => groupDevelopmentItems(
      visibleDevelopmentItems.filter((item) => !viewer.isAdmin || item.developerOwnerId),
      nowMs
    ),
    [visibleDevelopmentItems, nowMs, viewer.isAdmin]
  );
  const previewGroups = useMemo(
    () => groupDevelopmentItems(
      visiblePreviewItems.filter((item) => !viewer.isAdmin || item.developerOwnerId),
      nowMs
    ),
    [visiblePreviewItems, nowMs, viewer.isAdmin]
  );
  const developmentUnassigned = useMemo(
    () => (viewer.isAdmin ? visibleDevelopmentItems.filter((item) => !item.developerOwnerId) : []),
    [visibleDevelopmentItems, viewer.isAdmin]
  );
  const previewUnassigned = useMemo(
    () => (viewer.isAdmin ? visiblePreviewItems.filter((item) => !item.developerOwnerId) : []),
    [visiblePreviewItems, viewer.isAdmin]
  );
  const visibleCount = visibleDevelopmentItems.length + visiblePreviewItems.length;
  const visibleItems = useMemo(
    () => [...visibleDevelopmentItems, ...visiblePreviewItems],
    [visibleDevelopmentItems, visiblePreviewItems]
  );
  const visibleSelectableIds = visibleItems.map((item) => item.id);
  const allVisibleSelected = Boolean(visibleSelectableIds.length && visibleSelectableIds.every((id) => selectedIds.includes(id)));
  const selectedClients = visibleItems
    .filter((item) => selectedIds.includes(item.id) && canWorkDevelopmentClient(viewer, item))
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

  function renderClientCard(item: DevelopmentItem, kind: 'preview' | 'deployment', canWork: boolean) {
    return (
      <DeveloperClientCard
        item={item}
        kind={kind}
        busyKey={busyKey}
        selected={selectedIds.includes(item.id)}
        websiteMakerBaseUrl={websiteMakerBaseUrl}
        queueItems={queueItems}
        canWork={canWork}
        isAdmin={viewer.isAdmin}
        viewerAccountKey={viewer.accountKey}
        developers={developers}
        assignBusy={assignBusy}
        onAssign={(ownerId) => void assignDeveloper(item, ownerId)}
        onAcceptHandoff={() => void acceptHandoff(item)}
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
    );
  }

  function renderGroupedCards(groups: Record<BucketId, DevelopmentItem[]>, kind: 'preview' | 'deployment', prefix: string) {
    return (
      <div className="space-y-3">
        {BUCKET_ORDER.map((bucketId) => {
          const bucketItems = groups[bucketId];
          if (!bucketItems.length) return null;
          const storageKey = `${prefix}:${bucketId}`;
          const collapsed = collapsedBuckets[storageKey] !== false;
          const meta = BUCKET_META[bucketId];
          return (
            <div key={storageKey} className="space-y-3">
              <button
                type="button"
                onClick={() => toggleBucket(storageKey)}
                className={`w-full rounded-xl border px-3 py-2.5 text-left ${bucketToneClass(meta.tone)}`}
              >
                <span className="flex items-center justify-between gap-3">
                  <span>
                    <span className="block text-sm font-semibold">{meta.title}</span>
                    <span className="block text-[11px] opacity-80 mt-0.5">{meta.hint}</span>
                  </span>
                  <span className="inline-flex items-center gap-2 shrink-0">
                    <span className="text-sm font-semibold tabular-nums">{bucketItems.length}</span>
                    <ChevronDown size={16} className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
                  </span>
                </span>
              </button>
              {!collapsed && bucketItems.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
                  {bucketItems.map((item) => (
                    <React.Fragment key={item.id}>
                      {renderClientCard(item, kind, canWorkDevelopmentClient(viewer, item))}
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
    const merge = (item: DevelopmentItem, clearRankWhenPreviewReady: boolean): DevelopmentItem => {
      if (String(item.salesClientId || '') !== salesClientId) return item;
      const developerGoals = client.developerGoals ?? item.developerGoals;
      return {
        ...item,
        makerRun: client.makerRun ?? item.makerRun,
        developerOwnerId: client.developerOwnerId ?? item.developerOwnerId,
        developerHandoff: client.developerHandoff ?? item.developerHandoff,
        websiteImport: client.websiteImport ?? item.websiteImport,
        developerQa: client.developerQa ?? item.developerQa,
        developerGoals,
        workshop: client.workshop ?? item.workshop,
        rankAt: clearRankWhenPreviewReady && developerGoals?.readyForPreview ? '' : item.rankAt,
      };
    };
    setDevelopmentItems((current) => current.map((item) => merge(item, false)));
    setPreviewItems((current) => current.map((item) => merge(item, true)));
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
      const nextViewer = data.viewer && typeof data.viewer === 'object' ? data.viewer : {};
      setViewer({
        isAdmin: Boolean(nextViewer.isAdmin),
        accountKey: String(nextViewer.accountKey || ''),
        username: String(nextViewer.username || ''),
      });
      setDevelopers(Array.isArray(data.developers) ? data.developers : []);
      const dedupe = (list: DevelopmentItem[]) => {
        const seen = new Set<string>();
        return list.filter((item) => {
          const id = String(item?.id || '');
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      };
      const nextDevelopment = Array.isArray(data.developmentItems)
        ? data.developmentItems
        : (Array.isArray(data.deploymentItems) ? data.deploymentItems : []);
      const nextPreview = Array.isArray(data.previewItems) ? data.previewItems : [];
      setDevelopmentItems(dedupe(nextDevelopment));
      setPreviewItems(dedupe(nextPreview));
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

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (!headerPanel) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && headerShellRef.current?.contains(target)) return;
      setHeaderPanel(null);
    };
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && headerShellRef.current?.contains(target)) return;
      setHeaderPanel(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [headerPanel]);

  const pumpHandoffs = useCallback(async () => {
    const caller = viewer;
    for (const item of itemsRef.current) {
      if (!canUploadDeveloperHandoff(caller, item)) continue;
      const runId = String(item.developerHandoff?.runId || '').trim();
      if (!runId || uploadingHandoffRef.current.has(item.id)) continue;
      uploadingHandoffRef.current.add(item.id);
      try {
        const packed = await fetch(`${LOCAL_EDITOR_ORIGIN}/api/runs/${encodeURIComponent(runId)}/dev-handoff`);
        if (!packed.ok) continue;
        const blob = await packed.blob();
        const form = new FormData();
        form.append('file', blob, `${runId}.zip`);
        const uploaded = await fetch(`${API}/admin/development/${encodeURIComponent(item.id)}/handoff`, {
          method: 'POST',
          headers: developmentAuthHeaders(),
          body: form,
        });
        if (!uploaded.ok) continue;
        await fetch(`${LOCAL_EDITOR_ORIGIN}/api/runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
        setNotice('Prosjektet er sendt. Den nye utvikleren kan ta det imot.');
        await loadItems();
      } catch {
        // Website Creator is not running on this computer yet.
      } finally {
        uploadingHandoffRef.current.delete(item.id);
      }
    }
  }, [viewer, loadItems]);

  useEffect(() => {
    void pumpHandoffs();
    const timer = window.setInterval(() => {
      void pumpHandoffs();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [pumpHandoffs]);

  async function assignDeveloper(item: DevelopmentItem, developerOwnerId: string) {
    const ownerId = String(developerOwnerId || '').trim();
    if (!ownerId) return;
    setAssignBusy(true);
    setError('');
    try {
      const response = await fetch(`${API}/admin/development/${encodeURIComponent(item.id)}/assign`, {
        method: 'POST',
        headers: { ...developmentAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ developerOwnerId: ownerId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Kunne ikke tildele utvikler.');
      const handoff = data.client?.developerHandoff;
      setNotice(handoff?.status === 'waiting-upload'
        ? 'Tildelt. Forrige datamaskin sender prosjektet når Website Creator er åpen.'
        : 'Utvikler er tildelt.');
      await loadItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke tildele utvikler.');
    } finally {
      setAssignBusy(false);
    }
  }

  async function acceptHandoff(item: DevelopmentItem) {
    setAssignBusy(true);
    setError('');
    try {
      const packed = await fetch(`${API}/admin/development/${encodeURIComponent(item.id)}/handoff`, {
        headers: developmentAuthHeaders(),
      });
      const failure = await packed.clone().json().catch(() => ({}));
      if (!packed.ok) throw new Error(failure.message || 'Kunne ikke hente prosjektet.');
      const blob = await packed.blob();
      const form = new FormData();
      form.append('file', blob, 'handoff.zip');
      const imported = await fetch(`${LOCAL_EDITOR_ORIGIN}/api/handoff/accept`, { method: 'POST', body: form });
      const importedBody = await imported.json().catch(() => ({}));
      if (!imported.ok) throw new Error(importedBody.error || importedBody.message || 'Website Creator kunne ikke ta imot prosjektet.');
      const accepted = await fetch(`${API}/admin/development/${encodeURIComponent(item.id)}/handoff/accepted`, {
        method: 'POST',
        headers: developmentAuthHeaders(),
      });
      const acceptedBody = await accepted.json().catch(() => ({}));
      if (!accepted.ok) throw new Error(acceptedBody.message || 'Prosjektet ble importert, men ikke lukket på serveren.');
      setNotice('Prosjektet er lastet inn i Website Creator.');
      await loadItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke ta imot prosjektet.');
    } finally {
      setAssignBusy(false);
    }
  }

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
      await loadItems();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed updating development step');
    } finally {
      setBusyKey(null);
    }
  }

  const empty = !loading && items.length === 0;

  return (
    <div className="space-y-6">
      {!hideHeader && (
        <div>
          <h2 className="text-lg font-semibold text-white">Utvikling</h2>
          <p className="text-gray-400 text-sm">
            Development øverst er solgte kunder. Listen under er før kontrakt, med møtetid fra salg.
          </p>
        </div>
      )}

      <div ref={headerShellRef} className="rounded-2xl bg-[#2a2a2a] border border-white/10">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <button
            type="button"
            onClick={() => setHeaderPanel((current) => (current === 'filter' ? null : 'filter'))}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm ${
              headerPanel === 'filter' ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
            }`}
            aria-expanded={headerPanel === 'filter'}
          >
            <Filter size={14} />
            Filter
            <ChevronDown size={12} className={`transition-transform ${headerPanel === 'filter' ? 'rotate-180' : ''}`} />
          </button>
          <p className="text-[11px] text-gray-400">
            Development sorteres etter leveringsfrist. Listen under sorteres etter møtetid.
            {hasActiveFilters ? ` Viser ${visibleCount}.` : ''}
          </p>
        </div>
        {headerPanel === 'filter' && (
          <form onSubmit={applySearch} className="border-t border-white/10 bg-[#1a1a1a] p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] text-gray-400">Lukk: klikk Filter igjen, klikk utenfor, eller scroll.</p>
              <button type="button" onClick={() => setHeaderPanel(null)} className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-white">
                <X size={12} /> Lukk
              </button>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Business, contact, domain, or area"
                  className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm"
                />
              </div>
              <button type="submit" className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm hover:bg-[#e55200]">
                <Search size={14} />
                Search
              </button>
              {hasActiveFilters && (
                <button type="button" onClick={clearSearch} className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15">
                  <X size={14} />
                  Clear
                </button>
              )}
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {viewer.isAdmin && (
                <label className="text-[11px] text-gray-400 block">
                  <span className="inline-flex items-center gap-1 mb-1"><Filter size={12} /> Utvikler</span>
                  <select
                    value={ownerFilter}
                    onChange={(event) => setOwnerFilter(event.target.value)}
                    className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
                  >
                    <option value="">Alle</option>
                    <option value="unassigned">Ikke tildelt</option>
                    {developers.map((owner) => (
                      <option key={owner.accountKey} value={owner.accountKey}>
                        {owner.name || owner.username}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="text-[11px] text-gray-400 block">
                <span className="block mb-1">Run</span>
                <select
                  value={runFilter}
                  onChange={(event) => setRunFilter(event.target.value as '' | 'with-run' | 'without-run')}
                  className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
                >
                  <option value="">Alle run</option>
                  <option value="with-run">Har website-run</option>
                  <option value="without-run">Ingen website-run</option>
                </select>
              </label>
              <label className="text-[11px] text-gray-400 block">
                <span className="block mb-1">Steg</span>
                <select
                  value={stepFilter}
                  onChange={(event) => setStepFilter(event.target.value)}
                  className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
                >
                  <option value="">Alle steg</option>
                  <option value="1">Steg 1 klar</option>
                  <option value="lang">Språk låst</option>
                  <option value="1.5">Steg 1.5 klar</option>
                  <option value="2.1">Steg 2.1 klar</option>
                  <option value="2.2">Steg 2.2 klar</option>
                </select>
              </label>
              <label className="text-[11px] text-gray-400 block">
                <span className="block mb-1">Frist</span>
                <select
                  value={dueFilter}
                  onChange={(event) => setDueFilter(event.target.value as '' | 'started' | 'waiting' | 'overdue' | 'upcoming')}
                  className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
                >
                  <option value="">Alle frister</option>
                  <option value="waiting">Venter på signert kontrakt</option>
                  <option value="upcoming">Kommende frist</option>
                  <option value="overdue">Forfalt frist</option>
                  <option value="started">Har fristdato</option>
                </select>
              </label>
              <label className="inline-flex items-center gap-2 rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2 cursor-pointer self-end">
                <input
                  type="checkbox"
                  checked={onlyWithRequests}
                  onChange={(event) => setOnlyWithRequests(event.target.checked)}
                  className="h-4 w-4 accent-[#FF5B00]"
                />
                Med forespørsel
              </label>
            </div>
          </form>
        )}
      </div>

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

      {viewer.isAdmin && selectedIds.length > 0 && developers.length > 0 && (
        <div className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 max-w-full">
          <Users size={14} className="text-[#FF5B00] shrink-0" />
          <select
            value={bulkAssignOwnerId}
            disabled={assignBusy}
            onChange={(event) => setBulkAssignOwnerId(event.target.value)}
            className="bg-transparent text-xs text-gray-200 outline-none disabled:opacity-50 min-w-0"
          >
            <option value="">Velg utvikler…</option>
            {developers.map((owner) => (
              <option key={owner.accountKey} value={owner.accountKey}>
                {owner.name || owner.username}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={assignBusy || !bulkAssignOwnerId}
            onClick={() => {
              const chosen = items.filter((item) => selectedIds.includes(item.id));
              for (const item of chosen) void assignDeveloper(item, bulkAssignOwnerId);
            }}
            className="px-2 py-1 rounded-md bg-[#FF5B00] text-white text-xs hover:bg-[#e55200] disabled:opacity-50"
          >
            Tildel
          </button>
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
          Ingen utviklerkunder ennå. Aktive salgskunder og signerte kontrakter vises her.
        </p>
      ) : (
        <div className="space-y-8">
          {visibleCount === 0 ? (
            <p className="text-sm text-gray-500">Ingen kunder matcher søket.</p>
          ) : (
            <>
              <section className="space-y-3">
                <div className="rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2.5">
                  <span className="block text-sm font-semibold text-white">Development</span>
                  <span className="block text-[11px] text-gray-400 mt-0.5">
                    Solgte kunder. Leveringsfrist fra tilbudets tier. Klar for preview ligger i listen under.
                  </span>
                </div>
                {visibleDevelopmentItems.length === 0 ? (
                  <p className="text-sm text-gray-500">Ingen solgte kunder her.</p>
                ) : (
                  <>
                    {developmentUnassigned.length > 0 && (
                      <div className="space-y-3">
                        <div className="rounded-xl border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2.5">
                          <span className="block text-sm font-semibold">Ikke tildelt</span>
                          <span className="block text-[11px] opacity-80 mt-0.5">Tildel en utvikler før arbeidet starter.</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
                          {developmentUnassigned.map((item) => (
                            <React.Fragment key={item.id}>
                              {renderClientCard(item, 'deployment', false)}
                            </React.Fragment>
                          ))}
                        </div>
                      </div>
                    )}
                    {renderGroupedCards(developmentGroups, 'deployment', 'development')}
                  </>
                )}
              </section>
              <section className="space-y-3">
                <div className="rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2.5">
                  <span className="block text-sm font-semibold text-white">Før signert kontrakt</span>
                  <span className="block text-[11px] text-gray-400 mt-0.5">
                    Møtetid fra salg, med klokkeslett. Etter Klar for preview er det ingen frist.
                  </span>
                </div>
                {visiblePreviewItems.length === 0 ? (
                  <p className="text-sm text-gray-500">Ingen kunder før kontrakt.</p>
                ) : (
                  <>
                    {previewUnassigned.length > 0 && (
                      <div className="space-y-3">
                        <div className="rounded-xl border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2.5">
                          <span className="block text-sm font-semibold">Ikke tildelt</span>
                          <span className="block text-[11px] opacity-80 mt-0.5">Tildel en utvikler før arbeidet starter.</span>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
                          {previewUnassigned.map((item) => (
                            <React.Fragment key={item.id}>
                              {renderClientCard(item, 'preview', false)}
                            </React.Fragment>
                          ))}
                        </div>
                      </div>
                    )}
                    {renderGroupedCards(previewGroups, 'preview', 'preview')}
                  </>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </div>
  );
}
