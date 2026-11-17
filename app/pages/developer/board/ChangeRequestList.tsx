import React from 'react';
import type { BoardDetail, BoardItem } from './types';

/** Used against the quota on the card. Over quota when used is greater than the quota. */
export function quotaState(item: BoardItem): { used: number; quota: number; over: boolean } {
  const summary = item.changeRequestSummary;
  const used = Number(summary?.used) || 0;
  const quota = Number(summary?.quota) || 0;
  return { used, quota, over: quota > 0 ? used > quota : used > 0 };
}

export function ChangeRequestList({ item, detail }: { item: BoardItem; detail: BoardDetail | null }) {
  const { used, quota, over } = quotaState(item);
  const rows = Array.isArray(detail?.changeRequests) ? detail.changeRequests : [];
  return (
    <section className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-2" data-testid="change-request-list">
      <h3 className="text-[11px] uppercase tracking-wide text-gray-500">Endringsønsker</h3>
      <p
        data-testid="quota-meter"
        className={`text-xs ${over ? 'text-red-300' : 'text-gray-200'}`}
      >
        {used} av {quota} brukt{over ? ' · Over kvoten' : ''}
      </p>
      {rows.length ? (
        <ul className="space-y-1 text-xs text-gray-200">
          {rows.map((row) => (
            <li key={row.id || row.title} className="flex justify-between gap-2">
              <span>{row.title || row.id || 'Endring'}</span>
              <span className="text-gray-400">{row.status || ''}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-gray-500">Ingen endringsønsker (0 av {rows.length}).</p>
      )}
    </section>
  );
}
