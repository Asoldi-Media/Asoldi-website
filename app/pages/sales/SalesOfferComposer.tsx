import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Copy, ExternalLink, Eye, FileText, Loader2, Paperclip, RefreshCw, Send, ShieldCheck, X } from 'lucide-react';
import { EmailVisualEditor } from './EmailVisualEditor';
import {
  approveClientOfferPreview,
  fillClientOffer,
  useClientOfferMeeting,
  getClientOffer,
  getClientOfferMeeting,
  openAuthedPdf,
  previewClientOffer,
  requestClientOfferReview,
  saveClientOffer,
  sendClientOffer,
  startNewClientOffer,
  type MergeField,
  type OfferPreview,
  type OfferReadiness,
} from './emailApi';
import { getSalesToken, type SalesOffer, type SalesSender } from '../Admin/shared';
import { ContractSummaryCard, HtmlPreview, OfferProductsCard, OfferStatusChip } from './offerUi';
import { SalesFlowSteps } from './SalesFlowSteps';
import { clientCardParty, offerMissingFields, offerReadinessMessage } from '../../../lib/offer-readiness.js';
import { resolveWebsiteEmail } from '../../../lib/sales-website-email.js';

type OfferClient = {
  id: string;
  businessName: string;
  contactPerson: string;
  contactEmail: string;
  websiteEmail?: string;
  clientEmail?: string;
  hasProductNotes?: boolean;
  workshopStartDate?: string;
  orgNumber: string;
  businessAddress: string;
  meetingPlace: string;
};

type MeetingInfo = {
  meetingId: string;
  title: string;
  when: string;
  hasTranscript: boolean;
  hasSummary: boolean;
  tooThin?: boolean;
  pendingTranscript?: boolean;
  liveJoined?: boolean;
  manual?: boolean;
  firefliesUrl?: string;
  durationMinutes?: number | '';
} | null;

type MeetingMatch = { meetingId: string; title: string; when: string; durationMinutes?: number | ''; selected?: boolean; hasTranscript?: boolean; liveJoined?: boolean };

type PreviewState = {
  preview: OfferPreview;
  placeholders: string[];
  blocker: string;
};

const AUTOSAVE_MS = 1500;

