import React from 'react';
import { defaultActionDateTimeLocal } from '../../../../lib/action-datetime-input.js';

type Props = {
  value?: string;
  onChange: (next: string) => void;
  nowMs?: number;
  allowEmpty?: boolean;
  ariaLabel?: string;
  className?: string;
};

export { defaultActionDateTimeLocal };

export function ActionDateTimeInput({
  value = '',
  onChange,
  nowMs = Date.now(),
  allowEmpty = false,
  ariaLabel = 'Tid',
  className = 'mt-1 w-full rounded-md bg-[#161616] border border-white/10 text-white text-xs px-2 py-1.5',
}: Props) {
  return (
    <input
      type="datetime-local"
      aria-label={ariaLabel}
      value={defaultActionDateTimeLocal(value, nowMs, { allowEmpty })}
      onChange={(event) => onChange(defaultActionDateTimeLocal(event.target.value, nowMs, { allowEmpty }))}
      className={className}
    />
  );
}
