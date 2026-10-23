import { useEffect, useMemo, useRef } from 'react';
import { getSalesClient } from '../../sales/emailApi';
import type { SalesClient } from '../shared';
import { LIVE_REFRESH_MAX_CLIENTS, LIVE_REFRESH_MS, clientNeedsLiveRefresh } from './firefliesRecording';

/**
 * While Fireflies is due, knocking or recording in a client's meeting, read that client again about every
 * 30 s, so the card shows the knock and the bot getting in. One timer for the whole board, one request after
 * another, and never more than a few clients: with more live at once, the whole list is read once instead.
 * Stops by itself when no meeting is live. It keeps going in a background tab, since the rep is then most
 * likely in the Meet tab, and the tab title is how a knock reaches them there.
 */
export function useLiveRecordingRefresh({ clients, nowMs, enabled = true, onClient, reloadAll, generation }: {
  clients: SalesClient[];
  nowMs: number;
  /** Off while the board is hidden, or while something else already re-reads these clients often enough. */
  enabled?: boolean;
  onClient: (client: SalesClient) => void;
  reloadAll?: () => Promise<unknown>;
  /** Bumped by every save on screen: an answer that left before a save must not overwrite it. */
  generation?: () => number;
}) {
  const liveClientKey = useMemo(
    () => clients.filter((client) => clientNeedsLiveRefresh(client, nowMs)).map((client) => client.id).join('|'),
    [clients, nowMs],
  );
  const busyRef = useRef(false);
  const onClientRef = useRef(onClient);
  const reloadAllRef = useRef(reloadAll);
  const generationRef = useRef(generation);
  onClientRef.current = onClient;
  reloadAllRef.current = reloadAll;
  generationRef.current = generation;

  useEffect(() => {
    if (!liveClientKey || !enabled) return undefined;
    const ids = liveClientKey.split('|');
    const timer = window.setInterval(() => {
      if (busyRef.current) return;
      busyRef.current = true;
      void (async () => {
        try {
          if (ids.length > LIVE_REFRESH_MAX_CLIENTS && reloadAllRef.current) {
            await reloadAllRef.current();
            return;
          }
          for (const id of ids.slice(0, LIVE_REFRESH_MAX_CLIENTS)) {
            const before = generationRef.current?.();
            const data = await getSalesClient(id).catch(() => null);
            // A save landed while this read was on the way: the save's answer is newer, so drop this one.
            if (generationRef.current && generationRef.current() !== before) continue;
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
