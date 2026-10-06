import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Filter, Loader2, LogOut, Search, UserRound, Users, X } from 'lucide-react';
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
import { currentPipelineStage } from '../../../../lib/developer-card.js';
import { DeveloperRunQueueBar } from '../../developer/DeveloperRunQueueBar';
import { LOCAL_EDITOR_ORIGIN } from '../../../../lib/maker-editor-origin.js';
import { fetchMakerQueue } from '../../developer/makerQueue';

type Props = {
  hideHeader?: boolean;
  onLogout?: () => void;
};

type ProductBracket = 'asoldi' | 'ssu';
type PeriodPreset = '' | '7d' | '30d' | '90d';
type DateField = 'created' | 'meeting' | 'due';

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


function itemDateIso(item: DevelopmentItem, field: DateField) {
  if (field === 'meeting') return String(item.meetingAt || '');
  if (field === 'due') return String(item.websiteDue?.dueAt || '');
  return String(item.createdAt || '');
}

function matchesDateWindow(
  item: DevelopmentItem,
  field: DateField,
  preset: PeriodPreset,
  from: string,
  to: string,
  nowMs: number,
) {
  if (!preset && !from && !to) return true;
  const ms = Date.parse(itemDateIso(item, field));
  if (!Number.isFinite(ms)) return false;
  if (from) {
    const start = Date.parse(`${from}T00:00:00`);
    if (Number.isFinite(start) && ms < start) return false;
  }
  if (to) {
    const end = Date.parse(`${to}T23:59:59`);
    if (Number.isFinite(end) && ms > end) return false;
  }
  if (preset) {
    const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
    if (ms < nowMs - days * 24 * 60 * 60 * 1000) return false;
    if (ms > nowMs) return false;
  }
  return true;
}

