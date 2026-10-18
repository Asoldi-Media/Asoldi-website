import React from 'react';
import { isoToDatetimeLocalOslo } from '../../../../lib/sales-next-actions.js';

type Props = {
  value?: string;
  onChange: (next: string) => void;
  nowMs?: number;
  ariaLabel?: string;
  className?: string;
};

export function defaultActionDateTimeLocal(value = '', nowMs = Date.now()) {
  return isoToDatetimeLocalOslo(value) || isoToDatetimeLocalOslo(new Date(nowMs).toISOString());
}

export function ActionDateTimeInput({
  value = '',
  onChange,
  nowMs = Date.now(),
  ariaLabel = 'Tid',
  className = 'mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5',
}: Props) {
  return (
    <input
      type="datetime-local"
      aria-label={ariaLabel}
      value={defaultActionDateTimeLocal(value, nowMs)}
      onChange={(event) => onChange(defaultActionDateTimeLocal(event.target.value, nowMs))}
      className={className}
    />
  );
}
