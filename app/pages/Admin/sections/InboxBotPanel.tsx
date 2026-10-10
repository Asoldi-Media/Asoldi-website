import React, { Suspense, lazy, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { API, salesAuthHeaders, type SalesClient } from '../shared';

const PdfPreviewOverlay = lazy(() =>
  import('../../sales/PdfPreviewOverlay').then((mod) => ({ default: mod.PdfPreviewOverlay }))
);

type Props = {
  client: SalesClient;
};

export function InboxBotPanel({ client }: Props) {
  const contracts = client.inboxBot?.contracts || [];
  const staged = Number(client.inboxBot?.stagedElements) || 0;
  const [previewUrl, setPreviewUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  if (!contracts.length && !staged) return null;

  async function openPdf(fileName: string) {
    setBusy(fileName);
    setError('');
    try {
      const response = await fetch(
        `${API}/admin/sales/${encodeURIComponent(client.id)}/inbox-contracts/${encodeURIComponent(fileName)}`,
        { headers: salesAuthHeaders(), cache: 'no-store' }
      );
      if (!response.ok) throw new Error('Kunne ikke åpne kontrakten.');
      const blob = await response.blob();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke åpne kontrakten.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-2.5 space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-gray-400">Innboks</div>
      {contracts.map((row) => (
        <div key={row.id || row.fileName} className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-white truncate">{row.summary || row.subject || 'Kontrakt mottatt'}</p>
            <p className="text-[11px] text-gray-500 truncate">
              {row.signedVerdict === 'likely'
                ? 'Signert (sjekket bunnen)'
                : row.signedVerdict === 'possible'
                  ? 'Mulig signert — sjekk bunnen'
                  : row.signedVerdict === 'unsigned' || row.status === 'unsigned_copy'
                    ? 'Usignert kopi'
                    : 'Kontrakt'}
              {row.from ? ` · ${row.from}` : ''}
              {row.receivedAt ? ` · ${new Date(row.receivedAt).toLocaleString('nb-NO')}` : ''}
            </p>
          </div>
          {row.fileName ? (
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void openPdf(row.fileName)}
              className="inline-flex items-center gap-1 shrink-0 px-2 py-1 rounded-lg bg-white/10 text-white text-[11px] hover:bg-white/15 disabled:opacity-50"
            >
              {busy === row.fileName ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
              Vis PDF
            </button>
          ) : null}
        </div>
      ))}
      {staged ? (
        <p className="text-[11px] text-amber-200">
          {staged === 1 ? '1 vedlegg venter på portal-Connect.' : `${staged} vedlegg venter på portal-Connect.`}
        </p>
      ) : null}
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
      {previewUrl ? (
        <Suspense fallback={null}>
          <PdfPreviewOverlay
            url={previewUrl}
            title="Mottatt kontrakt"
            onClose={() => {
              URL.revokeObjectURL(previewUrl);
              setPreviewUrl('');
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
