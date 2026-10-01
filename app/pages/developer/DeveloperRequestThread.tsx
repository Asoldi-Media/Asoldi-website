import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Paperclip } from 'lucide-react';
import { API } from '../Admin/shared';

export type RequestAuthHeaders = Record<string, string>;

type CommitState = {
  at: string;
  destination: 'maker' | 'client-uploads';
  field?: string;
  url?: string;
} | null;

type ThreadFile = {
  id: string;
  originalName: string;
  mime: string;
  bytes: number;
  committed: CommitState;
};

type ThreadMessage = {
  id: string;
  at: string;
  authorRole: 'admin' | 'developer' | 'client';
  authorLabel: string;
  text: string;
  kind?: string;
  domain?: string;
  files: ThreadFile[];
};

type ThreadPayload = {
  salesClientId: string;
  businessName: string;
  makerRunId: string;
  portalUserId: string;
  recommendedDestination: 'maker' | 'client-uploads';
  unreadForAdmin: number;
  unreadForDeveloper: number;
  updatedAt: string;
  messages: ThreadMessage[];
};

type ExtraMessage = {
  id: string;
  at: string;
  authorLabel: string;
  text: string;
};

type PanelProps = {
  salesClientId: string;
  makerRunId?: string;
  websiteMakerBaseUrl?: string;
  authHeaders: RequestAuthHeaders;
  allowCommit?: boolean;
  layout?: 'panel' | 'side';
  extraMessages?: ExtraMessage[];
};

function formatWhen(value = '') {
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('nb-NO', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function isImageFile(file: ThreadFile) {
  return String(file.mime || '').startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file.originalName);
}

async function parseResponse(response: Response) {
  const data = await response.json().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) {
    throw new Error(String((data as { message?: string }).message || `Forespørsel feilet (${response.status})`));
  }
  return data;
}

async function fetchThread(salesClientId: string, authHeaders: RequestAuthHeaders) {
  const response = await fetch(`${API}/admin/dev-requests/${encodeURIComponent(salesClientId)}`, {
    headers: authHeaders,
  });
  return parseResponse(response) as Promise<ThreadPayload>;
}

function apiPath(path = '') {
  const raw = String(path || '');
  if (raw.startsWith('/api/')) return raw;
  if (raw.startsWith('/')) return `${API}${raw}`;
  return `${API}/${raw}`;
}

async function blobFromAuthUrl(path: string, authHeaders: RequestAuthHeaders) {
  const response = await fetch(apiPath(path), { headers: authHeaders });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(String((data as { message?: string }).message || 'Kunne ikke hente filen.'));
  }
  return response.blob();
}

