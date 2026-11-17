import React from 'react';
import { FALLBACK_LANE, LANES, laneKeyForStage, stageOf } from './lanes';
import type { BoardItem } from './types';

/** The ten delivery lanes, with the card's current lane marked. */
export function StageStepper({ item }: { item: BoardItem }) {
  const stage = stageOf(item);
  const current = stage ? laneKeyForStage(stage) : FALLBACK_LANE.key;
  return (
    <ol data-testid="stage-stepper" className="flex flex-wrap gap-1">
      {LANES.map((lane) => {
        const on = lane.key === current;
        return (
          <li
            key={lane.key}
            aria-current={on ? 'step' : undefined}
            className={`rounded px-1.5 py-0.5 text-[10px] ${on ? 'bg-[#FF5B00] text-white' : 'bg-white/5 text-gray-400'}`}
          >
            {lane.title}
          </li>
        );
      })}
      {current === FALLBACK_LANE.key ? (
        <li aria-current="step" className="rounded bg-amber-700/80 px-1.5 py-0.5 text-[10px] text-white">
          {FALLBACK_LANE.title}
        </li>
      ) : null}
    </ol>
  );
}
