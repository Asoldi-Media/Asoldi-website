import React, { useMemo, useState } from 'react';
import {
  CALL_TIMES_DAY_COLORS,
  CALL_TIMES_HOURS,
  CALL_TIMES_VIEWS,
  dayRateIndex,
  hourLabel,
  matchCallTimesIndividual,
  rateIndex,
} from '../../../lib/ansatt-call-times.js';

type Identity = { name?: string; username?: string; fromEmail?: string } | null;
type View = (typeof CALL_TIMES_VIEWS)[keyof typeof CALL_TIMES_VIEWS];

function Stat({
  value,
  label,
  color,
}: {
  value: string;
  label: string;
  color: string;
}) {
  return (
    <div className="shrink-0 min-w-0">
      <p className="text-2xl font-semibold leading-none whitespace-nowrap" style={{ color }}>
        {value}
      </p>
      <p className="mt-1 text-[11px] text-gray-500 whitespace-nowrap">{label}</p>
    </div>
  );
}

function OverlayChart({ view }: { view: View }) {
  const idx = rateIndex(view);
  const weekdays = view.grid.slice(0, 5);
  const w = 720;
  const h = 240;
  const pad = { l: 36, r: 10, t: 14, b: 28 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const max = Math.max(view.avg * 1.15, 0.01, ...weekdays.flatMap((g) => g.cells.map((c) => c[idx])));
  const x = (i: number) => pad.l + (i / (CALL_TIMES_HOURS.length - 1)) * innerW;
  const y = (v: number) => pad.t + innerH - (v / max) * innerH;
  const avgY = y(view.avg);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full min-w-[560px] h-[240px]" role="img" aria-label="Efficiency by hour">
        <line x1={pad.l} y1={avgY} x2={w - pad.r} y2={avgY} stroke="#FF5B00" strokeDasharray="4 4" strokeWidth="1" />
        <text x={w - pad.r} y={avgY - 4} textAnchor="end" fill="#FF5B00" fontSize="10">
          Average {view.avg.toFixed(2)}
        </text>
        {CALL_TIMES_HOURS.map((hour, i) => (
          <text key={hour} x={x(i)} y={h - 8} textAnchor="middle" fill="#6b7280" fontSize="11">
            {hourLabel(hour)}
          </text>
        ))}
        {weekdays.map((row, r) => {
          const d = row.cells.map((c, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(c[idx])}`).join(' ');
          return (
            <g key={row.day}>
              <path d={d} fill="none" stroke={CALL_TIMES_DAY_COLORS[r]} strokeWidth="2" />
              {row.cells.map((c, i) => (
                <circle key={`${row.day}-${i}`} cx={x(i)} cy={y(c[idx])} r="3" fill={CALL_TIMES_DAY_COLORS[r]}>
                  <title>{`${row.day} ${hourLabel(CALL_TIMES_HOURS[i])}: ${c[idx].toFixed(2)} per 100`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </svg>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-gray-500">
        {weekdays.map((row, r) => (
          <span key={row.day} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: CALL_TIMES_DAY_COLORS[r] }} />
            {row.day}
          </span>
        ))}
      </div>
    </div>
  );
}

function Heatmap({ view }: { view: View }) {
  const idx = rateIndex(view);
  const max = Math.max(0.01, ...view.grid.flatMap((g) => g.cells.map((c) => c[idx])));
  return (
    <div className="overflow-x-auto">
      <div
        className="grid gap-1 min-w-[560px]"
        style={{ gridTemplateColumns: `64px repeat(${CALL_TIMES_HOURS.length}, minmax(0, 1fr))` }}
      >
        <div />
        {CALL_TIMES_HOURS.map((hour) => (
          <div key={hour} className="text-[10px] text-gray-500 text-center pb-1">
            {hourLabel(hour)}
          </div>
        ))}
        {view.grid.map((row, r) => (
          <React.Fragment key={row.day}>
            <div className={`text-xs flex items-center ${r === 5 ? 'text-gray-900 font-medium mt-1' : 'text-gray-500'}`}>
              {row.day}
            </div>
            {row.cells.map((cell, c) => {
              const v = cell[idx];
              const t = v / max;
              const bg = v <= 0 ? '#f3f4f6' : `rgba(5, 150, 105, ${0.12 + t * 0.55})`;
              return (
                <div
                  key={`${row.day}-${c}`}
                  title={`${row.day} ${hourLabel(CALL_TIMES_HOURS[c])}: ${v.toFixed(2)} per 100`}
                  className="h-9 rounded-md text-[10px] text-center leading-9 text-gray-900"
                  style={{ background: bg }}
                >
                  {v > 0 ? v.toFixed(1) : ''}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export function CallTimesSection({ identity }: { identity: Identity }) {
  const individualKey = useMemo(() => matchCallTimesIndividual(identity), [identity]);
  const [scope, setScope] = useState<'all' | 'individual'>('all');
  const [chart, setChart] = useState<'lines' | 'heatmap'>('lines');
  const view =
    scope === 'individual' && individualKey ? CALL_TIMES_VIEWS[individualKey] : CALL_TIMES_VIEWS.all;
  const rateCol = dayRateIndex(view);
  const ranked = [...view.days].sort((a, b) => Number(b[rateCol]) - Number(a[rateCol]));
  const best = ranked[0];
  const second = ranked[1];
  const worst = ranked[ranked.length - 1];

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">Beste tider å ringe</h2>
          <p className="text-sm text-gray-600 mt-1">{view.headline}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setScope('all')}
            className={`px-3 py-1.5 rounded-full text-xs font-medium ${
              view.id === 'all' ? 'bg-[#FF5B00] text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            All reps
          </button>
          {individualKey ? (
            <button
              type="button"
              onClick={() => setScope('individual')}
              className={`px-3 py-1.5 rounded-full text-xs font-medium ${
                view.id !== 'all' ? 'bg-[#FF5B00] text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Individual
            </button>
          ) : null}
        </div>
      </div>

      <div className="rounded-2xl bg-white border border-gray-200 p-5">
        <div className="flex flex-nowrap items-end gap-8 overflow-x-auto pb-1">
          <Stat value={Number(best[rateCol]).toFixed(2)} label={`${best[0]}, per 100`} color="#059669" />
          <Stat value={Number(second[rateCol]).toFixed(2)} label={`${second[0]}, per 100`} color="#0284c7" />
          <Stat value={Number(worst[rateCol]).toFixed(2)} label={`${worst[0]}, per 100`} color="#dc2626" />
          <Stat value={view.avg.toFixed(2)} label="Average, per 100" color="#111827" />
        </div>

        <p className="mt-4 text-sm text-gray-600">{view.blurb}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setChart('lines')}
            className={`px-3 py-1.5 rounded-full text-xs ${
              chart === 'lines' ? 'bg-[#FF5B00] text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Days overlaid
          </button>
          <button
            type="button"
            onClick={() => setChart('heatmap')}
            className={`px-3 py-1.5 rounded-full text-xs ${
              chart === 'heatmap' ? 'bg-[#FF5B00] text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            Heatmap
          </button>
        </div>

        <div className="mt-4">{chart === 'lines' ? <OverlayChart view={view} /> : <Heatmap view={view} />}</div>

        <ul className="mt-4 space-y-1.5 text-sm text-gray-700 list-disc pl-5">
          {view.advice.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-gray-500">
          Efficiency is meetings per 100 calls
          {view.showAdjusted ? ', adjusted for who was on the phone' : ''}. Hour values are estimated. Source: Telegenta,
          20 Jul – 16 Oct 2026.
        </p>
      </div>
    </div>
  );
}
