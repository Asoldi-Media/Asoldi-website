import React from 'react';
import type { BoardAlert, BoardItem } from './types';
import { blockingCodesOf, clientIdOf } from './lanes';

/** Alert lines from the board payload, plus one line per blocked card already on the board. */
export function alertLines(alerts: BoardAlert[] | undefined, items: BoardItem[]): Array<{ key: string; message: string }> {
  const lines: Array<{ key: string; message: string }> = [];
  for (const alert of Array.isArray(alerts) ? alerts : []) {
    const message = String(alert?.message || '').trim();
    if (!message) continue;
    lines.push({ key: String(alert.key || message), message });
  }
  for (const item of items) {
    const codes = blockingCodesOf(item);
    if (!codes.length) continue;
    const name = String(item.businessName || clientIdOf(item) || 'Kort');
    lines.push({ key: `card:${item.id}`, message: `${name} er blokkert (${codes.join(', ')}).` });
  }
  return lines;
}

export function DeliveryAlertsBanner({ alerts, items }: { alerts?: BoardAlert[]; items: BoardItem[] }) {
  const lines = alertLines(alerts, items);
  if (!lines.length) return null;
  return (
    <div className="rounded-lg border border-amber-700/40 bg-amber-950/40 px-3 py-2 text-xs text-amber-100" role="status">
      <div className="mb-1 font-medium">Varsler ({lines.length})</div>
      <ul className="space-y-1">
        {lines.map((line) => (
          <li key={line.key}>{line.message}</li>
        ))}
      </ul>
    </div>
  );
}
