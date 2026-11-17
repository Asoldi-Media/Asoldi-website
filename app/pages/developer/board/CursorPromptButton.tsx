import React, { useState } from 'react';
import type { BoardItem } from './types';
import { clientIdOf } from './lanes';
import { boardFetch, readBoardJson } from './useBoardPoll';

function promptOnItem(item: BoardItem): string {
  const text = item.cursorPrompt || item.prompt || '';
  return typeof text === 'string' ? text : '';
}

/** Copies the prompt text the board already has, or the prompt route when the card has none. */
export function CursorPromptButton({ item }: { item: BoardItem }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  async function copy() {
    setError('');
    let text = promptOnItem(item);
    if (!text) {
      const salesId = clientIdOf(item);
      if (!salesId) {
        setError('Ingen prompt å kopiere.');
        return;
      }
      const response = await boardFetch(`/admin/development/${encodeURIComponent(salesId)}/cursor-prompt`);
      const body = await readBoardJson<{ prompt?: string }>(response);
      text = response.ok && body && typeof body.prompt === 'string' ? body.prompt : '';
    }
    if (!text) {
      setError('Ingen prompt å kopiere.');
      return;
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopied(true);
    } catch {
      setError('Kunne ikke kopiere.');
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid="cursor-prompt-copy"
        onClick={() => void copy()}
        className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white hover:bg-white/15"
      >
        {copied ? 'Kopiert' : 'Kopier prompt'}
      </button>
      {error ? <span className="text-[11px] text-red-300">{error}</span> : null}
    </div>
  );
}
