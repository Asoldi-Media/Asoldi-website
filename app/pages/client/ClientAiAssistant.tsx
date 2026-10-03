import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, ChevronLeft, Paperclip } from 'lucide-react';
import { ClientRouteGuard } from '../../components/client/ClientRouteGuard';
import { useClientAuth } from '../../contexts/ClientAuthContext';
import { layoutLabel, summarizeCatalogs } from '../../../lib/client-product-catalog.js';
import { PRODUCT_ASSISTANT_GREETING } from '../../../lib/ai-assistant/chat.js';
import { STEP_LABELS, personFirstName } from '../../../lib/ai-assistant/intake.js';

type ChatMessage = { id: string; role: 'ai' | 'user'; text: string };
type PendingFile = { id: string; file: File; url: string };

type Progress = {
  layout: string | null;
  layoutLabel: string;
  categoryCount: number;
  productCount: number;
  categories: Array<{ id?: string; name: string; productCount: number }>;
};

const DOCUMENT_NAME = /\.(pdf|odt|ods|odp|docx|doc|rtf|xlsx|xls|csv|tsv|txt|md|html|htm|xml|json)$/i;
const IMAGE_NAME = /\.(png|jpe?g|webp|gif|heic|avif|svg)$/i;
const MEDIA_NAME = /\.(png|jpe?g|webp|gif|heic|avif|svg|mp4|mov|webm)$/i;

function previewKind(file: File) {
  const name = file.name.toLowerCase();
  if (file.type.startsWith('image/') || IMAGE_NAME.test(name)) return 'image';
  if (file.type.startsWith('video/') || /\.(mp4|mov|webm)$/i.test(name)) return 'video';
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  return 'document';
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
const FILE_ACCEPT = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'text/plain',
  'text/csv',
  'application/rtf',
  'application/json',
  '.pdf,.doc,.docx,.xls,.xlsx,.ods,.odt,.rtf,.csv,.tsv,.txt,.md,.html,.htm,.xml,.json',
  '.png,.jpg,.jpeg,.webp,.gif,.heic,.avif,.svg,.mp4,.mov,.webm',
].join(',');

const EMPTY_PROGRESS: Progress = {
  layout: null,
  layoutLabel: '',
  categoryCount: 0,
  productCount: 0,
  categories: [
    { name: 'Kategori 1', productCount: 0 },
    { name: 'Kategori 2', productCount: 0 },
  ],
};

function TypeLine({ text, className }: { text: string; className?: string }) {
  const [shown, setShown] = useState('');
  useEffect(() => {
    setShown('');
    if (!text) return undefined;
    let index = 0;
    const timer = window.setInterval(() => {
      index += 1;
      setShown(text.slice(0, index));
      if (index >= text.length) window.clearInterval(timer);
    }, 18);
    return () => window.clearInterval(timer);
  }, [text]);
  return <span className={className}>{shown || text}</span>;
}

