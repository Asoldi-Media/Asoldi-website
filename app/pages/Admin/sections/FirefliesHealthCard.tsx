import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Mic, RefreshCw } from 'lucide-react';
import { getFirefliesIngestStatus, getFirefliesLiveJoinStatus, isMissingRoute } from '../../sales/emailApi';

type PartStatus = { lastOkAt?: string; lastError?: string; failingSince?: string };
type Budget = { limit?: number | null; remaining?: number | null; resetAt?: number; seenAt?: number };
type RateLimitStatus = {
  pausedUntil?: { api?: string; join?: string };
  api?: Budget;
  join?: Budget;
  lastRateLimitAt?: string;
  lastError?: string;
};

/** lib/fireflies-ingest.js firefliesIngestStatus(). */
type IngestStatus = {
  keyConfigured?: boolean;
  safeModeBlocked?: boolean;
  lastTickAt?: string;
  lastOkAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  consecutiveFailures?: number;
  lastRateLimitedAt?: string;
  rateLimit?: RateLimitStatus;
  pendingHydrations?: number;
  unfinishedSummaries?: number;
  gaveUp?: number;
  missingPlaceholders?: number;
  scan?: PartStatus;
  watchdog?: PartStatus;
  lastHealthAlertAt?: string;
  stateError?: string;
  store?: Record<string, { source?: string; error?: string }>;
};

/** lib/fireflies-live-sessions.js firefliesLiveJoinStatus(), plus the transport's rate limit. */
type LiveJoinStatus = {
  lastTickAt?: string;
  lastError?: string;
  running?: boolean;
  sessionsInWindow?: number;
  sessions?: Array<{ key: string; startAt: string; state: string; attempts: number; verifiedAt: string; nextAttemptAt: string }>;
  limiter?: { limit?: number; windowMinutes?: number; callsInWindow?: number; blockedUntil?: string; nextAllowedAt?: string };
  apiKeyPresent?: boolean;
  safeModeBlocking?: boolean;
  keyOwnerEmail?: string;
  oneBot?: boolean;
  rateLimit?: RateLimitStatus;
};

type Loaded<T> = { status: 'loading' } | { status: 'missing' } | { status: 'error'; message: string } | { status: 'ok'; data: T };

const REFRESH_MS = 60_000;

const STORE_FILES: Record<string, string> = {
  meetings: 'fireflies-meetings.json',
  notified: 'fireflies-notified.json',
  ingest: 'fireflies-ingest-state.json',
};

const SESSION_STATE_LABEL: Record<string, string> = {
  scheduled: 'venter på start',
  dispatched: 'banker på',
  recording: 'tar opp',
  ended: 'ferdig',
  'not-admitted': 'kom ikke inn',
};

function when(iso = '') {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Oslo' });
}

function future(iso = '', nowMs = Date.now()) {
  const ms = Date.parse(iso || '');
  return Number.isFinite(ms) && ms > nowMs;
}

