import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { DEVELOPER_QA_LABELS } from '../../../lib/developer-card.js';
import { DeveloperClientIdentityFull, DeveloperKundedata } from './DeveloperKundedata';

export type MaterialDot = {
  id: string;
  group: string;
  label: string;
  mark: 'green' | 'orange' | 'red' | string;
  detail?: string;
};

export type BriefMediaFile = {
  fileName: string;
  source?: string;
  url?: string;
  mime?: string;
  field?: string;
  index?: number;
  bundleId?: string;
};

type SummaryView = {
  ready: boolean;
  message: string;
  intro: string;
  voice: string;
  whatTheyWant: string;
  functionality: string;
};

type QaState = {
  textOk: boolean;
  mediaOk: boolean;
  responsiveOk: boolean;
};

type AuthHeaders = Record<string, string>;

function isImageFile(file: BriefMediaFile) {
  return String(file.mime || '').startsWith('image/')
    || /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(file.fileName || '');
}

function markClass(mark = '') {
  if (mark === 'green') return 'border-green-600/40 bg-green-900/30 text-green-200';
  if (mark === 'orange') return 'border-amber-600/40 bg-amber-900/30 text-amber-200';
  return 'border-red-700/40 bg-red-900/20 text-red-200';
}

function dotClass(mark = '') {
  if (mark === 'green') return 'bg-green-400';
  if (mark === 'orange') return 'bg-amber-400';
  return 'bg-red-400';
}

