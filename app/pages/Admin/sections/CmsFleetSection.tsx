import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Site } from '../shared';
import { asoldiPageIsOnThisComputer, fetchLocalMakerJson, makerBrowserUnreachableMessage } from '../../../../lib/maker-browser-client.js';

export type CmsFleetItem = {
  id?: string;
  repo?: string;
  status?: string;
  error?: string;
  fromVersion?: string;
  toVersion?: string;
};

export type CmsFleetJob = {
  id?: string;
  status?: string;
  targetVersion?: string;
  error?: string;
  items?: CmsFleetItem[];
};

export type CmsFleetSnapshot = {
  packageVersion?: string;
  contractVersion?: number;
  githubConfigured?: boolean;
  missingEnv?: string[];
  error?: string;
  job?: CmsFleetJob | null;
};

export function siteGithubRepo(site: Site) {
  return String(site.cms?.githubRepo || '').trim();
}

export function runningCmsVersion(site: Site) {
  return String(site.cms?.packageVersion || '').trim();
}

export function cmsFleetJobBusy(job?: CmsFleetJob | null) {
  return job?.status === 'queued' || job?.status === 'running';
}

export function cmsFleetStatusLabel(status = '') {
  if (status === 'finished') return 'Pushed';
  if (status === 'pushing') return 'Pushing';
  if (status === 'queued') return 'Queued';
  if (status === 'skipped') return 'Skipped';
  if (status === 'failed') return 'Failed';
  return status || '';
}

export function useCmsFleet(sites: Site[]) {
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [snapshot, setSnapshot] = useState<CmsFleetSnapshot | null>(null);
  const [makerError, setMakerError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadFleet = useCallback(async () => {
    if (typeof window !== 'undefined' && !asoldiPageIsOnThisComputer(window.location.hostname)) {
      setSnapshot(null);
      setMakerError('');
      return null;
    }
    try {
      const data = (await fetchLocalMakerJson('/api/cms-fleet')) as CmsFleetSnapshot;
      setSnapshot(data);
      setMakerError('');
      return data;
    } catch (error) {
      setMakerError(error instanceof Error ? error.message : makerBrowserUnreachableMessage());
      return null;
    }
  }, []);

  useEffect(() => {
    void loadFleet();
  }, [loadFleet]);

  useEffect(() => {
    if (!cmsFleetJobBusy(snapshot?.job)) return undefined;
    const timer = window.setInterval(() => {
      void loadFleet();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [loadFleet, snapshot?.job?.status, snapshot?.job?.id]);

  const withRepo = useMemo(() => sites.filter((site) => siteGithubRepo(site)), [sites]);
  const selectedRepos = withRepo.filter((site) => selected[site.id]).map(siteGithubRepo);
  const itemByRepo = useMemo(() => {
    const map = new Map<string, CmsFleetItem>();
    for (const item of snapshot?.job?.items || []) {
      const repo = String(item.repo || '').trim().toLowerCase();
      if (!repo) continue;
      map.set(repo, item);
      const shortName = repo.split('/').pop();
      if (shortName) map.set(shortName, item);
    }
    return map;
  }, [snapshot?.job]);

  function itemForSite(site: Site) {
    const repo = siteGithubRepo(site);
    if (!repo) return undefined;
    const key = repo.toLowerCase();
    return itemByRepo.get(key) || itemByRepo.get(key.split('/').pop() || '');
  }

  const allSelected = withRepo.length > 0 && withRepo.every((site) => selected[site.id]);
  const makerVersion = snapshot?.packageVersion || '';
  const pushing = busy || cmsFleetJobBusy(snapshot?.job);

  function toggle(id: string) {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function toggleAll() {
    if (allSelected) {
      setSelected({});
      return;
    }
    const next: Record<string, boolean> = {};
    for (const site of withRepo) next[site.id] = true;
    setSelected(next);
  }

  async function push(body: { repos?: string[]; all?: boolean }, confirmText: string) {
    if (typeof window !== 'undefined' && !asoldiPageIsOnThisComputer(window.location.hostname)) {
      return;
    }
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    try {
      const post = fetchLocalMakerJson as (
        pathname: string,
        opts?: { method?: string; body?: unknown }
      ) => Promise<CmsFleetSnapshot>;
      await post('/api/cms-fleet', { method: 'POST', body });
      await loadFleet();
    } catch (error) {
      setMakerError(error instanceof Error ? error.message : makerBrowserUnreachableMessage());
    } finally {
      setBusy(false);
    }
  }

  function pushSite(site: Site) {
    const repo = siteGithubRepo(site);
    if (!repo) return;
    const name = site.name || site.domain || repo;
    void push(
      { repos: [repo] },
      `Push CMS ${makerVersion || 'this version'} to ${name}? The website HTML and cms.site.json will not change.`
    );
  }

  function pushSelected() {
    void push(
      { repos: selectedRepos },
      `Push CMS ${makerVersion || 'this version'} to ${selectedRepos.length} selected site(s)? The website HTML and cms.site.json will not change.`
    );
  }

  function pushAll() {
    void push(
      { all: true },
      `Push CMS ${makerVersion || 'this version'} to every website--- repo on GitHub? The website HTML and cms.site.json will not change.`
    );
  }

  return {
    snapshot,
    makerError,
    makerVersion,
    pushing,
    selected,
    selectedRepos,
    allSelected,
    itemByRepo,
    itemForSite,
    toggle,
    toggleAll,
    pushSite,
    pushSelected,
    pushAll,
  };
}

type ToolbarProps = {
  fleet: ReturnType<typeof useCmsFleet>;
};

export function CmsFleetToolbar({ fleet }: ToolbarProps) {
  const { snapshot, makerError, makerVersion, pushing, selectedRepos, allSelected, toggleAll, pushSelected, pushAll } =
    fleet;
  if (typeof window !== 'undefined' && !asoldiPageIsOnThisComputer(window.location.hostname)) {
    return (
      <p className="mb-4 text-gray-500 text-xs">
        CMS push runs from Website Creator on this computer. Start Docker Maker, then use a local asoldi page.
      </p>
    );
  }
  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={toggleAll}
          className="px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15"
        >
          {allSelected ? 'Clear CMS selection' : 'Select all with a GitHub repo'}
        </button>
        <button
          type="button"
          disabled={pushing || !selectedRepos.length}
          onClick={pushSelected}
          className="px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm font-medium hover:bg-[#e55200] disabled:opacity-50"
        >
          Push CMS to selected
        </button>
        <button
          type="button"
          disabled={pushing || !snapshot || snapshot.githubConfigured === false}
          onClick={pushAll}
          className="px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15 disabled:opacity-50"
        >
          Push CMS to all
        </button>
      </div>
      <p className="text-gray-500 text-xs">
        Maker CMS {makerVersion || (snapshot ? 'unknown' : '…')}
        {snapshot?.githubConfigured === false
          ? ` · GitHub missing ${(snapshot.missingEnv || ['GITHUB_TOKEN']).join(', ')}`
          : snapshot
            ? ' · GitHub ready'
            : ''}
        {snapshot?.job ? ` · last job ${cmsFleetStatusLabel(snapshot.job.status)}` : ''}
      </p>
      {makerError && <p className="text-red-400 text-sm">{makerError}</p>}
    </div>
  );
}
