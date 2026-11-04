import React from 'react';

/** "Vi har rett til å bruke disse bildene": the answer is stored with each upload made while it is shown. */
export function MediaRightsCheckbox({ checked, onChange, className = '' }: {
  checked: boolean;
  onChange: (next: boolean) => void;
  className?: string;
}) {
  return (
    <label className={`flex items-center gap-2 text-[13px] text-[#121212] ${className}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="w-4 h-4 accent-[#FF5B00]"
      />
      Vi har rett til å bruke disse bildene
    </label>
  );
}
