/// <reference types="vite/client" />
import React, { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import * as pdfjs from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

type Props = {
  url: string;
  title?: string;
  onClose: () => void;
};

export function PdfPreviewOverlay({ url, title = 'Kontrakt', onClose }: Props) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    const host = scrollerRef.current;
    if (!host) return undefined;
    host.replaceChildren();
    setLoading(true);
    setError('');

    (async () => {
      try {
        const doc = await pdfjs.getDocument({ url }).promise;
        if (cancelled) return;
        const maxWidth = Math.max(280, Math.min(host.clientWidth || window.innerWidth - 24, 900));
        for (let n = 1; n <= doc.numPages; n += 1) {
          const page = await doc.getPage(n);
          if (cancelled) return;
          const unscaled = page.getViewport({ scale: 1 });
          const scale = maxWidth / unscaled.width;
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          canvas.className = 'w-full max-w-[900px] mx-auto mb-3 bg-white rounded-sm shadow';
          canvas.setAttribute('aria-label', `Side ${n} av ${doc.numPages}`);
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('Kunne ikke tegne kontrakten');
          await page.render({ canvasContext: ctx, viewport }).promise;
          host.appendChild(canvas);
        }
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Kunne ikke vise kontrakten');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="fixed inset-0 z-[100] bg-black/85" role="dialog" aria-modal="true" aria-label={title}>
      <button
        type="button"
        onClick={onClose}
        className="fixed z-[101] inline-flex items-center gap-1 rounded-full bg-[#111] text-white text-xs font-medium px-3 py-2 shadow-lg border border-white/25"
        style={{ top: 'max(12px, env(safe-area-inset-top))', right: 'max(12px, env(safe-area-inset-right))' }}
      >
        <X size={14} /> Lukk
      </button>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-white text-sm">
          <Loader2 size={16} className="animate-spin" /> Åpner kontrakten…
        </div>
      )}
      {error ? (
        <iframe src={url} title={title} className="h-full w-full bg-white pt-14" />
      ) : (
        <div
          ref={scrollerRef}
          className={`h-full overflow-y-auto overscroll-contain pt-14 pb-8 px-2 sm:px-4 ${loading ? 'invisible' : ''}`}
        />
      )}
    </div>
  );
}