export function RequestThreadPanel({
  salesClientId,
  makerRunId = '',
  websiteMakerBaseUrl = '',
  authHeaders,
  allowCommit = false,
  layout = 'panel',
  extraMessages = [],
}: PanelProps) {
  const [thread, setThread] = useState<ThreadPayload | null>(null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [destination, setDestination] = useState<'maker' | 'client-uploads'>(
    makerRunId ? 'maker' : 'client-uploads'
  );
  const destinationTouched = useRef(false);
  const headersRef = useRef(authHeaders);
  headersRef.current = authHeaders;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const previewsRef = useRef(previews);
  previewsRef.current = previews;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const authKey = String(authHeaders?.Authorization || '');

  const load = useCallback(async () => {
    if (!salesClientId) return;
    const next = await fetchThread(salesClientId, headersRef.current);
    setThread(next);
    if (!destinationTouched.current && next.recommendedDestination) {
      setDestination(next.recommendedDestination);
    }
  }, [salesClientId, authKey]);

  useEffect(() => {
    let active = true;
    setError('');
    void load().catch((err) => {
      if (active) setError(err instanceof Error ? err.message : 'Kunne ikke laste tråden.');
    });
    const timer = window.setInterval(() => {
      void load().catch(() => undefined);
    }, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [thread?.messages?.length]);

  const imageFileKey = (thread?.messages || [])
    .flatMap((message) => (message.files || []).filter(isImageFile).map((file) => file.id))
    .join('|');

  useEffect(() => {
    let cancelled = false;
    async function loadPreviews() {
      const wanted = new Set(imageFileKey ? imageFileKey.split('|') : []);
      setPreviews((prev) => {
        const next = { ...prev };
        for (const [id, url] of Object.entries(next)) {
          if (wanted.has(id)) continue;
          URL.revokeObjectURL(url);
          delete next[id];
        }
        return next;
      });
      for (const fileId of wanted) {
        if (previewsRef.current[fileId]) continue;
        try {
          const blob = await blobFromAuthUrl(
            `/api/admin/dev-requests/${encodeURIComponent(salesClientId)}/files/${encodeURIComponent(fileId)}`,
            headersRef.current
          );
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          setPreviews((prev) => (prev[fileId] ? prev : { ...prev, [fileId]: url }));
        } catch {
          // Preview is optional; download still works.
        }
      }
    }
    void loadPreviews();
    return () => {
      cancelled = true;
    };
  }, [imageFileKey, salesClientId]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() && files.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('text', text);
      for (const file of files) form.append('files', file);
      const response = await fetch(`${API}/admin/dev-requests/${encodeURIComponent(salesClientId)}/messages`, {
        method: 'POST',
        headers: headersRef.current,
        body: form,
      });
      const data = await parseResponse(response);
      setThread(data as ThreadPayload);
      setText('');
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke sende.');
    } finally {
      setBusy(false);
    }
  }

  async function downloadFile(file: ThreadFile) {
    setError('');
    try {
      const blob = await blobFromAuthUrl(
        `/api/admin/dev-requests/${encodeURIComponent(salesClientId)}/files/${encodeURIComponent(file.id)}`,
        headersRef.current
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.originalName || 'fil';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke laste ned filen.');
    }
  }

  async function commit(file: ThreadFile) {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(
        `${API}/admin/dev-requests/${encodeURIComponent(salesClientId)}/files/${encodeURIComponent(file.id)}/commit`,
        {
          method: 'POST',
          headers: { ...headersRef.current, 'Content-Type': 'application/json' },
          body: JSON.stringify({ destination, websiteMakerBaseUrl }),
        }
      );
      const data = await parseResponse(response) as ThreadPayload & {
        browserHandoff?: boolean;
        downloadPath?: string;
        uploadUrl?: string;
        field?: string;
        originalName?: string;
      };
      if (data.browserHandoff) {
        const blob = await blobFromAuthUrl(String(data.downloadPath || ''), headersRef.current);
        const form = new FormData();
        form.append(String(data.field || 'mainMedia'), blob, data.originalName || file.originalName);
        const makerRes = await fetch(String(data.uploadUrl || ''), { method: 'POST', body: form });
        const makerBody = await makerRes.json().catch(() => ({}));
        if (!makerRes.ok) {
          throw new Error(String((makerBody as { error?: string; message?: string }).error
            || (makerBody as { message?: string }).message
            || 'Website Maker avviste filen.'));
        }
        const done = await fetch(
          `${API}/admin/dev-requests/${encodeURIComponent(salesClientId)}/files/${encodeURIComponent(file.id)}/commit-complete`,
          {
            method: 'POST',
            headers: { ...headersRef.current, 'Content-Type': 'application/json' },
            body: JSON.stringify({ destination: 'maker', field: data.field }),
          }
        );
        setThread(await parseResponse(done) as ThreadPayload);
        return;
      }
      setThread(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke legge inn filen.');
    } finally {
      setBusy(false);
    }
  }

  const side = layout === 'side';
  const timeline = [
    ...(thread?.messages || []).map((message) => ({ ...message, source: 'request' as const })),
    ...extraMessages.map((message) => ({
      id: message.id,
      at: message.at,
      authorRole: 'developer' as const,
      authorLabel: message.authorLabel,
      text: message.text,
      files: [] as ThreadFile[],
      source: 'note' as const,
    })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  const committedLabel = (file: ThreadFile) => {
    if (!file.committed) return '';
    if (file.committed.destination === 'maker') return 'Lagt inn i Maker';
    return 'Lagt inn i Kundedata';
  };

  return (
    <div className={`rounded-2xl bg-black/20 border border-white/10 p-3 space-y-3 ${side ? 'h-full flex flex-col' : ''}`}>
      <div>
        <h4 className="text-xs font-semibold text-gray-200 uppercase tracking-wide">
          {side ? 'Iterasjon' : 'Forespørsel'}
        </h4>
        {side ? null : (
          <p className="text-[11px] text-gray-500 mt-0.5">
            Meldinger og filer mellom kunde, admin og utvikler. Filer ligger her til noen legger dem inn.
          </p>
        )}
      </div>

      <div ref={listRef} className={`${side ? 'max-h-[420px] flex-1' : 'max-h-64'} overflow-y-auto space-y-2 pr-1`}>
        {timeline.length === 0 ? (
          <p className="text-xs text-gray-500">Ingen meldinger ennå.</p>
        ) : (
          timeline.map((message) => (
            <div key={message.id} className="rounded-xl bg-[#1a1a1a] border border-white/10 p-2.5 space-y-1.5">
              <div className="flex items-center justify-between gap-2 text-[11px] text-gray-400">
                <span className="text-gray-200">{message.authorLabel || message.authorRole}</span>
                <span>{formatWhen(message.at)}</span>
              </div>
              {message.kind ? (
                <p className="text-[11px] text-amber-300">
                  {message.kind === 'domain-nameservers-owned'
                    ? 'Hjelp kunde sette opp navnservere på eid domene'
                    : message.kind === 'domain-nameservers-buy'
                      ? 'Hjelp kunde sette opp navnservere på ikke-eid domene'
                      : message.kind}
                </p>
              ) : null}
              {message.text ? (
                <p className="text-sm text-gray-200 whitespace-pre-wrap">{message.text}</p>
              ) : null}
              {(message.files || []).map((file) => (
                <div key={file.id} className="rounded-lg border border-white/10 bg-white/5 p-2 space-y-1.5">
                  {previews[file.id] ? (
                    <img src={previews[file.id]} alt={file.originalName} className="max-h-32 rounded-md object-contain" />
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void downloadFile(file)}
                      className="text-xs text-gray-200 underline-offset-2 hover:underline"
                    >
                      {file.originalName}
                    </button>
                    {file.committed ? (
                      <span className="px-2 py-0.5 rounded text-[11px] bg-green-900/40 border border-green-600/40 text-green-300">
                        {committedLabel(file)}
                      </span>
                    ) : (
                      <span className="text-[11px] text-gray-500">Ikke lagt inn</span>
                    )}
                  </div>
                  {allowCommit && !file.committed ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void commit(file)}
                      className="px-2 py-1 rounded-md text-[11px] bg-[#FF5B00] text-white hover:bg-[#e55200] disabled:opacity-50"
                    >
                      {destination === 'maker' ? 'Legg inn i Maker' : 'Legg inn i Kundedata'}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {allowCommit ? (
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => {
              destinationTouched.current = true;
              setDestination('maker');
            }}
            className={`px-2 py-1 rounded-md text-[11px] border ${
              destination === 'maker'
                ? 'bg-[#FF5B00]/20 border-[#FF5B00]/50 text-white'
                : 'bg-white/10 border-white/10 text-gray-300 hover:bg-white/15'
            }`}
          >
            Legg inn i Maker
          </button>
          <button
            type="button"
            onClick={() => {
              destinationTouched.current = true;
              setDestination('client-uploads');
            }}
            className={`px-2 py-1 rounded-md text-[11px] border ${
              destination === 'client-uploads'
                ? 'bg-[#FF5B00]/20 border-[#FF5B00]/50 text-white'
                : 'bg-white/10 border-white/10 text-gray-300 hover:bg-white/15'
            }`}
          >
            Legg inn i Kundedata
          </button>
        </div>
      ) : null}

      <form onSubmit={(e) => void send(e)} className="space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Skriv en forespørsel…"
          rows={2}
          className="w-full px-3 py-2 rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 cursor-pointer">
            <Paperclip size={13} />
            Vedlegg
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => setFiles(Array.from(e.target.files || []))}
            />
          </label>
          {files.length > 0 ? (
            <span className="text-[11px] text-gray-400">{files.map((file) => file.name).join(', ')}</span>
          ) : null}
          <button
            type="submit"
            disabled={busy || (!text.trim() && files.length === 0)}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF5B00] text-white text-xs hover:bg-[#e55200] disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : null}
            Send
          </button>
        </div>
      </form>

      {error ? (
        <p className="text-xs text-red-300">{error}</p>
      ) : null}
    </div>
  );
}

type DeveloperProps = {
  salesClientId: string;
  makerRunId?: string;
  websiteMakerBaseUrl?: string;
  authHeaders: RequestAuthHeaders;
  extraMessages?: ExtraMessage[];
};

export function DeveloperRequestThread({
  salesClientId,
  makerRunId = '',
  websiteMakerBaseUrl = '',
  authHeaders,
  extraMessages = [],
}: DeveloperProps) {
  if (!salesClientId) return null;
  return (
    <RequestThreadPanel
      salesClientId={salesClientId}
      makerRunId={makerRunId}
      websiteMakerBaseUrl={websiteMakerBaseUrl}
      authHeaders={authHeaders}
      allowCommit
      layout="side"
      extraMessages={extraMessages}
    />
  );
}