export function DevelopmentClientsSection({ onLogout }: Props) {
  const [developmentItems, setDevelopmentItems] = useState<DevelopmentItem[]>([]);
  const [previewItems, setPreviewItems] = useState<DevelopmentItem[]>([]);
  const [ssuItems, setSsuItems] = useState<DevelopmentItem[]>([]);
  const [productBracket, setProductBracket] = useState<ProductBracket>('asoldi');
  const [productMenuOpen, setProductMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
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
  const [industryFilter, setIndustryFilter] = useState('');
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>('');
  const [periodFrom, setPeriodFrom] = useState('');
  const [periodTo, setPeriodTo] = useState('');
  const [dateField, setDateField] = useState<DateField>('created');
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

  function revealPreviewReadyBucket() {
    setCollapsedBuckets((prev) => {
      const key = 'preview:noNextAction';
      if (prev[key] === false) return prev;
      const next = { ...prev, [key]: false };
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
    setIndustryFilter('');
    setPeriodPreset('');
    setPeriodFrom('');
    setPeriodTo('');
    setDateField('created');
    setDueFilter('');
    setOnlyWithRequests(false);
    setOwnerFilter('');
  }

  const hasActiveFilters = Boolean(
    searchQuery || runFilter || stepFilter || industryFilter || periodPreset || periodFrom || periodTo
    || dueFilter || onlyWithRequests || ownerFilter
  );
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
      const industry = String(item.industry || '').trim();
      if (industryFilter === '__none__' && industry) return false;
      if (industryFilter && industryFilter !== '__none__' && industry.toLowerCase() !== industryFilter.toLowerCase()) return false;
      if (stepFilter && currentPipelineStage(item.makerRun || {}) !== stepFilter) return false;
      if (!matchesDateWindow(item, dateField, periodPreset, periodFrom, periodTo, nowMs)) return false;
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
    [itemMatchesSearch, runFilter, stepFilter, industryFilter, dateField, periodPreset, periodFrom, periodTo, dueFilter, nowMs, onlyWithRequests, threadMap, viewer.isAdmin, ownerFilter]
  );
  const items = useMemo(
    () => [...developmentItems, ...previewItems, ...ssuItems],
    [developmentItems, previewItems, ssuItems]
  );
  const productCounts = useMemo(() => ({
    asoldi: developmentItems.length + previewItems.length,
    ssu: ssuItems.length,
  }), [developmentItems.length, previewItems.length, ssuItems.length]);
  const industryOptions = useMemo(() => {
    const pool = productBracket === 'ssu' ? ssuItems : [...developmentItems, ...previewItems];
    const names = new Set<string>();
    for (const item of pool) {
      const name = String(item.industry || '').trim();
      if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b, 'nb'));
  }, [productBracket, ssuItems, developmentItems, previewItems]);
  const visibleDevelopmentItems = useMemo(
    () => (productBracket === 'asoldi' ? developmentItems.filter(itemVisible) : []),
    [developmentItems, itemVisible, productBracket]
  );
  const visiblePreviewItems = useMemo(
    () => (productBracket === 'asoldi' ? previewItems.filter(itemVisible) : []),
    [previewItems, itemVisible, productBracket]
  );
  const visibleSsuItems = useMemo(
    () => (productBracket === 'ssu' ? ssuItems.filter(itemVisible) : []),
    [ssuItems, itemVisible, productBracket]
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
  const ssuGroups = useMemo(
    () => groupDevelopmentItems(
      visibleSsuItems.filter((item) => !viewer.isAdmin || item.developerOwnerId),
      nowMs
    ),
    [visibleSsuItems, nowMs, viewer.isAdmin]
  );
  const ssuUnassigned = useMemo(
    () => (viewer.isAdmin ? visibleSsuItems.filter((item) => !item.developerOwnerId) : []),
    [visibleSsuItems, viewer.isAdmin]
  );
  const visibleCount = visibleDevelopmentItems.length + visiblePreviewItems.length + visibleSsuItems.length;
  const visibleItems = useMemo(
    () => [...visibleDevelopmentItems, ...visiblePreviewItems, ...visibleSsuItems],
    [visibleDevelopmentItems, visiblePreviewItems, visibleSsuItems]
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
        onPreviewGoalReady={revealPreviewReadyBucket}
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
      const nextSsu = Array.isArray(data.ssuItems) ? data.ssuItems : [];
      setDevelopmentItems(dedupe(nextDevelopment));
      setPreviewItems(dedupe(nextPreview));
      setSsuItems(dedupe(nextSsu));
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
    if (!headerPanel && !productMenuOpen && !accountMenuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && headerShellRef.current?.contains(target)) return;
      setHeaderPanel(null);
      setProductMenuOpen(false);
      setAccountMenuOpen(false);
    };
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && headerShellRef.current?.contains(target)) return;
      setHeaderPanel(null);
      setProductMenuOpen(false);
      setAccountMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [headerPanel, productMenuOpen, accountMenuOpen]);

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
  const isSsuBracket = productBracket === 'ssu';
  const runningJobs = queueItems.filter((item) => {
    const status = String(item.status || '');
    return status === 'running' || status === 'queued';
  }).length;

  function chooseProduct(next: ProductBracket) {
    setProductBracket(next);
    setProductMenuOpen(false);
    setSelectedIds([]);
    setIndustryFilter('');
  }

  return (
    <div className="sales-clients-surface min-h-screen bg-[#1a1a1a] text-white">
      <header ref={headerShellRef} className="sales-sticky-header sticky top-0 z-[70] border-b border-white/10 bg-[#161616] shadow-sm">
        <div className="max-w-[1440px] mx-auto px-3 sm:px-5 py-2.5 flex items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 shrink-0 relative z-[80]">
            <img src="/media/Untitled-1.png" alt="Asoldi" className="h-8 sm:h-9 w-auto shrink-0" />
            <div className="min-w-0 relative">
              <h1 className="text-sm sm:text-base font-semibold leading-tight truncate">Utviklerterminal</h1>
              <button
                type="button"
                onClick={() => {
                  setHeaderPanel(null);
                  setAccountMenuOpen(false);
                  setProductMenuOpen((open) => !open);
                }}
                className="mt-0.5 inline-flex items-center gap-1 text-[11px] sm:text-xs text-gray-300 hover:text-white"
                aria-expanded={productMenuOpen}
              >
                <span className="truncate">
                  {isSsuBracket ? 'SSU' : 'Website'} ({isSsuBracket ? productCounts.ssu : productCounts.asoldi})
                </span>
                <ChevronDown size={12} className={`shrink-0 transition-transform ${productMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {productMenuOpen && (
                <div className="absolute left-0 top-full mt-1 z-[90] min-w-[180px] rounded-xl border border-white/10 bg-[#1f1f1f] shadow-xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => chooseProduct('asoldi')}
                    className={`w-full text-left px-3 py-2 text-sm ${productBracket === 'asoldi' ? 'bg-[#FF5B00] text-white' : 'text-gray-200 hover:bg-white/10'}`}
                  >
                    Website ({productCounts.asoldi})
                  </button>
                  <button
                    type="button"
                    onClick={() => chooseProduct('ssu')}
                    className={`w-full text-left px-3 py-2 text-sm ${productBracket === 'ssu' ? 'bg-[#FF5B00] text-white' : 'text-gray-200 hover:bg-white/10'}`}
                  >
                    SSU ({productCounts.ssu})
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                setProductMenuOpen(false);
                setAccountMenuOpen(false);
                setHeaderPanel((current) => (current === 'filter' ? null : 'filter'));
              }}
              className={`inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs sm:text-sm ${
                headerPanel === 'filter' ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
              }`}
              aria-expanded={headerPanel === 'filter'}
            >
              <Filter size={14} />
              <span className="hidden sm:inline">Filter</span>
              {hasActiveFilters || selectedIds.length > 0 ? <span className="h-1.5 w-1.5 rounded-full bg-white sm:bg-orange-200" /> : null}
              <ChevronDown size={12} className={`hidden sm:block transition-transform ${headerPanel === 'filter' ? 'rotate-180' : ''}`} />
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setHeaderPanel(null);
                  setProductMenuOpen(false);
                  setAccountMenuOpen((open) => !open);
                }}
                className={`inline-flex items-center justify-center h-10 w-10 rounded-lg ${
                  accountMenuOpen ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
                }`}
                title="Konto"
                aria-expanded={accountMenuOpen}
                aria-label="Konto"
              >
                <UserRound size={16} />
              </button>
              {accountMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-[90] w-64 rounded-xl border border-white/10 bg-[#1f1f1f] shadow-xl p-3">
                  <p className="text-[11px] text-gray-400">Innlogget som {viewer.username || 'utvikler'}</p>
                  {onLogout && (
                    <button
                      type="button"
                      onClick={() => onLogout()}
                      className="mt-2 w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15"
                    >
                      <LogOut size={14} />
                      Logg ut
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {headerPanel === 'filter' && (
          <div className="border-t border-white/10 bg-[#1a1a1a]">
            <div className="max-w-[1440px] mx-auto px-3 sm:px-5 py-3">
              <form onSubmit={applySearch} className="rounded-xl border border-white/10 bg-black/20 p-2.5 sm:p-3 space-y-2.5 max-h-[70vh] overflow-y-auto">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-gray-400">
                    Lukk: klikk Filter igjen, klikk under, eller scroll.
                    {hasActiveFilters ? ` Viser ${visibleCount}.` : ''}
                  </p>
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
                  <div className="flex gap-2">
                    <button type="submit" className="inline-flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm hover:bg-[#e55200]">
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
                </div>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  <label className="text-[11px] text-gray-400 block">
                    <span className="block mb-1">Bransje</span>
                    <select
                      value={industryFilter}
                      onChange={(event) => setIndustryFilter(event.target.value)}
                      className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
                    >
                      <option value="">Alle bransjer</option>
                      <option value="__none__">Uten bransje</option>
                      {industryOptions.map((name) => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-[11px] text-gray-400 block">
                    <span className="block mb-1">Nåværende steg (siste ferdig)</span>
                    <select
                      value={stepFilter}
                      onChange={(event) => setStepFilter(event.target.value)}
                      className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
                    >
                      <option value="">Alle steg</option>
                      <option value="none">Ingen run</option>
                      <option value="draft">Run uten ferdig steg</option>
                      <option value="1">Steg 1</option>
                      <option value="lang">Språk låst</option>
                      <option value="1.5">Steg 1.5</option>
                      <option value="2.1">Steg 2.1</option>
                      <option value="2.2">Steg 2.2</option>
                      <option value="layout">Layout</option>
                      <option value="maps">Kart</option>
                      <option value="cms">CMS</option>
                      <option value="seo">Steg 4 SEO</option>
                    </select>
                  </label>
                  <label className="text-[11px] text-gray-400 block">
                    <span className="block mb-1">Datofelt</span>
                    <select
                      value={dateField}
                      onChange={(event) => setDateField(event.target.value as DateField)}
                      className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
                    >
                      <option value="created">Opprettet</option>
                      <option value="meeting">Møte</option>
                      <option value="due">Frist</option>
                    </select>
                  </label>
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
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {([
                    ['7d', 'Siste uke'],
                    ['30d', 'Siste måned'],
                    ['90d', 'Siste 3 måneder'],
                  ] as const).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setPeriodPreset((current) => (current === id ? '' : id))}
                      className={`px-2.5 py-1 rounded-lg text-xs border ${
                        periodPreset === id
                          ? 'bg-[#FF5B00] border-[#FF5B00] text-white'
                          : 'bg-[#1a1a1a] border-white/10 text-gray-200 hover:bg-white/10'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="grid sm:grid-cols-2 gap-2">
                  <label className="text-[11px] text-gray-400 block">
                    <span className="block mb-1">Fra</span>
                    <input
                      type="date"
                      value={periodFrom}
                      onChange={(event) => setPeriodFrom(event.target.value)}
                      className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
                    />
                  </label>
                  <label className="text-[11px] text-gray-400 block">
                    <span className="block mb-1">Til</span>
                    <input
                      type="date"
                      value={periodTo}
                      onChange={(event) => setPeriodTo(event.target.value)}
                      className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
                    />
                  </label>
                </div>
                <label className="inline-flex items-center gap-2 rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={onlyWithRequests}
                    onChange={(event) => setOnlyWithRequests(event.target.checked)}
                    className="h-4 w-4 accent-[#FF5B00]"
                  />
                  Med forespørsel
                </label>
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-white/10">
                  <label className="inline-flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      disabled={!visibleSelectableIds.length || assignBusy}
                      onChange={toggleSelectAllVisible}
                      className="h-4 w-4 accent-[#FF5B00]"
                    />
                    Velg alle
                    <span className="text-xs text-gray-400">
                      {selectedIds.length ? `${selectedIds.length} valgt` : `${visibleSelectableIds.length} synlige`}
                    </span>
                  </label>
                  {selectedIds.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedIds([])}
                      disabled={assignBusy}
                      className="text-xs text-gray-400 hover:text-white disabled:opacity-50"
                    >
                      Nullstill
                    </button>
                  )}
                </div>
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
                  embedded
                  hideSelection
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
              </form>
            </div>
          </div>
        )}
      </header>

      <div className="max-w-[1440px] mx-auto px-3 sm:px-6 py-4 space-y-4">
      {headerPanel !== 'filter' && (selectedIds.length > 0 || runningJobs > 0) && (
        <button
          type="button"
          onClick={() => setHeaderPanel('filter')}
          className="w-full text-left rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2 text-xs text-gray-300 hover:bg-white/10"
        >
          {selectedIds.length > 0 ? `${selectedIds.length} valgt. ` : ''}
          {runningJobs > 0 ? `${runningJobs} i kø. ` : ''}
          Åpne Filter for å kjøre steg.
        </button>
      )}

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
            <p className="text-sm text-gray-500">
              {hasActiveFilters
                ? 'Ingen kunder matcher filteret.'
                : isSsuBracket
                  ? 'Ingen SSU-kunder.'
                  : 'Ingen kunder her.'}
            </p>
          ) : isSsuBracket ? (
            <section className="space-y-3">
              <div className="rounded-xl border border-white/10 bg-[#2a2a2a] px-3 py-2.5">
                <span className="block text-sm font-semibold text-white">SSU</span>
                <span className="block text-[11px] text-gray-400 mt-0.5">
                  SSU-kunder. Nettstedskundene ligger under Website.
                </span>
              </div>
              {ssuUnassigned.length > 0 && (
                <div className="space-y-3">
                  <div className="rounded-xl border border-amber-300 bg-amber-50 text-amber-900 px-3 py-2.5">
                    <span className="block text-sm font-semibold">Ikke tildelt</span>
                    <span className="block text-[11px] opacity-80 mt-0.5">Tildel en utvikler før arbeidet starter.</span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
                    {ssuUnassigned.map((item) => (
                      <React.Fragment key={item.id}>
                        {renderClientCard(item, 'preview', false)}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}
              {renderGroupedCards(ssuGroups, 'preview', 'ssu')}
            </section>
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
    </div>
  );
}
