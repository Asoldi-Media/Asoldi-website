import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Copy, ExternalLink, FileText, Loader2, RefreshCw, Send, ShieldCheck, X } from 'lucide-react';
import { EmailVisualEditor } from './EmailVisualEditor';
import {
  fillClientOffer,
  useClientOfferMeeting,
  getClientOffer,
  getClientOfferMeeting,
  fetchAuthedPdf,
  requestClientOfferReview,
  saveClientOffer,
  sendClientOffer,
  startNewClientOffer,
  type MergeField,
  type OfferReadiness,
} from './emailApi';
import { getSalesToken, type SalesOffer, type SalesSender } from '../Admin/shared';
import { ContractSummaryCard, HtmlPreview, OfferProductsCard, OfferStatusChip } from './offerUi';
import { SalesFlowSteps } from './SalesFlowSteps';
import { clientCardParty, offerMissingFields, offerReadinessMessage } from '../../../lib/offer-readiness.js';
import { resolveWebsiteEmail } from '../../../lib/sales-website-email.js';

const PdfPreviewOverlay = React.lazy(() =>
  import('./PdfPreviewOverlay').then((mod) => ({ default: mod.PdfPreviewOverlay }))
);

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

type MeetingMatch = {
  meetingId: string;
  title: string;
  when: string;
  durationMinutes?: number | '';
  selected?: boolean;
  hasTranscript?: boolean;
  liveJoined?: boolean;
  purpose?: string;
};

function meetingPurposeLabel(purpose = '') {
  if (purpose === 'sales') return 'Salgsmøte';
  if (purpose === 'workshop') return 'Workshop';
  if (purpose === 'iteration') return 'Iterasjon';
  return '';
}

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
};

