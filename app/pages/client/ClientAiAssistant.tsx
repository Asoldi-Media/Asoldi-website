import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, ChevronLeft, Paperclip } from 'lucide-react';
import { ClientRouteGuard } from '../../components/client/ClientRouteGuard';
import { useClientAuth } from '../../contexts/ClientAuthContext';
import { layoutLabel, summarizeCatalogs } from '../../../lib/client-product-catalog.js';
import { PRODUCT_ASSISTANT_GREETING } from '../../../lib/ai-assistant/chat.js';

type ChatMessage = { id: string; role: 'ai' | 'user'; text: string };

type Progress = {
  layout: string | null;
  layoutLabel: string;
  categoryCount: number;
  productCount: number;
  categories: Array<{ id?: string; name: string; productCount: number }>;
};

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: '1', role: 'ai', text: PRODUCT_ASSISTANT_GREETING },
  ]);
  const [inputValue, setInputValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState('');
  const [progress, setProgress] = useState<Progress>(EMPTY_PROGRESS);
  const [statusLine, setStatusLine] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [makerLinked, setMakerLinked] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');

  function applyCatalog(catalogs: any[]) {
    const summary = summarizeCatalogs(catalogs);
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
        if (payload.summary?.productCount) applyCatalog(payload.profile?.clientDataBank?.productCatalogs || []);
        setMakerLinked(Boolean(payload.makerLinked || payload.profile?.clientDataBank?.makerLink?.bundleId));
        setPreviewUrl(String(payload.profile?.clientDataBank?.makerLink?.publicPreviewUrl || ''));
      })
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, statusLine]);

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
          setMessages((prev) => [
            ...prev,
            {
              id: String(Date.now()),
              role: 'ai',
              text: payload.status === 'done'
                ? (payload.assistantMessage || `Ferdig. Jeg har lagt inn ${payload.summary?.productCount || 0} produkter i ${payload.summary?.categoryCount || 0} kategorier.`)
                : (payload.error || 'Klarte ikke å hente produktene. Prøv en annen URL eller last opp en fil.'),
            },
          ]);
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }
    void poll();
    return () => { stop = true; };
  }, [jobId, token]);

  async function sendToAssistant(text: string, files: File[] = []) {
    const trimmed = text.trim();
    const attached = files.length ? files : pendingFiles;
    if (!trimmed && !attached.length) return;
    const fileLabel = attached.length ? `${attached.length} fil(er): ${attached.map((file) => file.name).join(', ')}` : '';
    setBusy(true);
    setMessages((prev) => [...prev, { id: String(Date.now()), role: 'user', text: [trimmed, fileLabel].filter(Boolean).join('\n') }]);
    setInputValue('');
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
        return;
      }
      if (payload.nextAction === 'manual') {
        window.location.assign('/kunde/innstillinger#produkter');
        return;
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
      if (!keepBusy) setBusy(false);
    }
  }

  const filled = Boolean(progress.layout || progress.categoryCount);

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
            <span className="text-[11px] font-bold tracking-[0.2em] text-[#121212] mb-8 uppercase">Produktdata</span>
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
              <div className="flex flex-col gap-3">
                {progress.categories.map((category, index) => (
                  <motion.div
                    key={`${category.name}-${index}`}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    className={`rounded-xl border px-4 py-3 ${filled && category.productCount ? 'border-gray-100 bg-white' : 'border-dashed border-gray-200 bg-gray-50/60'}`}
                  >
                    <p className={`text-[14px] font-medium ${category.productCount ? 'text-[#121212]' : 'text-gray-400'}`}>
                      {category.productCount ? <TypeLine text={category.name} /> : category.name}
                    </p>
                    <p className={`text-[12px] mt-1 ${category.productCount ? 'text-gray-500' : 'text-gray-300'}`}>
                      {category.productCount ? `${category.productCount} produkter` : 'Produkter fylles inn her'}
                    </p>
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
            {statusLine ? <p className="mt-auto pt-6 text-xs text-[#FF5B00]">{statusLine}</p> : null}
          </div>

          <div className="flex-1 flex flex-col h-full min-h-0 overflow-hidden">
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
                            {idx === 0 ? <span className="text-sm font-semibold text-gray-400 mb-2 block">Hei</span> : null}
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
              </div>
            </div>

            <form
              className="shrink-0 pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (!busy) void sendToAssistant(inputValue, pendingFiles);
              }}
            >
              {pendingFiles.length ? (
                <div className="flex flex-wrap gap-2 mb-2">
                  {pendingFiles.map((file, index) => (
                    <button
                      key={`${file.name}-${index}`}
                      type="button"
                      onClick={() => setPendingFiles((prev) => prev.filter((_, current) => current !== index))}
                      className="bg-white border border-gray-200 rounded-full px-3 py-1 text-[12px] text-[#121212]"
                    >
                      {file.name} ×
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="relative flex items-center bg-white border border-gray-100 rounded-[16px] shadow-[0_8px_30px_rgba(0,0,0,0.06)] overflow-hidden">
                <button type="button" onClick={() => fileRef.current?.click()} className="ml-3 text-gray-400 hover:text-[#121212]" aria-label="Legg ved fil">
                  <Paperclip className="w-4 h-4" />
                </button>
                <input
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  placeholder="Lim inn URL, skriv notater, og legg ved filer — alt leses sammen"
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
                accept=".xlsx,.xls,.csv,.pdf,.docx,.odt,.txt,.md,.png,.jpg,.jpeg,.webp"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  if (files.length) setPendingFiles((prev) => [...prev, ...files]);
                  e.target.value = '';
                }}
              />
              <p className="mt-2 text-[12px] text-gray-400">
                Filer, lenker og tekst vurderes som én kilde. Legg ved flere dokumenter før du sender.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                <button type="button" onClick={() => fileRef.current?.click()} className="bg-white/70 border border-gray-200 px-4 py-2 rounded-lg text-[13px] text-gray-600">Legg ved filer</button>
                <button type="button" onClick={() => setInputValue((prev) => (prev.includes('https://') ? prev : `${prev}${prev ? '\n' : ''}https://`.trim()))} className="bg-white/70 border border-gray-200 px-4 py-2 rounded-lg text-[13px] text-gray-600">Lim inn URL</button>
                <Link to="/kunde/innstillinger#produkter" className="bg-white/70 border border-gray-200 px-4 py-2 rounded-lg text-[13px] text-gray-600">Sett opp manuelt</Link>
              </div>
            </form>
          </div>
        </main>
      </div>
    </ClientRouteGuard>
  );
};