export function DeveloperAuthImage({
  url = '',
  authHeaders,
  alt = '',
  className = '',
}: {
  url?: string;
  authHeaders: AuthHeaders;
  alt?: string;
  className?: string;
}) {
  const [src, setSrc] = useState('');
  const authKey = String(authHeaders?.Authorization || '');

  useEffect(() => {
    if (!url) return undefined;
    let cancelled = false;
    let objectUrl = '';
    void fetch(url, { headers: authHeaders })
      .then(async (response) => {
        if (!response.ok || cancelled) return;
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setSrc(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, authKey]);

  if (!src) return <div className={`bg-white/5 ${className}`} />;
  return <img src={src} alt={alt} className={className} />;
}

export function DeveloperMediaLibrary({
  open,
  onClose,
  files,
  authHeaders,
  deletingKey = '',
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  files: BriefMediaFile[];
  authHeaders: AuthHeaders;
  deletingKey?: string;
  onDelete: (file: BriefMediaFile) => void;
}) {
  if (!open) return null;
  const clientFiles = files.filter((file) => file.source !== 'maker' && file.source !== 'bundle' && file.source !== 'run');
  const makerFiles = files.filter((file) => file.source === 'maker' || file.source === 'bundle' || file.source === 'run');

  function column(title: string, rows: BriefMediaFile[], empty: string) {
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-white">{title}</h3>
        {rows.length ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {rows.map((file) => {
              const key = `${file.source}-${file.field || ''}-${file.index ?? ''}-${file.fileName}`;
              return (
                <div key={key} className="rounded-xl border border-white/10 bg-black/30 p-2 space-y-2">
                  {isImageFile(file) && file.url ? (
                    <DeveloperAuthImage
                      url={file.url}
                      authHeaders={authHeaders}
                      alt={file.fileName}
                      className="h-28 w-full rounded-lg object-cover bg-black/40"
                    />
                  ) : (
                    <div className="h-28 rounded-lg bg-white/5 flex items-center justify-center text-[11px] text-gray-400 px-2 text-center">
                      {file.fileName}
                    </div>
                  )}
                  <p className="text-[11px] text-gray-300 truncate">{file.fileName}</p>
                  <button
                    type="button"
                    disabled={deletingKey === key}
                    onClick={() => onDelete(file)}
                    className="text-[11px] text-red-300 hover:text-red-200 disabled:opacity-50"
                  >
                    {deletingKey === key ? 'Sletter…' : 'Slett'}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-gray-500">{empty}</p>
        )}
      </section>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/80 flex items-stretch justify-center p-3 sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-6xl overflow-y-auto rounded-2xl bg-[#1a1a1a] border border-white/10 p-4 sm:p-6 space-y-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-white">Mediebibliotek</h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
          >
            <X size={14} />
            Lukk
          </button>
        </div>
        {column('Fra kunden', clientFiles, 'Ingen filer i Kundedata ennå.')}
        {column('Fra Website Maker', makerFiles, 'Ingen Maker-filer ennå.')}
      </div>
    </div>
  );
}

export function DeveloperClientBrief({
  open,
  onClose,
  summary,
  qa,
  onToggleQa,
  files,
  authHeaders,
  dots,
  onOpenLibrary,
  kundekortSource = {},
}: {
  open: boolean;
  onClose: () => void;
  summary: SummaryView;
  qa: QaState;
  onToggleQa: (key: 'textOk' | 'mediaOk' | 'responsiveOk', value: boolean) => void;
  files: BriefMediaFile[];
  authHeaders: AuthHeaders;
  dots: MaterialDot[];
  onOpenLibrary: () => void;
  kundekortSource?: Record<string, unknown>;
}) {
  if (!open) return null;
  const images = files.filter((file) => isImageFile(file) && file.url);
  const preview = images.slice(0, 6);
  const hidden = Math.max(0, images.length - preview.length);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-2 sm:p-3"
      onClick={onClose}
    >
      <div
        className="flex h-[92vh] w-[94vw] max-w-[1720px] flex-col overflow-hidden rounded-2xl bg-[#1f1f1f] border border-white/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-white/10 px-4 py-4 sm:px-6">
          <div>
            <h2 className="text-lg font-semibold text-white">Prosjektdokument</h2>
            <p className="text-xs text-gray-400 mt-1">Kundekort, sammendrag, det vi mangler, og kundens mediefiler.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
          >
            <X size={14} />
            Lukk
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(360px,42%)]">
          <div className="min-h-0 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5 space-y-6">
            <DeveloperKundedata source={kundekortSource} />
            <DeveloperClientIdentityFull source={kundekortSource} />
            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-300">Sammendrag</h3>
              {summary.ready ? (
                <div className="grid gap-3 md:grid-cols-2 text-sm text-gray-200">
                  {([
                    ['Intro', summary.intro],
                    ['Stemme', summary.voice],
                    ['Det de vil', summary.whatTheyWant],
                    ['Funksjon', summary.functionality],
                  ] as const).map(([label, text]) => (
                    <div key={label}>
                      <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
                      <p className="whitespace-pre-wrap mt-1">{text}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-400">{summary.message}</p>
              )}
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-300">Mediebibliotek</h3>
                <button
                  type="button"
                  onClick={onOpenLibrary}
                  className="text-xs text-gray-300 underline-offset-2 hover:underline"
                >
                  {hidden > 0 ? `Vis ${hidden} til` : 'Åpne hele biblioteket'}
                </button>
              </div>
              {preview.length ? (
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                  {preview.map((file) => (
                    <button
                      key={`${file.source}-${file.fileName}`}
                      type="button"
                      onClick={onOpenLibrary}
                      className="aspect-square rounded-lg overflow-hidden border border-white/10"
                    >
                      <DeveloperAuthImage
                        url={file.url}
                        authHeaders={authHeaders}
                        alt={file.fileName}
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-500">Ingen bilder ennå. Hele biblioteket viser også andre filer.</p>
              )}
            </section>

            <section className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-300">Datapunkter</h3>
              {dots.length ? (
                <div className="flex flex-wrap items-start gap-x-1.5 gap-y-1">
                  {dots.map((dot, index) => {
                    const startsGroup = index === 0 || dots[index - 1]?.group !== dot.group;
                    return (
                      <span key={dot.id} className="relative inline-flex pt-4">
                        {startsGroup ? (
                          <span className="absolute left-0 top-0 text-[10px] font-medium uppercase leading-none tracking-wide text-gray-500 whitespace-nowrap">
                            {dot.group}
                          </span>
                        ) : null}
                        <span
                          title={dot.detail || dot.label}
                          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] ${markClass(dot.mark)}`}
                        >
                          <span className={`inline-block h-2 w-2 rounded-full ${dotClass(dot.mark)}`} />
                          {dot.label}
                        </span>
                      </span>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-gray-500">Ingen datapunkter ennå.</p>
              )}
            </section>
          </div>

          <section className="min-h-0 overflow-y-auto border-t border-white/10 bg-black/20 px-4 py-4 sm:px-6 sm:py-5 lg:border-l lg:border-t-0">
            <h3 className="text-sm font-semibold text-white">Checklist</h3>
            <ul className="mt-4 space-y-2">
              {(['textOk', 'mediaOk', 'responsiveOk'] as const).map((key) => (
                <li key={key}>
                  <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-gray-200">
                    <input
                      type="checkbox"
                      checked={Boolean(qa[key])}
                      onChange={(event) => onToggleQa(key, event.target.checked)}
                      className="h-5 w-5 shrink-0 accent-[#FF5B00]"
                    />
                    <span>{DEVELOPER_QA_LABELS[key]}</span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="mt-8">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-300">Funksjon</h4>
              <p className="mt-2 whitespace-pre-wrap text-sm text-gray-200">
                {summary.ready && summary.functionality
                  ? summary.functionality
                  : 'Funksjonen skrives når workshopen er holdt.'}
              </p>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
