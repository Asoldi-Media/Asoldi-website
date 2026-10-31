import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { DEVELOPER_MAKER_UPLOAD_FIELDS, DOCUMENT_LABELS } from '../../../lib/developer-card.js';
import { fetchLocalMakerBlob } from '../../../lib/maker-browser-client.js';
import { DeveloperClientIdentityFull, DeveloperKundedata, type KundekortDraft } from './DeveloperKundedata';

const TODO_CATEGORIES = [
  'Sider og innhold',
  'Funksjon og flyt',
  'Design og merkevare',
  'Media og materiell',
  'Integrasjoner',
  'Åpne beslutninger',
  'Utenfor scope',
];

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
  viaLocalMaker?: boolean;
};

type SummaryView = {
  ready: boolean;
  message: string;
  intro: string;
  voice: string;
  whatTheyWant: string;
  functionality: string;
};

type PreviewDoc = {
  status?: string;
  summary?: string;
  transcriptChat?: string;
  error?: string;
};

type ProjectTodo = {
  id: string;
  category: string;
  title: string;
  detail: string;
  done: boolean;
};

type ProjectDoc = {
  goalExplanation?: string;
  clientDocumentation?: string;
  todos?: ProjectTodo[];
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
  viaLocalMaker = false,
}: {
  url?: string;
  authHeaders: AuthHeaders;
  alt?: string;
  className?: string;
  viaLocalMaker?: boolean;
}) {
  const [src, setSrc] = useState('');
  const authKey = String(authHeaders?.Authorization || '');

  useEffect(() => {
    if (!url) return undefined;
    let cancelled = false;
    let objectUrl = '';
    const load = viaLocalMaker
      ? fetchLocalMakerBlob(url, { allowPublicOrigin: true }).then((result) => result.blob)
      : fetch(url, { headers: authHeaders }).then(async (response) => {
        if (!response.ok) throw new Error(`media ${response.status}`);
        return response.blob();
      });
    void load
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, authKey, viaLocalMaker]);

  if (!src) return <div className={`bg-white/5 ${className}`} />;
  return <img src={src} alt={alt} className={className} />;
}