function count(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function load<T>(read: () => Promise<Record<string, unknown>>): Promise<Loaded<T>> {
  try {
    return { status: 'ok', data: await read() as T };
  } catch (error) {
    if (isMissingRoute(error)) return { status: 'missing' };
    return { status: 'error', message: error instanceof Error ? error.message : 'Kunne ikke hente status.' };
  }
}

function Row({ label, value, warn = false }: { label: string; value: React.ReactNode; warn?: boolean }) {
  return (
    <li className="flex justify-between gap-4">
      <span className="text-gray-400">{label}</span>
      <span className={`text-right ${warn ? 'text-amber-300' : 'text-white'}`}>{value}</span>
    </li>
  );
}

/**
 * Superadmin → System safety: is Fireflies working on this hub. Pull ingest (GET /api/admin/fireflies/ingest-status)
 * and the live-join engine (GET /api/admin/fireflies/live-join-status). Loud when safe mode or a missing key
 * stops recordings; quiet details otherwise. A hub without these routes shows nothing.
 */
export function FirefliesHealthCard() {
  const [ingest, setIngest] = useState<Loaded<IngestStatus>>({ status: 'loading' });
  const [live, setLive] = useState<Loaded<LiveJoinStatus>>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const [nextIngest, nextLive] = await Promise.all([
      load<IngestStatus>(getFirefliesIngestStatus),
      load<LiveJoinStatus>(getFirefliesLiveJoinStatus),
    ]);
    setIngest(nextIngest);
    setLive(nextLive);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  if (ingest.status === 'missing' && live.status === 'missing') return null;
  if (ingest.status === 'loading' && live.status === 'loading') return null;

  const nowMs = Date.now();
  const ingestData = ingest.status === 'ok' ? ingest.data : null;
  const liveData = live.status === 'ok' ? live.data : null;
  const rate = liveData?.rateLimit || ingestData?.rateLimit || null;

  const alarms: string[] = [];
  if (ingestData?.safeModeBlocked || liveData?.safeModeBlocking) {
    alarms.push('Safe mode stopper Fireflies på denne huben: boten sendes ikke inn i møter, og nye opptak hentes ikke inn. Er dette produksjon, må safe mode av.');
  }
  if (ingestData?.keyConfigured === false || liveData?.apiKeyPresent === false) {
    alarms.push('Fireflies-nøkkelen mangler på serveren (FIREFLIES_API_KEY). Ingen møter blir tatt opp eller hentet inn.');
  }
  for (const [name, file] of Object.entries(STORE_FILES)) {
    if (ingestData?.store?.[name]?.source === 'unreadable') {
      alarms.push(`${file} kan ikke leses, og ingen sikkerhetskopi kan leses. Se backups/ i datamappen.`);
    }
  }

  const warnings: string[] = [];
  const pausedUntil = [rate?.pausedUntil?.api, rate?.pausedUntil?.join].filter((iso) => future(iso, nowMs)).sort()[0] || '';
  if (pausedUntil) warnings.push(`Fireflies har bedt huben vente til ${when(pausedUntil)} (fartsgrense). Henting og innsending venter til da.`);
  if (count(ingestData?.consecutiveFailures) > 0) {
    warnings.push(`Hentingen har feilet ${count(ingestData?.consecutiveFailures)} ganger på rad${ingestData?.lastError ? `: ${ingestData.lastError}` : '.'}`);
  }
  if (ingestData?.scan?.failingSince) warnings.push(`Gjennomgangen av eldre opptak feiler siden ${when(ingestData.scan.failingSince)}.`);
  if (ingestData?.watchdog?.failingSince) warnings.push(`Sjekken av bookede møter feiler siden ${when(ingestData.watchdog.failingSince)}.`);
  if (ingestData?.stateError) warnings.push(`Hentestatus: ${ingestData.stateError}`);
  if (liveData?.lastError) warnings.push(`Live-join: ${liveData.lastError}`);
  if (future(liveData?.limiter?.blockedUntil, nowMs)) warnings.push(`Innsending er stoppet av Fireflies til ${when(liveData?.limiter?.blockedUntil)}.`);

  const limiter = liveData?.limiter || null;
  const api = rate?.api || null;

  return (
    <div className="rounded-xl border border-white/10 bg-[#1f1f1f] p-4 space-y-3 text-sm">
      <div className="flex items-center justify-between gap-3">
        <h3 className="inline-flex items-center gap-2 text-white font-medium">
          <Mic size={16} /> Fireflies
        </h3>
        <button
          type="button"
          onClick={() => void refresh()}
          className="px-2.5 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 inline-flex items-center gap-1.5"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> Oppdater
        </button>
      </div>

      {alarms.map((text) => (
        <div key={text} role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/60 bg-red-900/40 px-3 py-2.5 text-red-200 font-medium">
          <AlertTriangle size={18} className="shrink-0 mt-0.5" />
          <span>{text}</span>
        </div>
      ))}
      {warnings.map((text) => (
        <div key={text} className="flex items-start gap-2 rounded-lg border border-amber-400/40 bg-amber-900/30 px-3 py-2 text-amber-200 text-xs">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>{text}</span>
        </div>
      ))}

      <div className="grid gap-4 md:grid-cols-2">
        {ingestData ? (
          <div>
            <h4 className="text-white font-medium mb-2">Henting av opptak</h4>
            <ul className="text-xs space-y-1">
              <Row label="Sist kjørt" value={when(ingestData.lastTickAt) || 'ikke ennå'} />
              <Row label="Sist OK" value={when(ingestData.lastOkAt) || 'ikke ennå'} warn={!ingestData.lastOkAt} />
              <Row
                label="Siste feil"
                value={ingestData.lastError ? `${ingestData.lastError}${ingestData.lastErrorAt ? ` (${when(ingestData.lastErrorAt)})` : ''}` : 'ingen'}
                warn={Boolean(ingestData.lastError)}
              />
              <Row label="Venter på henting" value={count(ingestData.pendingHydrations)} />
              <Row label="Uten ferdig sammendrag" value={count(ingestData.unfinishedSummaries)} />
              <Row label="Gitt opp" value={count(ingestData.gaveUp)} warn={count(ingestData.gaveUp) > 0} />
              <Row label="Møter uten opptak" value={count(ingestData.missingPlaceholders)} warn={count(ingestData.missingPlaceholders) > 0} />
              <Row
                label="Gjennomgang av eldre opptak"
                value={ingestData.scan?.failingSince ? `feiler siden ${when(ingestData.scan.failingSince)}` : when(ingestData.scan?.lastOkAt) || 'ikke ennå'}
                warn={Boolean(ingestData.scan?.failingSince)}
              />
              <Row
                label="Sjekk av bookede møter"
                value={ingestData.watchdog?.failingSince ? `feiler siden ${when(ingestData.watchdog.failingSince)}` : when(ingestData.watchdog?.lastOkAt) || 'ikke ennå'}
                warn={Boolean(ingestData.watchdog?.failingSince)}
              />
              <Row label="Sist begrenset av Fireflies" value={when(ingestData.lastRateLimitedAt || rate?.lastRateLimitAt) || 'aldri'} />
              {api && api.limit != null ? <Row label="API-kall igjen dette minuttet" value={`${count(api.remaining)} av ${count(api.limit)}`} /> : null}
              {ingestData.lastHealthAlertAt ? <Row label="Siste varsel sendt" value={when(ingestData.lastHealthAlertAt)} /> : null}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-gray-400">{ingest.status === 'error' ? `Henting: ${ingest.message}` : ''}</p>
        )}

        {liveData ? (
          <div>
            <h4 className="text-white font-medium mb-2">Fireflies inn i møtene (live-join)</h4>
            <ul className="text-xs space-y-1">
              <Row label="Sist kjørt" value={liveData.running ? 'kjører nå' : when(liveData.lastTickAt) || 'ikke ennå'} />
              <Row label="Møter i vinduet nå" value={count(liveData.sessionsInWindow)} />
              {limiter ? (
                <Row
                  label={`Innsendinger siste ${count(limiter.windowMinutes) || 20} min`}
                  value={`${count(limiter.callsInWindow)} av ${count(limiter.limit) || 3}`}
                  warn={count(limiter.callsInWindow) >= (count(limiter.limit) || 3)}
                />
              ) : null}
              {limiter?.nextAllowedAt && future(limiter.nextAllowedAt, nowMs) ? (
                <Row label="Neste innsending tidligst" value={when(limiter.nextAllowedAt)} warn />
              ) : null}
              <Row label="Fireflies-konto (nøkkelen)" value={liveData.keyOwnerEmail || 'ukjent'} />
              <Row label="Én bot om gangen" value={liveData.oneBot ? 'på' : 'av'} />
            </ul>
            {liveData.sessions?.length ? (
              <ul className="mt-2 text-xs space-y-1">
                {liveData.sessions.map((session) => (
                  <li key={session.key} className="text-gray-300">
                    {when(session.startAt)} · {SESSION_STATE_LABEL[session.state] || session.state}
                    {session.attempts ? ` · ${session.attempts} forsøk` : ''}
                    {session.nextAttemptAt && future(session.nextAttemptAt, nowMs) ? ` · neste ${when(session.nextAttemptAt)}` : ''}
                    <span className="block text-gray-500 break-all">{session.key.split('|')[0]}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-gray-400">{live.status === 'error' ? `Live-join: ${live.message}` : ''}</p>
        )}
      </div>
    </div>
  );
}
