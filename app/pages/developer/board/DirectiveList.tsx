import React, { useState } from 'react';
import type { BoardDirective } from './types';
import { clientIdOf } from './lanes';
import type { BoardItem } from './types';
import { boardFetch } from './useBoardPoll';

const STATUSES = ['open', 'accepted', 'rejected', 'done'] as const;

/** Accept, reject or edit a directive through the existing brief route. */
export function DirectiveList({ item, directives, onChanged }: { item: BoardItem; directives: BoardDirective[]; onChanged?: () => void }) {
  const [error, setError] = useState('');
  const [editing, setEditing] = useState('');
  const [note, setNote] = useState('');
  const salesId = clientIdOf(item);

  async function send(row: BoardDirective, status: string, nextNote?: string) {
    if (!salesId || !row.id) return;
    setError('');
    const response = await boardFetch(`/admin/development/${encodeURIComponent(salesId)}/brief/directives/${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, ...(nextNote ? { note: nextNote } : {}) }),
    });
    if (!response.ok) setError('Direktiven ble ikke oppdatert.');
    else onChanged?.();
  }

  return (
    <section className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-2">
      <h3 className="text-[11px] uppercase tracking-wide text-gray-500">Direktiver</h3>
      {directives.length ? (
        <ul className="space-y-2">
          {directives.map((row) => (
            <li key={row.id} className="text-xs text-gray-200 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">{row.ask || row.id}</span>
                <span className="text-gray-400">{row.status || 'open'}</span>
                <button type="button" className="rounded bg-white/10 px-2 py-1" onClick={() => void send(row, 'accepted')}>Godta</button>
                <button type="button" className="rounded bg-white/10 px-2 py-1" onClick={() => void send(row, 'rejected')}>Avvis</button>
                <button
                  type="button"
                  className="rounded bg-white/10 px-2 py-1"
                  onClick={() => {
                    setEditing(row.id);
                    setNote(row.note || '');
                  }}
                >
                  Rediger
                </button>
              </div>
              {editing === row.id ? (
                <form
                  className="flex flex-wrap gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send(row, row.status && (STATUSES as readonly string[]).includes(row.status) ? row.status : 'open', note);
                    setEditing('');
                  }}
                >
                  <input
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    aria-label="Notat"
                    className="min-w-0 flex-1 rounded bg-[#1a1a1a] border border-white/15 px-2 py-1"
                  />
                  <button type="submit" className="rounded bg-[#FF5B00] px-2 py-1 text-white">Lagre</button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-gray-500">Ingen direktiver (0 av 0).</p>
      )}
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
    </section>
  );
}
