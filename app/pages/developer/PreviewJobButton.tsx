import React, { useEffect, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { API } from '../Admin/shared';

type JobRow = { id: string; kind: string; status: string; error?: string; blocking?: string };
type JobsState = { canEnqueuePreview?: boolean; jobs?: JobRow[] };

type Props = {
  salesClientId: string;
  authHeaders: Record<string, string>;
  onError: (message: string) => void;
  onNotice?: (message: string) => void;
};

const ACTIVE = new Set(['queued', 'claimed', 'running', 'retrying']);

/**
 * "Send preview job to Maker": shown only when the delivery loop and preview jobs are on and the
 * client runs in auto. Otherwise it renders nothing.
 */
export function PreviewJobButton({ salesClientId, authHeaders, onError, onNotice }: Props) {
  const [state, setState] = useState<JobsState | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(signal?: { cancelled: boolean }) {
    try {
      const response = await fetch(`${API}/admin/delivery/jobs?clientId=${encodeURIComponent(salesClientId)}`, { headers: authHeaders });
      if (!response.ok) return;
      const data = (await response.json()) as JobsState;
      if (!signal?.cancelled) setState(data);
    } catch {
      // No button when the state cannot be read.
    }
  }

  useEffect(() => {
    const signal = { cancelled: false };
    if (salesClientId) void load(signal);
    return () => {
      signal.cancelled = true;
    };
    // authHeaders changes identity on every render; the client id is what matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesClientId]);

  if (!state?.canEnqueuePreview) return null;
  const active = (state.jobs || []).find((job) => job.kind === 'preview' && ACTIVE.has(job.status));

  async function enqueue() {
    setBusy(true);
    onError('');
    try {
      const response = await fetch(`${API}/admin/delivery/jobs`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ salesClientId, kind: 'preview' }),
      });
      const data = await response.json().catch(() => ({} as Record<string, unknown>));
      if (!response.ok) {
        const code = String((data as { code?: string }).code || '');
        throw new Error(code === 'duplicate' ? 'En preview-jobb ligger allerede i køen.' : `Kunne ikke legge inn preview-jobb (${code || response.status}).`);
      }
      onNotice?.('Preview-jobb lagt i køen. Maker fortsetter kjøringen til slutten av steg 2.');
      await load();
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Kunne ikke legge inn preview-jobb.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void enqueue();
      }}
      disabled={busy || Boolean(active)}
      title={active ? `Preview-jobb: ${active.status}` : 'Maker henter jobben og kjører til slutten av steg 2'}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
      {active ? `Preview-jobb: ${active.status}` : 'Send preview-jobb til Maker'}
    </button>
  );
}
