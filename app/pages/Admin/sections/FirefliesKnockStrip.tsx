import React, { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, UserRound, X } from 'lucide-react';
import type { SalesClient } from '../shared';
import { knockingMeetings, recordingClock, slotKindLabel, type KnockingMeeting } from './firefliesRecording';

const TITLE_PREFIX = 'Slipp inn Fireflies · ';

/**
 * While a notetaker knocks in any meeting on this board, prefix the tab title: a rep who sits in the Meet
 * tab sees it in the tab strip. Re-applied on every render, since the page's own title may be set again.
 */
export function useKnockTitle(knocking: boolean) {
  useEffect(() => {
    if (!knocking) return undefined;
    if (!document.title.startsWith(TITLE_PREFIX)) document.title = `${TITLE_PREFIX}${document.title}`;
    return () => {
      if (document.title.startsWith(TITLE_PREFIX)) document.title = document.title.slice(TITLE_PREFIX.length);
    };
  });
}

function knockKey(item: KnockingMeeting) {
  return `${item.client.id}|${item.entry.slotKey}|${item.entry.lastAttemptAt}`;
}

/**
 * One line per meeting where Fireflies waits in the Meet lobby, for every client on the board, so the knock
 * is seen whichever card is open. Sits in the sticky header (and under the client flow's header). Hiding a
 * line lasts until the next knock.
 */
export function FirefliesKnockStrip({ clients, nowMs, excludeClientId = '', onOpenClient }: {
  clients: SalesClient[];
  nowMs?: number;
  /** Shown in full on screen already (the open client flow). */
  excludeClientId?: string;
  onOpenClient?: (client: SalesClient) => void;
}) {
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const knocks = knockingMeetings(clients, nowMs ?? Date.now())
    .filter((item) => item.client.id !== excludeClientId && !hidden[knockKey(item)]);
  if (!knocks.length) return null;

  return (
    // The same amber as the card's knock banner (staff-light remaps these classes).
    <div role="alert" className="border-t border-amber-400/40 bg-amber-900/30 text-amber-200" data-fireflies-knock>
      <div className="max-w-[1440px] mx-auto px-3 sm:px-5 py-2 space-y-1.5">
        {knocks.map((item) => {
          const start = recordingClock(item.entry.startAt);
          return (
            <div key={knockKey(item)} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs sm:text-sm">
              <AlertTriangle size={16} className="shrink-0 text-amber-300" />
              {/* basis-60: on a phone the buttons drop below the text instead of squeezing it. */}
              <span className="min-w-0 flex-1 basis-60">
                <span className="font-semibold">Fireflies banker på</span>
                {' i møtet med '}
                <span className="font-semibold">{item.client.businessName || 'kunden'}</span>
                {` (${slotKindLabel(item.entry.kind).toLowerCase()}${start ? ` kl. ${start}` : ''})`}
                {' – slipp inn «Fireflies.ai Notetaker» i Meet.'}
              </span>
              <span className="inline-flex flex-wrap items-center gap-1.5">
                {/^https:\/\/meet\.google\.com\//i.test(item.entry.meetLink || '') ? (
                  <a
                    href={item.entry.meetLink}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/10 text-[11px] text-white hover:bg-white/15"
                  >
                    <ExternalLink size={11} />
                    Åpne Meet
                  </a>
                ) : null}
                {onOpenClient ? (
                  <button
                    type="button"
                    onClick={() => onOpenClient(item.client)}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-white/10 text-[11px] text-white hover:bg-white/15"
                  >
                    <UserRound size={11} />
                    Åpne kunde
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setHidden((current) => ({ ...current, [knockKey(item)]: true }))}
                  className="inline-flex items-center justify-center h-6 w-6 rounded-md text-amber-200 hover:bg-white/10"
                  aria-label="Skjul til neste gang Fireflies banker på"
                  title="Skjul til neste gang Fireflies banker på"
                >
                  <X size={13} />
                </button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
