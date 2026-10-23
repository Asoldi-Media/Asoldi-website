import { useEffect, useMemo, useRef } from 'react';
import { getSalesClient } from '../../sales/emailApi';
import type { SalesClient } from '../shared';
import { LIVE_REFRESH_MAX_CLIENTS, LIVE_REFRESH_MS, clientNeedsLiveRefresh } from './firefliesRecording';

/**
 * While Fireflies is due, knocking or recording in a client's meeting, read that client again about every
 * 30 s, so the card shows the knock and the bot getting in. One timer for the whole board, one request after
 * another, and never more than a few clients: with more live at once, the whole list is read once instead.
 * Stops by itself when no meeting is live, and while the tab is hidden.
 */
export function useLiveRecordingRefresh({ clients, nowMs, enabled = true, onClient, reloadAll }: {
  clients: SalesClient[];
  nowMs: number;
  /** Off while something else already re-reads these clients often enough. */
  enabled?: boolean;
  onClient: (client: SalesClient) => void;
  reloadAll?: () => Promise<unknown>;
}) {
  const liveClientKey = useMemo(
    () => clients.filter((client) => clientNeedsLiveRefresh(client, nowMs)).map((client) => client.id).join('|'),
    [clients, nowMs],
  );
  const busyRef = useRef(false);
  const onClientRef = useRef(onClient);
  const reloadAllRef = useRef(reloadAll);
  onClientRef.current = onClient;
  reloadAllRef.current = reloadAll;

  useEffect(() => {
    if (!liveClientKey || !enabled) return undefined;
    const ids = liveClientKey.split('|');
    const timer = window.setInterval(() => {
      if (busyRef.current || document.visibilityState === 'hidden') return;
      busyRef.current = true;
      void (async () => {
        try {
          if (ids.length > LIVE_REFRESH_MAX_CLIENTS && reloadAllRef.current) {
            await reloadAllRef.current();
            return;
          }
          for (const id of ids.slice(0, LIVE_REFRESH_MAX_CLIENTS)) {
            const data = await getSalesClient(id).catch(() => null);
            if (data?.client?.id) onClientRef.current(data.client);
          }
        } catch {
          // The next tick tries again.
        } finally {
          busyRef.current = false;
        }
      })();
    }, LIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [liveClientKey, enabled]);
}