function formatWorkshopDate(value = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Avtales senere';
  const [year, month, day] = value.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('nb-NO', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

type ComposerProps = {
  embedded?: boolean;
  clientId?: string;
  autoFillToken?: number;
};

export function SalesOfferComposer({ embedded = false, clientId: clientIdProp = '', autoFillToken = 0 }: ComposerProps = {}) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const clientId = clientIdProp || params.get('clientId') || '';

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'' | 'tier' | 'mva' | 'review-toggle' | 'fill' | 'review' | 'send' | 'contract' | 'new' | 'save' | 'preview' | 'approve' | 'meeting'>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [offer, setOffer] = useState<SalesOffer | null>(null);
  const [client, setClient] = useState<OfferClient | null>(null);
  const [party, setParty] = useState({ businessName: '', orgNumber: '', address: '', contactPerson: '' });
  const [mergeFields, setMergeFields] = useState<MergeField[]>([]);
  const [meeting, setMeeting] = useState<MeetingInfo>(null);
  const [meetingQuery, setMeetingQuery] = useState('');
  const [meetingMatches, setMeetingMatches] = useState<MeetingMatch[]>([]);
  const [meetings, setMeetings] = useState<MeetingMatch[]>([]);
  const [sender, setSender] = useState<SalesSender | null>(null);
  const [deepseek, setDeepseek] = useState(false);
  const [canSendEmail, setCanSendEmail] = useState(true);

  const [to, setTo] = useState('');
  const [meetingsOpen, setMeetingsOpen] = useState(false);
  const [fillPhase, setFillPhase] = useState<'' | 'running' | 'done' | 'error'>('');
  const [fillMessage, setFillMessage] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [sendPortal, setSendPortal] = useState(false);
  const [portalAccount, setPortalAccount] = useState<{ email: string; found: boolean } | null>(null);
  const [fillRequest, setFillRequest] = useState(0);
  const [subject, setSubject] = useState('');
  const [preheader, setPreheader] = useState('');
  const [html, setHtml] = useState('');
  const [htmlKey, setHtmlKey] = useState('');
  // Edits made since the last approved preview (before the autosave has told the server about them).
  const [editedSincePreview, setEditedSincePreview] = useState(false);
  const [previewState, setPreviewState] = useState<PreviewState | null>(null);
  const dirtyRef = useRef(false);
  const autoFillKeyRef = useRef('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const htmlRef = useRef(html);
  const subjectRef = useRef(subject);
  const preheaderRef = useRef(preheader);
  const toRef = useRef(to);
  const partyRef = useRef(party);
  const clientRef = useRef(client);
  htmlRef.current = html;
  subjectRef.current = subject;
  preheaderRef.current = preheader;
  toRef.current = to;
  partyRef.current = party;
  clientRef.current = client;

  const status = offer?.status || 'draft';
  const locked = status === 'review-requested' || status === 'verified' || status === 'sent';
  const isCustom = offer?.tierId === 'custom';
  // Server is the source of truth: custom tier always needs admin, otherwise the rep's checkbox decides.
  const reviewChecked = isCustom || Boolean(offer?.reviewRequested);
  const needsReview = reviewChecked;
  const mvaIncluded = Boolean(offer?.mvaIncluded);
  const placeholders = offer?.placeholders || [];
  const previewApproved = Boolean(offer?.previewCurrent) && !editedSincePreview;

  const applyOffer = useCallback((next: SalesOffer, { resetHtml = true } = {}) => {
    setOffer(next);
    setSubject(next.email.subject || '');
    setPreheader(next.email.preheader || '');
    if (resetHtml) {
      setHtml(next.email.html || '');
      setHtmlKey(`${next.id}-${next.updatedAt}-${Date.now()}`);
    }
    dirtyRef.current = false;
    setEditedSincePreview(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getClientOffer(clientId) as {
        offer: SalesOffer;
        client: OfferClient;
        readiness: OfferReadiness;
        mergeFields: MergeField[];
        meeting: MeetingInfo;
        meetings?: MeetingMatch[];
        sender: SalesSender;
        deepseek: boolean;
        canSendEmail: boolean;
        portalAccount?: { email: string; found: boolean };
      };
      setClient(data.client);
      setPortalAccount(data.portalAccount || null);
      setMergeFields(Array.isArray(data.mergeFields) ? data.mergeFields : []);
      setMeeting(data.meeting || null);
      setMeetings(Array.isArray(data.meetings) ? data.meetings : []);
      setSender(data.sender || null);
      setDeepseek(Boolean(data.deepseek));
      setCanSendEmail(data.canSendEmail !== false);
      const card = clientCardParty(data.client);
      const stored = data.offer.party;
      setParty({
        businessName: stored?.businessName || card.businessName,
        orgNumber: stored?.orgNumber || card.orgNumber,
        address: stored?.address || card.address,
        contactPerson: stored?.contactPerson || card.contactPerson,
      });
      setTo(resolveWebsiteEmail(data.client));
      applyOffer(data.offer);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke åpne tilbudet');
    } finally {
      setLoading(false);
    }
  }, [clientId, applyOffer]);

  useEffect(() => {
    if (!getSalesToken()) {
      navigate('/login/ansatt', { replace: true });
      return;
    }
    if (!clientId) {
      setError('Mangler kunde.');
      setLoading(false);
      return;
    }
    void load();
  }, [clientId, navigate, load]);

  const meetingReady = Boolean(meeting?.hasTranscript || meeting?.hasSummary);

  useEffect(() => {
    if (!clientId || !getSalesToken()) return undefined;
    if (meeting?.manual && meetingReady) return undefined;
    let cancelled = false;
    async function tick() {
      if (document.visibilityState === 'hidden') return;
      try {
        const data = await getClientOfferMeeting(clientId) as { meeting: MeetingInfo; meetings?: MeetingMatch[] };
        if (cancelled) return;
        if (Array.isArray(data.meetings)) setMeetings(data.meetings);
        const next = data.meeting || null;
        let becameReady = false;
        setMeeting((current) => {
          if (current?.manual && current.meetingId) return current;
          const same = (current?.meetingId || '') === (next?.meetingId || '')
            && Boolean(current?.hasTranscript) === Boolean(next?.hasTranscript)
            && Boolean(current?.hasSummary) === Boolean(next?.hasSummary)
            && (current?.title || '') === (next?.title || '');
          if (same) return current;
          if (next && (next.hasTranscript || next.hasSummary) && !(current?.hasTranscript || current?.hasSummary)) {
            becameReady = true;
          }
          return next;
        });
        if (becameReady) setNotice('Fireflies-møtet er klart på tilbudet.');
      } catch {
        // Keep waiting; the webhook may not have landed yet.
      }
    }
    const timer = window.setInterval(() => { void tick(); }, 10_000);
    const onVisible = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [clientId, meeting?.manual, meetingReady]);

  function partyPayload() {
    const card = clientCardParty(clientRef.current || {});
    const draft = partyRef.current;
    const org = draft.orgNumber.replace(/\D+/g, '');
    return {
      businessName: draft.businessName.trim() === card.businessName ? '' : draft.businessName.trim(),
      orgNumber: org === card.orgNumber ? '' : org,
      address: draft.address.trim() === card.address ? '' : draft.address.trim(),
      contactPerson: draft.contactPerson.trim() === card.contactPerson ? '' : draft.contactPerson.trim(),
      contactEmail: '',
    };
  }

  // Autosave the draft so the rep can leave and come back (and so admin review sees the latest content).
  const scheduleSave = useCallback((extra: Record<string, unknown> = {}) => {
    if (!offer || locked) return;
    dirtyRef.current = true;
    setEditedSincePreview(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const data = await saveClientOffer(clientId, {
          html: htmlRef.current,
          subject: subjectRef.current,
          preheader: preheaderRef.current,
          to: toRef.current,
          party: partyPayload(),
          ...extra,
        }) as { offer: SalesOffer };
        setOffer(data.offer);
        dirtyRef.current = false;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Autolagring feilet');
      }
    }, AUTOSAVE_MS);
  }, [clientId, offer, locked]);

  function onHtmlChange(next: string) {
    if (next === html) return;
    setHtml(next);
    scheduleSave({ html: next, subject, preheader });
  }

  function onSubjectChange(next: string) {
    setSubject(next);
    scheduleSave({ html, subject: next, preheader });
  }

  function onPreheaderChange(next: string) {
    setPreheader(next);
    scheduleSave({ html, subject, preheader: next });
  }

  async function flushSave() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (!dirtyRef.current || locked) return offer;
    const data = await saveClientOffer(clientId, { html, subject, preheader, to, party: partyPayload() }) as { offer: SalesOffer };
    setOffer(data.offer);
    dirtyRef.current = false;
    return data.offer;
  }

  async function toggleReviewFirst(next: boolean) {
    if (!offer || locked || isCustom) return;
    setBusy('review-toggle');
    setError('');
    try {
      const data = await saveClientOffer(clientId, { reviewRequested: next }) as { offer: SalesOffer };
      setOffer(data.offer);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre valget');
    } finally {
      setBusy('');
    }
  }

  async function toggleMvaIncluded(next: boolean) {
    if (!offer || locked) return;
    setBusy('mva');
    setError('');
    try {
      const data = await saveClientOffer(clientId, { mvaIncluded: next, html, subject, preheader }) as { offer: SalesOffer };
      applyOffer(data.offer);
      setNotice(next
        ? 'Mva er nå inkludert i prisen – oppgitt pris er det kunden betaler per måned.'
        : 'Mva legges til på toppen av oppgitt pris (standard).');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke endre mva-visning');
    } finally {
      setBusy('');
    }
  }

  async function handlePickMeeting(payload: { title?: string; meetingId?: string; clear?: boolean }) {
    setBusy('meeting');
    setError('');
    setNotice('');
    try {
      const data = await useClientOfferMeeting(clientId, payload) as {
        offer?: SalesOffer;
        meeting?: MeetingInfo;
        meetings?: MeetingMatch[];
        matches?: MeetingMatch[];
      };
      if (Array.isArray(data.matches) && data.matches.length > 1) {
        setMeetingMatches(data.matches);
        setNotice('Flere møter matcher. Velg det riktige.');
        return;
      }
      setMeetingMatches([]);
      setMeetingQuery('');
      setMeetingsOpen(false);
      autoFillKeyRef.current = '';
      setFillRequest((current) => current + 1);
      if (Array.isArray(data.meetings)) setMeetings(data.meetings);
      if (data.meeting) setMeeting(data.meeting);
      if (data.offer) applyOffer(data.offer);
      setNotice(payload.clear ? 'Bruker det bookede salgsmøtet igjen.' : 'Møtet er valgt som grunnlag for tilbudet.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke hente møtet');
    } finally {
      setBusy('');
    }
  }

  async function handleFill() {
    if (fillDisabledReason) {
      setFillPhase('error');
      setFillMessage(fillDisabledReason);
      return;
    }
    setBusy('fill');
    setFillPhase('running');
    setFillMessage('Fyller ut e-posten…');
    setError('');
    try {
      await flushSave();
      const data = await fillClientOffer(clientId, { meetingId: meeting?.meetingId || '' }) as { offer: SalesOffer };
      applyOffer(data.offer);
      setFillPhase('done');
      setFillMessage('E-posten er fylt ut fra møtet og produktnotatene.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI-utfylling feilet';
      setFillPhase('error');
      setFillMessage(message);
      setError(message);
    } finally {
      setBusy('');
    }
  }

  async function openContract() {
    setBusy('contract');
    setError('');
    try {
      await flushSave();
      await openAuthedPdf(`/admin/sales/${encodeURIComponent(clientId)}/offer/contract.pdf`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lage kontrakt');
    } finally {
      setBusy('');
    }
  }

  async function openPreview() {
    setBusy('preview');
    setError('');
    try {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const data = await previewClientOffer(clientId, locked ? { to } : { to, html, subject, preheader, party: partyPayload() });
      setOffer(data.offer);
      if (data.offer?.email?.html && data.offer.email.html !== html) {
        setHtml(data.offer.email.html);
        setHtmlKey(`${data.offer.id}-${data.offer.updatedAt}-${Date.now()}`);
      }
      if (data.offer?.email?.subject) setSubject(data.offer.email.subject);
      dirtyRef.current = false;
      setPreviewState({ preview: data.preview, placeholders: data.placeholders || [], blocker: data.blocker || '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Forhåndsvisning feilet');
    } finally {
      setBusy('');
    }
  }

  async function approvePreview() {
    setBusy('approve');
    setError('');
    try {
      const data = await approveClientOfferPreview(clientId);
      setOffer(data.offer);
      setEditedSincePreview(false);
      setPreviewState(null);
      setNotice('Forhåndsvisningen er godkjent – du kan nå sende tilbudet.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke godkjenne forhåndsvisningen');
    } finally {
      setBusy('');
    }
  }

  async function handleRequestReview() {
    setBusy('review');
    setError('');
    setNotice('');
    try {
      const data = await requestClientOfferReview(clientId, { html, subject, preheader, reviewRequested: true }) as { offer: SalesOffer; notification?: { sent: boolean; to?: string } };
      applyOffer(data.offer);
      setNotice(data.notification?.sent ? `Sendt til admin for gjennomgang (${data.notification.to}).` : 'Sendt til admin for gjennomgang.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke sende til gjennomgang');
    } finally {
      setBusy('');
    }
  }

  async function handleSend() {
    setBusy('send');
    setError('');
    setNotice('');
    try {
      const channels = [sendEmail ? 'email' : '', sendPortal ? 'portal' : ''].filter(Boolean);
      const payload = { to: resolveWebsiteEmail(client || {}), party: partyPayload(), channels };
      const data = await sendClientOffer(clientId, payload) as {
        offer: SalesOffer;
        copyTo?: string;
        contractFileName?: string;
        delivery?: string;
        channels?: string[];
        accountFound?: boolean;
        portalEmail?: string;
        websiteCode?: string;
      };
      applyOffer(data.offer);
      const code = data.websiteCode || data.offer?.websiteCode || '';
      const codeNote = code ? ` Nettsidekode: ${code} — lim inn på asoldi.com for å aktivere nettsiden.` : '';
      const sentChannels = data.channels?.length ? data.channels : (data.delivery === 'both' ? ['email', 'portal'] : [data.delivery || 'email']);
      const portalEmail = data.portalEmail || resolveWebsiteEmail(client || {}) || to;
      const parts = [];
      if (sentChannels.includes('email')) {
        parts.push(`E-post sendt til ${to}${data.contractFileName ? ` med ${data.contractFileName}` : ''}${data.copyTo ? ` · Kopi: ${data.copyTo}` : ''}`);
      }
      if (sentChannels.includes('portal')) {
        parts.push(data.accountFound
          ? `Lagt på asoldi.com-kontoen ${portalEmail}`
          : `Klart for asoldi.com (${portalEmail}). Kontoen finnes ikke enda — tilbudet vises når kunden registrerer seg med den e-posten`);
      }
      setNotice(`${parts.join('. ')}.${codeNote}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sending feilet');
    } finally {
      setBusy('');
    }
  }

  async function handleNewOffer() {
    setBusy('new');
    setError('');
    try {
      const data = await startNewClientOffer(clientId) as { offer: SalesOffer; copied?: boolean };
      const fresh = clientCardParty(client || {});
      const stored = data.offer.party;
      setParty({
        businessName: stored?.businessName || fresh.businessName,
        orgNumber: stored?.orgNumber || fresh.orgNumber,
        address: stored?.address || fresh.address,
        contactPerson: stored?.contactPerson || fresh.contactPerson,
      });
      setTo(resolveWebsiteEmail(client || {}));
      autoFillKeyRef.current = '';
      applyOffer(data.offer);
      setNotice(data.copied
        ? 'Nytt utkast er en kopi av tilbudet som ble sendt. Endre det du trenger, og forhåndsvis på nytt før du sender.'
        : 'Nytt tilbudsutkast opprettet.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke starte nytt tilbud');
    } finally {
      setBusy('');
    }
  }

  const fillDisabledReason = useMemo(() => {
    if (!deepseek) return 'AI-utfylling er ikke aktivert på serveren enda. Du kan skrive feltene i editoren.';
    if (client?.hasProductNotes) return '';
    if (!meeting) return 'Venter på Fireflies-transkript, eller skriv produktnotater på forrige side.';
    if (meeting.pendingTranscript) return 'Fireflies var i Meet. Transkriptet er ikke klart ennå.';
    if (!meeting.hasTranscript && !meeting.hasSummary) return 'Møtet mangler transkript og sammendrag.';
    if (meeting.tooThin) return 'Opptaket har under 10 linjer, og produktnotatene er for korte.';
    return '';
  }, [deepseek, meeting, client?.hasProductNotes]);

  const handleFillRef = useRef(handleFill);
  handleFillRef.current = handleFill;
  const meetingSelected = Boolean(meeting?.meetingId);
  const openPlaceholders = (offer?.placeholders || []).length;
  useEffect(() => {
    if (loading || locked || !offer?.id || !meetingSelected || fillDisabledReason || !openPlaceholders) return;
    const key = `${offer.id}:${meeting?.meetingId || ''}:${autoFillToken}:${fillRequest}`;
    if (autoFillKeyRef.current === key) return;
    autoFillKeyRef.current = key;
    void handleFillRef.current();
  }, [autoFillToken, loading, locked, fillDisabledReason, offer?.id, meeting?.meetingId, meetingSelected, openPlaceholders, fillRequest]);

  const card = useMemo(() => clientCardParty(client || {}), [client]);
  const offerTo = resolveWebsiteEmail(client || {}) || to;
  const workshopDateLabel = formatWorkshopDate(client?.workshopStartDate || '');
  const readiness = useMemo(() => {
    const missing = offerMissingFields({
      businessName: party.businessName,
      orgNumber: party.orgNumber,
      meetingPlace: party.address,
      businessAddress: party.address,
      contactPerson: party.contactPerson,
      contactEmail: offerTo,
    });
    return { ready: missing.length === 0, missing, message: offerReadinessMessage(missing) };
  }, [party, offerTo]);

  const sendDisabledReason = useMemo(() => {
    if (!offer) return '';
    if (!sendEmail && !sendPortal) return 'Velg e-post, asoldi.com, eller begge.';
    if (sendEmail && !canSendEmail) return 'E-post er ikke konfigurert på serveren.';
    if (!readiness.ready) return readiness.message;
    if (!offerTo) return 'Mangler e-postadresse.';
    if (!offer.products.length) return 'Velg en nettside-tier først.';
    if (status === 'review-requested') return 'Venter på gjennomgang hos admin.';
    if (needsReview && status !== 'verified') return 'Dette tilbudet må verifiseres av admin før det kan sendes.';
    if (placeholders.length) return `${placeholders.length} felt fra malen er ikke fylt ut enda.`;
    if (!previewApproved) return 'Forhåndsvis e-posten og godkjenn før du sender.';
    return '';
  }, [offer, canSendEmail, readiness, offerTo, status, needsReview, placeholders.length, previewApproved, sendEmail, sendPortal]);

  const showSendButton = status !== 'sent' && (!needsReview || status === 'verified');
  const title = 'Se gjennom tilbud';

  return (
    <>
      <Helmet>
        <title>{title} – Asoldi</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <div className={embedded ? 'text-white' : 'staff-light min-h-screen bg-[#1a1a1a] text-white'}>
        {!embedded && (
        <header className="border-b border-white/10 bg-[#222]">
          <div className="max-w-[1400px] mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold">{title}</h1>
                {offer && <OfferStatusChip status={offer.status} />}
              </div>
              <p className="text-xs text-gray-400 truncate">
                {client?.businessName || 'Kunde'}{client?.contactPerson ? ` · ${client.contactPerson}` : ''} · tilbuds-e-post og kontrakt (PDF) sendes sammen
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Link to="/sales/email/templates" className="px-3 py-2 rounded-lg bg-white/10 text-sm hover:bg-white/15">Maler</Link>
              <Link to="/sales" className="px-3 py-2 rounded-lg bg-white/10 text-sm hover:bg-white/15">Tilbake til salg</Link>
            </div>
          </div>
        </header>
        )}

        {!embedded && (
        <div className="bg-white text-[#111827] border-b border-[#E6E9EF]">
          <div className="max-w-[1400px] mx-auto px-6 py-3">
            <SalesFlowSteps
              step={3}
              onStep={(step) => {
                if (!clientId || step === 3) return;
                navigate(`/sales?flow=${encodeURIComponent(clientId)}&step=${step}`);
              }}
            />
          </div>
        </div>
        )}
        <main className="max-w-[1400px] mx-auto px-6 py-6 flex flex-col gap-4">
          {error && <p className="text-red-300 text-sm">{error}</p>}
          {notice && <p className="text-emerald-200 text-sm">{notice}</p>}

          {loading || !offer ? (
            <div className="flex items-center gap-2 text-gray-400"><Loader2 className="animate-spin" size={18} /> Åpner tilbudet…</div>
          ) : (
            <>
              {(sender && !sender.phone) && (
                <div className="flex items-start gap-3 rounded-xl border border-amber-400/30 bg-amber-900/20 px-4 py-3 text-sm text-amber-200">
                  <AlertTriangle size={18} className="shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium">Telefonnummeret ditt mangler</div>
                    <div>E-posten signeres med navn, e-post og telefon fra brukeren din ({sender.fromEmail}). Be admin legge inn nummeret under Admin → Users, ellers vises kontornummeret.</div>
                  </div>
                </div>
              )}
              {status === 'review-requested' && (
                <div className="rounded-xl border border-amber-400/30 bg-amber-900/20 px-4 py-3 text-sm text-amber-200">
                  Tilbudet ligger hos admin for gjennomgang. Du får e-post når det er verifisert – da kan du sende det herfra.
                </div>
              )}
              {status === 'verified' && (
                <div className="flex items-start gap-3 rounded-xl border border-sky-400/30 bg-sky-900/30 px-4 py-3 text-sm text-sky-300">
                  <ShieldCheck size={18} className="shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium">Verifisert av admin – klart til å sendes</div>
                    {offer.adminNote && <div className="text-sky-300">Melding fra admin: {offer.adminNote}</div>}
                    <div className="text-sky-300 text-xs mt-1">Innholdet er låst. Forhåndsvis e-posten, godkjenn, og send.</div>
                  </div>
                </div>
              )}
              {status === 'sent' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-400/30 bg-emerald-900/20 px-4 py-3 text-sm text-emerald-200">
                    <span>Sendt {offer.sentAt ? new Date(offer.sentAt).toLocaleString('nb-NO') : ''} til {offer.sentTo}.</span>
                    <button type="button" onClick={() => void handleNewOffer()} disabled={busy === 'new'} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/10 text-xs hover:bg-white/15 disabled:opacity-50">
                      {busy === 'new' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Nytt tilbud
                    </button>
                  </div>
                  {offer.websiteCode && (
                    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-[#161616] px-4 py-3 text-sm">
                      <span className="text-gray-400">Nettsidekode</span>
                      <span className="font-mono tracking-[0.3em] text-lg text-white">{offer.websiteCode}</span>
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(offer.websiteCode || '').then(
                          () => setNotice(`Kopiert ${offer.websiteCode}`),
                          () => setError('Kunne ikke kopiere koden')
                        )}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-xs hover:bg-white/15"
                      >
                        <Copy size={12} /> Kopier
                      </button>
                      <span className="text-xs text-gray-500">Kunden limer inn koden på asoldi.com for å aktivere nettsiden.</span>
                    </div>
                  )}
                </div>
              )}

              <div className="grid xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
                <div className="flex flex-col gap-4 min-w-0">
                  <div className="grid md:grid-cols-2 gap-3">
                    <label className="text-xs text-gray-400">
                      Emne
                      <input value={subject} onChange={(e) => onSubjectChange(e.target.value)} disabled={locked} className="mt-1 w-full px-3 py-2 rounded-lg bg-[#111] border border-white/15 text-white text-sm disabled:opacity-50" />
                    </label>
                    <label className="text-xs text-gray-400">
                      Forhåndstekst
                      <input value={preheader} onChange={(e) => onPreheaderChange(e.target.value)} disabled={locked} className="mt-1 w-full px-3 py-2 rounded-lg bg-[#111] border border-white/15 text-white text-sm disabled:opacity-50" />
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className={`text-xs ${fillPhase === 'error' ? 'text-amber-200' : fillPhase === 'done' ? 'text-emerald-300' : 'text-gray-400'}`}>
                      {fillPhase === 'running' || busy === 'fill'
                        ? 'Fyller ut e-posten…'
                        : (fillMessage || (fillDisabledReason && meetingSelected ? fillDisabledReason : 'E-posten fylles ut når salgsmøtet fra Fireflies er valgt og transkriptet er klart.'))}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <label
                        className={`inline-flex items-center gap-2 text-xs ${locked ? 'text-gray-500' : 'text-gray-300'}`}
                        title="Standard: mva legges til på toppen av prisen. Slå på for å la oppgitt pris være det kunden betaler inkl. mva (for kunder med lavt budsjett)."
                      >
                        <input
                          type="checkbox"
                          checked={mvaIncluded}
                          disabled={locked || busy === 'mva'}
                          onChange={(e) => void toggleMvaIncluded(e.target.checked)}
                        />
                        Inkluder mva i prisen
                      </label>
                      <label
                        className={`inline-flex items-center gap-2 text-xs ${isCustom || locked ? 'text-gray-500' : 'text-gray-300'}`}
                        title={isCustom ? 'Skreddersydde tilbud må alltid via admin' : 'Valgfritt for tier 1–3: la admin se gjennom tilbudet før du sender'}
                      >
                        <input
                          type="checkbox"
                          checked={reviewChecked}
                          disabled={locked || isCustom || busy === 'review-toggle'}
                          onChange={(e) => void toggleReviewFirst(e.target.checked)}
                        />
                        Kjør via admin først{isCustom ? ' (påkrevd for skreddersydd)' : ''}
                      </label>
                    </div>
                  </div>

                  <div className="rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-400">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>
                        {meeting
                          ? `${meeting.title || 'Møte'}${meeting.when ? ` · ${meeting.when}` : ''}${meeting.pendingTranscript ? ' · venter på transkript' : ''}`
                          : 'Ingen Fireflies-opptak valgt'}
                      </span>
                      <a href={meeting?.firefliesUrl || 'https://app.fireflies.ai/'} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[#FF5B00] hover:underline">
                        <ExternalLink size={12} /> Fireflies
                      </a>
                      {!locked && (
                        <button type="button" onClick={() => setMeetingsOpen((open) => !open)} className="text-[#FF5B00] hover:underline">
                          {meetingsOpen ? 'Skjul' : 'Bytt opptak'}
                        </button>
                      )}
                    </div>
                    {meetingsOpen && !locked && (
                      <div className="mt-2 space-y-3">
                        <div>
                          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Transkript fra kalenderøkten</div>
                          {meetings.some((entry) => entry.hasTranscript) ? (
                            <div className="flex flex-wrap gap-2">
                              {meetings.filter((entry) => entry.hasTranscript).map((entry) => (
                                <button
                                  key={entry.meetingId}
                                  type="button"
                                  disabled={busy === 'meeting'}
                                  onClick={() => void handlePickMeeting({ meetingId: entry.meetingId })}
                                  className={`px-2 py-1 rounded-md text-left ${
                                    entry.selected || entry.meetingId === meeting?.meetingId
                                      ? 'bg-[#FF5B00]/20 text-white'
                                      : 'bg-white/10 text-white hover:bg-white/15'
                                  }`}
                                >
                                  {entry.title || 'Uten tittel'}{entry.when ? ` · ${entry.when}` : ''}
                                </button>
                              ))}
                            </div>
                          ) : (
                            <p className="text-[11px] text-gray-500">Ingen transkript er knyttet til denne kalenderøkten ennå.</p>
                          )}
                        </div>
                        {meetings.some((entry) => !entry.hasTranscript) && (
                          <div className="flex flex-wrap gap-2">
                            {meetings.filter((entry) => !entry.hasTranscript).map((entry) => (
                              <button
                                key={entry.meetingId}
                                type="button"
                                disabled={busy === 'meeting'}
                                onClick={() => void handlePickMeeting({ meetingId: entry.meetingId })}
                                className={`px-2 py-1 rounded-md text-left ${
                                  entry.selected || entry.meetingId === meeting?.meetingId
                                    ? 'bg-[#FF5B00]/20 text-white'
                                    : 'bg-white/10 text-gray-300 hover:bg-white/15'
                                }`}
                              >
                                {entry.title || 'Uten tittel'}{entry.when ? ` · ${entry.when}` : ''} · venter på transkript
                              </button>
                            ))}
                          </div>
                        )}
                        <div>
                          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Legg til Fireflies-lenke eller navn</div>
                          <div className="flex flex-wrap items-end gap-2">
                            <input
                              value={meetingQuery}
                              onChange={(event) => setMeetingQuery(event.target.value)}
                              placeholder="https://app.fireflies.ai/view/… eller møtenavn"
                              className="flex-1 min-w-[180px] px-2 py-1.5 rounded-md bg-[#111] border border-white/15 text-white text-xs"
                            />
                            <button
                              type="button"
                              disabled={busy === 'meeting' || meetingQuery.trim().length < 3}
                              onClick={() => void handlePickMeeting({ title: meetingQuery.trim() })}
                              className="px-2 py-1.5 rounded-md bg-white/10 text-xs hover:bg-white/15 disabled:opacity-50"
                            >
                              {busy === 'meeting' ? 'Henter…' : 'Legg til'}
                            </button>
                          </div>
                        </div>
                        {meetingMatches.length > 1 && (
                          <div className="flex flex-wrap gap-2">
                            {meetingMatches.map((match) => (
                              <button
                                key={match.meetingId}
                                type="button"
                                disabled={busy === 'meeting'}
                                onClick={() => void handlePickMeeting({ meetingId: match.meetingId })}
                                className="px-2 py-1 rounded-md bg-white/10 text-xs text-white hover:bg-white/15"
                              >
                                {match.title || 'Uten tittel'}{match.when ? ` · ${match.when}` : ''}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {placeholders.length > 0 && status !== 'sent' && (
                    <div className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-900/20 px-4 py-3 text-sm text-amber-200">
                      <AlertTriangle size={18} className="shrink-0 mt-0.5" />
                      <div>
                        <div className="font-medium">{placeholders.length} felt fra malen er ikke fylt ut enda</div>
                        <div className="text-xs mt-1">
                          {placeholders.map((label) => `«${label}»`).join(' · ')}
                        </div>
                        <div className="text-xs mt-1">Skriv i editoren, eller slett avsnittet. Tilbudet kan ikke sendes med tomme felt.</div>
                      </div>
                    </div>
                  )}

                  <div className="min-h-[620px]">
                    {locked ? (
                      <HtmlPreview html={html} className="min-h-[620px] h-[900px]" />
                    ) : (
                      <EmailVisualEditor html={html} htmlKey={htmlKey} mergeFields={mergeFields} onHtmlChange={onHtmlChange} />
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void openContract()}
                      disabled={busy === 'contract' || !offer.contractAvailable}
                      title={offer.contractAvailable ? 'Åpner kontrakten som PDF' : isCustom ? 'Kontrakten for skreddersydd lages av admin ved verifisering' : 'Velg en tier først'}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-sm disabled:opacity-50"
                    >
                      {busy === 'contract' ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} Se kontrakt (PDF)
                    </button>

                    {status !== 'sent' && (
                      <button
                        type="button"
                        onClick={() => void openPreview()}
                        disabled={busy === 'preview'}
                        title="Viser e-posten slik kunden får den – med navn, priser og signatur fylt inn"
                        className={`inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm disabled:opacity-50 ${showSendButton && !previewApproved && !sendDisabledReason.startsWith('Kundekortet') ? 'bg-white text-black' : 'bg-white/10'}`}
                      >
                        {busy === 'preview' ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
                        {previewApproved ? 'Forhåndsvis igjen' : 'Forhåndsvis e-post'}
                      </button>
                    )}

                    {status !== 'sent' && needsReview && status !== 'verified' && (
                      <button
                        type="button"
                        onClick={() => void handleRequestReview()}
                        disabled={busy === 'review' || status === 'review-requested' || !readiness.ready || (!offer.products.length && !isCustom)}
                        title={!readiness.ready ? readiness.message : (!offer.products.length && !isCustom) ? 'Velg en tier eller skreddersydd først' : ''}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500 text-black text-sm font-medium disabled:opacity-50"
                      >
                        {busy === 'review' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                        {status === 'review-requested' ? 'Sendt til admin' : 'Se gjennom tilbud (admin)'}
                      </button>
                    )}
                    {showSendButton && (
                      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 px-3 py-2">
                        <span className="text-xs text-gray-400">Levering</span>
                        <label className="inline-flex items-center gap-1.5 text-sm">
                          <input type="checkbox" checked={sendEmail} onChange={(event) => setSendEmail(event.target.checked)} />
                          E-post
                        </label>
                        <label
                          className="inline-flex items-center gap-1.5 text-sm"
                          title={portalAccount?.found
                            ? `Legges på kundekontoen ${portalAccount.email}`
                            : `Legges på asoldi.com for ${offerTo || 'e-posten på kortet'}`}
                        >
                          <input type="checkbox" checked={sendPortal} onChange={(event) => setSendPortal(event.target.checked)} disabled={!offerTo} />
                          Asoldi.com{offerTo ? ` (${portalAccount?.found ? portalAccount.email : offerTo})` : ''}
                        </label>
                        {sendPortal && offerTo && (
                          <span className={`text-[11px] ${portalAccount?.found ? 'text-emerald-300' : 'text-amber-200'}`}>
                            {portalAccount?.found ? 'Kundekonto funnet' : 'Ingen kundekonto med denne e-posten enda'}
                          </span>
                        )}
                      </div>
                    )}
                    {showSendButton && (
                      <button
                        type="button"
                        onClick={() => void handleSend()}
                        disabled={busy === 'send' || Boolean(sendDisabledReason)}
                        title={sendDisabledReason}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#FF5B00] text-white text-sm disabled:opacity-50"
                      >
                        {busy === 'send' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                        {sendEmail && sendPortal ? 'Send e-post og legg på asoldi.com' : sendPortal ? 'Legg tilbudet på asoldi.com' : 'Send tilbud + kontrakt'}
                      </button>
                    )}
                    {sendDisabledReason && showSendButton && (
                      <span className="text-xs text-gray-500 self-center">{sendDisabledReason}</span>
                    )}
                    {!sendDisabledReason && showSendButton && previewApproved && (
                      <span className="text-xs text-emerald-300 self-center">Forhåndsvisning godkjent{offer.previewedAt ? ` ${new Date(offer.previewedAt).toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' })}` : ''}.</span>
                    )}
                  </div>
                </div>

                <aside className="flex flex-col gap-4">
                  <OfferProductsCard products={offer.products} mvaIncluded={mvaIncluded} />
                  <ContractSummaryCard summary={offer.contract.summary} mvaIncluded={mvaIncluded} />
                  <div className="rounded-xl border border-white/10 bg-[#161616] p-4 text-xs text-gray-300 space-y-2">
                    <div className="font-medium text-white text-sm">Kontraktdata for dette tilbudet</div>
                    <p className="text-[11px] text-gray-500">Krysset nullstiller feltet til kundekortet. Til og startdato settes på de forrige stegene.</p>
                    <div className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                      <div className="text-[10px] uppercase tracking-wide text-gray-500">Til</div>
                      <div className="text-sm text-white break-all">{offerTo || '—'}</div>
                    </div>
                    <div className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                      <div className="text-[10px] uppercase tracking-wide text-gray-500">Startdato for workshop</div>
                      <div className="text-sm text-white">{workshopDateLabel}</div>
                    </div>
                    <PartyField label="Bedrift" value={party.businessName} cardValue={card.businessName} disabled={locked} onChange={(value) => { setParty((prev) => ({ ...prev, businessName: value })); scheduleSave(); }} onReset={() => { setParty((prev) => ({ ...prev, businessName: card.businessName })); scheduleSave(); }} />
                    <PartyField label="Org. nr" value={party.orgNumber} cardValue={card.orgNumber} disabled={locked} onChange={(value) => { setParty((prev) => ({ ...prev, orgNumber: value })); scheduleSave(); }} onReset={() => { setParty((prev) => ({ ...prev, orgNumber: card.orgNumber })); scheduleSave(); }} />
                    <PartyField label="Adresse" value={party.address} cardValue={card.address} disabled={locked} onChange={(value) => { setParty((prev) => ({ ...prev, address: value })); scheduleSave(); }} onReset={() => { setParty((prev) => ({ ...prev, address: card.address })); scheduleSave(); }} />
                    <PartyField label="Innehaver" value={party.contactPerson} cardValue={card.contactPerson} disabled={locked} onChange={(value) => { setParty((prev) => ({ ...prev, contactPerson: value })); scheduleSave(); }} onReset={() => { setParty((prev) => ({ ...prev, contactPerson: card.contactPerson })); scheduleSave(); }} />
                  </div>
                  {sender && (
                    <div className="rounded-xl border border-white/10 bg-[#161616] p-4 text-xs text-gray-300 space-y-1">
                      <div className="font-medium text-white text-sm mb-1">Signatur (fra brukeren din)</div>
                      <div>Navn: <span className="text-white">{sender.fullName || sender.name || '—'}</span></div>
                      <div>E-post: <span className="text-white">{sender.fromEmail || '—'}</span></div>
                      <div>Telefon: <span className={sender.phone ? 'text-white' : 'text-amber-300'}>{sender.phone || 'mangler – kontornummer brukes'}</span></div>
                    </div>
                  )}
                  {offer.history.length > 0 && (
                    <div className="rounded-xl border border-white/10 bg-[#161616] p-4 text-xs text-gray-400 space-y-1">
                      <div className="font-medium text-white text-sm mb-1">Historikk</div>
                      {offer.history.slice(-6).reverse().map((entry, index) => (
                        <div key={`${entry.at}-${index}`}>
                          {new Date(entry.at).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' })} · {entry.action}{entry.note ? ` · ${entry.note}` : ''}
                        </div>
                      ))}
                    </div>
                  )}
                </aside>
              </div>
            </>
          )}
        </main>

        {previewState && offer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
            <div className="w-full max-w-[860px] max-h-[94vh] flex flex-col rounded-2xl border border-white/10 bg-[#1f1f1f] shadow-2xl">
              <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
                <div className="min-w-0">
                  <div className="text-base font-semibold">Slik ser e-posten ut for kunden</div>
                  <div className="text-xs text-gray-400 mt-1 space-y-0.5">
                    <div>Til: <span className="text-gray-200">{previewState.preview.to || to || '—'}</span> · Fra: <span className="text-gray-200">{previewState.preview.from}</span></div>
                    <div>Emne: <span className="text-gray-200">{previewState.preview.subject}</span></div>
                    <div className="inline-flex items-center gap-1">
                      <Paperclip size={12} />
                      {previewState.preview.contractAvailable
                        ? <span>Vedlegg: <span className="text-gray-200">{previewState.preview.contractFileName}</span></span>
                        : <span className="text-amber-300">Ingen kontrakt kan lages enda (velg tier, eller få tilbudet verifisert).</span>}
                    </div>
                  </div>
                </div>
                <button type="button" onClick={() => setPreviewState(null)} className="p-1.5 rounded-lg bg-white/10 hover:bg-white/15" aria-label="Lukk">
                  <X size={16} />
                </button>
              </div>

              {(previewState.placeholders.length > 0 || previewState.blocker) && (
                <div className="mx-5 mt-4 flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-900/20 px-4 py-3 text-sm text-amber-200">
                  <AlertTriangle size={18} className="shrink-0 mt-0.5" />
                  <div>
                    {previewState.placeholders.length > 0 && (
                      <div>
                        <div className="font-medium">{previewState.placeholders.length} felt fra malen mangler innhold</div>
                        <div className="text-xs mt-0.5">{previewState.placeholders.map((label) => `«${label}»`).join(' · ')}</div>
                      </div>
                    )}
                    {previewState.blocker && previewState.placeholders.length === 0 && <div>{previewState.blocker}</div>}
                  </div>
                </div>
              )}

              <div className="flex-1 min-h-0 p-5">
                <HtmlPreview html={previewState.preview.html} className="h-[60vh] min-h-[360px]" />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-5 py-4">
                <div className="text-xs text-gray-400">
                  Signatur: {previewState.preview.sender.name} · {previewState.preview.sender.email}{previewState.preview.sender.phone ? ` · ${previewState.preview.sender.phone}` : ' · (telefon mangler)'}
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={() => setPreviewState(null)} className="px-3 py-2 rounded-lg bg-white/10 text-sm">
                    {locked ? 'Lukk' : 'Rediger videre'}
                  </button>
                  {status !== 'sent' && (
                    <button
                      type="button"
                      onClick={() => void approvePreview()}
                      disabled={busy === 'approve' || previewState.placeholders.length > 0 || Boolean(previewState.blocker) || !readiness.ready}
                      title={!readiness.ready ? readiness.message : previewState.placeholders.length ? 'Fyll ut eller slett feltene fra malen først' : previewState.blocker || 'Bekreft at e-posten er riktig'}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium disabled:opacity-50"
                    >
                      {busy === 'approve' ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}
                      Ser riktig ut – klar til sending
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function samePartyValue(value: string, cardValue: string) {
  const digits = (input: string) => input.replace(/\D+/g, '');
  if (digits(cardValue).length === 9 && digits(value) === digits(cardValue)) return true;
  return value.trim().toLowerCase() === cardValue.trim().toLowerCase();
}

function PartyField({
  label,
  value,
  cardValue,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  value: string;
  cardValue: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  const overridden = !samePartyValue(value, cardValue);
  return (
    <label className="block">
      <span className="text-gray-400">{label}</span>
      <span className="mt-1 flex items-center gap-1">
        <input
          value={value}
          disabled={disabled}
          onChange={(event) => {
            if (!event.target.value.trim()) onReset();
            else onChange(event.target.value);
          }}
          className="w-full px-2 py-1.5 rounded-lg bg-[#111] border border-white/15 text-white text-xs disabled:opacity-50"
        />
        {overridden && !disabled && (
          <button
            type="button"
            title="Tilbakestill til kundekortet"
            onClick={onReset}
            className="p-1.5 rounded-lg bg-white/10 text-gray-300 hover:bg-white/15"
          >
            <X size={12} />
          </button>
        )}
      </span>
    </label>
  );
}
