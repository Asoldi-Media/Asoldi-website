import { useEffect, useRef } from 'react';
import { API, authHeaders, developmentAuthHeaders } from '../../Admin/shared';
import type { BoardSnapshot } from './types';

/** One board poll. Idle traffic stays at four requests a minute. */
export const BOARD_POLL_MS = 15_000;

export type BoardClock = {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
};

export type BoardPollOptions = {
  intervalMs?: number;
  clock: BoardClock;
  hidden: () => boolean;
  since?: number;
  poll: (since: number) => Promise<{ rev?: number } | void>;
  onError?: () => void;
  onSuccess?: () => void;
};

/**
 * One interval for the whole board. The first request waits one interval.
 * A hidden tab skips the request. After an error the next ticks are skipped,
 * so the wait grows without a second timer.
 */
export function createBoardPollScheduler(options: BoardPollOptions) {
  const intervalMs = options.intervalMs ?? BOARD_POLL_MS;
  let since = Number(options.since) || 0;
  let timer: unknown = null;
  let stopped = false;
  let skip = 0;
  let backoff = 0;
  let inFlight = false;

  async function tick() {
    if (stopped || options.hidden() || inFlight) return;
    if (skip > 0) {
      skip -= 1;
      return;
    }
    inFlight = true;
    try {
      const body = await options.poll(since);
      if (body && typeof body.rev === 'number' && Number.isFinite(body.rev)) since = body.rev;
      backoff = 0;
      options.onSuccess?.();
    } catch {
      backoff = Math.min(backoff + 1, 4);
      skip = backoff;
      options.onError?.();
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer != null || stopped) return;
      timer = options.clock.setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop() {
      stopped = true;
      if (timer != null) options.clock.clearInterval(timer);
      timer = null;
    },
  };
}

/** Every board request sends the staff headers from authHeaders(). */
export function boardFetch(path: string, init: RequestInit = {}) {
  const url = path.startsWith('http') ? path : `${API}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = new Headers(init.headers || undefined);
  const auth = { ...authHeaders(), ...developmentAuthHeaders() };
  for (const [key, value] of Object.entries(auth)) {
    if (value && !headers.has(key)) headers.set(key, value);
  }
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(url, { ...init, headers });
}

export async function readBoardJson<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

type HookOptions = {
  enabled: boolean;
  sinceRef: { current: number };
  onStatus: (body: BoardSnapshot) => void;
  onError?: () => void;
  onSuccess?: () => void;
};

/** Starts the single board interval while `enabled` is true. */
export function useBoardPoll({ enabled, sinceRef, onStatus, onError, onSuccess }: HookOptions) {
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  const onStatusRef = useRef(onStatus);
  const onErrorRef = useRef(onError);
  onStatusRef.current = onStatus;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!enabled) return undefined;
    const scheduler = createBoardPollScheduler({
      since: sinceRef.current,
      clock: {
        setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
        clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
      },
      onError: () => onErrorRef.current?.(),
      onSuccess: () => onSuccessRef.current?.(),
      hidden: () => typeof document !== 'undefined' && document.hidden === true,
      poll: async (since) => {
        const response = await boardFetch(`/admin/development/board-status?since=${encodeURIComponent(String(since))}`);
        if (!response.ok) throw new Error('board-status');
        const body = await readBoardJson<BoardSnapshot>(response);
        if (!body) throw new Error('board-status');
        sinceRef.current = typeof body.rev === 'number' ? body.rev : since;
        onStatusRef.current(body);
        return body;
      },
    });
    scheduler.start();
    return () => scheduler.stop();
  }, [enabled, sinceRef]);
}
