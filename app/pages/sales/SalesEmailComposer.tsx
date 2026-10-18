import React, { useEffect, useMemo, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ExternalLink, Loader2, Send } from 'lucide-react';
import { EmailVisualEditor } from './EmailVisualEditor';
import { composeSalesEmail, saveEmailDraft, sendComposedEmail, type MergeField } from './emailApi';
import { getSalesToken } from '../Admin/shared';

export function SalesEmailComposer() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const clientId = params.get('clientId') || '';
  const templateKey = params.get('template') || 'thank-you';
  const fromAdmin = params.get('from') === 'admin';
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [preheader, setPreheader] = useState('');
  const [html, setHtml] = useState('');
  const [htmlKey, setHtmlKey] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [mergeFields, setMergeFields] = useState<MergeField[]>([]);
  const [previewPc, setPreviewPc] = useState('');
  const [previewPhone, setPreviewPhone] = useState('');

  const templates = [
    { key: 'thank-you', label: 'Bekreftelse — online' },
    { key: 'thank-you-in-person', label: 'Bekreftelse — fysisk' },
    { key: 'reminder-3d', label: 'Påminnelse 3 dager — online' },
    { key: 'reminder-3d-in-person', label: 'Påminnelse 3 dager — fysisk' },
    { key: 'reminder-24h', label: 'Påminnelse 24 timer — online' },
    { key: 'reminder-24h-in-person', label: 'Påminnelse 24 timer — fysisk' },
    { key: 'reminder-1h', label: 'Påminnelse 1 time — online' },
    { key: 'reminder-1h-in-person', label: 'Påminnelse 1 time — fysisk' },
    { key: 'workshop', label: 'Workshop — Meet' },
    { key: 'workshop-sms-ring', label: 'Workshop — SMS/ring' },
    { key: 'iteration', label: 'Iterasjonsmøte — Meet' },
    { key: 'workshop-reminder-3d', label: 'Workshop 3 dager' },
    { key: 'workshop-reminder-24h', label: 'Workshop 24 timer' },
    { key: 'data-innsamling-1', label: 'Datainnsamling' },
    { key: 'data-innsamling-2', label: 'Datainnsamling påminnelse' },
    { key: 'offer', label: 'Tilbud + kontrakt' },
  ];

  function composerHref(nextTemplate: string) {
    const next = new URLSearchParams();
    next.set('clientId', clientId);
    next.set('template', nextTemplate);
    if (fromAdmin) next.set('from', 'admin');
    return `/sales/email?${next.toString()}`;
  }

  useEffect(() => {
    const token = getSalesToken();
    if (!token) {
      navigate('/login/ansatt', { replace: true });
      return;
    }
    if (!clientId) {
      setError('Mangler kunde.');
      setLoading(false);
      return;
    }
    if (templateKey === 'offer') {
      // The offer has its own composer (tier picker, AI fill, contract PDF, admin review).
      navigate(`/sales/offer?clientId=${encodeURIComponent(clientId)}`, { replace: true });
      return;
    }
    setLoading(true);
    setError('');
    composeSalesEmail(clientId, templateKey)
      .then((data: Record<string, unknown>) => {
        const client = (data.client || {}) as { contactEmail?: string; businessName?: string };
        const merged = (data.merged || {}) as { subject?: string; preheader?: string; html?: string };
        setTo(String(client.contactEmail || ''));
        setBusinessName(String(client.businessName || ''));
        setSubject(String(merged.subject || ''));
        setPreheader(String(merged.preheader || ''));
        setHtml(String(merged.html || ''));
        setHtmlKey(`${templateKey}-${Date.now()}`);
        setMergeFields(Array.isArray(data.mergeFields) ? data.mergeFields as MergeField[] : []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Kunne ikke åpne e-posten');
        setLoading(false);
      });
  }, [clientId, templateKey, navigate]);

  const title = useMemo(() => {
    if (templateKey.startsWith('data-innsamling')) return 'Send datainnsamling';
    if (templateKey.startsWith('workshop-reminder')) return 'Send workshop-påminnelse';
    if (templateKey === 'workshop' || templateKey.startsWith('workshop-')) return 'Send workshop-e-post';
    if (templateKey.startsWith('iteration')) return 'Send iterasjonsmøte';
    if (templateKey.startsWith('reminder')) return 'Send påminnelse';
    return 'Send velkomstmail';
  }, [templateKey]);

  async function handlePreview() {
    setError('');
    const data = await saveEmailDraft({
      clientId,
      templateKey,
      to,
      subject,
      preheader,
      html,
    });
    setPreviewPc(data.previewPc);
    setPreviewPhone(data.previewPhone);
    return data;
  }

  async function openPreview(view: 'pc' | 'phone') {
    try {
      const data = await handlePreview();
      window.open(view === 'phone' ? data.previewPhone : data.previewPc, '_blank');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Forhåndsvisning feilet');
    }
  }

  async function handleSend() {
    setSending(true);
    setError('');
    setNotice('');
    try {
      await handlePreview();
      const data = await sendComposedEmail(clientId, {
        templateKey,
        subject,
        preheader,
        html,
        to,
        markAs: templateKey,
      }) as { copyTo?: string; meetLink?: string };
      const extra = [data.meetLink ? `Meet: ${data.meetLink}` : '', data.copyTo ? `Kopi: ${data.copyTo}` : '']
        .filter(Boolean)
        .join(' · ');
      setNotice(`Sendt til ${to}${extra ? ` · ${extra}` : ''}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sending feilet');
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Helmet>
        <title>{title} – Asoldi</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <div className="staff-light min-h-screen bg-[#1a1a1a] text-white">
        <header className="border-b border-white/10 bg-[#222]">
          <div className="max-w-[1400px] mx-auto px-6 py-4 flex items-center justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold">{title}</h1>
              <p className="text-xs text-gray-400">{businessName || 'Kunde'} · rediger før du sender</p>
            </div>
            <div className="flex items-center gap-2">
              <Link to="/sales/email/templates" className="px-3 py-2 rounded-lg bg-white/10 text-sm hover:bg-white/15">Maler</Link>
              <Link to={fromAdmin ? '/admin' : '/sales'} className="px-3 py-2 rounded-lg bg-white/10 text-sm hover:bg-white/15">
                {fromAdmin ? 'Tilbake til Admin' : 'Tilbake'}
              </Link>
            </div>
          </div>
        </header>
        <main className="max-w-[1400px] mx-auto px-6 py-6 flex flex-col gap-4">
          {error && <p className="text-red-400 text-sm">{error}</p>}
          {notice && <p className="text-emerald-300 text-sm">{notice}</p>}
          {loading ? (
            <div className="flex items-center gap-2 text-gray-400"><Loader2 className="animate-spin" size={18} /> Åpner malen…</div>
          ) : (
            <>
              <div className="grid md:grid-cols-4 gap-3">
                <label className="text-xs text-gray-400">
                  Mal
                  <select
                    value={templateKey}
                    onChange={(event) => navigate(composerHref(event.target.value))}
                    className="mt-1 w-full px-3 py-2 rounded-lg bg-[#111] border border-white/15 text-white text-sm"
                  >
                    {templates.map((row) => (
                      <option key={row.key} value={row.key}>{row.label}</option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-gray-400">
                  Til
                  <input value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg bg-[#111] border border-white/15 text-white text-sm" />
                </label>
                <label className="text-xs text-gray-400">
                  Emne
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg bg-[#111] border border-white/15 text-white text-sm" />
                </label>
                <label className="text-xs text-gray-400">
                  Preheader
                  <input value={preheader} onChange={(e) => setPreheader(e.target.value)} className="mt-1 w-full px-3 py-2 rounded-lg bg-[#111] border border-white/15 text-white text-sm" />
                </label>
              </div>
              <div className="min-h-[620px]">
                <EmailVisualEditor html={html} htmlKey={htmlKey} mergeFields={mergeFields} onHtmlChange={setHtml} />
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => void openPreview('pc')} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-sm">
                  <ExternalLink size={14} /> Forhåndsvis PC
                </button>
                <button type="button" onClick={() => void openPreview('phone')} className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-sm">
                  <ExternalLink size={14} /> Forhåndsvis telefon
                </button>
                <button type="button" onClick={() => void handleSend()} disabled={sending || !to} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#FF5B00] text-white text-sm disabled:opacity-50">
                  {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  Send e-post
                </button>
                {previewPc && (
                  <a href={previewPc} target="_blank" rel="noreferrer" className="text-xs text-gray-400 underline self-center">
                    {previewPc}
                  </a>
                )}
                {previewPhone && (
                  <a href={previewPhone} target="_blank" rel="noreferrer" className="text-xs text-gray-400 underline self-center">
                    {previewPhone}
                  </a>
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </>
  );
}