export function SalesOfferComposer({ embedded = false, clientId: clientIdProp = '' }: ComposerProps = {}) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const clientId = clientIdProp || params.get('clientId') || '';

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'' | 'tier' | 'mva' | 'review-toggle' | 'fill' | 'review' | 'send' | 'contract' | 'new' | 'save' | 'meeting' | 'meeting-save'>('');
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
  const [draftMeetingIds, setDraftMeetingIds] = useState<string[] | null>(null);
  const [sender, setSender] = useState<SalesSender | null>(null);
  const [deepseek, setDeepseek] = useState(false);
  const [canSendEmail, setCanSendEmail] = useState(true);

  const [to, setTo] = useState('');
  const [meetingsOpen, setMeetingsOpen] = useState(false);
  const [fillPhase, setFillPhase] = useState<'' | 'running' | 'done' | 'error'>('');
  const [fillMessage, setFillMessage] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const [sendPortal, setSendPortal] = useState(false);
  const [sendContent, setSendContent] = useState<'full' | 'contract'>('full');
  const [portalAccount, setPortalAccount] = useState<{ email: string; found: boolean } | null>(null);
  const [subject, setSubject] = useState('');
  const [preheader, setPreheader] = useState('');
  const [html, setHtml] = useState('');
  const [htmlKey, setHtmlKey] = useState('');
  const [contractPdfUrl, setContractPdfUrl] = useState('');
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const htmlRef = useRef(html);
  const subjectRef = useRef(subject);
  const preheaderRef = useRef(preheader);
  const toRef = useRef(to);
  const partyRef = useRef(party);
  const clientRef = useRef(client);
  const contractPdfUrlRef = useRef(contractPdfUrl);
  htmlRef.current = html;
  subjectRef.current = subject;
  preheaderRef.current = preheader;
  toRef.current = to;
  partyRef.current = party;
  clientRef.current = client;
  contractPdfUrlRef.current = contractPdfUrl;

  const status = offer?.status || 'draft';
  const locked = status === 'review-requested' || status === 'verified' || status === 'sent';
  const isCustom = offer?.tierId === 'custom';
  // Server is the source of truth: custom tier always needs admin, otherwise the rep's checkbox decides.
  const reviewChecked = isCustom || Boolean(offer?.reviewRequested);
  const needsReview = reviewChecked;
  const mvaIncluded = Boolean(offer?.mvaIncluded);
  const placeholders = offer?.placeholders || [];
  const applyOffer = useCallback((next: SalesOffer, { resetHtml = true } = {}) => {
    setOffer(next);
    setSubject(next.email.subject || '');
    setPreheader(next.email.preheader || '');
    if (resetHtml) {
      setHtml(next.email.html || '');
      setHtmlKey(`${next.id}-${next.updatedAt}-${Date.now()}`);
    }
    dirtyRef.current = false;
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
      setDraftMeetingIds(null);
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

  useEffect(() => () => {
    if (contractPdfUrlRef.current) URL.revokeObjectURL(contractPdfUrlRef.current);
  }, []);

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
  // After admin lock, only the recipient (Til) can still be saved.
  const scheduleSave = useCallback((extra: Record<string, unknown> = {}) => {
    if (!offer || status === 'sent') return;
    if (!locked) dirtyRef.current = true;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const payload = locked
          ? { to: toRef.current }
          : {
            html: htmlRef.current,
            subject: subjectRef.current,
            preheader: preheaderRef.current,
            to: toRef.current,
            party: partyPayload(),
            ...extra,
          };
        const data = await saveClientOffer(clientId, payload) as { offer: SalesOffer };
        setOffer(data.offer);
        dirtyRef.current = false;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Autolagring feilet');
      }
    }, AUTOSAVE_MS);
  }, [clientId, offer, locked, status]);

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

  async function handlePickMeeting(payload: { title?: string; meetingId?: string; meetingIds?: string[]; clear?: boolean }) {
    const savingSelection = Array.isArray(payload.meetingIds);
    setBusy(savingSelection ? 'meeting-save' : 'meeting');
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
      if (payload.title) setMeetingQuery('');
      if (Array.isArray(data.meetings)) setMeetings(data.meetings);
      if (data.meeting) setMeeting(data.meeting);
      if (data.offer) applyOffer(data.offer);
      setDraftMeetingIds(null);
      const selectedCount = Array.isArray(data.meetings)
        ? data.meetings.filter((entry) => entry.selected).length
        : 0;
      setNotice(payload.clear
        ? 'Alle opptak med transkript er valgt igjen.'
        : savingSelection
          ? (selectedCount ? `${selectedCount} opptak lagret. Trykk Generer på nytt for å bruke dem i e-posten.` : 'Ingen opptak valgt. Trykk Generer på nytt hvis e-posten skal skrives uten transkript.')
          : selectedCount
            ? `${selectedCount} opptak valgt som grunnlag for tilbudet.`
            : 'Opptakene er oppdatert.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke hente møtet');
    } finally {
      setBusy('');
    }
  }

  async function handleFill(force = false) {
    if (fillDisabledReason) {
      if (force) {
        setFillPhase('error');
        setFillMessage(fillDisabledReason);
      }
      return;
    }
    setBusy('fill');
    setFillPhase('running');
    setFillMessage(force ? 'Skriver e-posten på nytt…' : 'Fyller ut e-posten…');
    setError('');
    try {
      await flushSave();
      const data = await fillClientOffer(clientId, { meetingId: meeting?.meetingId || '', force }) as { offer: SalesOffer };
      applyOffer(data.offer);
      setFillPhase('done');
      setFillMessage(force ? 'E-posten er skrevet på nytt fra møtet og produktnotatene.' : 'E-posten er fylt ut fra møtet og produktnotatene.');
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
      if (contractPdfUrlRef.current) URL.revokeObjectURL(contractPdfUrlRef.current);
      const url = await fetchAuthedPdf(`/admin/sales/${encodeURIComponent(clientId)}/offer/contract.pdf`);
      setContractPdfUrl(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lage kontrakt');
    } finally {
      setBusy('');
    }
  }

  const closeContractPreview = useCallback(() => {
    if (contractPdfUrlRef.current) URL.revokeObjectURL(contractPdfUrlRef.current);
    setContractPdfUrl('');
  }, []);

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
      const payload = { to: (to || '').trim() || resolveWebsiteEmail(client || {}), party: partyPayload(), channels, content: sendContent };
      const data = await sendClientOffer(clientId, payload) as {
        offer: SalesOffer;
        copyTo?: string;
        contractFileName?: string;
        delivery?: string;
        content?: string;
        channels?: string[];
        accountFound?: boolean;
        portalEmail?: string;
        websiteCode?: string;
      };
      applyOffer(data.offer);
      const code = data.websiteCode || data.offer?.websiteCode || '';
      const codeNote = code ? ` Nettsidekode: ${code} — lim inn på asoldi.com for å aktivere nettsiden.` : '';
      const sentChannels = data.channels?.length ? data.channels : (data.delivery === 'both' ? ['email', 'portal'] : [data.delivery || 'email']);
      const sentContract = (data.content || sendContent) === 'contract';
      const portalEmail = data.portalEmail || resolveWebsiteEmail(client || {}) || to;
      const parts = [];
      if (sentChannels.includes('email')) {
        parts.push(sentContract
          ? `Kontrakt sendt på e-post til ${to}${data.contractFileName ? ` (${data.contractFileName})` : ''}${data.copyTo ? ` · Kopi: ${data.copyTo}` : ''}`
          : `E-post sendt til ${to}${data.contractFileName ? ` med ${data.contractFileName}` : ''}${data.copyTo ? ` · Kopi: ${data.copyTo}` : ''}`);
      }
      if (sentChannels.includes('portal')) {
        parts.push(data.accountFound
          ? `${sentContract ? 'Kontrakt lagt' : 'Lagt'} på asoldi.com-kontoen ${portalEmail}`
          : `${sentContract ? 'Kontrakt klar' : 'Klart'} for asoldi.com (${portalEmail}). Kontoen finnes ikke enda — tilbudet vises når kunden registrerer seg med den e-posten`);
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
      applyOffer(data.offer);
      setNotice(data.copied
        ? 'Nytt utkast er en kopi av tilbudet som ble sendt. Kundeteksten er beholdt. Pakkelisten følger gjeldende katalog. Ikke trykk Generer på nytt med mindre du vil skrive e-posten på nytt fra transkriptet.'
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
    const selectedReady = meetings.some((entry) => entry.selected && (entry.hasTranscript || entry.hasSummary));
    if (selectedReady || meeting?.hasTranscript || meeting?.hasSummary) {
      if (meeting?.tooThin && !selectedReady && !client?.hasProductNotes) {
        return 'Opptaket har under 10 linjer, og produktnotatene er for korte.';
      }
      return '';
    }
    if (!meeting && !meetings.length) return 'Venter på Fireflies-transkript, eller skriv produktnotater på forrige side.';
    if (meeting?.pendingTranscript || meetings.some((entry) => entry.selected && !entry.hasTranscript)) {
      return 'Fireflies-transkriptet er ikke hentet hit ennå. Åpne tilbudet på nytt, eller lim inn Fireflies-lenken under Bytt opptak.';
    }
    return 'Møtet mangler transkript og sammendrag.';
  }, [deepseek, meeting, meetings, client?.hasProductNotes]);

  const serverSelectedIds = useMemo(
    () => meetings.filter((entry) => entry.selected).map((entry) => entry.meetingId),
    [meetings]
  );
  const pickerIds = draftMeetingIds ?? serverSelectedIds;
  const pickerDirty = Boolean(
    draftMeetingIds
    && (draftMeetingIds.length !== serverSelectedIds.length
      || draftMeetingIds.some((id) => !serverSelectedIds.includes(id)))
  );
  const pickerMeetings = useMemo(
    () => meetings.map((entry) => ({ ...entry, selected: pickerIds.includes(entry.meetingId) })),
    [meetings, pickerIds]
  );

  function toggleDraftMeeting(meetingId: string) {
    setDraftMeetingIds((current) => {
      const base = current ?? serverSelectedIds;
      return base.includes(meetingId)
        ? base.filter((id) => id !== meetingId)
        : [...base, meetingId];
    });
  }

  const card = useMemo(() => clientCardParty(client || {}), [client]);
  const offerTo = (to || '').trim() || resolveWebsiteEmail(client || {});
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
    if (sendContent === 'full' && placeholders.length) return `${placeholders.length} felt fra malen er ikke fylt ut enda. Velg Kun kontrakt for å sende avtalen under møtet.`;
    return '';
  }, [offer, canSendEmail, readiness, offerTo, status, needsReview, placeholders.length, sendEmail, sendPortal, sendContent]);

  const showSendButton = status !== 'sent' && (!needsReview || status === 'verified');
  const contractSend = sendContent === 'contract';
  const sendButtonLabel = contractSend
    ? (sendEmail && sendPortal ? 'Send kontrakt begge' : sendPortal ? 'Legg kontrakt på Asoldi' : 'Send kontrakt')
    : (sendEmail && sendPortal ? 'Send begge' : sendPortal ? 'Legg på Asoldi' : 'Send e-post');
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
          <div className="max-w-[1400px] mx-auto px-3 sm:px-6 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-semibold">{title}</h1>
                {offer && <OfferStatusChip status={offer.status} />}
              </div>
              <p className="text-xs text-gray-400 truncate">
                {client?.businessName || 'Kunde'}{client?.contactPerson ? ` · ${client.contactPerson}` : ''} · hele tilbudet, eller kun kontrakt under møtet
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
          <div className="max-w-[1400px] mx-auto px-3 sm:px-6 py-0 sm:py-3">
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
        <main className={`${embedded ? 'px-3 sm:px-6 py-3 sm:py-6' : 'max-w-[1400px] mx-auto px-3 sm:px-6 py-4 sm:py-6'} flex flex-col gap-4`}>
          {error && <p className="text-red-300 text-sm">{error}</p>}
          {notice && <p className="text-emerald-200 text-sm">{notice}</p>}

          {loading ? (
            <div className="flex items-center gap-2 text-gray-400"><Loader2 className="animate-spin" size={18} /> Åpner tilbudet…</div>
          ) : offer ? (
            <>
              {(sender && !sender.phone) && (
                <div className="flex items-start gap-3 rounded-xl border border-amber-400/30 bg-amber-900/20 px-4 py-3 text-sm text-amber-200">
                  <AlertTriangle size={18} className="shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium">Telefonnummeret ditt mangler</div>
                    <div>E-posten signeres med navn, e-post og telefon fra brukeren din ({sender.fromEmail}). Be admin klikke Save under Admin → Users (eller «Your sender profile» hvis du sender som admin). Ellers vises kontornummeret.</div>
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
                    <div className="text-sky-300 text-xs mt-1">Innholdet er låst. Du kan sende det herfra.</div>
                  </div>
                </div>
              )}
              {status === 'sent' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-emerald-400/30 bg-emerald-900/20 px-4 py-3 text-sm text-emerald-200">
                    <span>
                      {offer.sentContent === 'contract' ? 'Kontrakt sendt' : 'Sendt'}
                      {' '}{offer.sentAt ? new Date(offer.sentAt).toLocaleString('nb-NO') : ''} til {offer.sentTo}
                      {offer.sentContent === 'contract' ? '. Uten møtetekst fra transkriptet.' : '.'}
                    </span>
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

                  <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
                    {(fillPhase === 'running' || busy === 'fill' || fillMessage) && (
                      <p className={`text-xs mr-auto ${fillPhase === 'error' ? 'text-amber-200' : fillPhase === 'done' ? 'text-emerald-300' : 'text-gray-400'}`}>
                        {fillPhase === 'running' || busy === 'fill' ? 'Fyller ut e-posten…' : fillMessage}
                      </p>
                    )}
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
                    {!locked && (
                      <button
                        type="button"
                        onClick={() => void handleFill(true)}
                        disabled={busy === 'fill' || Boolean(fillDisabledReason)}
                        title={fillDisabledReason || 'Skriv e-posten på nytt fra transkriptet og tilbudet'}
                        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/10 text-xs whitespace-nowrap hover:bg-white/15 disabled:opacity-50"
                      >
                        {busy === 'fill' ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        Generer på nytt
                      </button>
                    )}
                  </div>

                  <div className="rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-400">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>
                        {pickerMeetings.filter((entry) => entry.selected).length
                          ? `${pickerMeetings.filter((entry) => entry.selected).length} opptak valgt${pickerDirty ? ' (ikke lagret)' : ''}`
                          : meeting
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
                        <p className="text-[11px] text-gray-500">Huk av opptakene tilbudet skal bruke, og trykk Lagre. E-posten skrives ikke om før du trykker Generer på nytt.</p>
                        <div>
                          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Transkript fra denne kunden</div>
                          {pickerMeetings.some((entry) => entry.hasTranscript) ? (
                            <div className="flex flex-wrap gap-2">
                              {pickerMeetings.filter((entry) => entry.hasTranscript).map((entry) => (
                                <label
                                  key={entry.meetingId}
                                  className={`inline-flex items-center gap-2 px-2 py-1 rounded-md text-left cursor-pointer ${
                                    entry.selected
                                      ? 'bg-[#FF5B00]/20 text-white'
                                      : 'bg-white/10 text-white hover:bg-white/15'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={Boolean(entry.selected)}
                                    onChange={() => toggleDraftMeeting(entry.meetingId)}
                                  />
                                  <span>
                                    {meetingPurposeLabel(entry.purpose) ? `${meetingPurposeLabel(entry.purpose)} · ` : ''}
                                    {entry.title || 'Uten tittel'}{entry.when ? ` · ${entry.when}` : ''}
                                  </span>
                                </label>
                              ))}
                            </div>
                          ) : (
                            <p className="text-[11px] text-gray-500">Ingen transkript er knyttet til denne kunden ennå.</p>
                          )}
                        </div>
                        {pickerMeetings.some((entry) => !entry.hasTranscript) && (
                          <div className="flex flex-wrap gap-2">
                            {pickerMeetings.filter((entry) => !entry.hasTranscript).map((entry) => (
                              <label
                                key={entry.meetingId}
                                className={`inline-flex items-center gap-2 px-2 py-1 rounded-md text-left cursor-pointer ${
                                  entry.selected
                                    ? 'bg-[#FF5B00]/20 text-white'
                                    : 'bg-white/10 text-gray-300 hover:bg-white/15'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={Boolean(entry.selected)}
                                  onChange={() => toggleDraftMeeting(entry.meetingId)}
                                />
                                <span>
                                  {meetingPurposeLabel(entry.purpose) ? `${meetingPurposeLabel(entry.purpose)} · ` : ''}
                                  {entry.title || 'Uten tittel'}{entry.when ? ` · ${entry.when}` : ''} · venter på transkript
                                </span>
                              </label>
                            ))}
                          </div>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={busy === 'meeting-save' || !pickerDirty}
                            onClick={() => void handlePickMeeting({ meetingIds: pickerIds })}
                            className="px-2 py-1.5 rounded-md bg-[#FF5B00] text-white text-xs hover:bg-[#ff7a33] disabled:opacity-50"
                          >
                            {busy === 'meeting-save' ? 'Lagrer…' : 'Lagre opptak'}
                          </button>
                          {pickerDirty && <span className="text-[11px] text-amber-200">Endringene brukes ikke i tilbudet før du lagrer.</span>}
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Legg til Fireflies-lenke eller navn</div>
                          <div className="flex flex-wrap items-end gap-2">
                            <input
                              value={meetingQuery}
                              onChange={(event) => setMeetingQuery(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' && meetingQuery.trim().length >= 3 && busy !== 'meeting') {
                                  event.preventDefault();
                                  void handlePickMeeting({ title: meetingQuery.trim() });
                                }
                              }}
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
                        <div className="text-xs mt-1">Hele tilbudet venter på disse feltene (de fylles fra transkriptet). Velg Kun kontrakt under for å sende avtalen under møtet.</div>
                      </div>
                    </div>
                  )}

                  <div className="min-h-[360px] sm:min-h-[620px]">
                    {locked ? (
                      <HtmlPreview html={html} className="min-h-[360px] h-[70vh] sm:min-h-[620px] sm:h-[900px]" />
                    ) : (
                      <EmailVisualEditor html={html} htmlKey={htmlKey} mergeFields={mergeFields} onHtmlChange={onHtmlChange} />
                    )}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void openContract()}
                      disabled={busy === 'contract' || !offer.contractAvailable}
                      title={offer.contractAvailable ? 'Viser kontrakten her i salg' : isCustom ? 'Kontrakten for skreddersydd lages av admin ved verifisering' : 'Velg en tier først'}
                      className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-sm disabled:opacity-50"
                    >
                      {busy === 'contract' ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} Se kontrakt (PDF)
                    </button>

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
                      <div className="flex flex-col gap-2 rounded-lg border border-white/10 px-3 py-2">
                        <div className="flex flex-wrap items-center gap-3">
                          <span className="text-xs text-gray-400">Hva som sendes</span>
                          <label className="inline-flex items-center gap-1.5 text-sm">
                            <input type="radio" name="offer-send-content" checked={sendContent === 'full'} onChange={() => setSendContent('full')} />
                            Hele tilbudet
                          </label>
                          <label className="inline-flex items-center gap-1.5 text-sm" title="Sender avtalen nå, uten å vente på Fireflies-transkriptet">
                            <input type="radio" name="offer-send-content" checked={sendContent === 'contract'} onChange={() => setSendContent('contract')} />
                            Kun kontrakt
                          </label>
                        </div>
                        {contractSend && (
                          <p className="text-[11px] text-gray-400 max-w-xl">
                            Kan sendes under møtet. E-posten er en kort melding med kontrakten som PDF. Asoldi.com viser avtalen. Møteteksten fra transkriptet er ikke med.
                          </p>
                        )}
                        <div className="flex flex-wrap items-center gap-3">
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
                          Asoldi.com
                        </label>
                        {sendPortal && offerTo && (
                          <span className={`text-[11px] ${portalAccount?.found ? 'text-emerald-300' : 'text-amber-200'}`}>
                            {portalAccount?.found ? 'Kundekonto funnet' : 'Ingen kundekonto med denne e-posten enda'}
                          </span>
                        )}
                        </div>
                      </div>
                    )}
                    {showSendButton && (
                      <button
                        type="button"
                        onClick={() => void handleSend()}
                        disabled={busy === 'send' || Boolean(sendDisabledReason)}
                        title={sendDisabledReason || (contractSend
                          ? 'Send kontrakten nå, uten å vente på transkriptet'
                          : (sendEmail && sendPortal ? 'Send e-post og legg tilbudet på asoldi.com' : sendPortal ? 'Legg tilbudet på asoldi.com' : 'Send tilbudet på e-post'))}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#FF5B00] text-white text-sm whitespace-nowrap shrink-0 disabled:opacity-50"
                      >
                        {busy === 'send' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                        {sendButtonLabel}
                      </button>
                    )}
                    {sendDisabledReason && showSendButton && (
                      <span className="text-xs text-gray-500 self-center">{sendDisabledReason}</span>
                    )}
                  </div>
                </div>

                <aside className="flex flex-col gap-4">
                  <OfferProductsCard products={offer.products} alternatives={offer.alternatives} mvaIncluded={mvaIncluded} />
                  <ContractSummaryCard summary={offer.contract.summary} mvaIncluded={mvaIncluded} />
                  <div className="rounded-xl border border-white/10 bg-[#161616] p-4 text-xs text-gray-300 space-y-2">
                    <div className="font-medium text-white text-sm">Kontraktdata for dette tilbudet</div>
                    <p className="text-[11px] text-gray-500">Krysset nullstiller feltet til kundekortet. Til og startdato settes på de forrige stegene.</p>
                    <div className="rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                      <label className="text-[10px] uppercase tracking-wide text-gray-500">
                        Til
                        <input
                          type="email"
                          value={to}
                          onChange={(event) => {
                            setTo(event.target.value);
                            scheduleSave({ to: event.target.value });
                          }}
                          disabled={status === 'sent'}
                          className="mt-0.5 w-full bg-transparent text-sm text-white outline-none disabled:opacity-50"
                        />
                      </label>
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
          ) : null}
        </main>
      </div>
      {contractPdfUrl && (
        <Suspense fallback={null}>
          <PdfPreviewOverlay url={contractPdfUrl} title="Kontrakt" onClose={closeContractPreview} />
        </Suspense>
      )}
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