export const ClientAiAssistant = () => {
  const { token, profile, updateProfileState } = useClientAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: '1', role: 'ai', text: PRODUCT_ASSISTANT_GREETING },
  ]);
  const [inputValue, setInputValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState('');
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS);
  const [catalogs, setCatalogs] = useState<any[]>([]);
  const [statusLine, setStatusLine] = useState('');
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [removingProducts, setRemovingProducts] = useState(false);
  const pendingRef = useRef<PendingFile[]>([]);
  pendingRef.current = pendingFiles;
  const [makerLinked, setMakerLinked] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [stepLabel, setStepLabel] = useState(STEP_LABELS.products);
  const [currentStep, setCurrentStep] = useState('products');

  function applyCatalog(nextCatalogs: any[]) {
    const list = Array.isArray(nextCatalogs) ? nextCatalogs : [];
    setCatalogs(list);
    const summary = summarizeCatalogs(list);
    setProgress({
      layout: summary.layout,
      layoutLabel: summary.layoutLabel,
      categoryCount: summary.categoryCount,
      productCount: summary.productCount,
      categories: summary.categories.length ? summary.categories : EMPTY_PROGRESS.categories,
    });
  }

  useEffect(() => {
    if (!token) return;
    fetch('/api/client/ai-assistant/state', { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.json())
      .then((payload) => {
        if (payload.profile) updateProfileState(payload.profile);
        applyCatalog(payload.profile?.clientDataBank?.productCatalogs || []);
        setMakerLinked(Boolean(payload.makerLinked || payload.profile?.clientDataBank?.makerLink?.bundleId));
        setPreviewUrl(String(payload.profile?.clientDataBank?.makerLink?.publicPreviewUrl || ''));
        if (payload.currentStep) {
          setCurrentStep(payload.currentStep);
          setStepLabel(STEP_LABELS[payload.currentStep as keyof typeof STEP_LABELS] || STEP_LABELS.products);
        }
        if (payload.greeting) {
          setMessages((prev) => (prev.some((row) => row.role === 'user')
            ? prev
            : [{ id: '1', role: 'ai', text: payload.greeting }]));
        }
        if (payload.redirectTo) {
          window.setTimeout(() => window.location.assign(payload.redirectTo), 1200);
        }
      })
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, statusLine]);

  useEffect(() => () => {
    pendingRef.current.forEach((item) => URL.revokeObjectURL(item.url));
  }, []);

  useEffect(() => {
    if (!jobId || !token) return undefined;
    let stop = false;
    async function poll() {
      while (!stop) {
        const response = await fetch(`/api/client/ai-assistant/products/jobs/${jobId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const payload = await response.json().catch(() => ({}));
        if (payload.progress?.message) setStatusLine(payload.progress.message);
        if (payload.catalogs?.length) applyCatalog(payload.catalogs);
        else if (payload.catalog) applyCatalog([payload.catalog]);
        if (payload.profile) updateProfileState(payload.profile);
        if (payload.status === 'done' || payload.status === 'failed') {
          setBusy(false);
          setJobId('');
          setStatusLine('');
          setMessages((prev) => [
            ...prev,
            {
              id: String(Date.now()),
              role: 'ai',
              text: payload.status === 'done'
                ? (payload.assistantMessage || `Ferdig. Jeg har lagt inn ${payload.summary?.productCount || 0} produkter i ${payload.summary?.categoryCount || 0} kategorier.`)
                : (payload.error || 'Klarte ikke å lese filene. Prøv et annet dokument, eller skriv produktene her.'),
            },
          ]);
          if (payload.status === 'done' && payload.redirectTo) {
            window.setTimeout(() => window.location.assign(payload.redirectTo), 900);
          }
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }
    void poll();
    return () => { stop = true; };
  }, [jobId, token]);

  function queueFiles(fileList: FileList | File[] | null) {
    const files = Array.from(fileList || []);
    if (!files.length) return files;
    const isDocument = (file: File) => DOCUMENT_NAME.test(file.name);
    let kept = files;
    if (currentStep === 'logo') {
      kept = files.filter((file) => IMAGE_NAME.test(file.name) || isDocument(file));
    } else if (currentStep === 'media') {
      kept = files.filter((file) => MEDIA_NAME.test(file.name) || isDocument(file));
    }
    if (kept.length < files.length) {
      setMessages((prev) => [...prev, {
        id: String(Date.now()),
        role: 'ai',
        text: currentStep === 'logo'
          ? 'Logoen må være et bilde. Dokumenter leser jeg som tekst, andre filer ble ikke lagt til.'
          : 'Noen filer ble ikke lagt til. Jeg tar PDF, Word, Excel, tekst, bilder og video.',
      }]);
    }
    if (kept.length) {
      setPendingFiles((prev) => [
        ...prev,
        ...kept.map((file) => ({
          id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 7)}`,
          file,
          url: URL.createObjectURL(file),
        })),
      ]);
    }
    return kept;
  }

  function removePending(id: string) {
    setPendingFiles((prev) => {
      const hit = prev.find((item) => item.id === id);
      if (hit) URL.revokeObjectURL(hit.url);
      return prev.filter((item) => item.id !== id);
    });
  }

  function productRows(source = catalogs) {
    const rows: Array<{ key: string; title: string; category: string; catalogIndex: number; categoryIndex: number; productIndex: number }> = [];
    source.forEach((catalog, catalogIndex) => {
      (catalog.categories || []).forEach((category: any, categoryIndex: number) => {
        (category.products || []).forEach((product: any, productIndex: number) => {
          const title = String(product?.title || product?.name || '').trim();
          if (!title) return;
          rows.push({
            key: `${catalogIndex}-${categoryIndex}-${productIndex}-${title}`,
            title,
            category: String(category?.name || ''),
            catalogIndex,
            categoryIndex,
            productIndex,
          });
        });
      });
    });
    return rows;
  }

  async function saveProductCatalogs(nextCatalogs: any[]) {
    if (!token || removingProducts) return;
    setRemovingProducts(true);
    try {
      const bank = profile?.clientDataBank || {};
      const response = await fetch('/api/client/settings/client-data', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          clientDataBank: {
            ...bank,
            productCatalogs: nextCatalogs,
            assistantIntake: {
              ...(bank.assistantIntake || {}),
              ...(summarizeCatalogs(nextCatalogs).productCount ? {} : { products: '' }),
            },
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke fjerne produktet.');
      if (payload.profile) updateProfileState(payload.profile);
      applyCatalog(payload.profile?.clientDataBank?.productCatalogs || payload.clientDataBank?.productCatalogs || nextCatalogs);
    } catch (error) {
      setMessages((prev) => [...prev, {
        id: String(Date.now()),
        role: 'ai',
        text: error instanceof Error ? error.message : 'Kunne ikke fjerne produktet.',
      }]);
    } finally {
      setRemovingProducts(false);
    }
  }

  function removeProduct(row: { catalogIndex: number; categoryIndex: number; productIndex: number }) {
    const next = catalogs.map((catalog, catalogIndex) => ({
      ...catalog,
      categories: (catalog.categories || []).map((category: any, categoryIndex: number) => ({
        ...category,
        products: (category.products || []).filter((_: unknown, productIndex: number) => !(
          catalogIndex === row.catalogIndex
          && categoryIndex === row.categoryIndex
          && productIndex === row.productIndex
        )),
      })),
    }));
    void saveProductCatalogs(next);
  }

  async function sendToAssistant(text: string) {
    const trimmed = text.trim();
    const attached = pendingFiles.map((item) => item.file);
    if (!trimmed && !attached.length) return;
    const docs = attached.filter((file) => /\.(pdf|odt|ods|odp|docx|doc|rtf|xlsx|xls|csv|tsv|txt|md|html|htm|xml|json)$/i.test(file.name));
    const media = attached.filter((file) => /\.(png|jpe?g|webp|gif|heic|avif|mp4|mov|webm)$/i.test(file.name));
    const fileLabel = attached.length
      ? [
        docs.length ? `${docs.length} dokument${docs.length === 1 ? '' : 'er'}` : '',
        media.length ? `${media.length} ${media.length === 1 ? 'bilde/video' : 'bilder/video'}` : '',
        !docs.length && !media.length ? `${attached.length} fil(er)` : '',
        attached.map((file) => file.name).join(', '),
      ].filter(Boolean).join(': ')
      : '';
    setBusy(true);
    setStatusLine(attached.length ? 'Leser filene…' : 'Jobber…');
    setMessages((prev) => [...prev, { id: String(Date.now()), role: 'user', text: [trimmed, fileLabel].filter(Boolean).join('\n') }]);
    setInputValue('');
    pendingFiles.forEach((item) => URL.revokeObjectURL(item.url));
    setPendingFiles([]);
    let keepBusy = false;
    try {
      const body = new FormData();
      body.append('text', trimmed);
      body.append('messages', JSON.stringify(messages.concat({ id: 'x', role: 'user', text: trimmed })));
      attached.forEach((file) => body.append('files', file));
      const response = await fetch('/api/client/ai-assistant/chat', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'AI-assistenten svarte ikke.');
      if (payload.profile) updateProfileState(payload.profile);
      if (payload.catalogs) applyCatalog(payload.catalogs);
      if (payload.jobId) {
        keepBusy = true;
        setJobId(payload.jobId);
        setStatusLine(payload.assistantMessage || 'Henter produkter…');
        if (payload.assistantMessage) {
          setMessages((prev) => [...prev, {
            id: String(Date.now() + 1),
            role: 'ai',
            text: payload.assistantMessage,
          }]);
        }
        return;
      }
      if (payload.currentStep) {
        setCurrentStep(payload.currentStep);
        setStepLabel(STEP_LABELS[payload.currentStep as keyof typeof STEP_LABELS] || stepLabel);
      }
      if (payload.nextAction === 'manual') {
        window.location.assign('/kunde/innstillinger#produkter');
        return;
      }
      if (payload.redirectTo) {
        window.setTimeout(() => window.location.assign(payload.redirectTo), 900);
      }
      setMessages((prev) => [...prev, {
        id: String(Date.now() + 1),
        role: 'ai',
        text: payload.assistantMessage || 'Hva vil du gjøre videre?',
      }]);
    } catch (error) {
      setMessages((prev) => [...prev, {
        id: String(Date.now() + 2),
        role: 'ai',
        text: error instanceof Error ? error.message : 'Noe gikk galt.',
      }]);
    } finally {
      if (!keepBusy) {
        setBusy(false);
        setStatusLine('');
      }
    }
  }

  const helloName = personFirstName(profile || {});

  return (
    <ClientRouteGuard>
      <Helmet>
        <title>Kundeportal – AI-assistent</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <div className="relative w-full h-[100dvh] bg-[#F9F9F8] overflow-hidden flex flex-col font-sans">
        <div className="absolute w-[600px] h-[600px] top-[10%] -left-[300px] opacity-[0.2] blur-[120px] z-0 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle, #FF5B00 0%, rgba(255,91,0,0) 70%)' }} />
        <div className="absolute w-[600px] h-[600px] bottom-[20%] -right-[300px] opacity-[0.2] blur-[120px] z-0 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle, #FF5B00 0%, rgba(255,91,0,0) 70%)' }} />

        <main className="relative z-10 flex-1 w-full max-w-[1400px] mx-auto px-4 md:px-10 py-8 flex flex-col md:flex-row gap-8 overflow-hidden">
          <div className="w-full md:w-[380px] lg:w-[440px] bg-white rounded-2xl p-8 shadow-[0_8px_30px_rgba(0,0,0,0.04)] border border-gray-100 flex flex-col shrink-0 min-h-0 overflow-y-auto">
            <span className="text-[11px] font-bold tracking-[0.2em] text-[#121212] mb-8 uppercase">{stepLabel}</span>
            <div className="flex flex-col gap-6">
              <div className="border-b border-gray-50 pb-5">
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Produktsystem</span>
                <p className={`mt-2 text-[22px] font-semibold ${progress.layout ? 'text-[#121212]' : 'text-gray-300'}`}>
                  {progress.layout ? <TypeLine text={progress.layoutLabel || layoutLabel(progress.layout)} /> : 'Normal / Meny / Tiers'}
                </p>
              </div>
              <div className="border-b border-gray-50 pb-5">
                <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Kategorier</span>
                <p className={`mt-2 text-[18px] font-medium ${progress.categoryCount ? 'text-[#121212]' : 'text-gray-300'}`}>
                  {progress.categoryCount ? <TypeLine text={`${progress.categoryCount} kategorier · ${progress.productCount} produkter`} /> : 'Antall kategorier'}
                </p>
              </div>
              {productRows().length ? (
                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={removingProducts || busy}
                    onClick={() => {
                      if (window.confirm('Fjerne alle produktene fra katalogen?')) void saveProductCatalogs([]);
                    }}
                    className="text-[12px] text-gray-500 hover:text-red-600 disabled:opacity-40"
                  >
                    Fjern alle
                  </button>
                </div>
              ) : null}
              <div className="flex flex-col gap-3">
                {productRows().length ? productRows().map((row) => (
                  <div key={row.key} className="rounded-xl border border-gray-100 bg-white px-4 py-3 flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[14px] font-medium text-[#121212] truncate">{row.title}</p>
                      <p className="text-[12px] mt-1 text-gray-500 truncate">{row.category || 'Produkt'}</p>
                    </div>
                    <button
                      type="button"
                      disabled={removingProducts || busy}
                      aria-label={`Fjern ${row.title}`}
                      onClick={() => removeProduct(row)}
                      className="shrink-0 text-[12px] text-gray-400 hover:text-red-600 disabled:opacity-40"
                    >
                      Fjern
                    </button>
                  </div>
                )) : progress.categories.map((category, index) => (
                  <motion.div
                    key={`${category.name}-${index}`}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="rounded-xl border border-dashed border-gray-200 bg-gray-50/60 px-4 py-3"
                  >
                    <p className="text-[14px] font-medium text-gray-400">{category.name}</p>
                    <p className="text-[12px] mt-1 text-gray-300">Produkter fylles inn her</p>
                  </motion.div>
                ))}
              </div>
            </div>
            {makerLinked ? (
              <p className="mt-6 text-[12px] text-gray-500">
                Koblet til Website Maker
                {previewUrl ? (
                  <>
                    {' · '}
                    <a href={previewUrl} target="_blank" rel="noreferrer" className="text-[#FF5B00] underline">Se forhåndsvisning</a>
                  </>
                ) : null}
              </p>
            ) : null}
            {(busy || statusLine) ? (
              <div className="mt-6 rounded-xl border border-[#FF5B00]/20 bg-[#FFF6F0] px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#FF5B00] animate-bounce" />
                  <span className="w-1.5 h-1.5 rounded-full bg-[#FF5B00] animate-bounce [animation-delay:120ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-[#FF5B00] animate-bounce [animation-delay:240ms]" />
                  <p className="text-xs text-[#FF5B00]">{statusLine || 'Jobber…'}</p>
                </div>
              </div>
            ) : null}
          </div>

          <div
            className="flex-1 flex flex-col h-full min-h-0 overflow-hidden"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (!busy) queueFiles(e.dataTransfer.files);
            }}
          >
            <header className="w-full flex justify-between items-center shrink-0 pb-4">
              <Link to="/kunde/hjem" className="flex items-center gap-2 font-medium text-[16px] text-[#121212] no-underline hover:opacity-80">
                <ChevronLeft className="w-4 h-4" />
                asoldi
              </Link>
              <Link to="/kunde/hjem" className="text-gray-900 border-b border-gray-900 font-medium text-sm pb-0.5">Avslutt</Link>
            </header>

            <div ref={scrollRef} className="flex-1 overflow-y-auto pr-2 flex flex-col">
              <div className="mt-auto flex flex-col gap-6 pb-4">
                <AnimatePresence initial={false}>
                  {messages.map((msg, idx) => (
                    <motion.div
                      key={msg.id}
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`flex flex-col gap-2 max-w-[84%] ${msg.role === 'user' ? 'self-end bg-white border border-gray-100 rounded-2xl p-5 shadow-[0_4px_20px_rgba(0,0,0,0.03)]' : 'self-start'}`}
                    >
                      {msg.role === 'ai' ? (
                        <div className="flex items-start gap-4">
                          <div className="w-6 h-6 shrink-0 mt-0.5 text-[#FF5B00]">✦</div>
                          <div>
                            {idx === 0 ? <span className="text-sm font-semibold text-gray-400 mb-2 block">Hei{helloName ? ` ${helloName}` : ''}</span> : null}
                            {msg.text.split('\n').map((line, lineIdx) => (
                              <p key={lineIdx} className={`text-[15px] leading-relaxed ${lineIdx === 0 ? 'text-gray-600' : 'text-[#121212] font-semibold'}`}>{line}</p>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className="text-[15px] text-[#121212]">{msg.text}</p>
                      )}
                    </motion.div>
                  ))}
                </AnimatePresence>
                {busy ? (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="self-start flex items-start gap-4 max-w-[84%]"
                  >
                    <div className="w-6 h-6 shrink-0 mt-0.5 text-[#FF5B00]">✦</div>
                    <div>
                      <div className="flex items-center gap-1.5 h-6">
                        <span className="w-2 h-2 rounded-full bg-[#FF5B00] animate-bounce" />
                        <span className="w-2 h-2 rounded-full bg-[#FF5B00] animate-bounce [animation-delay:140ms]" />
                        <span className="w-2 h-2 rounded-full bg-[#FF5B00] animate-bounce [animation-delay:280ms]" />
                      </div>
                      <p className="text-[14px] text-gray-500">{statusLine || 'Tenker og leser kildene…'}</p>
                    </div>
                  </motion.div>
                ) : null}
              </div>
            </div>

            <form
              className="shrink-0 pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void sendToAssistant(inputValue);
              }}
            >
              {pendingFiles.length ? (
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {pendingFiles.map((item) => {
                    const kind = previewKind(item.file);
                    return (
                      <div key={item.id} className="relative shrink-0 w-[148px] bg-white border border-gray-200 rounded-xl overflow-hidden">
                        <button
                          type="button"
                          aria-label={`Fjern ${item.file.name}`}
                          onClick={() => removePending(item.id)}
                          className="absolute top-1 right-1 z-10 w-5 h-5 rounded-full bg-white/90 border border-gray-200 text-[12px] leading-none text-[#121212]"
                        >
                          ×
                        </button>
                        <button type="button" onClick={() => window.open(item.url, '_blank', 'noopener')} className="block w-full text-left">
                          {kind === 'image' ? <img src={item.url} alt="" className="h-24 w-full object-cover bg-gray-50" /> : null}
                          {kind === 'video' ? <video src={item.url} className="h-24 w-full object-cover bg-black" muted /> : null}
                          {kind === 'pdf' ? <iframe title={item.file.name} src={item.url} className="h-24 w-full pointer-events-none bg-gray-50" /> : null}
                          {kind === 'document' ? <div className="h-24 flex items-center justify-center bg-gray-50 text-[12px] text-gray-400">Dokument</div> : null}
                          <p className="px-2 pt-1 text-[11px] text-[#121212] truncate">{item.file.name}</p>
                          <p className="px-2 pb-2 text-[10px] text-gray-400">{formatFileSize(item.file.size)}</p>
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <div className={`relative flex items-center bg-white border rounded-[16px] shadow-[0_8px_30px_rgba(0,0,0,0.06)] overflow-hidden ${dragOver ? 'border-[#FF5B00] bg-[#FFF6F0]' : 'border-gray-100'}`}>
                <button type="button" onClick={() => fileRef.current?.click()} className="ml-3 text-gray-400 hover:text-[#121212]" aria-label="Legg ved fil">
                  <Paperclip className="w-4 h-4" />
                </button>
                <input
                  ref={composerRef}
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder={dragOver ? 'Slipp dokumenter eller bilder her' : 'Skriv fritt, eller last opp et dokument'}
                  className="w-full bg-transparent px-4 py-4 outline-none text-[15px] text-[#121212] placeholder-gray-400"
                  disabled={busy}
                />
                <button
                  type="submit"
                  disabled={busy || (!inputValue.trim() && !pendingFiles.length)}
                  className="mr-3 w-9 h-9 rounded-[10px] bg-gray-200 text-gray-500 hover:bg-[#121212] hover:text-white disabled:opacity-40 flex items-center justify-center"
                >
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                accept={FILE_ACCEPT}
                onChange={(e) => {
                  queueFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <p className="mt-2 text-[12px] text-gray-400">
                Dra og slipp PDF, Word, Excel, tekstfiler, bilder eller video. Jeg leser dokumentene som tekst.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <button type="button" onClick={() => fileRef.current?.click()} className="bg-white/70 border border-gray-200 px-4 py-2 rounded-lg text-[13px] text-gray-600">Last opp dokument</button>
                <Link to="/kunde/innstillinger#produkter" className="bg-white/70 border border-gray-200 px-4 py-2 rounded-lg text-[13px] text-gray-600">Sett opp manuelt</Link>
              </div>
            </form>
          </div>
        </main>
      </div>
    </ClientRouteGuard>
  );
};
