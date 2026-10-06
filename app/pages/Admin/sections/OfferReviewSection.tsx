import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Download, FileText, Loader2, Plus, RefreshCw, RotateCcw, Save, ShieldCheck, Sparkles, Undo2 } from 'lucide-react';
import { EmailVisualEditor } from '../../sales/EmailVisualEditor';
import {
  getAdminOffer,
  listAdminOffers,
  listFirefliesMeetings,
  openAuthedPdf,
  reflectAdminOfferContract,
  refreshAdminOfferIntent,
  reopenAdminOffer,
  saveAdminOffer,
  saveAdminOfferContract,
  verifyAdminOffer,
  type MergeField,
  type OfferReadiness,
  type OfferTier,
} from '../../sales/emailApi';
import { ContractSummaryCard, OFFER_STATUS_LABEL, OfferProductsCard, OfferStatusChip } from '../../sales/offerUi';
import { API, salesAuthHeaders, type OfferContractSummary, type OfferProduct, type SalesOffer, type SalesOfferStatus } from '../shared';
import { ClientMeetingCard, MeetingCard, type StoredMeetingRow } from './MeetingDataPanel';
import { WebsiteDueField } from './WebsiteDueField';

type OfferRow = SalesOffer & {
  client: { id: string; businessName: string; contactPerson: string; contactEmail: string } | null;
  ownerName: string;
};

type OfferDetail = {
  offer: SalesOffer;
  client: {
    id: string;
    businessName: string;
    contactPerson: string;
    contactEmail: string;
    contactPhone: string;
    orgNumber: string;
    businessAddress: string;
    meetingPlace: string;
    industry: string;
    meetings: { meetingId: string; title: string; when: string }[];
    meetingQuote?: {
      tierId?: string;
      productNotes?: string;
      productGoal?: string;
      identity?: string;
      customSections?: string;
      selected?: string[];
    } | null;
  } | null;
  readiness: OfferReadiness;
  ownerName: string;
  tiers: OfferTier[];
  mergeFields: MergeField[];
  deepseek: boolean;
};

type ClientOption = { id: string; businessName: string };

type DetailTab = 'email' | 'contract' | 'meetings';

const FILTERS: { key: SalesOfferStatus | 'all'; label: string }[] = [
  { key: 'review-requested', label: 'Venter på deg' },
  { key: 'verified', label: 'Verifisert' },
  { key: 'draft', label: 'Utkast' },
  { key: 'sent', label: 'Sendt' },
  { key: 'all', label: 'Alle' },
];

const EMPTY_CUSTOM: Omit<OfferProduct, 'id'> = {
  kind: 'custom',
  tierId: '',
  name: '',
  pages: 0,
  includes: [],
  note: '',
  priceExMva: 0,
  deliveryWeeks: 0,
};

function linesToList(value: string) {
  return value.split('\n').map((line) => line.trim()).filter(Boolean);
}

