import React from 'react';
import type { BoardItem } from './types';

const STEPS: Array<{ key: string; label: string }> = [
  { key: 'hostingerEnvironmentSetup', label: 'Hostinger environment sat opp' },
  { key: 'githubRepoPushed', label: 'GitHub-repo er lagt ut' },
  { key: 'v1Ferdig', label: 'Få tilbakemelding' },
  { key: 'nettsideFerdig', label: 'Nettside ferdig' },
];

/** The old development checklist, shown read-only. */
export function LegacyChecklist({ item }: { item: BoardItem }) {
  const flags = item.development || {};
  return (
    <section className="rounded-xl border border-white/10 bg-black/20 p-3" aria-label="Gammel sjekkliste">
      <h3 className="mb-2 text-[11px] uppercase tracking-wide text-gray-500">Gammel sjekkliste</h3>
      <ul className="flex flex-wrap gap-1.5">
        {STEPS.map((step) => {
          const done = Boolean(flags[step.key]);
          return (
            <li
              key={step.key}
              className={`rounded-md border px-2 py-1 text-[11px] ${done ? 'border-green-600/40 bg-green-900/40 text-green-200' : 'border-white/10 text-gray-400'}`}
            >
              {done ? 'Ferdig' : 'Åpen'}: {step.label}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
