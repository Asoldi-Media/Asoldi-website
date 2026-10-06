import React, { useMemo, useState } from 'react';
import { CheckCircle2, ChevronsDown, ChevronsUp, Loader2 } from 'lucide-react';
import {
  formatDeveloperGoalLabel,
  getCurrentDeveloperGoalKey,
  getRemainingDeveloperGoalCount,
  getVisibleDeveloperGoalKeys,
  normalizeDeveloperGoals,
} from '../../../lib/developer-goals.js';

type DeveloperGoals = {
  readyForPreview?: boolean;
  readyForDeployment?: boolean;
  iterationDone?: boolean;
  publish?: boolean;
};

type Props = {
  goals?: DeveloperGoals | null;
  goalKeys?: string[];
  busyKey?: string | null;
  itemId: string;
  onToggle: (key: string) => void;
};

export function DeveloperGoalTimeline({ goals, goalKeys, busyKey, itemId, onToggle }: Props) {
  const normalized = useMemo(() => normalizeDeveloperGoals(goals), [goals]);
  const [showFuture, setShowFuture] = useState(false);
  const visible = getVisibleDeveloperGoalKeys(normalized, showFuture, goalKeys);
  const remaining = getRemainingDeveloperGoalCount(normalized, goalKeys);
  const current = getCurrentDeveloperGoalKey(normalized, goalKeys);

  return (
    <div className="flex flex-wrap items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
      {visible.map((key) => {
        const done = Boolean(normalized[key as keyof DeveloperGoals]);
        const busy = busyKey === `goals:${itemId}:${key}`;
        const locked = !done && key !== current;
        return (
          <button
            key={key}
            type="button"
            disabled={busy || locked}
            onClick={() => onToggle(key)}
            aria-pressed={done}
            title={
              locked
                ? 'Fullfør nåværende mål først'
                : done
                  ? 'Klikk for å angre dette målet'
                  : 'Marker dette målet som ferdig. Neste mål vises automatisk.'
            }
            className={`px-2 py-1 rounded-md text-[11px] border transition-colors disabled:opacity-60 ${
              done
                ? 'bg-green-900/40 border-green-600/40 text-green-300 hover:border-green-500/50'
                : 'bg-black/20 border-white/10 text-gray-300 hover:border-white/20'
            }`}
          >
            {busy ? <Loader2 size={11} className="inline mr-1 animate-spin" /> : done ? <CheckCircle2 size={11} className="inline mr-1" /> : null}
            {formatDeveloperGoalLabel(key)}
          </button>
        );
      })}
      {remaining > 0 && (
        <button
          type="button"
          onClick={() => setShowFuture((prev) => !prev)}
          className="inline-flex items-center justify-center p-1 text-gray-400 hover:text-gray-200"
          title={showFuture ? 'Skjul senere mål' : `Vis ${remaining} senere mål`}
          aria-label={showFuture ? 'Skjul senere mål' : `Vis ${remaining} senere mål`}
        >
          {showFuture ? <ChevronsUp size={16} /> : <ChevronsDown size={16} />}
        </button>
      )}
    </div>
  );
}