function ClientIntentCard({
  intent,
  busy,
  onRefresh,
}: {
  intent: NonNullable<SalesOffer['clientIntent']> | null | undefined;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="rounded-xl border border-sky-400/30 bg-sky-900/30 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-sky-300">Hva kunden vil ha</div>
          <p className="mt-1 text-sm text-white font-medium">
            {intent?.headline || 'Sammendraget kommer når transkript, notater eller pakke er på plass.'}
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white/10 text-xs text-white disabled:opacity-50"
          title="Lag sammendraget på nytt fra transkript, notater og valgt pakke"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Oppdater
        </button>
      </div>
      {intent?.wants?.length ? (
        <ul className="list-disc pl-5 text-sm text-gray-200 space-y-1">
          {intent.wants.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
      <div className="grid sm:grid-cols-2 gap-3 text-xs text-gray-300">
        {intent?.plan ? (
          <div>
            <div className="uppercase tracking-wide text-gray-500 mb-1">Valgt pakke og tillegg</div>
            <p>{intent.plan}</p>
          </div>
        ) : null}
        {intent?.notes ? (
          <div>
            <div className="uppercase tracking-wide text-gray-500 mb-1">Produktnotater</div>
            <p className="whitespace-pre-wrap">{intent.notes}</p>
          </div>
        ) : null}
        {intent?.goal ? (
          <div>
            <div className="uppercase tracking-wide text-gray-500 mb-1">Mål</div>
            <p className="whitespace-pre-wrap">{intent.goal}</p>
          </div>
        ) : null}
        {intent?.identity || intent?.customSections ? (
          <div>
            <div className="uppercase tracking-wide text-gray-500 mb-1">Identitet / seksjoner</div>
            <p className="whitespace-pre-wrap">{[intent.identity, intent.customSections].filter(Boolean).join('\n')}</p>
          </div>
        ) : null}
      </div>
      {intent?.uncertainties?.length ? (
        <div className="rounded-lg border border-amber-400/30 bg-amber-900/20 px-3 py-2 text-xs text-amber-200">
          <div className="font-medium mb-1">Uklart i kildene</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {intent.uncertainties.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function OfferReviewSection({ hideHeader = false }: { hideHeader?: boolean }) {
  const [filter, setFilter] = useState<SalesOfferStatus | 'all'>('review-requested');
  const [rows, setRows] = useState<OfferRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [unmatchedCount, setUnmatchedCount] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<OfferDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<DetailTab>('email');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [clients, setClients] = useState<ClientOption[]>([]);
  const [unmatched, setUnmatched] = useState<StoredMeetingRow[]>([]);
  const [showUnmatched, setShowUnmatched] = useState(false);

  // Editable state for the selected offer
  const [subject, setSubject] = useState('');
  const [preheader, setPreheader] = useState('');
  const [html, setHtml] = useState('');
  const [htmlKey, setHtmlKey] = useState('');
  const [adminNote, setAdminNote] = useState('');
  const [dirty, setDirty] = useState(false);
  const [addTierId, setAddTierId] = useState('');
  const [customDraft, setCustomDraft] = useState<(Omit<OfferProduct, 'id'> & { id?: string; includesText: string }) | null>(null);
  const [contractDraft, setContractDraft] = useState<OfferContractSummary | null>(null);

  const offer = detail?.offer || null;

  const loadList = useCallback(async () => {
    setListLoading(true);
    try {
      const data = await listAdminOffers(filter === 'all' ? '' : filter) as { offers: OfferRow[]; counts: Record<string, number>; unmatchedMeetings: number };
      setRows(data.offers || []);
      setCounts(data.counts || {});
      setUnmatchedCount(Number(data.unmatchedMeetings) || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke hente tilbud');
    } finally {
      setListLoading(false);
    }
  }, [filter]);

  const applyDetail = useCallback((data: OfferDetail) => {
    setDetail(data);
    setSubject(data.offer.email.subject || '');
    setPreheader(data.offer.email.preheader || '');
    setHtml(data.offer.email.html || '');
    setHtmlKey(`${data.offer.id}-${data.offer.updatedAt}-${Date.now()}`);
    setAdminNote(data.offer.adminNote || '');
    setContractDraft(data.offer.contract.summary ? structuredClone(data.offer.contract.summary) : null);
    setDirty(false);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) return;
    setDetailLoading(true);
    setError('');
    try {
      const data = await getAdminOffer(id) as OfferDetail;
      applyDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke åpne tilbudet');
    } finally {
      setDetailLoading(false);
    }
  }, [applyDetail]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    fetch(`${API}/admin/sales`, { headers: salesAuthHeaders() })
      .then((response) => response.json())
      .then((data: { clients?: ClientOption[] }) => {
        setClients((data.clients || []).map((client) => ({ id: client.id, businessName: client.businessName })));
      })
      .catch(() => undefined);
  }, []);

  async function loadUnmatched() {
    try {
      const data = await listFirefliesMeetings({ unmatched: true }) as { meetings: StoredMeetingRow[] };
      setUnmatched(data.meetings || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke hente møter');
    }
  }

  useEffect(() => {
    if (showUnmatched) void loadUnmatched();
  }, [showUnmatched]);

  function patchOffer(next: SalesOffer, { resetHtml = false } = {}) {
    setDetail((current) => (current ? { ...current, offer: next } : current));
    setRows((current) => current.map((row) => (row.id === next.id ? { ...row, ...next, email: { ...next.email, html: '' } } : row)));
    if (resetHtml) {
      setHtml(next.email.html || '');
      setHtmlKey(`${next.id}-${next.updatedAt}-${Date.now()}`);
    }
    if (next.contract.summary) setContractDraft(structuredClone(next.contract.summary));
    setDirty(false);
  }

  async function runAction(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Noe gikk galt');
    } finally {
      setBusy('');
    }
  }

  async function saveEmail() {
    if (!offer) return;
    await runAction('save', async () => {
      const data = await saveAdminOffer(offer.id, { html, subject, preheader, adminNote }) as { offer: SalesOffer };
      patchOffer(data.offer);
      setNotice('Lagret.');
      void loadList();
    });
  }

  async function refreshIntent() {
    if (!offer) return;
    await runAction('intent', async () => {
      const data = await refreshAdminOfferIntent(offer.id) as { offer: SalesOffer };
      patchOffer(data.offer);
      setNotice('Sammendraget er oppdatert fra transkript, notater og valgt pakke.');
    });
  }

  async function saveProducts(products: OfferProduct[]) {
    if (!offer) return;
    await runAction('products', async () => {
      const data = await saveAdminOffer(offer.id, { html, subject, preheader, products }) as { offer: SalesOffer };
      patchOffer(data.offer, { resetHtml: true });
      setNotice('Produktene er oppdatert i e-posten.');
      void loadList();
    });
  }

  async function toggleMva(next: boolean) {
    if (!offer) return;
    await runAction('mva', async () => {
      const data = await saveAdminOffer(offer.id, { html, subject, preheader, mvaIncluded: next }) as { offer: SalesOffer };
      patchOffer(data.offer, { resetHtml: true });
      setNotice(next ? 'Mva er nå inkludert i oppgitt pris (e-post og kontrakt).' : 'Mva legges til på toppen av oppgitt pris.');
      void loadList();
    });
  }

  function addTier() {
    if (!offer || !addTierId) return;
    const tier = detail?.tiers.find((item) => item.id === addTierId);
    if (!tier) return;
    const tierProduct: OfferProduct = {
      id: `tier-${tier.id}`,
      kind: 'tier',
      tierId: tier.id,
      name: tier.offerName,
      pages: tier.pages,
      includes: tier.includes,
      note: '',
      priceExMva: tier.monthlyExMva,
      deliveryWeeks: tier.deliveryWeeks,
    };
    const without = offer.products.filter((item) => item.kind !== 'tier');
    void saveProducts([tierProduct, ...without]);
    setAddTierId('');
  }

  function removeProduct(id: string) {
    if (!offer) return;
    void saveProducts(offer.products.filter((item) => item.id !== id));
  }

  function startCustomProduct(existing?: OfferProduct) {
    setCustomDraft(existing
      ? { ...existing, includesText: existing.includes.join('\n') }
      : { ...EMPTY_CUSTOM, includesText: '' });
  }

  function saveCustomProduct() {
    if (!offer || !customDraft) return;
    const product: OfferProduct = {
      id: customDraft.id || `custom-${Date.now().toString(36)}`,
      kind: 'custom',
      tierId: '',
      name: customDraft.name.trim() || 'Skreddersydd produkt',
      pages: Number(customDraft.pages) || 0,
      includes: linesToList(customDraft.includesText),
      note: customDraft.note.trim(),
      priceExMva: Number(customDraft.priceExMva) || 0,
      deliveryWeeks: Number(customDraft.deliveryWeeks) || 0,
    };
    const next = customDraft.id
      ? offer.products.map((item) => (item.id === customDraft.id ? product : item))
      : [...offer.products, product];
    setCustomDraft(null);
    void saveProducts(next);
  }

  async function reflectContract() {
    if (!offer) return;
    await runAction('reflect', async () => {
      const data = await reflectAdminOfferContract(offer.id, { html, subject, preheader }) as { offer: SalesOffer };
      patchOffer(data.offer);
      setDetailTab('contract');
      setNotice('Kontrakten speiler nå e-posten. Les gjennom og juster før du verifiserer.');
    });
  }

  async function saveContract() {
    if (!offer || !contractDraft) return;
    await runAction('contract', async () => {
      const monthlyExMva = contractDraft.products.reduce((sum, item) => sum + (Number(item.priceExMva) || 0), 0);
      const data = await saveAdminOfferContract(offer.id, { ...contractDraft, monthlyExMva }) as { offer: SalesOffer };
      patchOffer(data.offer);
      setNotice('Kontraktsammendraget er lagret.');
    });
  }

  async function verify() {
    if (!offer) return;
    await runAction('verify', async () => {
      const data = await verifyAdminOffer(offer.id, { html, subject, preheader, adminNote }) as { offer: SalesOffer; notification?: { sent: boolean; to?: string } };
      patchOffer(data.offer);
      setNotice(data.notification?.sent ? `Verifisert. Selger (${data.notification.to}) har fått beskjed.` : 'Verifisert. Selger kan nå sende tilbudet.');
      void loadList();
    });
  }

  async function reopen(toDraft: boolean) {
    if (!offer) return;
    await runAction(toDraft ? 'return' : 'reopen', async () => {
      const data = await reopenAdminOffer(offer.id, { note: adminNote, toDraft }) as { offer: SalesOffer };
      patchOffer(data.offer);
      setNotice(toDraft ? 'Tilbudet er sendt tilbake til selger som utkast.' : 'Tilbudet er åpnet for redigering igjen.');
      void loadList();
    });
  }

  const sortedRows = useMemo(() => {
    const weight: Record<string, number> = { 'review-requested': 0, verified: 1, draft: 2, sent: 3 };
    return [...rows].sort((a, b) => (weight[a.status] ?? 9) - (weight[b.status] ?? 9) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }, [rows]);

  const locked = offer?.status === 'sent';
  const contractProducts = contractDraft?.products || [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {hideHeader ? <div /> : (
        <div>
          <h1 className="text-2xl font-semibold text-white">Tilbud</h1>
          <p className="text-sm text-gray-400">Gjennomgang av tilbud fra selgerne: rediger e-posten, legg til produkter, speil kontrakten og verifiser.</p>
        </div>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowUnmatched((value) => !value)}
            className={`px-3 py-1.5 rounded-lg text-xs ${unmatchedCount ? 'bg-amber-900/20 text-amber-200 border border-amber-400/30' : 'bg-white/10 text-gray-300'}`}
          >
            {unmatchedCount} ukoblede Fireflies-møter
          </button>
          <button type="button" onClick={() => void loadList()} className="p-2 rounded-lg bg-white/10 text-gray-300 hover:text-white" title="Oppdater">
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-300">{error}</p>}
      {notice && <p className="text-sm text-emerald-200">{notice}</p>}

      {showUnmatched && (
        <div className="rounded-xl border border-white/10 bg-[#1f1f1f] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-white font-medium">Ukoblede Fireflies-møter</h2>
            <button type="button" onClick={() => void loadUnmatched()} className="text-xs text-gray-400 hover:text-white">Oppdater</button>
          </div>
          {!unmatched.length ? (
            <p className="text-xs text-gray-500">Alle møter er koblet til en kunde.</p>
          ) : (
            unmatched.map((meeting) => (
              <MeetingCard
                key={meeting.meetingId}
                meeting={meeting}
                clients={clients}
                compact
                onChanged={() => {
                  void loadUnmatched();
                  void loadList();
                  if (selectedId) void loadDetail(selectedId);
                }}
              />
            ))
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key)}
            className={`px-3 py-1.5 rounded-lg text-xs ${filter === item.key ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-gray-300 hover:bg-white/15'}`}
          >
            {item.label}{item.key !== 'all' && counts[item.key] ? ` (${counts[item.key]})` : ''}
          </button>
        ))}
      </div>

      <div className="grid xl:grid-cols-[320px_minmax(0,1fr)] gap-4">
        <div className="space-y-2">
          {listLoading ? (
            <p className="text-sm text-gray-400 inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Henter…</p>
          ) : !sortedRows.length ? (
            <p className="text-sm text-gray-500">Ingen tilbud i denne kategorien.</p>
          ) : (
            sortedRows.map((row) => (
              <button
                key={row.id}
                type="button"
                onClick={() => {
                  setSelectedId(row.id);
                  setDetailTab('email');
                }}
                className={`w-full text-left rounded-xl border px-3 py-2.5 ${selectedId === row.id ? 'border-[#FF5B00]/60 bg-[#FF5B00]/10' : 'border-white/10 bg-[#1f1f1f] hover:bg-white/10'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-white font-medium truncate">{row.client?.businessName || 'Ukjent kunde'}</span>
                  <OfferStatusChip status={row.status} />
                </div>
                <div className="text-xs text-gray-400 truncate">
                  {row.ownerName ? `Selger: ${row.ownerName} · ` : ''}{row.tierId === 'custom' ? 'Skreddersydd' : row.tierId ? `Tier ${row.tierId.match(/\d+/)?.[0] || ''}`.trim() : 'Ingen tier'} · {row.products.length} produkt{row.products.length === 1 ? '' : 'er'}
                </div>
                <div className="text-[11px] text-gray-500">
                  {row.reviewRequestedAt && row.status === 'review-requested' ? `Bedt om gjennomgang ${new Date(row.reviewRequestedAt).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' })}` : `Oppdatert ${new Date(row.updatedAt).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' })}`}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="min-w-0">
          {!selectedId ? (
            <div className="rounded-xl border border-dashed border-white/15 p-8 text-center text-sm text-gray-500">
              Velg et tilbud i listen for å redigere e-post, kontrakt og se møtedata.
            </div>
          ) : detailLoading || !detail || !offer ? (
            <p className="text-sm text-gray-400 inline-flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Åpner tilbudet…</p>
          ) : (
            <div className="space-y-4">
              <ClientIntentCard
                intent={offer.clientIntent}
                busy={busy === 'intent'}
                onRefresh={() => void refreshIntent()}
              />
              <div className="rounded-xl border border-white/10 bg-[#1f1f1f] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg font-semibold text-white">{detail.client?.businessName || 'Ukjent kunde'}</h2>
                      <OfferStatusChip status={offer.status} />
                    </div>
                    <div className="text-xs text-gray-400">
                      {detail.client?.contactPerson || '—'} · {detail.client?.contactEmail || '—'} · Selger: {detail.ownerName || offer.ownerId || '—'}
                    </div>
                    <div className="text-xs text-gray-500">
                      Org. nr {detail.client?.orgNumber || '—'} · {detail.client?.businessAddress || detail.client?.meetingPlace || '—'}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void openAuthedPdf(`/admin/offers/${encodeURIComponent(offer.id)}/contract.pdf`)}
                      disabled={!offer.contractAvailable}
                      title={offer.contractAvailable ? 'Åpner kontrakten som PDF' : 'Speil e-posten i kontrakten eller legg til en tier først'}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-xs text-white disabled:opacity-50"
                    >
                      <FileText size={13} /> Kontrakt (PDF)
                    </button>
                    {!locked && offer.status !== 'verified' && (
                      <button
                        type="button"
                        onClick={() => void verify()}
                        disabled={busy === 'verify'}
                        title="Låser innholdet og gir selger beskjed om at tilbudet kan sendes"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium disabled:opacity-50"
                      >
                        {busy === 'verify' ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />} Verifiser og send til selger
                      </button>
                    )}
                    {!locked && offer.status === 'verified' && (
                      <button
                        type="button"
                        onClick={() => void reopen(false)}
                        disabled={busy === 'reopen'}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-xs text-white disabled:opacity-50"
                        title="Låser opp tilbudet så du kan redigere videre (selger kan ikke sende før du verifiserer igjen)"
                      >
                        {busy === 'reopen' ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />} Åpne for redigering
                      </button>
                    )}
                    {!locked && offer.status !== 'draft' && (
                      <button
                        type="button"
                        onClick={() => void reopen(true)}
                        disabled={busy === 'return'}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-xs text-white disabled:opacity-50"
                        title="Sender tilbudet tilbake til selger som utkast (bruk meldingsfeltet for å forklare hva som må endres)"
                      >
                        {busy === 'return' ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Tilbake til selger
                      </button>
                    )}
                  </div>
                </div>
                {!detail.readiness.ready && (
                  <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-900/20 px-3 py-2 text-xs text-amber-200">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <span>Kundekortet mangler: {detail.readiness.missing.map((item) => item.label).join(', ')}. Selger må fylle ut dette før sending.</span>
                  </div>
                )}
                {offer.status === 'verified' && (
                  <p className="mt-3 text-xs text-sky-300">Verifisert {offer.verifiedAt ? new Date(offer.verifiedAt).toLocaleString('nb-NO') : ''}. Endrer du innholdet nå går tilbudet tilbake til gjennomgang.</p>
                )}
                <label className="mt-3 block text-xs text-gray-400">
                  Melding til selger (vises i salgsterminalen og i varsel-e-posten)
                  <textarea
                    value={adminNote}
                    onChange={(event) => {
                      setAdminNote(event.target.value);
                      setDirty(true);
                    }}
                    rows={2}
                    disabled={locked}
                    className="mt-1 w-full rounded-lg bg-[#111] border border-white/15 text-white text-sm px-3 py-2 disabled:opacity-50"
                    placeholder="F.eks. «Pris justert på produkt 2, send som avtalt.»"
                  />
                </label>
              </div>

              <div className="flex gap-2 border-b border-white/10">
                {([
                  ['email', 'E-post'],
                  ['contract', 'Kontrakt'],
                  ['meetings', `Møtedata (${detail.client?.meetings?.length || 0})`],
                ] as [DetailTab, string][]).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setDetailTab(key)}
                    className={`px-3 py-2 text-sm border-b-2 -mb-px ${detailTab === key ? 'border-[#FF5B00] text-white' : 'border-transparent text-gray-400 hover:text-white'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {detailTab === 'email' && (
                <div className="grid 2xl:grid-cols-[minmax(0,1fr)_300px] gap-4">
                  <div className="space-y-3 min-w-0">
                    <div className="grid md:grid-cols-2 gap-3">
                      <label className="text-xs text-gray-400">
                        Emne
                        <input value={subject} onChange={(e) => { setSubject(e.target.value); setDirty(true); }} disabled={locked} className="mt-1 w-full px-3 py-2 rounded-lg bg-[#111] border border-white/15 text-white text-sm disabled:opacity-50" />
                      </label>
                      <label className="text-xs text-gray-400">
                        Preheader
                        <input value={preheader} onChange={(e) => { setPreheader(e.target.value); setDirty(true); }} disabled={locked} className="mt-1 w-full px-3 py-2 rounded-lg bg-[#111] border border-white/15 text-white text-sm disabled:opacity-50" />
                      </label>
                    </div>
                    <div className="h-[720px]">
                      <EmailVisualEditor
                        html={html}
                        htmlKey={htmlKey}
                        mergeFields={detail.mergeFields}
                        onHtmlChange={(next) => {
                          setHtml(next);
                          setDirty(true);
                        }}
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void saveEmail()}
                        disabled={locked || busy === 'save' || !dirty}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm disabled:opacity-50"
                      >
                        {busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Lagre e-post
                      </button>
                      <button
                        type="button"
                        onClick={() => void reflectContract()}
                        disabled={locked || busy === 'reflect' || !detail.deepseek || !offer.products.length}
                        title={!detail.deepseek ? 'DeepSeek er ikke konfigurert' : !offer.products.length ? 'Legg til minst ett produkt først' : 'DeepSeek oppsummerer e-posten til kontraktvilkår'}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/10 text-white text-sm disabled:opacity-50"
                      >
                        {busy === 'reflect' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Speil e-posten i kontrakten
                      </button>
                      {dirty && <span className="text-xs text-amber-300 self-center">Ulagrede endringer</span>}
                    </div>
                  </div>
                  <aside className="space-y-3">
                    <WebsiteDueField
                      salesClientId={String(offer.salesClientId || detail.client?.id || '')}
                      authHeaders={salesAuthHeaders()}
                    />
                    <OfferProductsCard
                      products={offer.products}
                      alternatives={offer.alternatives}
                      mvaIncluded={Boolean(offer.mvaIncluded)}
                      onRemove={locked ? undefined : removeProduct}
                      onEdit={locked ? undefined : (product) => (product.kind === 'custom' ? startCustomProduct(product) : undefined)}
                    />
                    <label
                      className={`flex items-center gap-2 rounded-xl border border-white/10 bg-[#161616] px-4 py-3 text-xs ${locked ? 'text-gray-500' : 'text-gray-200'}`}
                      title="Standard: mva legges til på toppen. Slått på: oppgitt pris er det kunden betaler inkl. mva (selger kan også velge dette)."
                    >
                      <input
                        type="checkbox"
                        checked={Boolean(offer.mvaIncluded)}
                        disabled={locked || busy === 'mva'}
                        onChange={(e) => void toggleMva(e.target.checked)}
                      />
                      Inkluder mva i prisen
                    </label>
                    {!locked && (
                      <div className="rounded-xl border border-white/10 bg-[#161616] p-4 space-y-3 text-sm">
                        <div className="font-medium text-white">Legg til produkt</div>
                        <div className="flex gap-2">
                          <select value={addTierId} onChange={(e) => setAddTierId(e.target.value)} className="flex-1 px-2 py-1.5 rounded-lg bg-[#111] border border-white/15 text-white text-xs">
                            <option value="">Nettside-tier…</option>
                            {detail.tiers.map((tier) => (
                              <option key={tier.id} value={tier.id}>{tier.name} · {tier.monthlyExMva} kr</option>
                            ))}
                          </select>
                          <button type="button" onClick={addTier} disabled={!addTierId || busy === 'products'} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-white/10 text-xs text-white disabled:opacity-50">
                            <Plus size={12} /> Tier
                          </button>
                        </div>
                        <p className="text-[11px] text-gray-500">En tier erstatter en eksisterende tier i tilbudet. Skreddersydde produkter legges til i tillegg (f.eks. Tier 3 + én spesialfunksjon).</p>
                        {customDraft ? (
                          <div className="space-y-2 rounded-lg bg-black/30 p-3">
                            <input value={customDraft.name} onChange={(e) => setCustomDraft({ ...customDraft, name: e.target.value })} placeholder="Produktnavn (f.eks. Bookingsystem)" className="w-full px-2 py-1.5 rounded bg-[#111] border border-white/15 text-white text-xs" />
                            <div className="grid grid-cols-3 gap-2">
                              <label className="text-[10px] text-gray-400">
                                Pris {offer.mvaIncluded ? 'inkl.' : 'eks.'} mva/mnd
                                <input type="number" value={customDraft.priceExMva || ''} onChange={(e) => setCustomDraft({ ...customDraft, priceExMva: Number(e.target.value) })} className="mt-0.5 w-full px-2 py-1 rounded bg-[#111] border border-white/15 text-white text-xs" />
                              </label>
                              <label className="text-[10px] text-gray-400">
                                Sider
                                <input type="number" value={customDraft.pages || ''} onChange={(e) => setCustomDraft({ ...customDraft, pages: Number(e.target.value) })} className="mt-0.5 w-full px-2 py-1 rounded bg-[#111] border border-white/15 text-white text-xs" />
                              </label>
                              <label className="text-[10px] text-gray-400">
                                Uker
                                <input type="number" value={customDraft.deliveryWeeks || ''} onChange={(e) => setCustomDraft({ ...customDraft, deliveryWeeks: Number(e.target.value) })} className="mt-0.5 w-full px-2 py-1 rounded bg-[#111] border border-white/15 text-white text-xs" />
                              </label>
                            </div>
                            <textarea value={customDraft.includesText} onChange={(e) => setCustomDraft({ ...customDraft, includesText: e.target.value })} rows={4} placeholder="Inkluderer – ett punkt per linje" className="w-full px-2 py-1.5 rounded bg-[#111] border border-white/15 text-white text-xs" />
                            <input value={customDraft.note} onChange={(e) => setCustomDraft({ ...customDraft, note: e.target.value })} placeholder="Notat i e-posten (valgfritt)" className="w-full px-2 py-1.5 rounded bg-[#111] border border-white/15 text-white text-xs" />
                            <div className="flex gap-2">
                              <button type="button" onClick={saveCustomProduct} disabled={busy === 'products'} className="px-2 py-1 rounded bg-[#FF5B00] text-white text-xs disabled:opacity-50">Lagre produkt</button>
                              <button type="button" onClick={() => setCustomDraft(null)} className="px-2 py-1 rounded bg-white/10 text-gray-200 text-xs">Avbryt</button>
                            </div>
                          </div>
                        ) : (
                          <button type="button" onClick={() => startCustomProduct()} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-white/10 text-xs text-white">
                            <Plus size={12} /> Skreddersydd produkt
                          </button>
                        )}
                      </div>
                    )}
                  </aside>
                </div>
              )}

              {detailTab === 'contract' && (
                <div className="grid 2xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void reflectContract()}
                        disabled={locked || busy === 'reflect' || !detail.deepseek || !offer.products.length}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/10 text-white text-sm disabled:opacity-50"
                      >
                        {busy === 'reflect' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Speil e-posten i kontrakten (DeepSeek)
                      </button>
                      {!contractDraft && offer.products.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setContractDraft({
                            title: 'Avtale om nettside og drift',
                            products: structuredClone(offer.products),
                            monthlyExMva: offer.products.reduce((sum, item) => sum + item.priceExMva, 0),
                            deliveryWeeks: Math.max(0, ...offer.products.map((item) => item.deliveryWeeks || 0)),
                            extraTerms: [],
                            scopeSummary: '',
                          })}
                          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/10 text-white text-sm"
                        >
                          <RotateCcw size={14} /> Start fra produktene
                        </button>
                      )}
                      <span className="text-xs text-gray-500">Standardkontrakter: {detail.tiers.map((tier) => (
                        <button key={tier.id} type="button" onClick={() => void openAuthedPdf(`/admin/offers/contract-template/${tier.id}.pdf`)} className="ml-1 inline-flex items-center gap-1 text-sky-300 hover:underline">
                          <Download size={11} /> {tier.shortName}
                        </button>
                      ))}</span>
                    </div>

                    {!contractDraft ? (
                      <ContractSummaryCard summary={null} />
                    ) : (
                      <div className="rounded-xl border border-white/10 bg-[#161616] p-4 space-y-3 text-sm">
                        <label className="block text-xs text-gray-400">
                          Tittel
                          <input value={contractDraft.title} onChange={(e) => setContractDraft({ ...contractDraft, title: e.target.value })} disabled={locked} className="mt-1 w-full px-3 py-2 rounded-lg bg-[#111] border border-white/15 text-white text-sm disabled:opacity-50" />
                        </label>
                        <label className="block text-xs text-gray-400">
                          Kort oppsummering av leveransen (1–3 setninger)
                          <textarea value={contractDraft.scopeSummary} onChange={(e) => setContractDraft({ ...contractDraft, scopeSummary: e.target.value })} rows={3} disabled={locked} className="mt-1 w-full px-3 py-2 rounded-lg bg-[#111] border border-white/15 text-white text-sm disabled:opacity-50" />
                        </label>
                        <div className="space-y-2">
                          <div className="text-xs text-gray-400">Leveranser</div>
                          {contractProducts.map((item, index) => (
                            <div key={item.id || index} className="rounded-lg bg-black/30 p-3 space-y-2">
                              <div className="grid grid-cols-[minmax(0,1fr)_110px_80px] gap-2">
                                <input value={item.name} disabled={locked} onChange={(e) => {
                                  const products = [...contractProducts];
                                  products[index] = { ...item, name: e.target.value };
                                  setContractDraft({ ...contractDraft, products });
                                }} className="px-2 py-1.5 rounded bg-[#111] border border-white/15 text-white text-xs" />
                                <input type="number" value={item.priceExMva || ''} disabled={locked} placeholder="kr eks. mva" onChange={(e) => {
                                  const products = [...contractProducts];
                                  products[index] = { ...item, priceExMva: Number(e.target.value) };
                                  setContractDraft({ ...contractDraft, products });
                                }} className="px-2 py-1.5 rounded bg-[#111] border border-white/15 text-white text-xs" />
                                <input type="number" value={item.pages || ''} disabled={locked} placeholder="sider" onChange={(e) => {
                                  const products = [...contractProducts];
                                  products[index] = { ...item, pages: Number(e.target.value) };
                                  setContractDraft({ ...contractDraft, products });
                                }} className="px-2 py-1.5 rounded bg-[#111] border border-white/15 text-white text-xs" />
                              </div>
                              <textarea value={item.includes.join('\n')} disabled={locked} rows={Math.min(8, Math.max(3, item.includes.length + 1))} onChange={(e) => {
                                const products = [...contractProducts];
                                products[index] = { ...item, includes: e.target.value.split('\n') };
                                setContractDraft({ ...contractDraft, products });
                              }} className="w-full px-2 py-1.5 rounded bg-[#111] border border-white/15 text-white text-xs" placeholder="Inkluderer – ett punkt per linje" />
                            </div>
                          ))}
                        </div>
                        <label className="block text-xs text-gray-400">
                          Tilleggsvilkår (ett per linje)
                          <textarea value={contractDraft.extraTerms.join('\n')} onChange={(e) => setContractDraft({ ...contractDraft, extraTerms: e.target.value.split('\n') })} rows={3} disabled={locked} className="mt-1 w-full px-3 py-2 rounded-lg bg-[#111] border border-white/15 text-white text-sm disabled:opacity-50" />
                        </label>
                        <label className="block text-xs text-gray-400 w-40">
                          Leveringstid (uker)
                          <input type="number" value={contractDraft.deliveryWeeks || ''} onChange={(e) => setContractDraft({ ...contractDraft, deliveryWeeks: Number(e.target.value) })} disabled={locked} className="mt-1 w-full px-3 py-2 rounded-lg bg-[#111] border border-white/15 text-white text-sm disabled:opacity-50" />
                        </label>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => void saveContract()}
                            disabled={locked || busy === 'contract'}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm disabled:opacity-50"
                          >
                            {busy === 'contract' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Lagre kontraktsammendrag
                          </button>
                          <button
                            type="button"
                            onClick={() => void openAuthedPdf(`/admin/offers/${encodeURIComponent(offer.id)}/contract.pdf`)}
                            disabled={!offer.contractAvailable}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/10 text-white text-sm disabled:opacity-50"
                          >
                            <FileText size={14} /> Se PDF
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <aside className="space-y-3">
                    <ContractSummaryCard summary={offer.contract.summary} mvaIncluded={Boolean(offer.mvaIncluded)} />
                    <p className="text-[11px] text-gray-500">
                      Kontrakten er et sammendrag (ingen prisnedbryting): produkter, «opp til N sider», inkluderte punkter, månedspris eks./inkl. mva og leveringstid. Kundedata hentes fra kundekortet.
                    </p>
                  </aside>
                </div>
              )}

              {detailTab === 'meetings' && (
                <div className="space-y-3">
                  {!detail.client?.meetings?.length ? (
                    <div className="rounded-xl border border-dashed border-white/15 p-6 text-sm text-gray-500">
                      Ingen Fireflies-møter er koblet til denne kunden. Åpne «ukoblede Fireflies-møter» øverst for å koble et møte manuelt.
                    </div>
                  ) : (
                    detail.client.meetings.map((ref) => (
                      <ClientMeetingCard
                        key={ref.meetingId}
                        meetingId={ref.meetingId}
                        clients={clients}
                        onChanged={() => void loadDetail(offer.id)}
                      />
                    ))
                  )}
                </div>
              )}

              {offer.history.length > 0 && (
                <details className="rounded-xl border border-white/10 bg-[#1f1f1f] p-4 text-xs text-gray-400">
                  <summary className="cursor-pointer text-gray-300">Historikk ({offer.history.length})</summary>
                  <div className="mt-2 space-y-1">
                    {[...offer.history].reverse().map((entry, index) => (
                      <div key={`${entry.at}-${index}`}>
                        {new Date(entry.at).toLocaleString('nb-NO', { dateStyle: 'short', timeStyle: 'short' })} · {entry.by || '—'} · {entry.action}{entry.note ? ` · ${entry.note}` : ''}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
      <p className="text-[11px] text-gray-600">Statuser: {Object.values(OFFER_STATUS_LABEL).join(' → ')}</p>
    </div>
  );
}
