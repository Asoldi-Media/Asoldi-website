import React from 'react';
import { Check, Loader2, Paperclip } from 'lucide-react';
import { API, salesAuthHeaders, type SalesClient, type WorkshopIterationLogEntry } from '../shared';

type Props = {
  client: SalesClient;
  canMarkDone?: boolean;
  onClient?: (client: SalesClient) => void;
};

function formatWhen(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nb-NO');
}

function fileHref(clientId: string, noteId: string, fileId: string) {
  const token = (salesAuthHeaders() as { Authorization?: string }).Authorization?.replace(/^Bearer\s+/i, '') || '';
  return `${API}/admin/sales/${encodeURIComponent(clientId)}/workshop/notes/${encodeURIComponent(noteId)}/files/${encodeURIComponent(fileId)}?token=${encodeURIComponent(token)}`;
}

export function WorkshopIterationLog({ client, canMarkDone = false, onClient }: Props) {
  const [busyId, setBusyId] = React.useState('');
  const [error, setError] = React.useState('');
  const rows = Array.isArray(client.workshop?.iterationLog) ? client.workshop.iterationLog : [];

  async function markDone(entry: WorkshopIterationLogEntry, done: boolean) {
    if (!canMarkDone) return;
    setBusyId(entry.id);
    setError('');
    try {
      const response = await fetch(
        `${API}/admin/sales/${encodeURIComponent(client.id)}/workshop/iteration-log/${encodeURIComponent(entry.id)}`,
        {
          method: 'PATCH',
          headers: { ...salesAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ done }),
        },
      );
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Kunne ikke oppdatere loggen.');
      if (data.client) onClient?.(data.client as SalesClient);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke oppdatere loggen.');
    } finally {
      setBusyId('');
    }
  }

  if (!rows.length) {
    return <p className="text-[11px] text-gray-500">Ingen iterasjonsmeldinger ennå.</p>;
  }

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] text-gray-400">Iterasjonslogg</div>
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
      <div className="max-h-48 overflow-y-auto space-y-1.5 pr-0.5">
        {rows.map((entry) => {
          const done = Boolean(entry.doneAt);
          return (
            <div
              key={entry.id}
              className={`rounded-lg border px-2 py-1.5 ${
                done
                  ? 'border-white/10 bg-white/5 text-gray-400'
                  : 'border-white/10 bg-black/20 text-gray-200'
              }`}
            >
              <div className="flex items-start gap-2">
                {canMarkDone ? (
                  <button
                    type="button"
                    disabled={busyId === entry.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      void markDone(entry, !done);
                    }}
                    className={`shrink-0 mt-0.5 p-0.5 rounded ${
                      done ? 'text-emerald-400' : 'text-gray-500 hover:text-emerald-300'
                    }`}
                    title={done ? 'Merk som ikke ferdig' : 'Merk som ferdig'}
                  >
                    {busyId === entry.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                  </button>
                ) : done ? (
                  <span className="shrink-0 mt-0.5 text-emerald-400"><Check size={12} /></span>
                ) : null}
                <div className="min-w-0 flex-1">
                  <div className={`text-[11px] whitespace-pre-wrap break-words ${done ? 'text-gray-400' : 'text-gray-200'}`}>
                    {entry.text || '(fil)'}
                  </div>
                  <div className="text-[10px] text-gray-500 mt-0.5">
                    {formatWhen(entry.at)}{entry.by ? ` · ${entry.by}` : ''}
                  </div>
                  {entry.files?.length ? (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {entry.files.map((file) => (
                        <a
                          key={file.id}
                          href={fileHref(client.id, entry.id, file.id)}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => event.stopPropagation()}
                          className="inline-flex items-center gap-1 text-[10px] text-sky-300 hover:underline"
                        >
                          <Paperclip size={10} />
                          {file.originalName}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