export function DeveloperMediaLibrary({
  open,
  onClose,
  files,
  authHeaders,
  deletingKey = '',
  copyingKey = '',
  downloadingKey = '',
  uploading = false,
  canUpload = false,
  makerError = '',
  uploadField = 'mainMedia',
  onUploadFieldChange,
  onUpload,
  onDelete,
  onDownload,
  onCopy,
}: {
  open: boolean;
  onClose: () => void;
  files: BriefMediaFile[];
  authHeaders: AuthHeaders;
  deletingKey?: string;
  copyingKey?: string;
  downloadingKey?: string;
  uploading?: boolean;
  canUpload?: boolean;
  makerError?: string;
  uploadField?: string;
  onUploadFieldChange?: (field: string) => void;
  onUpload?: (files: FileList) => void;
  onDelete: (file: BriefMediaFile) => void;
  onDownload?: (file: BriefMediaFile) => void;
  onCopy?: (file: BriefMediaFile) => void;
}) {
  if (!open) return null;
  const clientFiles = files.filter((file) => file.source !== 'maker' && file.source !== 'bundle' && file.source !== 'run');
  const makerFiles = files.filter((file) => file.source === 'maker' || file.source === 'bundle' || file.source === 'run');

  function tile(file: BriefMediaFile) {
    const key = `${file.source}-${file.field || ''}-${file.index ?? ''}-${file.fileName}`;
    const busy = deletingKey === key || copyingKey === key || downloadingKey === key;
    return (
      <div key={key} className="rounded-xl border border-white/10 bg-black/30 p-2 space-y-2">
        {isImageFile(file) && file.url ? (
          <DeveloperAuthImage
            url={file.url}
            authHeaders={authHeaders}
            viaLocalMaker={Boolean(file.viaLocalMaker)}
            alt={file.fileName}
            className="h-28 w-full rounded-lg object-cover bg-black/40"
          />
        ) : (
          <div className="h-28 rounded-lg bg-white/5 flex items-center justify-center text-[11px] text-gray-400 px-2 text-center">
            {file.fileName}
          </div>
        )}
        <p className="text-[11px] text-gray-300 truncate">{file.fileName}</p>
        <div className="flex flex-wrap gap-2">
          {onDownload ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onDownload(file)}
              className="text-[11px] text-gray-300 hover:text-white disabled:opacity-50"
            >
              {downloadingKey === key ? 'Laster…' : 'Last ned'}
            </button>
          ) : null}
          {onCopy ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onCopy(file)}
              className="text-[11px] text-gray-300 hover:text-white disabled:opacity-50"
            >
              {copyingKey === key ? 'Kopierer…' : 'Kopier'}
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => onDelete(file)}
            className="text-[11px] text-red-300 hover:text-red-200 disabled:opacity-50"
          >
            {deletingKey === key ? 'Sletter…' : 'Slett'}
          </button>
        </div>
      </div>
    );
  }

  function column(title: string, rows: BriefMediaFile[], empty: string) {
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-medium text-white">{title}</h3>
        {rows.length ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {rows.map(tile)}
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
        <section className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h3 className="text-sm font-medium text-white">Fra Website Maker</h3>
            {canUpload && onUpload ? (
              <label className="inline-flex items-center gap-2 text-xs text-gray-300">
                <select
                  value={uploadField}
                  onChange={(event) => onUploadFieldChange?.(event.target.value)}
                  className="rounded-md bg-black/40 border border-white/10 px-2 py-1 text-xs text-white"
                >
                  {DEVELOPER_MAKER_UPLOAD_FIELDS.map((field) => (
                    <option key={field.key} value={field.key}>{field.label}</option>
                  ))}
                </select>
                <span className="inline-flex items-center px-3 py-1.5 rounded-lg bg-white/10 text-white hover:bg-white/15 cursor-pointer">
                  {uploading ? 'Laster opp…' : 'Last opp'}
                  <input
                    type="file"
                    multiple
                    className="sr-only"
                    disabled={uploading}
                    onChange={(event) => {
                      if (event.target.files?.length) onUpload(event.target.files);
                      event.target.value = '';
                    }}
                  />
                </span>
              </label>
            ) : null}
          </div>
          {makerError ? <p className="text-xs text-amber-200">{makerError}</p> : null}
          {makerFiles.length ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {makerFiles.map(tile)}
            </div>
          ) : (
            <p className="text-xs text-gray-500">
              {makerError ? 'Maker-filene vises når Website Creator svarer på denne PC-en.' : 'Ingen Maker-filer ennå.'}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function previewStatusMessage(doc: PreviewDoc | null | undefined) {
  const status = String(doc?.status || '');
  if (status === 'transcribing') return 'Booker-samtalen transkriberes…';
  if (status === 'needs-key') return 'Transkripsjon venter på DEEPGRAM_API_KEY på serveren.';
  if (status === 'failed') return doc?.error || 'Klarte ikke å transkribere booker-samtalen.';
  if (doc?.summary) return '';
  return 'Venter på booker-opptak.';
}

export function DeveloperClientBrief({
  open,
  onClose,
  mode = 'project',
  summary,
  previewDocument = null,
  projectDocument = null,
  onToggleTodo,
  files,
  authHeaders,
  dots,
  makerError = '',
  onOpenLibrary,
  kundekortSource = {},
  itemId = '',
  latestRecordingUrl = '',
  onSaveKundekort,
}: {
  open: boolean;
  onClose: () => void;
  mode?: 'preview' | 'project';
  summary: SummaryView;
  previewDocument?: PreviewDoc | null;
  projectDocument?: ProjectDoc | null;
  onToggleTodo?: (todoId: string, done: boolean) => void;
  files: BriefMediaFile[];
  authHeaders: AuthHeaders;
  dots: MaterialDot[];
  makerError?: string;
  onOpenLibrary: () => void;
  kundekortSource?: Record<string, unknown>;
  itemId?: string;
  latestRecordingUrl?: string;
  onSaveKundekort?: (draft: KundekortDraft) => Promise<void>;
}) {
  if (!open) return null;
  const images = files.filter((file) => isImageFile(file) && file.url);
  const preview = images.slice(0, 6);
  const hidden = Math.max(0, images.length - preview.length);
  const isPreview = mode === 'preview';
  const title = isPreview ? DOCUMENT_LABELS.preview : DOCUMENT_LABELS.project;
  const todos = Array.isArray(projectDocument?.todos) ? projectDocument.todos : [];
  const groupedTodos = TODO_CATEGORIES
    .map((category) => ({ category, rows: todos.filter((row) => row.category === category) }))
    .filter((group) => group.rows.length);
  const previewNote = previewStatusMessage(previewDocument);

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
            <h2 className="text-lg font-semibold text-white">{title}</h2>
            <p className="text-xs text-gray-400 mt-1">
              {isPreview
                ? 'Kundekort og sammendrag av booker-samtalen.'
                : 'Kundekort, sammendrag, det vi mangler, og workshop-oppgaver.'}
            </p>
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
            <DeveloperKundedata
              source={kundekortSource}
              itemId={itemId}
              latestRecordingUrl={latestRecordingUrl}
              authHeaders={authHeaders}
              onSave={onSaveKundekort}
            />
            {onSaveKundekort ? null : <DeveloperClientIdentityFull source={kundekortSource} />}
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
                        viaLocalMaker={Boolean(file.viaLocalMaker)}
                        alt={file.fileName}
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-500">
                  {makerError
                    ? makerError
                    : 'Ingen bilder ennå. Hele biblioteket viser også andre filer.'}
                </p>
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
            {isPreview ? (
              <>
                <h3 className="text-sm font-semibold text-white">Utgangspunkt for preview</h3>
                {previewNote ? (
                  <p className="mt-3 text-sm text-gray-400">{previewNote}</p>
                ) : null}
                {previewDocument?.summary ? (
                  <p className="mt-3 whitespace-pre-wrap text-sm text-gray-200">{previewDocument.summary}</p>
                ) : null}
                {previewDocument?.transcriptChat ? (
                  <details className="mt-6 rounded-xl border border-white/10 bg-black/30 p-3">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-gray-300">
                      Fullt transkript
                    </summary>
                    <pre className="mt-3 whitespace-pre-wrap text-sm text-gray-200 font-sans">
                      {previewDocument.transcriptChat}
                    </pre>
                  </details>
                ) : null}
              </>
            ) : (
              <>
                <h3 className="text-sm font-semibold text-white">Mål</h3>
                <p className="mt-2 whitespace-pre-wrap text-sm text-gray-200">
                  {projectDocument?.goalExplanation || 'Målet skrives når en gyldig workshop er transkribert.'}
                </p>
                <h4 className="mt-8 text-xs font-semibold uppercase tracking-wide text-gray-300">Klientdokumentasjon</h4>
                <p className="mt-2 whitespace-pre-wrap text-sm text-gray-200">
                  {projectDocument?.clientDocumentation || 'Klientdokumentasjon skrives når workshopen er holdt.'}
                </p>
                <h4 className="mt-8 text-xs font-semibold uppercase tracking-wide text-gray-300">Oppgaver</h4>
                {groupedTodos.length ? (
                  <div className="mt-3 space-y-5">
                    {groupedTodos.map((group) => (
                      <div key={group.category}>
                        <h5 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{group.category}</h5>
                        <ul className="mt-2 space-y-2">
                          {group.rows.map((todo) => (
                            <li key={todo.id}>
                              <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-3 text-sm text-gray-200">
                                <input
                                  type="checkbox"
                                  checked={Boolean(todo.done)}
                                  onChange={(event) => onToggleTodo?.(todo.id, event.target.checked)}
                                  className="mt-0.5 h-5 w-5 shrink-0 accent-[#FF5B00]"
                                />
                                <span>
                                  <span className="block font-medium text-white">{todo.title}</span>
                                  {todo.detail ? (
                                    <span className="mt-1 block text-xs text-gray-400 whitespace-pre-wrap">{todo.detail}</span>
                                  ) : null}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-gray-400">Oppgavelisten skrives når workshopen er holdt.</p>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
