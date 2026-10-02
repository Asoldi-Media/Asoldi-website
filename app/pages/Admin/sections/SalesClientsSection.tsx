import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArchiveX,
  Calendar,
  CalendarCheck2,
  CalendarClock,
  ChevronDown,
  Copy,
  ExternalLink,
  Filter,
  Gift,
  Loader2,
  LogOut,
  Mail,
  MapPin,
  MonitorSmartphone,
  Pencil,
  Phone,
  Plus,
  ShieldCheck,
  Search,
  StickyNote,
  Tag,
  Trash2,
  Undo2,
  UserRound,
  Users,
  Volume2,
  X,
} from 'lucide-react';
import { API, salesAuthHeaders, type SalesClient, type SalesGoalKey, type SalesProduct } from '../shared';
import { matchesClientSearchQuery, normalizeClientSearchText } from '../clientSearch';
import { MeetingNotesModal } from '../../sales/MeetingNotesModal';
import { SalesOfferComposer } from '../../sales/SalesOfferComposer';
import { SalesFlowSteps } from '../../sales/SalesFlowSteps';
import { SalesScriptsDock } from '../../sales/SalesScriptsDock';
import { offerMissingFields, offerReadinessMessage } from '../../../../lib/offer-readiness.js';
import { SalesGoalTimeline } from './SalesGoalTimeline';
import { WorkshopIterationLog } from './WorkshopIterationLog';
import {
  clientIsSalesWin,
  classifySalesPipelineState,
  countSalesPipelineStates,
  getActiveNextAction,
  getCalendarNextAction,
  clientMeetingAtIso,
  getClientNextActionMs,
  groupSalesClientsByNextAction,
  confirmationSendGaps,
  clientNeedsConfirmationSend,
  clientIsNewlyAssigned,
  SALES_PIPELINE_STATES,
  SECONDARY_INTEREST_STATES,
  normalizeSecondaryInterest,
  secondaryInterestLabel,
  clientMatchesMeetingModeFilter,
  clientNextActionInDateRange,
} from '../../../../lib/sales-next-actions.js';
import { salesBookingFacts } from '../../../../lib/sales-booking-facts.js';
import { calendarDurationForMode } from '../../../../lib/sales-meeting-duration.js';
import { GOOGLE_CALENDAR_OAUTH_EVENT } from '../../../../lib/google-calendar-oauth-ui.js';
import { expireFatCookies } from '../../../lib/expire-fat-cookies';
import {
  clientHasPublicPreviewSnapshot,
  getPublicClientPreviewUrl,
  useWebsiteMakerBaseUrl,
} from '../../sales/websiteMaker';
import type { MeetingQuoteState } from '../../sales/websitePricing';
import 'leaflet/dist/leaflet.css';

type WebsiteOffer = {
  id: string;
  code: string;
  salesClientId: string;
  planId: string;
  planName: string;
  price: string;
  note: string;
  businessName: string;
  previewUrl: string;
  targetUserId: string;
  targetEmail: string;
  claimed: boolean;
  claimedAt: string;
  createdAt: string;
};

type ClientUserResult = {
  userId: string;
  email: string;
  name: string;
  businessName: string;
};

const OFFER_TIERS = [
  { id: 'tier-1-standard', name: 'Tier 1: Standard', price: '999,-/mnd' },
  { id: 'tier-2-seo', name: 'Tier 2: SEO', price: '1 499,-/mnd' },
  { id: 'tier-3-ecommerce', name: 'Tier 3: Nettbutikk', price: '1 999,-/mnd' },
];
const SALES_MAP_DEFAULT_CENTER: [number, number] = [63.4305, 10.3951];
const SALES_MAP_DEFAULT_ZOOM = 5;
const SALES_COMPACT_PREVIEW = 6;
const SALES_CARD_SELECTED = 'sales-client-card-selected border-[#FF5B00] ring-2 ring-[#FF5B00]/25';
const SALES_LIST_CACHE_KEY = 'asoldi-sales-list-v1';
const SALES_BUCKETS_STORAGE_KEY = 'asoldi-sales-timeline-collapsed-v2';
const SECONDARY_INTEREST_PRIMARY = SECONDARY_INTEREST_STATES.filter((state) => state.group === 'primary');
const SECONDARY_INTEREST_MORE = SECONDARY_INTEREST_STATES.filter((state) => state.group === 'secondary');
const DEFAULT_SALES_BUCKETS_COLLAPSED: Record<string, boolean> = {
  awaitingRep: true,
  recentPastDue: true,
  upcoming: true,
  pastDue: true,
  noNextAction: true,
  archived: true,
  wins: true,
};

type SalesHeaderPanel = 'filter' | 'map' | null;

type SalesListCache = {
  clients: SalesClient[];
  products: { asoldi: number; ssu: number };
};

function readSalesListCache(): SalesListCache | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SALES_LIST_CACHE_KEY) || '');
    if (!Array.isArray(parsed?.clients) || !parsed.clients.length) return null;
    return {
      clients: parsed.clients as SalesClient[],
      products: {
        asoldi: Number(parsed.products?.asoldi) || 0,
        ssu: Number(parsed.products?.ssu) || 0,
      },
    };
  } catch {
    return null;
  }
}

function writeSalesListCache(clients: SalesClient[], products: { asoldi: number; ssu: number }) {
  try {
    sessionStorage.setItem(SALES_LIST_CACHE_KEY, JSON.stringify({ clients, products, at: Date.now() }));
  } catch {
    // Ignore quota / private-mode failures.
  }
}

function salesIsMobileViewport() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
}

type CalendarStatus = {
  configured: boolean;
  connected: boolean;
  calendarId: string;
  redirectUri: string;
  tokenUpdatedAt: string;
  accountKey?: string;
  googleEmail?: string;
  googleName?: string;
  loginRole?: string;
  loginUsername?: string;
  loginAccountKey?: string;
};

function calendarChipLabel(status: CalendarStatus | null) {
  if (!status?.connected) return 'Kalender';
  const email = String(status.googleEmail || '').trim();
  if (!email) return 'Kalender';
  return email.split('@')[0] || 'Kalender';
}

type CalendarConnectSnapshot = {
  connected: boolean;
  tokenUpdatedAt: string;
  googleEmail: string;
};

type GoogleCalendarOAuthMessage = {
  type: string;
  connected?: boolean;
  googleEmail?: string;
  googleName?: string;
  tokenUpdatedAt?: string;
  error?: string;
};

const GOOGLE_CALENDAR_CONNECT_POLL_MS = 1200;
const GOOGLE_CALENDAR_CONNECT_MAX_MS = 120_000;

function isGoogleCalendarOAuthMessage(data: unknown): data is GoogleCalendarOAuthMessage {
  return Boolean(data && typeof data === 'object' && (data as { type?: string }).type === GOOGLE_CALENDAR_OAUTH_EVENT);
}

function calendarStatusLooksUpdated(snapshot: CalendarConnectSnapshot, next: CalendarStatus | null | undefined) {
  if (!next?.connected) return false;
  if (!snapshot.connected) return true;
  return String(next.tokenUpdatedAt || '') !== snapshot.tokenUpdatedAt
    || String(next.googleEmail || '') !== snapshot.googleEmail;
}

type SalesOwnerOption = {
  accountKey: string;
  username: string;
  name: string;
};

type MeetingMapPin = {
  clientId: string;
  businessName: string;
  contactPerson: string;
  meetingPlace: string;
  locationSource?: 'address' | 'businessName';
  meetingAt: string;
  meetingMode?: 'online' | 'in-person';
  status?: 'active' | 'not-sold' | 'secondary';
  latitude: number;
  longitude: number;
};

type Props = {
  onMovedToDevelopment?: () => void;
  onLogout?: () => void;
  showScriptsDock?: boolean;
  /** When false the section is hidden but kept mounted. Retry a failed load when it becomes true. */
  active?: boolean;
};

type SalesFormState = {
  product: SalesProduct;
  businessName: string;
  contactPerson: string;
  contactEmail: string;
  websiteEmail: string;
  contactPhone: string;
  meetingPlace: string;
  orgNumber: string;
  businessAddress: string;
  industry: string;
  meetingMode: 'online' | 'in-person';
  websiteDomain: string;
  notes: string;
  instagramUrl: string;
  facebookUrl: string;
  proffUrl: string;
  otherLinks: string;
  googleBusinessProfile: string;
};

const INITIAL_FORM: SalesFormState = {
  product: 'asoldi',
  businessName: '',
  contactPerson: '',
  contactEmail: '',
  websiteEmail: '',
  contactPhone: '',
  meetingPlace: '',
  orgNumber: '',
  businessAddress: '',
  industry: '',
  meetingMode: 'online',
  websiteDomain: '',
  notes: '',
  instagramUrl: '',
  facebookUrl: '',
  proffUrl: '',
  otherLinks: '',
  googleBusinessProfile: '',
};

function clientCardSnapshot(form: SalesFormState, websiteEmailTouched: boolean) {
  return JSON.stringify({
    product: form.product,
    businessName: form.businessName.trim(),
    contactPerson: form.contactPerson.trim(),
    contactEmail: form.contactEmail.trim(),
    websiteEmail: websiteEmailTouched ? form.websiteEmail.trim() : '',
    contactPhone: form.contactPhone.trim(),
    meetingPlace: form.meetingPlace.trim(),
    orgNumber: form.orgNumber.trim(),
    businessAddress: form.businessAddress.trim(),
    industry: form.industry.trim(),
    meetingMode: form.meetingMode,
    websiteDomain: form.product === 'ssu' ? '' : form.websiteDomain.trim(),
    notes: form.notes.trim(),
    instagramUrl: form.instagramUrl.trim(),
    facebookUrl: form.facebookUrl.trim(),
    proffUrl: form.proffUrl.trim(),
    otherLinks: form.otherLinks.trim(),
    googleBusinessProfile: form.googleBusinessProfile.trim(),
  });
}

function normalizeSalesProduct(value: unknown): SalesProduct {
  return String(value || '').trim().toLowerCase() === 'ssu' ? 'ssu' : 'asoldi';
}

function isSsuClient(client: Pick<SalesClient, 'product'> | null | undefined) {
  return normalizeSalesProduct(client?.product) === 'ssu';
}

function parseDetails(details: Record<string, unknown> | undefined) {
  const safe = details && typeof details === 'object' ? details : {};
  return {
    instagramUrl: String(safe.instagramUrl || ''),
    facebookUrl: String(safe.facebookUrl || ''),
    proffUrl: String(safe.proffUrl || ''),
    otherLinks: String(safe.otherLinks || ''),
    googleBusinessProfile: String(safe.googleBusinessProfile || ''),
  };
}

// proff.no company URLs carry the 9-digit org number as a path segment
// (`/selskap/<slug>/<sted>/<bransje>/<orgnr>` or `/organisasjon/<orgnr>`), so the
// Kontraktdata block can be pre-filled straight from the link the rep already pasted.
function extractOrgNumberFromProffUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return '';
  }
  if (!parsed.host.toLowerCase().includes('proff.no')) return '';
  const segments = parsed.pathname
    .split('/')
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (/^\d{9}$/.test(segments[i])) return segments[i];
  }
  const queryOrg = String(parsed.searchParams.get('orgnr') || parsed.searchParams.get('organisasjonsnummer') || '').replace(/\D+/g, '');
  return queryOrg.length === 9 ? queryOrg : '';
}

function salesMeetLink(client: { meetingMode?: string; calendar?: { meetLink?: string } | null }) {
  if (client?.meetingMode !== 'online') return '';
  const link = String(client?.calendar?.meetLink || '').trim();
  if (!/^https:\/\/meet\.google\.com\/[a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3}/i.test(link)
    && !/^https:\/\/meet\.google\.com\/[a-z0-9-]{10,}/i.test(link)) return '';
  return link;
}

function durationForMode(mode: 'online' | 'in-person') {
  return calendarDurationForMode(mode);
}

function formatMeetingHeadline(value = '') {
  if (!value) return 'Ingen møtetid satt';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' });
}

function formatWhen(value = '') {
  if (!value) return 'Not agreed yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nb-NO');
}

function formatBookingWhen(value = '') {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('nb-NO', {
    timeZone: 'Europe/Oslo',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatDateTime(value = '') {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('nb-NO');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isTestLikeEmail(value = '') {
  const email = normalizeEmail(value);
  if (!email) return false;
  if (/(?:^|@)(?:example\.com|example\.org|example\.net|test\.com|mailinator\.com)$/i.test(email)) return true;
  const [localPart = ''] = email.split('@');
  return /(?:^|[-_.])(test|demo|sample|fake|qa|no-?reply|noreply)(?:[-_.]|\d|$)/i.test(localPart);
}

function buildRecordingProxyUrl(clientId = '') {
  const id = String(clientId || '').trim();
  if (!id) return '';
  return `${API}/admin/sales/${encodeURIComponent(id)}/recording`;
}

function pinStyleFor(pin: MeetingMapPin) {
  if (pin.status === 'not-sold') {
    return { color: '#9ca3af', fillColor: '#6b7280' };
  }
  if (pin.status === 'secondary') {
    return { color: '#c084fc', fillColor: '#a855f7' };
  }
  if (pin.meetingMode === 'online') {
    return { color: '#60a5fa', fillColor: '#3b82f6' };
  }
  return { color: '#ff7a2f', fillColor: '#FF5B00' };
}

function offsetOverlappingPin(lat: number, lng: number, indexAtCell: number): [number, number] {
  if (indexAtCell <= 0) return [lat, lng];
  const angle = indexAtCell * 2.399;
  const radius = 0.00018 * Math.ceil(indexAtCell / 6);
  return [lat + Math.cos(angle) * radius, lng + Math.sin(angle) * radius];
}

function escapeHtml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function salesStepBlockedReason(client: SalesClient, key: SalesGoalKey, fastTrack = false) {
  if (key === 'offerSent' && !client.progression?.meetingHeld) return 'Marker møtet hatt først';
  if (key === 'contractSigned') {
    if (fastTrack) return '';
    if (!client.progression?.meetingHeld) return 'Marker møtet hatt først';
    if (!client.progression?.offerSent) return 'Marker sendt tilbud først';
  }
  if (key === 'paymentReceived' && !client.progression?.contractSigned) return 'Marker kontrakt signert først';
  return '';
}

function isValidClientEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

export function SalesClientsSection({ onMovedToDevelopment, onLogout, showScriptsDock = false, active = true }: Props) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const flowClientId = searchParams.get('flow') || '';
  const flowStepNumber = Number(searchParams.get('step') || '1');
  const flowStep: 1 | 2 | 3 = flowStepNumber === 2 || flowStepNumber === 3 ? flowStepNumber : 1;
  const cachedList = readSalesListCache();
  const [clients, setClients] = useState<SalesClient[]>(() => cachedList?.clients || []);
  const [productCounts, setProductCounts] = useState<{ asoldi: number; ssu: number }>(() => (
    cachedList?.products || { asoldi: 0, ssu: 0 }
  ));
  const [productBracket, setProductBracket] = useState<SalesProduct>('asoldi');
  const [calendarStatus, setCalendarStatus] = useState<CalendarStatus | null>(null);
  const [calendarConnecting, setCalendarConnecting] = useState(false);
  const [isSalesAdmin, setIsSalesAdmin] = useState(false);
  const [salesOwners, setSalesOwners] = useState<SalesOwnerOption[]>([]);
  const [assigningOwnerId, setAssigningOwnerId] = useState<string | null>(null);
  const [selectedClientIds, setSelectedClientIds] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkAssignOwnerId, setBulkAssignOwnerId] = useState('');
  const [sendingMailKey, setSendingMailKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(() => !cachedList);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [clientSearchInput, setClientSearchInput] = useState('');
  const [clientSearchQuery, setClientSearchQuery] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [pipelineFilter, setPipelineFilter] = useState('');
  const [meetingModeFilter, setMeetingModeFilter] = useState('');
  const [nextActionFromDate, setNextActionFromDate] = useState('');
  const [nextActionToDate, setNextActionToDate] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<SalesFormState>(INITIAL_FORM);
  const [websiteEmailTouched, setWebsiteEmailTouched] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showMailActionsId, setShowMailActionsId] = useState<string | null>(null);
  const [deletingArchivedId, setDeletingArchivedId] = useState<string | null>(null);
  const [progressBusyKey, setProgressBusyKey] = useState<string | null>(null);
  const [nextActionBusyId, setNextActionBusyId] = useState<string | null>(null);
  const [collapsedBuckets, setCollapsedBuckets] = useState<Record<string, boolean>>(() => {
    try {
      const raw = window.localStorage.getItem(SALES_BUCKETS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) as Record<string, boolean> : {};
      return { ...DEFAULT_SALES_BUCKETS_COLLAPSED, ...parsed };
    } catch {
      return { ...DEFAULT_SALES_BUCKETS_COLLAPSED };
    }
  });
  const [headerPanel, setHeaderPanel] = useState<SalesHeaderPanel>(null);
  const [productMenuOpen, setProductMenuOpen] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [peekCardIds, setPeekCardIds] = useState<Record<string, boolean>>({});
  const [mapMounted, setMapMounted] = useState(false);
  const [calendarPanelOpen, setCalendarPanelOpen] = useState(false);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);
  const [secondaryPicker, setSecondaryPicker] = useState<{
    clientIds: string[];
    selected: string;
    label: string;
  } | null>(null);
  const { websiteMakerBaseUrl } = useWebsiteMakerBaseUrl();
  const [meetingNowMs, setMeetingNowMs] = useState(() => Date.now());
  const [meetingMapPins, setMeetingMapPins] = useState<MeetingMapPin[]>([]);
  const [meetingMapLoading, setMeetingMapLoading] = useState(false);
  const [meetingMapError, setMeetingMapError] = useState('');
  const [meetingMapUnresolvedCount, setMeetingMapUnresolvedCount] = useState(0);
  const [meetingMapPendingCount, setMeetingMapPendingCount] = useState(0);
  const [meetingMapMissingAddressCount, setMeetingMapMissingAddressCount] = useState(0);
  const [recordingBlobUrlByClient, setRecordingBlobUrlByClient] = useState<Record<string, string>>({});
  const [recordingOpenClientId, setRecordingOpenClientId] = useState<string | null>(null);
  const [recordingLoadingClientId, setRecordingLoadingClientId] = useState<string | null>(null);
  const [recordingErrorByClient, setRecordingErrorByClient] = useState<Record<string, string>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [savingNoteId, setSavingNoteId] = useState<string | null>(null);
  const notesFlushRef = useRef<null | (() => Promise<void>)>(null);
  const clientCardBaselineRef = useRef('');
  const salesListGenRef = useRef(0);
  const salesListLoadedRef = useRef(false);
  const clientsLenRef = useRef(0);
  const errorRef = useRef('');
  const [discardPrompt, setDiscardPrompt] = useState(false);
  const [verifiedInboxOpen, setVerifiedInboxOpen] = useState(false);
  const [previewMissingToastId, setPreviewMissingToastId] = useState<string | null>(null);
  const meetingMapContainerRef = useRef<HTMLDivElement | null>(null);
  const meetingMapRef = useRef<any>(null);
  const meetingMapMarkerLayerRef = useRef<any>(null);
  const recordingBlobUrlsRef = useRef<Record<string, string>>({});
  const previewMissingTimerRef = useRef<number | null>(null);
  const calendarConnectStopRef = useRef<null | (() => void)>(null);
  const headerShellRef = useRef<HTMLDivElement | null>(null);

  // Website offers (tier + nettsidekode given to a client).
  const [offers, setOffers] = useState<WebsiteOffer[]>([]);
  const [offerOpenId, setOfferOpenId] = useState<string | null>(null);
  const [offerPlanId, setOfferPlanId] = useState('tier-1-standard');
  const [offerNote, setOfferNote] = useState('');
  const [offerSearch, setOfferSearch] = useState('');
  const [offerResults, setOfferResults] = useState<ClientUserResult[]>([]);
  const [offerSelectedUser, setOfferSelectedUser] = useState<ClientUserResult | null>(null);
  const [offerSearching, setOfferSearching] = useState(false);
  const [creatingOffer, setCreatingOffer] = useState(false);
  const [lastCreatedCode, setLastCreatedCode] = useState<string | null>(null);

  const flowClient = clients.find((entry) => entry.id === flowClientId) || null;
  const inClientFlow = Boolean(flowClient && normalizeSalesProduct(flowClient.product) !== 'ssu');
  const clientCardDirty = editingId === flowClientId
    && clientCardSnapshot(form, websiteEmailTouched) !== clientCardBaselineRef.current;
  const contractMissing = inClientFlow
    ? offerMissingFields({
      businessName: form.businessName,
      orgNumber: form.orgNumber,
      meetingPlace: form.meetingPlace,
      businessAddress: form.meetingPlace || form.businessAddress,
      contactPerson: form.contactPerson,
      contactEmail: form.contactEmail,
    })
    : [];
  const normalizedClientSearchQuery = useMemo(
    () => normalizeClientSearchText(clientSearchQuery),
    [clientSearchQuery]
  );
  const productClients = useMemo(
    () => clients.filter((client) => normalizeSalesProduct(client.product) === productBracket),
    [clients, productBracket]
  );
  const isSsuBracket = productBracket === 'ssu';
  const mapOpen = headerPanel === 'map';
  const canSignOut = Boolean(onLogout) && typeof window !== 'undefined' && window.location.pathname.startsWith('/sales');
  const clientMatchesNameSearch = (client: SalesClient) => {
    if (!normalizedClientSearchQuery) return true;
    const haystack = [
      client.businessName,
      client.contactPerson,
      client.contactEmail,
      client.websiteEmail,
      client.contactPhone,
      client.meetingPlace,
      client.industry,
      client.notes,
    ]
      .map((entry) => normalizeClientSearchText(entry))
      .filter(Boolean)
      .join(' ');
    return matchesClientSearchQuery(haystack, normalizedClientSearchQuery);
  };
  const ownerFilterOptions = useMemo(() => {
    const byKey = new Map<string, SalesOwnerOption>();
    for (const owner of salesOwners) {
      if (owner.accountKey) byKey.set(owner.accountKey, owner);
    }
    for (const client of productClients) {
      const key = String(client.ownerId || '').trim();
      if (!key || byKey.has(key)) continue;
      byKey.set(key, { accountKey: key, username: key, name: key });
    }
    return [...byKey.values()].sort((a, b) =>
      (a.name || a.username || a.accountKey).localeCompare(b.name || b.username || b.accountKey, 'nb-NO', { sensitivity: 'base' })
    );
  }, [salesOwners, productClients]);
  const clientMatchesFilters = (client: SalesClient) => {
    if (!clientMatchesNameSearch(client)) return false;
    if (isSalesAdmin) {
      if (ownerFilter === 'unassigned' && String(client.ownerId || '').trim()) return false;
      if (ownerFilter && ownerFilter !== 'unassigned' && String(client.ownerId || '') !== ownerFilter) return false;
    }
    if (pipelineFilter && classifySalesPipelineState(client, meetingNowMs) !== pipelineFilter) return false;
    if (!clientMatchesMeetingModeFilter(client, meetingModeFilter)) return false;
    if (!clientNextActionInDateRange(client, nextActionFromDate, nextActionToDate)) return false;
    return true;
  };
  const hasActiveFilters = Boolean(
    normalizedClientSearchQuery
    || (isSalesAdmin && ownerFilter)
    || pipelineFilter
    || meetingModeFilter
    || nextActionFromDate
    || nextActionToDate
  );
  const timelineClients = useMemo(
    () => productClients.filter((client) => (
      client.status !== 'not-sold'
      && !clientIsSalesWin(client)
      && clientMatchesFilters(client)
    )),
    [productClients, normalizedClientSearchQuery, ownerFilter, pipelineFilter, meetingModeFilter, nextActionFromDate, nextActionToDate, meetingNowMs, isSalesAdmin]
  );
  const salesRepOptions = useMemo(
    () => salesOwners.filter((owner) => String(owner.accountKey || '').startsWith('sales:')),
    [salesOwners]
  );
  const awaitingRepClients = useMemo(
    () => (isSalesAdmin ? timelineClients.filter((client) => !String(client.ownerId || '').startsWith('sales:')) : []),
    [timelineClients, isSalesAdmin]
  );
  const assignedTimelineClients = useMemo(
    () => timelineClients.filter((client) => !isSalesAdmin || String(client.ownerId || '').startsWith('sales:')),
    [timelineClients, isSalesAdmin]
  );
  const verifiedInbox = useMemo(
    () => productClients.filter((client) => client.offerStatus === 'verified' && client.status !== 'not-sold'),
    [productClients]
  );
  const emailAudit = useMemo(() => {
    const rows = productClients.map((client) => {
      const email = normalizeEmail(client.contactEmail);
      const hasEmail = Boolean(email);
      const valid = hasEmail && EMAIL_RE.test(email);
      const testLike = valid && isTestLikeEmail(email);
      return { hasEmail, valid, testLike };
    });
    return {
      total: rows.length,
      withAnyEmail: rows.filter((entry) => entry.hasEmail).length,
      valid: rows.filter((entry) => entry.valid).length,
      validNonTest: rows.filter((entry) => entry.valid && !entry.testLike).length,
      missing: rows.filter((entry) => !entry.hasEmail).length,
      invalid: rows.filter((entry) => entry.hasEmail && !entry.valid).length,
      flaggedTest: rows.filter((entry) => entry.testLike).length,
    };
  }, [productClients]);
  const archivedClients = useMemo(
    () => productClients.filter((client) => client.status === 'not-sold' && clientMatchesFilters(client)),
    [productClients, normalizedClientSearchQuery, ownerFilter, pipelineFilter, meetingModeFilter, nextActionFromDate, nextActionToDate, meetingNowMs, isSalesAdmin]
  );
  const winClients = useMemo(
    () => productClients
      .filter((client) => clientIsSalesWin(client) && client.status !== 'not-sold' && clientMatchesFilters(client))
      .sort((a, b) => {
        const aMs = getClientNextActionMs(a);
        const bMs = getClientNextActionMs(b);
        if (aMs == null && bMs == null) {
          return String(a.businessName || '').localeCompare(String(b.businessName || ''), 'nb-NO', { sensitivity: 'base' });
        }
        if (aMs == null) return 1;
        if (bMs == null) return -1;
        return aMs - bMs;
      }),
    [productClients, normalizedClientSearchQuery, ownerFilter, pipelineFilter, meetingModeFilter, nextActionFromDate, nextActionToDate, meetingNowMs, isSalesAdmin]
  );
  const pipelineScopeClients = useMemo(
    () => productClients.filter((client) => {
      if (client.status === 'not-sold') return false;
      if (!clientMatchesNameSearch(client)) return false;
      if (isSalesAdmin) {
        if (ownerFilter === 'unassigned' && String(client.ownerId || '').trim()) return false;
        if (ownerFilter && ownerFilter !== 'unassigned' && String(client.ownerId || '') !== ownerFilter) return false;
      }
      if (!clientMatchesMeetingModeFilter(client, meetingModeFilter)) return false;
      if (!clientNextActionInDateRange(client, nextActionFromDate, nextActionToDate)) return false;
      return true;
    }),
    [productClients, normalizedClientSearchQuery, ownerFilter, meetingModeFilter, nextActionFromDate, nextActionToDate, isSalesAdmin]
  );
  const pipelineCounts = useMemo(
    () => countSalesPipelineStates(pipelineScopeClients, meetingNowMs),
    [pipelineScopeClients, meetingNowMs]
  );
  const activeMeetingGroups = useMemo(
    () => groupSalesClientsByNextAction(assignedTimelineClients, meetingNowMs),
    [assignedTimelineClients, meetingNowMs]
  );
  const orderedTimelineClients = useMemo(
    () => [
      ...awaitingRepClients,
      ...(activeMeetingGroups.recentPastDue || []),
      ...activeMeetingGroups.upcoming,
      ...activeMeetingGroups.pastDue,
      ...activeMeetingGroups.noNextAction,
    ],
    [awaitingRepClients, activeMeetingGroups]
  );
  const timelineRows = useMemo(() => {
    const rows: Array<
      | { kind: 'header'; id: string; title: string; hint: string; count: number; tone: 'assign' | 'recent' | 'upcoming' | 'past' | 'none'; collapsed: boolean }
      | { kind: 'divider'; id: string }
      | { kind: 'client'; client: SalesClient; compact: boolean }
      | { kind: 'more'; id: string; bucketId: string; count: number; collapsed: boolean }
    > = [];
    const pushSection = (
      id: string,
      title: string,
      hint: string,
      clients: SalesClient[],
      tone: 'assign' | 'recent' | 'upcoming' | 'past' | 'none'
    ) => {
      if (!clients.length) return;
      const collapsed = collapsedBuckets[id] !== false;
      if (rows.length) rows.push({ kind: 'divider', id: `after-${rows.length}` });
      rows.push({ kind: 'header', id, title, hint, count: clients.length, tone, collapsed });
      const visible = collapsed ? clients.slice(0, SALES_COMPACT_PREVIEW) : clients;
      for (const client of visible) rows.push({ kind: 'client', client, compact: true });
      if (clients.length > SALES_COMPACT_PREVIEW) {
        rows.push({ kind: 'more', id: `more-${id}`, bucketId: id, count: clients.length, collapsed });
      }
    };
    if (isSalesAdmin) {
      pushSection(
        'awaitingRep',
        'Tildel selger',
        'Bekreftelse sendes først når en selger er valgt, og da fra selgerens e-post.',
        awaitingRepClients,
        'assign'
      );
    }
    pushSection(
      'recentPastDue',
      'Forfalt (siste 48 timer)',
      'Nylig forfalt — vises over listen så du ikke mister dem.',
      activeMeetingGroups.recentPastDue || [],
      'recent'
    );
    pushSection(
      'upcoming',
      'Neste handling',
      'Kommende handlinger, nærmeste først.',
      activeMeetingGroups.upcoming,
      'upcoming'
    );
    pushSection(
      'pastDue',
      'Forfalt',
      'Mer enn 48 timer etter avtalt handling.',
      activeMeetingGroups.pastDue,
      'past'
    );
    pushSection(
      'noNextAction',
      'No agreed meeting date',
      'Ingen neste handling eller avtalt møtetid.',
      activeMeetingGroups.noNextAction,
      'none'
    );
    return rows;
  }, [activeMeetingGroups, awaitingRepClients, collapsedBuckets, isSalesAdmin]);
  const visibleSelectableClients = useMemo(
    () => [...orderedTimelineClients, ...winClients, ...archivedClients],
    [orderedTimelineClients, winClients, archivedClients]
  );
  const visibleSelectableIds = useMemo(
    () => visibleSelectableClients.map((client) => client.id),
    [visibleSelectableClients]
  );
  const selectedCount = selectedClientIds.length;
  const allVisibleSelected = visibleSelectableIds.length > 0
    && visibleSelectableIds.every((id) => selectedClientIds.includes(id));
  const visibleMeetingMapPins = useMemo(() => {
    const allowedIds = new Set(productClients.map((client) => client.id));
    return meetingMapPins.filter((pin) => allowedIds.has(pin.clientId));
  }, [meetingMapPins, productClients]);

  async function request(path: string, init?: RequestInit) {
    expireFatCookies();
    const headers: Record<string, string> = {
      ...salesAuthHeaders(),
      ...(init?.headers as Record<string, string> || {}),
    };
    if (init?.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(`${API}${path}`, {
      ...init,
      headers,
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({} as Record<string, unknown>));
    if (!response.ok) {
      const message = String(
        (data as { message?: string; error?: string })?.message
        || (data as { message?: string; error?: string })?.error
        || `Request failed (${response.status})`
      ).trim();
      throw new Error(message || `Request failed (${response.status})`);
    }
    return data;
  }

  async function loadMeetingMap(options?: { quiet?: boolean }) {
    const quiet = Boolean(options?.quiet);
    if (!quiet) setMeetingMapLoading(true);
    setMeetingMapError('');
    try {
      const data = await request(`/admin/sales/meeting-map?product=${encodeURIComponent(productBracket)}`);
      const pins = Array.isArray(data.pins) ? data.pins : [];
      setMeetingMapPins(pins as MeetingMapPin[]);
      setMeetingMapUnresolvedCount(Number.isFinite(Number(data.unresolvedCount)) ? Number(data.unresolvedCount) : 0);
      setMeetingMapPendingCount(Number.isFinite(Number(data.pendingCount)) ? Number(data.pendingCount) : 0);
      setMeetingMapMissingAddressCount(
        Number.isFinite(Number(data.missingAddressCount)) ? Number(data.missingAddressCount) : 0
      );
    } catch (err) {
      setMeetingMapError(err instanceof Error ? err.message : 'Failed loading client map');
      setMeetingMapPins([]);
      setMeetingMapUnresolvedCount(0);
      setMeetingMapPendingCount(0);
      setMeetingMapMissingAddressCount(0);
    } finally {
      if (!quiet) setMeetingMapLoading(false);
    }
  }

  async function loadSales(options: { clearMessages?: boolean; showLoading?: boolean } = {}) {
    const clearMessages = options.clearMessages !== false;
    const showLoading = options.showLoading === true;
    if (showLoading) setLoading(true);
    if (clearMessages) {
      setError('');
      setNotice('');
    }
    const gen = ++salesListGenRef.current;
    let lastErr: unknown = null;
    const backoffMs = [0, 1200, 3500];
    try {
      for (let attempt = 0; attempt < backoffMs.length; attempt += 1) {
        if (backoffMs[attempt]) {
          await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
        }
        try {
          expireFatCookies();
          const data = await request('/admin/sales');
          if (gen !== salesListGenRef.current) return;
          const nextClients = Array.isArray(data.clients) ? data.clients : [];
          setClients(nextClients);
          const nextIds = new Set(nextClients.map((client: SalesClient) => client.id));
          setSelectedClientIds((prev) => prev.filter((id) => nextIds.has(id)));
          const counts = data.products && typeof data.products === 'object'
            ? data.products
            : {
                asoldi: nextClients.filter((client: SalesClient) => normalizeSalesProduct(client.product) === 'asoldi').length,
                ssu: nextClients.filter((client: SalesClient) => normalizeSalesProduct(client.product) === 'ssu').length,
              };
          const nextProducts = {
            asoldi: Number(counts.asoldi) || 0,
            ssu: Number(counts.ssu) || 0,
          };
          setProductCounts(nextProducts);
          writeSalesListCache(nextClients, nextProducts);
          if (data.calendar) setCalendarStatus(data.calendar as CalendarStatus);
          setIsSalesAdmin(Boolean(data.isAdmin) || data?.calendar?.loginRole === 'admin');
          setSalesOwners(Array.isArray(data.owners) ? data.owners : []);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (gen !== salesListGenRef.current) return;
        }
      }
      if (lastErr) {
        const cached = readSalesListCache();
        if (cached?.clients.length && gen === salesListGenRef.current) {
          setClients((prev) => prev.length ? prev : cached.clients);
          setProductCounts((prev) => (prev.asoldi || prev.ssu) ? prev : cached.products);
          setError('');
        } else if (gen === salesListGenRef.current) {
          setError(lastErr instanceof Error ? lastErr.message : 'Failed to load sales clients');
        }
      } else {
        void loadOffers();
      }
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  async function loadOffers() {
    try {
      const data = await request('/admin/sales/offers');
      setOffers(Array.isArray(data.offers) ? data.offers : []);
    } catch {
      // Offers are non-critical for the main list; ignore load errors here.
    }
  }

  async function loadCalendarStatus() {
    try {
      const data = await request('/admin/sales/google/status') as CalendarStatus;
      setCalendarStatus(data);
      return data;
    } catch {
      setCalendarStatus((prev) => prev || {
        configured: true,
        connected: false,
        calendarId: '',
        redirectUri: '',
        tokenUpdatedAt: '',
      });
      return null;
    }
  }

  clientsLenRef.current = clients.length;
  errorRef.current = error;

  useEffect(() => {
    if (!active) return;
    const hasList = clientsLenRef.current > 0;
    const failed = Boolean(errorRef.current);
    if (salesListLoadedRef.current && hasList && !failed) return;
    salesListLoadedRef.current = true;
    void loadSales({ showLoading: !hasList, clearMessages: !hasList });
  }, [active]);

  useEffect(() => {
    if (isSalesAdmin) return undefined;
    const timer = window.setInterval(() => {
      void loadSales({ clearMessages: false, showLoading: false });
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [isSalesAdmin]);

  useEffect(() => {
    const timer = window.setInterval(() => setMeetingNowMs(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const hasPendingMapGeocodes = meetingMapPendingCount > 0;
  useEffect(() => {
    if (!mapMounted || !hasPendingMapGeocodes) return undefined;
    const timer = window.setInterval(() => {
      void loadMeetingMap({ quiet: true });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [hasPendingMapGeocodes, mapMounted]);

  useEffect(() => {
    setSelectedClientIds([]);
    setBulkAssignOwnerId('');
  }, [productBracket]);

  useEffect(() => {
    if (!mapMounted) return undefined;
    void loadMeetingMap({ quiet: true });
    return undefined;
  }, [productBracket, mapMounted]);

  useEffect(() => {
    recordingBlobUrlsRef.current = recordingBlobUrlByClient;
  }, [recordingBlobUrlByClient]);

  useEffect(() => () => {
    for (const url of Object.values(recordingBlobUrlsRef.current || {}) as string[]) {
      if (!url) continue;
      URL.revokeObjectURL(url);
    }
    if (previewMissingTimerRef.current) window.clearTimeout(previewMissingTimerRef.current);
    calendarConnectStopRef.current?.();
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function syncMeetingMap() {
      if (!meetingMapContainerRef.current || !mapMounted) return;
      const L = await import('leaflet');
      if (cancelled || !meetingMapContainerRef.current) return;

      if (!meetingMapRef.current) {
        const map = L.map(meetingMapContainerRef.current, {
          zoomControl: true,
          // Keep page scrolling natural when cursor is over the map panel.
          scrollWheelZoom: false,
        });
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors',
          maxZoom: 19,
        }).addTo(map);
        map.setView(SALES_MAP_DEFAULT_CENTER, SALES_MAP_DEFAULT_ZOOM);
        window.setTimeout(() => {
          try {
            map.invalidateSize();
          } catch {
            // Map may already have been torn down.
          }
        }, 80);
        const mapContainer = map.getContainer?.();
        if (mapContainer) {
          mapContainer.style.position = 'relative';
          mapContainer.style.zIndex = '0';
        }
        const tilePane = map.getPane?.('tilePane');
        const overlayPane = map.getPane?.('overlayPane');
        const markerPane = map.getPane?.('markerPane');
        const popupPane = map.getPane?.('popupPane');
        if (tilePane) tilePane.style.zIndex = '1';
        if (overlayPane) overlayPane.style.zIndex = '2';
        if (markerPane) markerPane.style.zIndex = '3';
        if (popupPane) popupPane.style.zIndex = '4';
        meetingMapRef.current = map;
        meetingMapMarkerLayerRef.current = L.layerGroup().addTo(map);
      }

      const map = meetingMapRef.current;
      if (!map) return;
      const markerLayer = meetingMapMarkerLayerRef.current || L.layerGroup().addTo(map);
      markerLayer.clearLayers();

      if (!visibleMeetingMapPins.length) {
        map.setView(SALES_MAP_DEFAULT_CENTER, SALES_MAP_DEFAULT_ZOOM);
        return;
      }

      const bounds = L.latLngBounds([]);
      const occupancy = new Map<string, number>();
      for (const pin of visibleMeetingMapPins) {
        const lat = Number(pin.latitude);
        const lng = Number(pin.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const cellKey = `${lat.toFixed(5)},${lng.toFixed(5)}`;
        const overlapIndex = occupancy.get(cellKey) || 0;
        occupancy.set(cellKey, overlapIndex + 1);
        const [markerLat, markerLng] = offsetOverlappingPin(lat, lng, overlapIndex);
        const style = pinStyleFor(pin);
        const marker = L.circleMarker([markerLat, markerLng], {
          radius: 8,
          color: style.color,
          weight: 2,
          fillColor: style.fillColor,
          fillOpacity: 0.85,
        });
        const modeLabel = pin.meetingMode === 'online' ? 'Online' : 'In person';
        const statusLabel = pin.status === 'not-sold' ? 'Not sold' : pin.status === 'secondary' ? 'Secondary' : 'Active';
        const sourceLabel = pin.locationSource === 'businessName' ? 'Mapped from business name' : 'Address';
        const popupHtml = [
          `<div style="min-width:180px;line-height:1.35;font-size:12px;">`,
          `<div style="font-weight:600;margin-bottom:4px;">${escapeHtml(pin.businessName || 'Client')}</div>`,
          pin.contactPerson ? `<div style="margin-bottom:2px;">${escapeHtml(pin.contactPerson)}</div>` : '',
          `<div style="margin-bottom:2px;">${escapeHtml(pin.meetingPlace || '')}</div>`,
          `<div style="margin-bottom:2px;color:#6b7280;">${escapeHtml(modeLabel)} · ${escapeHtml(statusLabel)}</div>`,
          `<div style="margin-bottom:2px;color:#6b7280;">${escapeHtml(sourceLabel)}</div>`,
          pin.meetingAt ? `<div style="color:#6b7280;">${escapeHtml(formatWhen(pin.meetingAt))}</div>` : '',
          '</div>',
        ].join('');
        marker.bindPopup(popupHtml);
        marker.addTo(markerLayer);
        bounds.extend([markerLat, markerLng]);
      }

      if (bounds.isValid()) {
        map.fitBounds(bounds.pad(0.2), { maxZoom: 13 });
      }
    }
    void syncMeetingMap();
    return () => {
      cancelled = true;
    };
  }, [visibleMeetingMapPins, mapMounted]);

  useEffect(() => {
    if (!mapOpen) return undefined;
    const timer = window.setTimeout(() => {
      try {
        meetingMapRef.current?.invalidateSize?.();
      } catch {
        // Map may not be ready yet.
      }
    }, 80);
    return () => window.clearTimeout(timer);
  }, [mapOpen]);

  useEffect(() => {
    if (!headerPanel && !productMenuOpen && !accountMenuOpen) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && headerShellRef.current?.contains(target)) return;
      closeHeaderMenus();
    };
    const onScroll = (event: Event) => {
      const target = event.target as Node | null;
      if (target && headerShellRef.current?.contains(target)) return;
      closeHeaderMenus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [headerPanel, productMenuOpen, accountMenuOpen]);

  useEffect(
    () => () => {
      if (meetingMapRef.current) {
        meetingMapRef.current.remove();
        meetingMapRef.current = null;
        meetingMapMarkerLayerRef.current = null;
      }
    },
    []
  );

  // Live (debounced) search of registered client accounts while an offer panel
  // is open. Runs with an empty query on open so the rep immediately sees the
  // signed-up clients, then filters as they type.
  useEffect(() => {
    if (!offerOpenId || offerSelectedUser) return;
    let active = true;
    setOfferSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await request(`/admin/sales/client-search?q=${encodeURIComponent(offerSearch.trim())}`);
        if (active) setOfferResults(Array.isArray(data.users) ? data.users : []);
      } catch {
        if (active) setOfferResults([]);
      } finally {
        if (active) setOfferSearching(false);
      }
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [offerSearch, offerOpenId, offerSelectedUser]);

  function openOfferPanel(client: SalesClient) {
    setOfferOpenId((prev) => (prev === client.id ? null : client.id));
    setOfferPlanId('tier-1-standard');
    setOfferNote('');
    setOfferSearch('');
    setOfferResults([]);
    setOfferSelectedUser(null);
    setLastCreatedCode(null);
    setError('');
  }

  async function createOffer(client: SalesClient) {
    setCreatingOffer(true);
    setError('');
    try {
      const selectedRunId = String(client.makerRun?.runId || '').trim();
      const data = await request('/admin/sales/offers', {
        method: 'POST',
        body: JSON.stringify({
          planId: offerPlanId,
          note: offerNote,
          salesClientId: client.id,
          runId: selectedRunId,
          websiteMakerBaseUrl,
          targetUserId: offerSelectedUser?.userId || '',
          targetEmail: offerSelectedUser?.email || '',
        }),
      });
      setLastCreatedCode(data.offer?.code || null);
      setOfferNote('');
      await loadSales();
      await loadOffers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed creating offer');
    } finally {
      setCreatingOffer(false);
    }
  }

  async function deleteOffer(id: string) {
    setError('');
    try {
      await request(`/admin/sales/offers/${id}`, { method: 'DELETE' });
      await loadOffers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed deleting offer');
    }
  }

  function openCreate() {
    setEditingId(null);
    setWebsiteEmailTouched(false);
    setForm({ ...INITIAL_FORM, product: productBracket });
    setShowForm(true);
  }

  function clientNoteDraft(client: SalesClient) {
    return Object.prototype.hasOwnProperty.call(noteDrafts, client.id)
      ? noteDrafts[client.id]
      : (client.notes || '');
  }

  function applySavedClient(saved: SalesClient) {
    if (!saved?.id) return;
    salesListGenRef.current += 1;
    setClients((prev) => {
      const index = prev.findIndex((entry) => entry.id === saved.id);
      if (index === -1) return [saved, ...prev];
      const next = prev.slice();
      next[index] = saved;
      return next;
    });
    setNoteDrafts((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, saved.id)) return prev;
      const next = { ...prev };
      delete next[saved.id];
      return next;
    });
  }

  async function saveClientNotes(client: SalesClient) {
    const notes = clientNoteDraft(client);
    if (notes.trim() === String(client.notes || '').trim()) return;
    if (savingNoteId === client.id) return;
    setSavingNoteId(client.id);
    setError('');
    try {
      const data = await request(`/admin/sales/${client.id}/notes`, {
        method: 'PATCH',
        body: JSON.stringify({ notes }),
      });
      const saved = data?.client as SalesClient | undefined;
      if (saved?.id) applySavedClient(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed saving note');
    } finally {
      setSavingNoteId((current) => (current === client.id ? null : current));
    }
  }

  async function saveMeetingNotes(client: SalesClient, payload: { meetingQuote?: MeetingQuoteState }) {
    setSavingNoteId(client.id);
    setError('');
    try {
      const data = await request(`/admin/sales/${client.id}/notes`, {
        method: 'PATCH',
        body: JSON.stringify({
          meetingQuote: payload.meetingQuote,
        }),
      });
      const saved = data?.client as SalesClient | undefined;
      if (saved?.id) {
        setClients((prev) => prev.map((entry) => (entry.id === saved.id ? saved : entry)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed saving product notes');
      throw err;
    } finally {
      setSavingNoteId((current) => (current === client.id ? null : current));
    }
  }

  async function saveWorkshopAction(client: SalesClient, payload: {
    workshopAction: { name: string; format: 'sms' | 'ring' | 'sms-ring' | 'mote'; dueAt: string; addToCalendar: boolean };
  }) {
    setSavingNoteId(client.id);
    setError('');
    try {
      const data = await request(`/admin/sales/${client.id}/workshop-action`, {
        method: 'PATCH',
        body: JSON.stringify(payload.workshopAction),
      });
      const saved = data?.client as SalesClient | undefined;
      if (saved?.id) {
        setClients((prev) => prev.map((entry) => (entry.id === saved.id ? saved : entry)));
      }
      const warnings = Array.isArray((data as { warnings?: string[] })?.warnings)
        ? (data as { warnings: string[] }).warnings.filter(Boolean)
        : [];
      if (warnings.length) setError(warnings.join(' '));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed saving workshop time');
      throw err;
    } finally {
      setSavingNoteId((current) => (current === client.id ? null : current));
    }
  }

  async function saveClientEmail(client: SalesClient, clientEmail: string) {
    const next = clientEmail.trim().toLowerCase();
    if (next === String(client.clientEmail || '').trim().toLowerCase()) return;
    setError('');
    const data = await request(`/admin/sales/${client.id}/client-email`, {
      method: 'PATCH',
      body: JSON.stringify({ clientEmail: next }),
    });
    const saved = data?.client as SalesClient | undefined;
    if (saved?.id) applySavedClient(saved);
  }

  async function connectPortalUser(client: SalesClient) {
    setError('');
    setNotice('');
    try {
      const data = await request(`/admin/sales/${client.id}/connect-portal`, { method: 'POST', body: '{}' });
      const saved = data?.client as SalesClient | undefined;
      if (saved?.id) applySavedClient(saved);
      const tierName = data?.tier?.name || 'valgt tier';
      setNotice(`Koblet ${data?.user?.email || client.clientEmail} til ${tierName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke koble kundekontoen');
    }
  }

  // Org. nr lives in the proff.no URL. No link means no fetch; a new link replaces the stored number.
  useEffect(() => {
    if (!showForm) return;
    const orgFromProff = extractOrgNumberFromProffUrl(form.proffUrl);
    if (!orgFromProff) return;
    setForm((prev) => {
      const current = String(prev.orgNumber || '').replace(/\D+/g, '');
      if (current === orgFromProff) return prev;
      return { ...prev, orgNumber: orgFromProff };
    });
  }, [form.proffUrl, showForm]);

  function fillEditForm(client: SalesClient) {
    const details = parseDetails(client.details);
    setEditingId(client.id);
    const touched = Boolean(String(client.websiteEmail || '').trim());
    setWebsiteEmailTouched(touched);
    const nextForm: SalesFormState = {
      product: normalizeSalesProduct(client.product),
      businessName: client.businessName || '',
      contactPerson: client.contactPerson || '',
      contactEmail: client.contactEmail || '',
      websiteEmail: client.websiteEmail || '',
      contactPhone: client.contactPhone || '',
      meetingPlace: client.meetingPlace || '',
      orgNumber: client.orgNumber || '',
      businessAddress: client.businessAddress || '',
      industry: client.industry || '',
      meetingMode: client.meetingMode === 'in-person' ? 'in-person' : 'online',
      websiteDomain: client.websiteDomain || '',
      notes: clientNoteDraft(client),
      instagramUrl: details.instagramUrl,
      facebookUrl: details.facebookUrl,
      proffUrl: details.proffUrl,
      otherLinks: details.otherLinks,
      googleBusinessProfile: details.googleBusinessProfile,
    };
    setForm(nextForm);
    clientCardBaselineRef.current = clientCardSnapshot(nextForm, touched);
  }

  function openEdit(client: SalesClient) {
    fillEditForm(client);
    if (normalizeSalesProduct(client.product) === 'ssu') {
      setShowForm(true);
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.delete('notes');
    next.set('flow', client.id);
    next.set('step', '1');
    setSearchParams(next, { replace: true });
    setShowForm(false);
  }

  function openVerifiedOffer(client: SalesClient) {
    fillEditForm(client);
    const next = new URLSearchParams(searchParams);
    next.delete('notes');
    next.set('flow', client.id);
    next.set('step', '3');
    setSearchParams(next, { replace: true });
    setVerifiedInboxOpen(false);
    setShowForm(false);
  }

  function closeClientFlow() {
    setDiscardPrompt(false);
    const next = new URLSearchParams(searchParams);
    next.delete('flow');
    next.delete('step');
    next.delete('notes');
    setSearchParams(next, { replace: true });
    setShowForm(false);
    setEditingId(null);
  }

  function requestCloseClientFlow() {
    if (clientCardDirty) {
      setDiscardPrompt(true);
      return;
    }
    closeClientFlow();
  }

  async function saveClientCardAndClose() {
    const ok = await saveForm(undefined, { keepOpen: true });
    if (!ok) return;
    closeClientFlow();
  }

  useEffect(() => {
    if (!flowClientId || loading) return;
    if (editingId === flowClientId) return;
    const match = clients.find((entry) => entry.id === flowClientId);
    if (!match || normalizeSalesProduct(match.product) === 'ssu') return;
    fillEditForm(match);
  }, [flowClientId, loading, clients, editingId]);

  async function saveForm(e?: React.FormEvent, options?: { keepOpen?: boolean }) {
    e?.preventDefault();
    if (!form.businessName.trim() || !form.contactPerson.trim()) {
      setError('Business name and contact person are required.');
      return false;
    }
    setSaving(true);
    setError('');
    try {
      const existingClient = editingId ? clients.find((entry) => entry.id === editingId) : null;
      const payload = {
        product: form.product,
        businessName: form.businessName,
        contactPerson: form.contactPerson,
        contactEmail: form.contactEmail,
        websiteEmail: websiteEmailTouched ? form.websiteEmail : '',
        contactPhone: form.contactPhone,
        meetingPlace: form.meetingPlace,
        orgNumber: form.orgNumber,
        businessAddress: form.businessAddress,
        industry: form.industry,
        ...(editingId ? {} : { meetingMode: form.meetingMode }),
        websiteDomain: form.product === 'ssu' ? '' : form.websiteDomain,
        notes: form.notes,
        details: {
          instagramUrl: form.instagramUrl,
          facebookUrl: form.facebookUrl,
          proffUrl: form.proffUrl,
          otherLinks: form.otherLinks,
          googleBusinessProfile: form.googleBusinessProfile,
          editEmailBeforeSend: Boolean(existingClient?.details?.editEmailBeforeSend),
        },
      };
      const endpoint = editingId ? `/admin/sales/${editingId}` : '/admin/sales';
      const method = editingId ? 'PUT' : 'POST';
      const data = await request(endpoint, {
        method,
        body: JSON.stringify(payload),
      });
      const warnings = (Array.isArray(data.warnings) ? data.warnings.filter(Boolean) : [])
        .filter((line) => !/client owner calendar/i.test(String(line)));
      const saved = (data.client || {}) as SalesClient;
      const meetingUpdated = Boolean(editingId && data.meetingChanged && data.calendarInviteSent);
      const savedId = editingId || saved.id || '';
      if (!options?.keepOpen) {
        setShowForm(false);
        setEditingId(null);
      }
      if (savedId) {
        setNoteDrafts((prev) => {
          if (!Object.prototype.hasOwnProperty.call(prev, savedId)) return prev;
          const next = { ...prev };
          delete next[savedId];
          return next;
        });
      }
      if (saved?.id) applySavedClient(saved);
      else await loadSales({ clearMessages: false, showLoading: false });
      clientCardBaselineRef.current = clientCardSnapshot(form, websiteEmailTouched);
      if (options?.keepOpen) {
        setError(warnings.length ? warnings.join(' | ') : '');
        return true;
      }
      setError(warnings.length ? warnings.join(' | ') : '');
      const googleEmail = calendarStatus?.googleEmail || saved.calendar?.accountKey || '';
      if (saved.calendar?.eventId) {
        setNotice(
          meetingUpdated
            ? `Meeting updated on Google Calendar${googleEmail ? ` (${googleEmail})` : ''}. Open that Google account — not a different Gmail / work inbox.`
            : `Meeting saved to Google Calendar${googleEmail ? ` (${googleEmail})` : ''}. Open that Google account to see it. The client only gets a Google invite when you send confirmation.`
        );
      } else if (saved.agreedTime && saved.meetingAt) {
        setNotice('');
        if (!warnings.length) {
          setError('Saved, but no Google Calendar event was created. Check Connect Google Calendar on this login, then save the client again.');
        }
      } else {
        setNotice('Lagret. Sett møtetiden på møtehandlingen for å opprette Google-kalenderhendelsen.');
      }
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed saving sales client');
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function goFlowStep(step: 1 | 2 | 3) {
    if (!inClientFlow || step === flowStep) return;
    if (flowStep === 1 && clientCardDirty) {
      const ok = await saveForm(undefined, { keepOpen: true });
      if (!ok) return;
    }
    if (flowStep === 2 && notesFlushRef.current) {
      try {
        await notesFlushRef.current();
      } catch {
        return;
      }
    }
    const next = new URLSearchParams(searchParams);
    next.set('flow', flowClientId);
    next.set('step', String(step));
    next.delete('notes');
    setSearchParams(next, { replace: true });
  }

  async function toggleProgress(client: SalesClient, key: SalesGoalKey, extra?: { fastTrack?: boolean }) {
    const fastTrack = Boolean(extra?.fastTrack);
    const nextValue = fastTrack ? true : !client.progression?.[key];
    if (nextValue) {
      const blocked = salesStepBlockedReason(client, key, fastTrack);
      if (blocked) {
        setError(blocked);
        return;
      }
    }
    if (key === 'contractSigned' && !nextValue && client.progression?.contractSigned) {
      const confirmed = window.confirm('Angre solgt nettside? Kunden tas ut av deployment-utvikling.');
      if (!confirmed) return;
    }
    if (fastTrack) {
      const confirmed = window.confirm('Hopp til kontrakt signert? Gjenstående mål mellom hoppes over.');
      if (!confirmed) return;
    }
    setProgressBusyKey(`${client.id}:${key}`);
    setError('');
    try {
      const data = await request(`/admin/sales/${client.id}/progression`, {
        method: 'PATCH',
        body: JSON.stringify({
          key,
          value: nextValue,
          fastTrack,
        }),
      });
      const saved = data?.client as SalesClient | undefined;
      if (saved?.id) applySavedClient(saved);
      else await loadSales({ clearMessages: false, showLoading: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed updating progression');
    } finally {
      setProgressBusyKey(null);
    }
  }

  async function mutateNextAction(client: SalesClient, body: Record<string, unknown>) {
    setNextActionBusyId(client.id);
    setError('');
    try {
      const data = await request(`/admin/sales/${client.id}/next-actions`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      const saved = data?.client as SalesClient | undefined;
      if (saved?.id) applySavedClient(saved);
      else await loadSales({ clearMessages: false, showLoading: false });
      const warnings = (Array.isArray(data?.warnings) ? data.warnings.filter(Boolean) : [])
        .filter((line) => !/client owner calendar/i.test(String(line)));
      if (warnings.length) setError(warnings.join(' | '));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed updating next action');
    } finally {
      setNextActionBusyId(null);
    }
  }

  async function toggleInlineRecording(client: SalesClient) {
    const existingBlobUrl = recordingBlobUrlByClient[client.id];
    if (recordingOpenClientId === client.id) {
      setRecordingOpenClientId(null);
      return;
    }
    if (existingBlobUrl) {
      setRecordingOpenClientId(client.id);
      return;
    }
    setRecordingLoadingClientId(client.id);
    setRecordingErrorByClient((prev) => ({ ...prev, [client.id]: '' }));
    try {
      const response = await fetch(buildRecordingProxyUrl(client.id), {
        method: 'GET',
        headers: salesAuthHeaders(),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || 'Failed loading recording audio.');
      }
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      setRecordingBlobUrlByClient((prev) => ({ ...prev, [client.id]: blobUrl }));
      setRecordingOpenClientId(client.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed loading recording audio.';
      setRecordingErrorByClient((prev) => ({ ...prev, [client.id]: message }));
      setRecordingOpenClientId(client.id);
    } finally {
      setRecordingLoadingClientId(null);
    }
  }

  function openSecondaryPicker(clientsToMark: SalesClient[], label = '') {
    const ids = clientsToMark.map((entry) => entry.id).filter(Boolean);
    if (!ids.length) return;
    const shared = ids.length === 1
      ? normalizeSecondaryInterest(clientsToMark[0]?.secondaryInterest)
      : '';
    setSecondaryPicker({
      clientIds: ids,
      selected: shared,
      label: label || (ids.length === 1
        ? (clientsToMark[0]?.businessName || 'kunden')
        : `${ids.length} kunder`),
    });
    setError('');
  }

  async function saveSecondaryPicker() {
    if (!secondaryPicker) return;
    const interest = normalizeSecondaryInterest(secondaryPicker.selected);
    if (!interest) {
      setError('Velg Redesign, Consulting eller et sekundært produkt.');
      return;
    }
    const ids = secondaryPicker.clientIds;
    if (ids.length === 1) {
      setStatusBusyId(`secondary:${ids[0]}`);
    } else {
      setBulkBusy(true);
    }
    setError('');
    try {
      if (ids.length === 1) {
        await request(`/admin/sales/${ids[0]}/secondary`, {
          method: 'POST',
          body: JSON.stringify({ interest }),
        });
      } else {
        const data = await request('/admin/sales/bulk', {
          method: 'POST',
          body: JSON.stringify({
            action: 'secondary',
            clientIds: ids,
            interest,
          }),
        });
        setNotice(formatBulkResult(data as Record<string, unknown>, 'secondary'));
        setSelectedClientIds([]);
      }
      setSecondaryPicker(null);
      await loadSales({ clearMessages: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed moving client to Sekundært');
    } finally {
      setStatusBusyId(null);
      setBulkBusy(false);
    }
  }

  async function markNotSold(client: SalesClient) {
    const label = client.businessName || 'this client';
    const reasonInput = window.prompt(`Optional reason for archiving "${label}" as not sold:`, '');
    if (reasonInput === null) return;
    setStatusBusyId(`not-sold:${client.id}`);
    setError('');
    try {
      await request(`/admin/sales/${client.id}/not-sold`, {
        method: 'POST',
        body: JSON.stringify({ reason: reasonInput }),
      });
      await loadSales();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed archiving client as not sold');
    } finally {
      setStatusBusyId(null);
    }
  }

  async function markSecondary(client: SalesClient) {
    openSecondaryPicker([client]);
  }

  async function restoreArchivedClient(client: SalesClient) {
    setStatusBusyId(`restore:${client.id}`);
    setError('');
    try {
      await request(`/admin/sales/${client.id}/restore`, { method: 'POST' });
      await loadSales();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed restoring archived client');
    } finally {
      setStatusBusyId(null);
    }
  }

  async function deleteArchivedClient(client: SalesClient) {
    const label = client.businessName || 'this archived client';
    const ok = window.confirm(`Delete "${label}" permanently? This cannot be undone.`);
    if (!ok) return;
    setDeletingArchivedId(client.id);
    setError('');
    try {
      await request(`/admin/sales/${client.id}`, { method: 'DELETE' });
      await loadSales();
      await loadOffers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed deleting archived client');
    } finally {
      setDeletingArchivedId(null);
    }
  }

  async function assignClientOwner(client: SalesClient, ownerId: string) {
    if (!isSalesAdmin || ownerId === (client.ownerId || '')) return;
    setAssigningOwnerId(client.id);
    setError('');
    try {
      const data = await request(`/admin/sales/${client.id}/owner`, {
        method: 'POST',
        body: JSON.stringify({ ownerId }),
      });
      const saved = data?.client as SalesClient | undefined;
      if (saved) applySavedClient(saved);
      else await loadSales({ clearMessages: false, showLoading: false });
      const gaps = Array.isArray(data?.confirmationGaps) ? data.confirmationGaps.filter(Boolean) : [];
      const warnings = Array.isArray(data?.warnings) ? data.warnings.filter(Boolean) : [];
      if (data?.thankYouSent) {
        setNotice(`Tildelt. Bekreftelse sendt${data.from ? ` fra ${data.from}` : ''}.`);
      } else if (gaps.length) {
        setError(`Tildelt, men bekreftelse ble ikke sendt. Mangler ${gaps.join(', ')}.`);
      } else if (data?.thankYouReason === 'meeting-passed') {
        setNotice('Tildelt. Bekreftelse sendes når selgeren setter en ny møtetid frem i tid.');
      } else {
        setNotice('Tildelt. Bekreftelse sendes fra selgeren når alle møtefeltene er fylt inn.');
      }
      if (warnings.length) setError(warnings.join(' | '));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed assigning sales owner');
    } finally {
      setAssigningOwnerId(null);
    }
  }

  function salesMailTemplate(client: SalesClient, kind: 'thank-you' | '3d' | '24h' | '1h') {
    const irl = client.meetingMode === 'in-person';
    if (kind === 'thank-you') return irl ? 'thank-you-in-person' : 'thank-you';
    if (kind === '3d') return irl ? 'reminder-3d-in-person' : 'reminder-3d';
    if (kind === '24h') return irl ? 'reminder-24h-in-person' : 'reminder-24h';
    return irl ? 'reminder-1h-in-person' : 'reminder-1h';
  }

  function openMailComposer(client: SalesClient, kind: 'thank-you' | '3d' | '24h' | '1h' = 'thank-you') {
    navigate(`/sales/email?clientId=${encodeURIComponent(client.id)}&template=${encodeURIComponent(salesMailTemplate(client, kind))}`);
  }

  async function sendClientMail(client: SalesClient, kind: 'thank-you' | '3d' | '24h' | '1h') {
    const to = String(client.contactEmail || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      setError('Client contact email is missing or invalid. Edit the client or use Rediger først.');
      return;
    }
    if (kind === 'thank-you' && client.reminders?.thankYouSentAt) {
      if (!window.confirm(`${client.businessName || 'Kunden'} har allerede fått bekreftelse. Send på nytt til ${to}?`)) return;
    }
    const mailKey = `${client.id}:${kind}`;
    setSendingMailKey(mailKey);
    setError('');
    try {
      const data = kind === 'thank-you'
        ? await request(`/admin/sales/${client.id}/send-welcome-email`, {
            method: 'POST',
            body: JSON.stringify({ to }),
          })
        : await request(`/admin/sales/${client.id}/send-reminder`, {
            method: 'POST',
            body: JSON.stringify({ to, kind }),
          });
      const saved = data?.client as SalesClient | undefined;
      if (saved) applySavedClient(saved);
      else await loadSales({ clearMessages: false, showLoading: false });
      const label = kind === 'thank-you' ? 'Bekreftelse' : kind === '3d' ? 'Påminnelse 3 dager' : kind === '1h' ? 'Påminnelse 1 time' : 'Påminnelse 24 timer';
      setNotice(`${label} sendt til ${to}${data?.from ? ` fra ${data.from}` : ''}.`);
      const warnings = Array.isArray(data?.warnings) ? data.warnings.filter(Boolean) : [];
      if (warnings.length) setError(warnings.join(' | '));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send email');
    } finally {
      setSendingMailKey(null);
    }
  }

  function ownerLabel(owner: SalesOwnerOption) {
    if (owner.name && owner.username) return `${owner.name} · ${owner.username}`;
    return owner.name || owner.username || owner.accountKey;
  }

  function toggleClientSelected(clientId: string) {
    setSelectedClientIds((prev) => (
      prev.includes(clientId) ? prev.filter((id) => id !== clientId) : [...prev, clientId]
    ));
  }

  function toggleSelectAllVisible() {
    if (allVisibleSelected) {
      const hide = new Set(visibleSelectableIds);
      setSelectedClientIds((prev) => prev.filter((id) => !hide.has(id)));
      return;
    }
    setSelectedClientIds((prev) => [...new Set([...prev, ...visibleSelectableIds])]);
  }

  function handleClientCardClick(event: React.MouseEvent<HTMLElement>, clientId: string) {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('button, a, input, select, textarea, label, audio, details, summary')) return;
    if (window.getSelection()?.toString()) return;
    toggleClientSelected(clientId);
  }

  function closeHeaderMenus() {
    setHeaderPanel(null);
    setProductMenuOpen(false);
    setAccountMenuOpen(false);
  }

  function toggleHeaderPanel(panel: SalesHeaderPanel) {
    setProductMenuOpen(false);
    setAccountMenuOpen(false);
    setHeaderPanel((current) => {
      const next = current === panel ? null : panel;
      if (next === 'map') setMapMounted(true);
      return next;
    });
  }

  function togglePeekCard(clientId: string) {
    setPeekCardIds((prev) => ({ ...prev, [clientId]: !prev[clientId] }));
  }

  function toggleTimelineBucket(id: string) {
    setCollapsedBuckets((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        window.localStorage.setItem(SALES_BUCKETS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }

  function renderCategoryMore(bucketId: string, count: number, className = '') {
    if (count <= SALES_COMPACT_PREVIEW) return null;
    const collapsed = collapsedBuckets[bucketId] !== false;
    return (
      <button
        type="button"
        onClick={() => toggleTimelineBucket(bucketId)}
        className={`inline-flex items-center justify-center gap-1 py-1.5 text-sm text-gray-300 hover:text-white ${className}`}
      >
        <span>{collapsed ? `Vis alle ${count} kunder` : 'Vis færre'}</span>
        <ChevronDown size={16} className={`shrink-0 transition-transform ${collapsed ? '' : 'rotate-180'}`} />
      </button>
    );
  }

  function formatBulkResult(data: Record<string, unknown>, action = '') {
    const updated = Number(data.updated) || 0;
    const deleted = Number(data.deleted) || 0;
    const skipped = Number(data.skipped) || 0;
    const failed = Number(data.failed) || 0;
    if (action === 'send-welcome') {
      const parts = [];
      if (updated) parts.push(`${updated} bekreftelse${updated === 1 ? '' : 'r'} sendt`);
      if (skipped) parts.push(`${skipped} hoppet over`);
      if (failed) parts.push(`${failed} feilet`);
      return parts.length ? `${parts.join(', ')}.` : 'Ingen bekreftelse sendt.';
    }
    const parts = [];
    if (updated) parts.push(`${updated} updated`);
    if (deleted) parts.push(`${deleted} deleted`);
    if (skipped) parts.push(`${skipped} skipped`);
    if (failed) parts.push(`${failed} failed`);
    return parts.length ? `Bulk action: ${parts.join(', ')}.` : 'Bulk action finished.';
  }

  async function runBulkAction(
    action: 'assign' | 'delete' | 'not-sold' | 'secondary' | 'restore' | 'send-welcome',
    extra: { ownerId?: string; reason?: string; clientIds?: string[]; interest?: string } = {},
  ) {
    const clientIds = extra.clientIds?.length ? extra.clientIds : selectedClientIds;
    if (!clientIds.length || bulkBusy) return;
    const count = clientIds.length;
    const payload = { ...extra };
    if (action === 'assign') {
      if (!isSalesAdmin) return;
      const ownerId = payload.ownerId || bulkAssignOwnerId;
      if (!ownerId) {
        setError('Choose a sales rep to send the selected clients to.');
        return;
      }
      payload.ownerId = ownerId;
      if (!window.confirm(`Tildel ${count} valgte kunder til selgeren? Bekreftelse sendes bare hvis møtetiden er frem i tid.`)) return;
    }
    if (action === 'send-welcome') {
      if (!window.confirm(`Send bekreftelse til ${count} kund${count === 1 ? 'e' : 'er'}? Den sendes fra selgeren som er tildelt.`)) return;
    }
    if (action === 'delete' && !window.confirm(`Permanently delete ${count} selected client${count === 1 ? '' : 's'}? This cannot be undone.`)) return;
    if (action === 'not-sold') {
      const reasonInput = window.prompt(`Optional reason for marking ${count} selected client${count === 1 ? '' : 's'} as not sold:`, '');
      if (reasonInput === null) return;
      payload.reason = reasonInput;
    }
    if (action === 'secondary') {
      const picked = productClients.filter((entry) => clientIds.includes(entry.id));
      openSecondaryPicker(picked, `${count} kunder`);
      return;
    }
    setBulkBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await request('/admin/sales/bulk', {
        method: 'POST',
        body: JSON.stringify({
          action,
          clientIds,
          ownerId: payload.ownerId || '',
          reason: payload.reason || '',
        }),
      });
      setNotice(formatBulkResult(data as Record<string, unknown>, action));
      setSelectedClientIds([]);
      setBulkAssignOwnerId('');
      await loadSales({ clearMessages: false });
      if (action === 'delete') await loadOffers();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Bulk action failed');
    } finally {
      setBulkBusy(false);
    }
  }

  async function connectGoogleCalendar() {
    setError('');
    calendarConnectStopRef.current?.();
    try {
      const data = await request('/admin/sales/google/auth-url');
      const popup = window.open(String(data.authUrl || ''), 'asoldi-google-calendar', 'width=560,height=760');
      if (!popup) {
        setError('Popup blocked. Please allow popups and try again.');
        return;
      }
      const snapshot: CalendarConnectSnapshot = {
        connected: Boolean(calendarStatus?.connected),
        tokenUpdatedAt: String(calendarStatus?.tokenUpdatedAt || ''),
        googleEmail: String(calendarStatus?.googleEmail || ''),
      };
      setCalendarConnecting(true);
      setNotice('Finish signing in with Google. This page updates when the calendar is connected.');

      let stopped = false;
      const startedAt = Date.now();
      let channel: BroadcastChannel | null = null;
      let pollTimer = 0;

      const cleanup = () => {
        window.clearInterval(pollTimer);
        window.removeEventListener('message', onMessage);
        window.removeEventListener('storage', onStorage);
        try { channel?.close(); } catch { /* ignore */ }
        calendarConnectStopRef.current = null;
      };

      const stopWaiting = () => {
        if (stopped) return;
        stopped = true;
        cleanup();
        setCalendarConnecting(false);
      };

      const finishConnected = async (hint?: GoogleCalendarOAuthMessage) => {
        if (stopped) return;
        stopped = true;
        cleanup();
        if (hint?.connected) {
          setCalendarStatus((prev) => ({
            configured: prev?.configured !== false,
            calendarId: prev?.calendarId || '',
            redirectUri: prev?.redirectUri || '',
            tokenUpdatedAt: hint.tokenUpdatedAt || prev?.tokenUpdatedAt || '',
            accountKey: prev?.accountKey,
            loginRole: prev?.loginRole,
            loginUsername: prev?.loginUsername,
            loginAccountKey: prev?.loginAccountKey,
            connected: true,
            googleEmail: hint.googleEmail || prev?.googleEmail,
            googleName: hint.googleName || prev?.googleName,
          }));
        }
        const next = await loadCalendarStatus();
        const email = next?.googleEmail || hint?.googleEmail || '';
        setNotice(email ? `Google Calendar connected as ${email}.` : 'Google Calendar connected.');
        setCalendarConnecting(false);
        setCalendarPanelOpen(false);
      };

      const finishFailed = (message = '') => {
        if (stopped) return;
        setError(message || 'Google Calendar connection failed.');
        setNotice('');
        stopWaiting();
      };

      const onPayload = (payload: GoogleCalendarOAuthMessage) => {
        if (payload.connected) void finishConnected(payload);
        else finishFailed(payload.error || '');
      };

      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) return;
        if (!isGoogleCalendarOAuthMessage(event.data)) return;
        onPayload(event.data);
      };

      const onStorage = (event: StorageEvent) => {
        if (event.key !== GOOGLE_CALENDAR_OAUTH_EVENT || !event.newValue) return;
        try {
          const parsed = JSON.parse(event.newValue) as unknown;
          if (isGoogleCalendarOAuthMessage(parsed)) onPayload(parsed);
        } catch {
          // Ignore a leftover or partial storage write.
        }
        try { window.localStorage.removeItem(GOOGLE_CALENDAR_OAUTH_EVENT); } catch { /* ignore */ }
      };

      window.addEventListener('message', onMessage);
      window.addEventListener('storage', onStorage);
      try {
        channel = new BroadcastChannel(GOOGLE_CALENDAR_OAUTH_EVENT);
        channel.onmessage = (event) => {
          if (isGoogleCalendarOAuthMessage(event.data)) onPayload(event.data);
        };
      } catch {
        // BroadcastChannel is unavailable in some embedded browsers.
      }

      pollTimer = window.setInterval(() => {
        void (async () => {
          if (stopped) return;
          if (Date.now() - startedAt > GOOGLE_CALENDAR_CONNECT_MAX_MS) {
            setNotice('');
            stopWaiting();
            return;
          }
          const next = await loadCalendarStatus();
          if (stopped) return;
          if (calendarStatusLooksUpdated(snapshot, next)) {
            const email = next?.googleEmail || '';
            setNotice(email ? `Google Calendar connected as ${email}.` : 'Google Calendar connected.');
            stopWaiting();
            setCalendarPanelOpen(false);
          }
        })();
      }, GOOGLE_CALENDAR_CONNECT_POLL_MS);

      calendarConnectStopRef.current = stopWaiting;
    } catch (err) {
      setCalendarConnecting(false);
      setError(err instanceof Error ? err.message : 'Failed to start Google OAuth');
    }
  }

  function openPublicPreview(client: SalesClient) {
    if (!clientHasPublicPreviewSnapshot(client)) {
      setPreviewMissingToastId(client.id);
      if (previewMissingTimerRef.current) window.clearTimeout(previewMissingTimerRef.current);
      previewMissingTimerRef.current = window.setTimeout(() => {
        setPreviewMissingToastId((current) => (current === client.id ? null : current));
      }, 3000);
      return;
    }
    window.open(getPublicClientPreviewUrl(client), '_blank');
  }

  function applyClientNameSearch(e?: React.FormEvent) {
    if (e) e.preventDefault();
    setClientSearchQuery(normalizeClientSearchText(clientSearchInput));
  }

  function clearClientNameSearch() {
    setClientSearchInput('');
    setClientSearchQuery('');
    setOwnerFilter('');
    setPipelineFilter('');
    setMeetingModeFilter('');
    setNextActionFromDate('');
    setNextActionToDate('');
  }

  const showCalendarConnect = calendarStatus?.configured !== false;
  const loggedInAs = calendarStatus?.loginUsername || 'this Sales login';

  function renderSalesClientCard(client: SalesClient, isWin = false, compact = false) {
            const clientIsSsu = isSsuClient(client);
            const publicPreviewUrl = getPublicClientPreviewUrl(client);
            const clientOffers = offers.filter((entry) => entry.salesClientId === client.id);
            const expanded = expandedId === client.id;
            const showMailActions = expanded && showMailActionsId === client.id;
            const meetingHeld = Boolean(client.progression?.meetingHeld);
            const nextAction = getActiveNextAction(client);
            // Important contact point: any action on the calendar, even if a reminder sits above it.
            const calendarAction = getCalendarNextAction(client);
            const meetingAtIso = clientMeetingAtIso(client);
            const meetingOnCalendar = Boolean(
              meetingAtIso
              && !client.progression?.meetingHeld
              && (calendarAction?.presetKey === 'meeting' || calendarAction?.presetKey === 'meetingBooked')
            );
            const websiteSold = Boolean(client.progression?.contractSigned);
            const canMarkSold = Boolean(client.progression?.contractSigned);
            const clientSelected = selectedClientIds.includes(client.id);
            const confirmationGaps = client.reminders?.thankYouSentAt ? [] : confirmationSendGaps(client);
            const needsConfirmation = clientNeedsConfirmationSend(client);
            const interestLabel = secondaryInterestLabel(client.secondaryInterest);
            const peeked = Boolean(peekCardIds[client.id]);
            const showCompact = compact && !peeked;
            const booking = salesBookingFacts(client);
            const bookingRows = [
              ['Booket av', booking.booker],
              ['Booket', formatBookingWhen(booking.bookedAt)],
              ['Booket for', formatBookingWhen(booking.meetingFor)],
              ['Liste', booking.listName],
            ];
            return (
              <React.Fragment key={client.id}>
                <div
                  onClick={(event) => handleClientCardClick(event, client.id)}
                  className={`rounded-2xl border flex flex-col cursor-pointer min-w-0 ${
                    showCompact ? 'p-2.5 gap-1' : 'p-3 sm:p-4 gap-2 sm:gap-3'
                  } ${
                    clientSelected
                      ? `bg-[#2a2a2a] hover:bg-[#323232] ${SALES_CARD_SELECTED}`
                      : confirmationGaps.length
                        ? 'bg-[#2a2a2a] hover:bg-[#353535] border-red-500/70 ring-1 ring-red-500/30'
                        : calendarAction
                        ? 'bg-[#2a2a2a] hover:bg-[#353535] border-sky-400/50 ring-1 ring-sky-400/20 shadow-[0_0_0_3px_rgba(56,189,248,0.06)]'
                        : 'bg-[#2a2a2a] hover:bg-[#353535] border-white/10'
                  }`}
                >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0 flex-wrap">
                      <input
                        type="checkbox"
                        checked={clientSelected}
                        onChange={() => toggleClientSelected(client.id)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`Select ${client.businessName || 'client'}`}
                        className="h-4 w-4 shrink-0 accent-[#FF5B00] cursor-pointer"
                      />
                      <h3 className="text-white font-semibold truncate min-w-0 flex-1 text-sm sm:text-base">{client.businessName || 'Unnamed business'}</h3>
                      {clientIsNewlyAssigned(client) ? (
                        <span className="sales-chip-ny shrink-0 text-[11px] px-2 py-0.5 rounded font-semibold bg-lime-500/15 border border-lime-500/40 text-lime-200">Ny</span>
                      ) : null}
                      {isWin ? (
                        <span className="shrink-0 text-[11px] px-2 py-0.5 rounded bg-emerald-900/40 text-emerald-200 border border-emerald-700/40">Solgt</span>
                      ) : null}
                      {interestLabel ? (
                        <span className={`shrink-0 px-2 py-0.5 rounded text-[11px] bg-violet-500/15 border border-violet-400/40 text-violet-100 truncate ${showCompact ? 'max-w-[52%]' : 'max-w-[46%]'}`}>
                          {interestLabel}
                        </span>
                      ) : confirmationGaps.length > 0 ? (
                        <span className={`shrink-0 px-2 py-0.5 rounded text-[11px] bg-red-500/15 border border-red-500/40 text-red-200 truncate ${showCompact ? 'max-w-[52%]' : 'max-w-[46%]'}`} title={`Mangler ${confirmationGaps.join(', ')}`}>
                          Bekreftelse stoppet
                        </span>
                      ) : needsConfirmation ? (
                        <span className={`shrink-0 px-2 py-0.5 rounded text-[11px] bg-amber-500/15 border border-amber-500/40 text-amber-200 truncate ${showCompact ? 'max-w-[52%]' : 'max-w-[46%]'}`}>
                          Bekreftelse ikke sendt
                        </span>
                      ) : !showCompact && nextAction?.name ? (
                        <span className="shrink-0 max-w-[40%] px-2 py-0.5 rounded text-[11px] bg-black/20 border border-white/10 text-gray-200 truncate">
                          {nextAction.name}
                        </span>
                      ) : null}
                    </div>
                    <div className={`flex items-center gap-1.5 text-xs min-w-0 ${showCompact ? 'mt-0.5' : 'mt-1'} ${meetingOnCalendar ? 'text-sky-300' : 'text-gray-400'}`}>
                      {meetingOnCalendar ? (
                        <CalendarCheck2 size={12} className="shrink-0" aria-label="På kalenderen" />
                      ) : (
                        <CalendarClock size={12} className="shrink-0" />
                      )}
                      <span className="truncate">{formatMeetingHeadline(meetingAtIso)}</span>
                      {meetingOnCalendar ? (
                        <span
                          className="sales-chip-calendar shrink-0 px-1.5 py-px rounded border border-sky-400/30 bg-sky-400/10 text-[10px] uppercase tracking-wide font-semibold text-sky-200"
                          title="Møtet ligger på kalenderen"
                        >
                          Kalender
                        </span>
                      ) : null}
                    </div>
                    {(!showCompact && confirmationGaps.length > 0) && (
                      <div className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-[11px] leading-snug text-red-200">
                        Bekreftelse sendes ikke. Mangler {confirmationGaps.join(', ')}.
                      </div>
                    )}
                    {(client.contactPerson || client.contactPhone) ? (
                      <div className={`${showCompact ? 'mt-0.5' : 'mt-1'} flex items-center gap-1.5 text-xs text-gray-400 min-w-0`}>
                        <UserRound size={12} className="shrink-0" />
                        <span className="truncate">{client.contactPerson || 'No contact person'}</span>
                        {client.contactPhone ? (
                          <a
                            href={`tel:${client.contactPhone.replace(/\s+/g, '')}`}
                            onClick={(event) => event.stopPropagation()}
                            className="shrink-0 inline-flex items-center gap-1 hover:text-white"
                          >
                            <span aria-hidden="true">·</span>
                            <Phone size={11} />
                            {client.contactPhone}
                          </a>
                        ) : null}
                      </div>
                    ) : null}
                    <div className={`${showCompact ? 'mt-0.5' : 'mt-1'} text-[11px] text-gray-500 truncate`}>
                      {client.meetingMode === 'in-person' ? 'IRL' : 'Online'}
                      {client.meetingPlace ? ` · ${client.meetingPlace}` : ''}
                    </div>
                    {showCompact ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          togglePeekCard(client.id);
                        }}
                        className="mt-0.5 mx-auto p-0.5 rounded text-gray-400 hover:text-white"
                        title="Vis mer på dette kortet"
                        aria-label="Vis mer på dette kortet"
                      >
                        <ChevronDown size={14} />
                      </button>
                    ) : null}
                    {!showCompact && isSalesAdmin && salesRepOptions.length > 0 && (
                      <label className="mt-2 flex items-center gap-2 text-[11px] text-gray-400">
                        <span className="shrink-0">Selger</span>
                        <select
                          value={
                            salesRepOptions.some((owner) => owner.accountKey === (client.ownerId || ''))
                              ? (client.ownerId || '')
                              : ''
                          }
                          disabled={assigningOwnerId === client.id}
                          onChange={(event) => void assignClientOwner(client, event.target.value)}
                          className="min-w-0 flex-1 rounded-md bg-black/30 border border-white/10 text-gray-200 px-2 py-1 disabled:opacity-50"
                        >
                          {!salesRepOptions.some((owner) => owner.accountKey === (client.ownerId || '')) && (
                            <option value="" disabled>
                              Ikke tildelt
                            </option>
                          )}
                          {salesRepOptions.map((owner) => (
                            <option key={owner.accountKey} value={owner.accountKey}>
                              {ownerLabel(owner)}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => openEdit(client)}
                    title="Edit client"
                    aria-label="Edit client"
                    className={`shrink-0 rounded-lg bg-white/10 text-white hover:bg-white/15 ${showCompact ? 'p-1' : 'p-2'}`}
                  >
                    <Pencil size={showCompact ? 12 : 14} />
                  </button>
                </div>

                {showCompact ? null : (
                <>
                <ClientNotesField
                  label="Notater"
                  value={clientNoteDraft(client)}
                  saving={savingNoteId === client.id}
                  dirty={clientNoteDraft(client).trim() !== String(client.notes || '').trim()}
                  onChange={(value) => setNoteDrafts((prev) => ({ ...prev, [client.id]: value }))}
                  onSave={() => void saveClientNotes(client)}
                />

                <SalesGoalTimeline
                  client={client}
                  progressBusyKey={progressBusyKey}
                  actionBusy={nextActionBusyId === client.id}
                  onToggleGoal={(key, extra) => void toggleProgress(client, key, extra)}
                  onMutateAction={(body) => mutateNextAction(client, body)}
                  variant={isWin ? 'win' : 'active'}
                />
                <WorkshopIterationLog
                  client={client}
                  canMarkDone
                  onClient={(saved) => setClients((prev) => prev.map((entry) => (entry.id === saved.id ? saved : entry)))}
                />

                <div className="flex flex-wrap items-center gap-2">
                  {!clientIsSsu && (
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => openPublicPreview(client)}
                        className="inline-flex items-center gap-1.5 px-3 py-2 sm:py-1.5 min-h-[40px] sm:min-h-0 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
                        title={publicPreviewUrl}
                      >
                        <ExternalLink size={13} />
                        Open preview
                      </button>
                      {previewMissingToastId === client.id && (
                        <div
                          role="status"
                          className="absolute left-0 bottom-full mb-1 z-20 whitespace-nowrap rounded-md border border-amber-700/40 bg-amber-950/95 px-2.5 py-1.5 text-[11px] text-amber-100 shadow-lg"
                        >
                          Not on asoldi.com yet
                        </div>
                      )}
                    </div>
                  )}
                  {salesMeetLink(client) && (
                    <button
                      type="button"
                      onClick={() => window.open(salesMeetLink(client), '_blank')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
                      title="Åpner Meet-rommet. Fireflies sendes inn ved kalendertid via API — slipp ham inn under Deltakere hvis Meet ber om det."
                    >
                      <ExternalLink size={13} />
                      Meet link
                    </button>
                  )}
                  {client.myphoner?.latestRecordingUrl && (
                    <button
                      type="button"
                      onClick={() => void toggleInlineRecording(client)}
                      disabled={recordingLoadingClientId === client.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
                      title="Load and play latest synced call recording inline"
                    >
                      {recordingLoadingClientId === client.id ? <Loader2 size={13} className="animate-spin" /> : <Volume2 size={13} />}
                      {recordingOpenClientId === client.id ? 'Hide audio' : 'Listen here'}
                    </button>
                  )}
                  {!clientIsSsu && isValidClientEmail(client.clientEmail) && (
                    <button
                      type="button"
                      onClick={() => void connectPortalUser(client)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF5B00] text-white text-xs hover:bg-[#e55200]"
                      title={client.portalConnectedAt ? 'Koble nettsiden til kundekontoen på nytt' : 'Finn kundekontoen og koble valgt tier'}
                    >
                      <Users size={13} />
                      {client.portalUserId ? 'Koblet' : 'Connect'}
                    </button>
                  )}
                  {!clientIsSsu && clientOffers.length > 0 && (
                    <span className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-[#FF5B00]/15 text-[#ff8a4d] text-[11px]">
                      <Tag size={12} />
                      {clientOffers.length} tilbud
                    </span>
                  )}
                </div>

                {recordingOpenClientId === client.id && (
                  <div className="rounded-xl border border-white/10 bg-black/20 p-3 space-y-2">
                    {recordingBlobUrlByClient[client.id] ? (
                      <>
                        <audio controls preload="metadata" src={recordingBlobUrlByClient[client.id]} className="w-full" />
                        <button
                          type="button"
                          onClick={() => window.open(client.myphoner?.latestRecordingUrl || '', '_blank')}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
                        >
                          <ExternalLink size={12} />
                          Open source URL
                        </button>
                      </>
                    ) : (
                      <div className="text-xs text-amber-300">
                        {recordingErrorByClient[client.id] || 'Could not load audio in-app for this recording.'}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {!clientIsSsu && (
                    <button
                      type="button"
                      disabled={!canMarkSold}
                      onClick={() => {
                        if (!canMarkSold) return;
                        onMovedToDevelopment?.();
                        setNotice(`${client.businessName || 'Kunden'} er solgt og ligger under Utvikling.`);
                      }}
                      title={canMarkSold
                        ? 'Kontrakt signert. Åpner Utvikling.'
                        : 'Solgt nettside kan bare klikkes når kontrakt er signert.'}
                      className={`inline-flex items-center gap-1.5 px-3 py-2 sm:py-1.5 min-h-[40px] sm:min-h-0 rounded-lg text-xs disabled:opacity-40 ${
                        websiteSold
                          ? 'bg-emerald-900/40 border border-emerald-700/40 text-emerald-200'
                          : 'bg-white/10 text-gray-400'
                      }`}
                    >
                      Solgt nettside
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void markNotSold(client)}
                    disabled={statusBusyId === `not-sold:${client.id}` || websiteSold}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-gray-200 text-xs hover:bg-white/15 disabled:opacity-50"
                    title={websiteSold ? 'Angre kontrakt signert først hvis dette var et uhell' : 'Arkiver som ikke solgt'}
                  >
                    {statusBusyId === `not-sold:${client.id}` ? <Loader2 size={13} className="animate-spin" /> : <ArchiveX size={13} />}
                    Ikke solgt
                  </button>
                  <button
                    type="button"
                    onClick={() => void markSecondary(client)}
                    disabled={statusBusyId === `secondary:${client.id}` || websiteSold}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs hover:bg-white/15 disabled:opacity-50 ${
                      client.status === 'secondary'
                        ? 'bg-violet-500/20 border border-violet-400/40 text-violet-100'
                        : 'bg-white/10 text-gray-200'
                    }`}
                    title="Velg Redesign, Consulting eller et sekundært produkt"
                  >
                    {statusBusyId === `secondary:${client.id}` ? <Loader2 size={13} className="animate-spin" /> : null}
                    {client.status === 'secondary' && interestLabel ? `Secondary · ${interestLabel}` : 'Secondary'}
                  </button>
                  {isWin && (
                    <button
                      type="button"
                      onClick={() => void toggleProgress(client, 'contractSigned')}
                      disabled={progressBusyKey === `${client.id}:contractSigned`}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-gray-200 text-xs hover:bg-white/15 disabled:opacity-50"
                      title="Angre kontrakt signert og send kunden tilbake i handlinglisten"
                    >
                      Tilbake til salg
                    </button>
                  )}
                </div>

                <div className="flex items-center justify-between gap-2 mt-auto pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setExpandedId((prev) => (prev === client.id ? null : client.id));
                      if (expanded) setShowMailActionsId((current) => (current === client.id ? null : current));
                    }}
                    className="text-xs text-[#FF5B00] hover:underline"
                  >
                    {expanded ? 'Hide details' : 'Details & tools'}
                  </button>
                </div>

                {expanded && (
                  <div className="space-y-4 border-t border-white/10 pt-3">
                    <div className="rounded-xl bg-black/20 border border-white/10 p-4">
                      <div className="text-sm text-white font-medium mb-2">Booking</div>
                      <ul className="space-y-1 text-sm">
                        {bookingRows.map(([label, value]) => (
                          <li key={label}>
                            <span className="text-gray-400">{label}: </span>
                            {value
                              ? <span className="text-gray-200">{value}</span>
                              : <span className="text-red-300">Mangler</span>}
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => setShowMailActionsId((current) => (current === client.id ? null : client.id))}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs ${
                          showMailActions ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
                        }`}
                      >
                        <Mail size={13} />
                        {showMailActions ? 'Skjul e-posthandlinger' : 'Vis e-posthandlinger'}
                      </button>
                    </div>
                    {showMailActions && (
                      <div className="flex flex-wrap items-center gap-2 rounded-xl bg-black/20 border border-white/10 p-3">
                        {([
                          ['thank-you', 'Bekreftelse'],
                          ['3d', '3 dager'],
                          ['24h', '24 timer'],
                          ['1h', '1 time'],
                        ] as const).map(([kind, label]) => (
                          <button
                            key={kind}
                            type="button"
                            onClick={() => void sendClientMail(client, kind)}
                            disabled={Boolean(sendingMailKey)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
                          >
                            {sendingMailKey === `${client.id}:${kind}` ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
                            {label}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => openMailComposer(client, 'thank-you')}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
                          title="Åpne malen, bytt mottaker og send"
                        >
                          Rediger først
                        </button>
                      </div>
                    )}
                    <div className="grid sm:grid-cols-2 gap-4 rounded-xl bg-black/20 border border-white/10 p-4">
                      <details open className="text-sm text-gray-200">
                        <summary className="cursor-pointer text-white font-medium mb-2">Contact & meeting</summary>
                        <ul className="space-y-1 text-gray-300">
                          <li>Contact email: {client.contactEmail || '—'}</li>
                          <li>
                            <label className="block">
                              Client email
                              <input
                                key={`${client.id}:${client.clientEmail || ''}`}
                                type="email"
                                defaultValue={client.clientEmail || ''}
                                placeholder="Kontoen kunden oppretter på asoldi.com"
                                onBlur={(event) => void saveClientEmail(client, event.target.value).catch((err) => {
                                  setError(err instanceof Error ? err.message : 'Kunne ikke lagre klient-e-post');
                                })}
                                className="mt-1 w-full rounded-md bg-black/30 border border-white/10 text-white text-xs px-2 py-1.5"
                              />
                            </label>
                            {client.portalConnectedAt ? (
                              <span className="text-[11px] text-emerald-300">Koblet {formatWhen(client.portalConnectedAt)}</span>
                            ) : null}
                          </li>
                          <li>
                            Website email:{' '}
                            {client.websiteEmail
                              || (client.contactEmail ? `${client.contactEmail} (from contact)` : '—')}
                          </li>
                          <li>Phone: {client.contactPhone || '—'}</li>
                          <li>Meeting: {client.meetingMode === 'in-person' ? 'In person' : 'Online (Google Meet)'}</li>
                          <li>Address: {client.meetingPlace || '—'}</li>
                          <li>Industry: {client.industry || '—'}</li>
                          <li>
                            Duration: {durationForMode(client.meetingMode)} min
                            {client.meetingMode === 'online' ? ' in calendar (client sees 30)' : ''}
                          </li>
                        </ul>
                      </details>
                      <details open className="text-sm text-gray-200">
                        <summary className="cursor-pointer text-white font-medium mb-2">Calendar & reminders</summary>
                        <ul className="space-y-1 text-gray-300">
                          {!clientIsSsu && <li>Website domain: {client.websiteDomain || '—'}</li>}
                          {!clientIsSsu && <li>Public preview: {publicPreviewUrl || '—'}</li>}
                          <li>Calendar event: {client.calendar?.eventId || '—'}</li>
                          <li>Calendar account: {client.calendar?.accountKey || '—'}</li>
                          <li>Meet link: {salesMeetLink(client) || '—'}</li>
                          <li>
                            Fireflies: {client.calendar?.firefliesInvitedAt
                              ? `invitert ${formatWhen(client.calendar.firefliesInvitedAt)}`
                              : 'ikke invitert på Google-eventet — send bekreftelse på nytt'}
                            {client.calendar?.firefliesLiveJoinedAt
                              ? ` · sendt inn i Meet ${formatWhen(client.calendar.firefliesLiveJoinedAt)}`
                              : client.calendar?.firefliesLiveJoinError
                                ? ` · live-join: ${client.calendar.firefliesLiveJoinError}`
                                : client.reminders?.thankYouSentAt
                                  ? ' · sendes inn i Meet ved start (uavhengig av Fireflies Upcoming)'
                                  : ''}
                          </li>
                          <li>
                            Thank-you sent: {client.reminders?.thankYouSentAt ? formatWhen(client.reminders.thankYouSentAt) : 'No'}
                            {showMailActions && (
                            <button
                              type="button"
                              onClick={() => void sendClientMail(client, 'thank-you')}
                              disabled={Boolean(sendingMailKey)}
                              className="ml-2 text-[#FF5B00] hover:underline disabled:opacity-50"
                            >
                              {sendingMailKey === `${client.id}:thank-you`
                                ? 'Sender…'
                                : client.reminders?.thankYouSentAt
                                  ? 'Send på nytt'
                                  : 'Send nå'}
                            </button>
                            )}
                          </li>
                          <li>
                            Reminders:{' '}
                            {showMailActions ? (
                              <>
                                <button type="button" onClick={() => void sendClientMail(client, '3d')} disabled={Boolean(sendingMailKey)} className="ml-2 text-[#FF5B00] hover:underline disabled:opacity-50">3 dager</button>
                                <button type="button" onClick={() => void sendClientMail(client, '24h')} disabled={Boolean(sendingMailKey)} className="ml-2 text-[#FF5B00] hover:underline disabled:opacity-50">24 timer</button>
                                <button type="button" onClick={() => void sendClientMail(client, '1h')} disabled={Boolean(sendingMailKey)} className="ml-2 text-[#FF5B00] hover:underline disabled:opacity-50">1 time</button>
                                <button type="button" onClick={() => openMailComposer(client, '24h')} className="ml-2 text-gray-400 hover:underline">Rediger</button>
                              </>
                            ) : (
                              <span className="text-gray-500">sendes automatisk</span>
                            )}
                          </li>
                          <li>3-day reminder: {client.reminders?.reminder3dSentAt ? formatWhen(client.reminders.reminder3dSentAt) : 'Pending/Skipped'}</li>
                          <li>24h reminder: {client.reminders?.reminder24hSentAt ? formatWhen(client.reminders.reminder24hSentAt) : 'Pending/Skipped'}</li>
                          <li>1h reminder: {client.reminders?.reminder1hSentAt ? formatWhen(client.reminders.reminder1hSentAt) : 'Pending/Skipped'}</li>
                        </ul>
                      </details>
                      <details open className="sm:col-span-2 text-sm text-gray-200">
                        <summary className="cursor-pointer text-white font-medium mb-2">Myphoner intake</summary>
                        <ul className="space-y-1 text-gray-300">
                          <li>Lead ID: {client.myphoner?.leadId || '—'}</li>
                          <li>List: {client.myphoner?.listName || client.myphoner?.listId || '—'}</li>
                          <li>Winner category: {client.myphoner?.winnerCategory || '—'}</li>
                          <li>Last winner sync: {client.myphoner?.lastWinnerWebhookAt ? formatWhen(client.myphoner.lastWinnerWebhookAt) : '—'}</li>
                          <li>Last recording sync: {client.myphoner?.lastRecordingWebhookAt ? formatWhen(client.myphoner.lastRecordingWebhookAt) : '—'}</li>
                          <li>Recording sync status: {client.myphoner?.latestRecordingSyncReason || '—'}</li>
                          <li>Call ID: {client.myphoner?.latestCallId || '—'}</li>
                          <li>Call started: {client.myphoner?.latestCallStartedAt ? formatWhen(client.myphoner.latestCallStartedAt) : '—'}</li>
                        </ul>
                        {client.myphoner?.latestRecordingUrl ? (
                          <div className="mt-3 space-y-2">
                            <button
                              type="button"
                              onClick={() => void toggleInlineRecording(client)}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
                            >
                              {recordingLoadingClientId === client.id ? <Loader2 size={13} className="animate-spin" /> : <Volume2 size={13} />}
                              {recordingOpenClientId === client.id ? 'Hide inline audio' : 'Listen in Sales UI'}
                            </button>
                            {recordingOpenClientId === client.id ? (
                              recordingBlobUrlByClient[client.id] ? (
                                <audio controls preload="metadata" src={recordingBlobUrlByClient[client.id]} className="w-full" />
                              ) : (
                                <p className="text-xs text-amber-300">
                                  {recordingErrorByClient[client.id] || 'Could not load inline audio. Open source URL instead.'}
                                </p>
                              )
                            ) : null}
                            <button
                              type="button"
                              onClick={() => window.open(client.myphoner.latestRecordingUrl, '_blank')}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
                            >
                              <ExternalLink size={12} />
                              Open source URL
                            </button>
                          </div>
                        ) : (
                          <p className="mt-2 text-xs text-gray-500">
                            No call recording synced yet for this lead.
                            {client.myphoner?.latestRecordingSyncReason ? ` Last sync status: ${client.myphoner.latestRecordingSyncReason}.` : ''}
                          </p>
                        )}
                      </details>
                      <details open className="sm:col-span-2 text-sm text-gray-200">
                        <summary className="cursor-pointer text-white font-medium mb-2">QuickFill links</summary>
                        <div className="grid sm:grid-cols-2 gap-3 text-gray-300">
                          <div>
                            <div className="text-xs text-gray-500 uppercase mb-1">Instagram</div>
                            <p>{String(client.details?.instagramUrl || '—')}</p>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500 uppercase mb-1">Facebook</div>
                            <p>{String(client.details?.facebookUrl || '—')}</p>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500 uppercase mb-1">proff.no</div>
                            <p>{String(client.details?.proffUrl || '—')}</p>
                            <p className="mt-1">Org. nr: {client.orgNumber || '—'}</p>
                          </div>
                          <div>
                            <div className="text-xs text-gray-500 uppercase mb-1">Google business profile</div>
                            <p>{String(client.details?.googleBusinessProfile || '—')}</p>
                          </div>
                          <div className="sm:col-span-2">
                            <div className="text-xs text-gray-500 uppercase mb-1">Other links</div>
                            <p style={{ whiteSpace: 'pre-wrap' }}>{String(client.details?.otherLinks || '—')}</p>
                          </div>
                        </div>
                      </details>
                    </div>

                    {!clientIsSsu && (
                    <>
                    <div className="rounded-xl bg-black/20 border border-white/10 p-4 space-y-3">
                      <div className="text-sm text-white font-medium">Public preview</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => openPublicPreview(client)}
                            className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15"
                          >
                            <ExternalLink size={14} />
                            Open preview
                          </button>
                          {previewMissingToastId === client.id && (
                            <div
                              role="status"
                              className="absolute left-0 bottom-full mb-1 z-20 whitespace-nowrap rounded-md border border-amber-700/40 bg-amber-950/95 px-2.5 py-1.5 text-[11px] text-amber-100 shadow-lg"
                            >
                              Not on asoldi.com yet
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard.writeText(publicPreviewUrl).then(
                            () => setNotice(`Copied ${publicPreviewUrl}`),
                            () => setError('Could not copy preview URL')
                          )}
                          className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15"
                        >
                          <Copy size={14} />
                          Copy public URL
                        </button>
                      </div>
                      <p className="text-[11px] text-gray-400 break-all">
                        Internet URL: <span className="text-white">{publicPreviewUrl}</span>
                      </p>
                    </div>

                    <div className="rounded-xl bg-black/20 border border-white/10 p-4 space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-sm text-white font-medium">
                          <Tag size={14} className="text-[#FF5B00]" />
                          Tilbud (nettsidekode)
                        </div>
                        <button
                          type="button"
                          onClick={() => openOfferPanel(client)}
                          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#FF5B00] text-white text-xs hover:bg-[#e55200]"
                        >
                          <Gift size={13} />
                          {offerOpenId === client.id ? 'Lukk' : 'Gi tilbud'}
                        </button>
                      </div>

                      {clientOffers.length > 0 && (
                        <div className="space-y-2">
                          {clientOffers.map((offer) => (
                            <div
                              key={offer.id}
                              className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#1a1a1a] border border-white/10 px-3 py-2"
                            >
                              <div className="flex items-center gap-3 text-sm">
                                <span className="px-2 py-1 rounded bg-[#FF5B00]/20 text-[#ff8a4d] font-mono tracking-widest text-base">{offer.code}</span>
                                <span className="text-gray-200">{offer.planName}</span>
                                <span className="text-gray-500">{offer.price}</span>
                              </div>
                              <div className="flex items-center gap-2 text-xs">
                                <span className="text-gray-400">{offer.targetEmail || 'Ikke tildelt'}</span>
                                <span className={`px-2 py-0.5 rounded ${offer.claimed ? 'bg-green-900/40 text-green-300' : 'bg-amber-900/30 text-amber-300'}`}>
                                  {offer.claimed ? 'Innløst' : 'Aktiv'}
                                </span>
                                {offer.previewUrl && (
                                  <button
                                    type="button"
                                    onClick={() => window.open(offer.previewUrl, '_blank')}
                                    className="inline-flex items-center gap-1 text-gray-300 hover:text-white"
                                  >
                                    <ExternalLink size={12} />
                                    Forhåndsvis
                                  </button>
                                )}
                                <button type="button" onClick={() => void deleteOffer(offer.id)} className="text-gray-400 hover:text-red-400" aria-label="Slett tilbud">
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {offerOpenId === client.id && (
                        <div className="rounded-lg bg-[#1a1a1a] border border-white/10 p-4 space-y-4">
                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Velg tier (anbefalt plan)</label>
                            <div className="grid sm:grid-cols-3 gap-2">
                              {OFFER_TIERS.map((tier) => (
                                <button
                                  key={tier.id}
                                  type="button"
                                  onClick={() => setOfferPlanId(tier.id)}
                                  className={`text-left rounded-lg border px-3 py-2 transition-colors ${
                                    offerPlanId === tier.id ? 'border-[#FF5B00] bg-[#FF5B00]/10' : 'border-white/10 bg-black/20 hover:border-white/20'
                                  }`}
                                >
                                  <div className="text-sm text-white">{tier.name}</div>
                                  <div className="text-xs text-gray-400">{tier.price}</div>
                                </button>
                              ))}
                            </div>
                          </div>

                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Søk etter bruker (e-post, navn eller bedrift)</label>
                            {offerSelectedUser ? (
                              <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/30 px-3 py-2">
                                <div className="text-sm">
                                  <div className="text-white">{offerSelectedUser.name || offerSelectedUser.email}</div>
                                  <div className="text-xs text-gray-400">
                                    {offerSelectedUser.email}
                                    {offerSelectedUser.businessName ? ` · ${offerSelectedUser.businessName}` : ''}
                                  </div>
                                </div>
                                <button type="button" onClick={() => setOfferSelectedUser(null)} className="text-gray-400 hover:text-white" aria-label="Fjern valgt bruker">
                                  <X size={15} />
                                </button>
                              </div>
                            ) : (
                              <>
                                <div className="relative">
                                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                                  <input
                                    value={offerSearch}
                                    onChange={(e) => setOfferSearch(e.target.value)}
                                    placeholder="Søk på e-post, navn eller bedrift…"
                                    className="w-full pl-9 pr-9 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-sm"
                                  />
                                  {offerSearching && (
                                    <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-gray-400" />
                                  )}
                                </div>
                                {offerResults.length > 0 ? (
                                  <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-white/10 divide-y divide-white/5">
                                    {offerResults.map((result) => (
                                      <button
                                        key={result.userId}
                                        type="button"
                                        onClick={() => {
                                          setOfferSelectedUser(result);
                                          setOfferResults([]);
                                        }}
                                        className="w-full text-left px-3 py-2 hover:bg-white/5"
                                      >
                                        <div className="text-sm text-white">{result.name || result.email}</div>
                                        <div className="text-xs text-gray-400">
                                          {result.email}
                                          {result.businessName ? ` · ${result.businessName}` : ''}
                                        </div>
                                      </button>
                                    ))}
                                  </div>
                                ) : !offerSearching ? (
                                  <p className="mt-2 text-xs text-gray-500">
                                    {offerSearch.trim()
                                      ? 'Ingen klientbrukere matcher søket.'
                                      : 'Ingen klientbrukere funnet ennå.'}
                                  </p>
                                ) : null}
                                <p className="mt-1 text-[11px] text-gray-500">
                                  Kun brukere med klient-innlogging vises her. Velg en bruker for å sende tilbudet rett i to-do-listen deres. Uten valgt bruker kan kunden løse inn tilbudet med nettsidekoden.
                                </p>
                              </>
                            )}
                          </div>

                          <div>
                            <label className="block text-xs text-gray-400 mb-1">Notat (valgfritt)</label>
                            <textarea
                              rows={2}
                              value={offerNote}
                              onChange={(e) => setOfferNote(e.target.value)}
                              className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-sm resize-y"
                            />
                          </div>

                          {client.websiteImport?.previewUrl ? (
                            <p className="text-[11px] text-gray-400">Forhåndsvisning av importert nettside legges automatisk ved tilbudet.</p>
                          ) : (
                            <p className="text-[11px] text-gray-500">Tips: utvikler publiserer preview slik at tilbudet får offentlig forhåndsvisning.</p>
                          )}

                          {lastCreatedCode && (
                            <div className="rounded-lg border border-green-600/40 bg-green-900/20 px-3 py-2 text-sm text-green-200">
                              Tilbud opprettet. Nettsidekode:{' '}
                              <span className="font-mono tracking-widest text-base text-white">{lastCreatedCode}</span>
                            </div>
                          )}

                          <button
                            type="button"
                            onClick={() => void createOffer(client)}
                            disabled={creatingOffer}
                            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#FF5B00] text-white text-sm hover:bg-[#e55200] disabled:opacity-50"
                          >
                            {creatingOffer ? <Loader2 size={14} className="animate-spin" /> : <Gift size={14} />}
                            Opprett tilbud
                          </button>
                        </div>
                      )}
                    </div>
                    </>
                    )}
                  </div>
                )}
                {compact && peeked ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      togglePeekCard(client.id);
                    }}
                    className="self-center mt-1 p-1 rounded-full bg-white/10 text-gray-300 hover:text-white"
                    title="Vis mindre"
                    aria-label="Vis mindre"
                  >
                    <ChevronDown size={16} className="rotate-180" />
                  </button>
                ) : null}
                </>
                )}
                </div>
              </React.Fragment>
            );
  }

  return (
    <div className="sales-clients-surface min-h-screen bg-[#1a1a1a] text-white">
      <header ref={headerShellRef} className="sales-sticky-header sticky top-0 z-[70] border-b border-white/10 bg-[#161616] shadow-sm">
        <div className="max-w-[1440px] mx-auto px-3 sm:px-5 py-2.5 flex items-center gap-2 sm:gap-3">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0 shrink-0 relative z-[80]">
            <img src="/media/Untitled-1.png" alt="Asoldi" className="h-8 sm:h-9 w-auto shrink-0" />
            <div className="min-w-0 relative">
              <h1 className="text-sm sm:text-base font-semibold leading-tight truncate">Salgsterminal</h1>
              <button
                type="button"
                onClick={() => {
                  setHeaderPanel(null);
                  setAccountMenuOpen(false);
                  setProductMenuOpen((open) => !open);
                }}
                className="mt-0.5 inline-flex items-center gap-1 text-[11px] sm:text-xs text-gray-300 hover:text-white"
                aria-expanded={productMenuOpen}
              >
                <span className="truncate">
                  {isSsuBracket ? 'SSU' : 'Website'} ({isSsuBracket ? productCounts.ssu : productCounts.asoldi})
                </span>
                <ChevronDown size={12} className={`shrink-0 transition-transform ${productMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {productMenuOpen && (
                <div className="absolute left-0 top-full mt-1 z-[90] min-w-[180px] rounded-xl border border-white/10 bg-[#1f1f1f] shadow-xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => { setProductBracket('asoldi'); setProductMenuOpen(false); }}
                    className={`w-full text-left px-3 py-2 text-sm ${productBracket === 'asoldi' ? 'bg-[#FF5B00] text-white' : 'text-gray-200 hover:bg-white/10'}`}
                  >
                    Website ({productCounts.asoldi})
                  </button>
                  <button
                    type="button"
                    onClick={() => { setProductBracket('ssu'); setProductMenuOpen(false); }}
                    className={`w-full text-left px-3 py-2 text-sm ${productBracket === 'ssu' ? 'bg-[#FF5B00] text-white' : 'text-gray-200 hover:bg-white/10'}`}
                  >
                    SSU ({productCounts.ssu})
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 sm:gap-1.5 min-w-0 flex-1 overflow-x-auto">
            <button
              type="button"
              onClick={() => toggleHeaderPanel('filter')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs sm:text-sm ${
                headerPanel === 'filter' ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
              }`}
              aria-expanded={headerPanel === 'filter'}
            >
              <Filter size={14} />
              <span className="hidden sm:inline">Filter</span>
              {hasActiveFilters ? <span className="h-1.5 w-1.5 rounded-full bg-white sm:bg-orange-200" /> : null}
              <ChevronDown size={12} className={`hidden sm:block transition-transform ${headerPanel === 'filter' ? 'rotate-180' : ''}`} />
            </button>
            <button
              type="button"
              onClick={() => toggleHeaderPanel('map')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-xs sm:text-sm ${
                headerPanel === 'map' ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
              }`}
              aria-expanded={headerPanel === 'map'}
            >
              <MapPin size={14} />
              <span className="hidden sm:inline">Client map</span>
              <span className="sm:hidden">Kart</span>
              <ChevronDown size={12} className={`hidden sm:block transition-transform ${headerPanel === 'map' ? 'rotate-180' : ''}`} />
            </button>
          </div>

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2 shrink-0">
            {isSalesAdmin && (
              <>
                <Link
                  to="/sales/email/templates"
                  className="hidden sm:inline-flex items-center px-2.5 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-xs sm:text-sm"
                >
                  Maler
                </Link>
                {!isSsuBracket && (
                  <a
                    href="https://asoldi.com/previews"
                    target="_blank"
                    rel="noreferrer"
                    className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15"
                    title="Open the public asoldi.com preview board"
                  >
                    <MonitorSmartphone size={14} />
                    Public previews
                  </a>
                )}
              </>
            )}
            <button type="button" onClick={openCreate} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm font-medium hover:bg-[#e55200]">
              <Plus size={16} />
              <span className="hidden sm:inline">Add client</span>
              <span className="sm:hidden">Add</span>
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setHeaderPanel(null);
                  setProductMenuOpen(false);
                  setAccountMenuOpen((open) => !open);
                }}
                className={`inline-flex items-center justify-center h-10 w-10 rounded-lg ${
                  accountMenuOpen ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-white hover:bg-white/15'
                }`}
                title="Konto"
                aria-expanded={accountMenuOpen}
                aria-label="Konto"
              >
                <UserRound size={16} />
              </button>
              {accountMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-[90] w-72 rounded-xl border border-white/10 bg-[#1f1f1f] shadow-xl p-3">
                  <p className={`text-xs ${calendarStatus?.connected ? 'text-green-300' : 'text-red-300'}`}>
                    {calendarStatus?.connected
                      ? (calendarStatus.googleEmail
                        ? `Kalender koblet som ${calendarStatus.googleEmail}`
                        : 'Kalender koblet')
                      : 'Kalender ikke koblet'}
                  </p>
                  <p className="mt-1 text-[11px] text-gray-400">Innlogget som {loggedInAs}</p>
                  {showCalendarConnect && (
                    <button
                      type="button"
                      onClick={() => { setAccountMenuOpen(false); setCalendarPanelOpen(true); }}
                      className="mt-2 w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15"
                    >
                      <Calendar size={14} />
                      {calendarStatus?.connected ? 'Kalenderinnstillinger' : 'Koble Google Calendar'}
                    </button>
                  )}
                  {canSignOut && (
                    <button
                      type="button"
                      onClick={() => onLogout?.()}
                      className="mt-2 w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15"
                    >
                      <LogOut size={14} />
                      Logg ut
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {(headerPanel || mapMounted) && (
          <div className={headerPanel ? 'border-t border-white/10 bg-[#1a1a1a]' : 'hidden'}>
            <div className="max-w-[1440px] mx-auto px-3 sm:px-5 py-3">
              {headerPanel && (
              <div className="flex items-center justify-between gap-2 mb-2">
                <p className="text-[11px] text-gray-400">
                  Lukk: klikk {headerPanel === 'filter' ? 'Filter' : 'Client map'} igjen, klikk under, eller scroll.
                </p>
                <button type="button" onClick={closeHeaderMenus} className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-white">
                  <X size={12} /> Lukk
                </button>
              </div>
              )}
              {headerPanel === 'filter' && (
                <form onSubmit={applyClientNameSearch} className="rounded-xl border border-white/10 bg-black/20 p-2.5 sm:p-3 space-y-2.5">
                  <div className="flex flex-col sm:flex-row gap-2">
                    <div className="relative flex-1">
                      <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input
                        value={clientSearchInput}
                        onChange={(e) => setClientSearchInput(e.target.value)}
                        placeholder="Business, contact, or area"
                        className="w-full pl-9 pr-3 py-2 rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm"
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        className="inline-flex flex-1 sm:flex-none items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm hover:bg-[#e55200]"
                      >
                        <Search size={14} />
                        Search
                      </button>
                      {hasActiveFilters && (
                        <button
                          type="button"
                          onClick={clearClientNameSearch}
                          className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-white/10 text-white text-sm hover:bg-white/15"
                        >
                          <X size={14} />
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                  {isSalesAdmin && (
                    <label className="text-[11px] text-gray-400 block">
                      <span className="inline-flex items-center gap-1 mb-1">
                        <Filter size={12} />
                        Sales rep
                      </span>
                      <select
                        value={ownerFilter}
                        onChange={(event) => setOwnerFilter(event.target.value)}
                        className="mt-1 w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
                      >
                        <option value="">All owners</option>
                        <option value="unassigned">Unassigned</option>
                        {ownerFilterOptions.map((owner) => (
                          <option key={owner.accountKey} value={owner.accountKey}>
                            {ownerLabel(owner)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className="grid sm:grid-cols-3 gap-2">
                    <label className="text-[11px] text-gray-400 block">
                      <span className="block mb-1">Møteform</span>
                      <select
                        value={meetingModeFilter}
                        onChange={(event) => setMeetingModeFilter(event.target.value)}
                        className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
                      >
                        <option value="">Alle</option>
                        <option value="online">Online</option>
                        <option value="in-person">IRL</option>
                      </select>
                    </label>
                    <label className="text-[11px] text-gray-400 block">
                      <span className="block mb-1">Neste handling fra</span>
                      <input
                        type="date"
                        value={nextActionFromDate}
                        onChange={(event) => setNextActionFromDate(event.target.value)}
                        className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
                      />
                    </label>
                    <label className="text-[11px] text-gray-400 block">
                      <span className="block mb-1">Neste handling til</span>
                      <input
                        type="date"
                        value={nextActionToDate}
                        onChange={(event) => setNextActionToDate(event.target.value)}
                        className="w-full rounded-lg bg-[#1a1a1a] border border-white/10 text-white text-sm px-3 py-2"
                      />
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-[11px]">
                    <span className="px-2 py-0.5 rounded border border-white/10 bg-black/30 text-gray-300">Mail {emailAudit.total}</span>
                    <span className="px-2 py-0.5 rounded border border-green-700/30 bg-green-900/20 text-green-300">OK {emailAudit.validNonTest}</span>
                    <span className="px-2 py-0.5 rounded border border-amber-700/30 bg-amber-900/20 text-amber-300">Missing {emailAudit.missing}</span>
                    <span className="px-2 py-0.5 rounded border border-red-700/30 bg-red-900/20 text-red-300">Invalid {emailAudit.invalid}</span>
                    <span className="px-2 py-0.5 rounded border border-purple-700/30 bg-purple-900/20 text-purple-300">Test {emailAudit.flaggedTest}</span>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-white/10">
                    <label className="inline-flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        disabled={!visibleSelectableIds.length || bulkBusy}
                        onChange={toggleSelectAllVisible}
                        className="h-4 w-4 accent-[#FF5B00]"
                      />
                      Select all
                      <span className="text-xs text-gray-400">
                        {selectedCount
                          ? `${selectedCount} selected`
                          : `${visibleSelectableIds.length} visible`}
                      </span>
                    </label>
                    {selectedCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedClientIds([])}
                        disabled={bulkBusy}
                        className="text-xs text-gray-400 hover:text-white disabled:opacity-50"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </form>
              )}
              {mapMounted && (
                <div className={headerPanel === 'map' ? '' : 'hidden'} aria-hidden={headerPanel !== 'map'}>
                  <div className="flex flex-wrap gap-2 text-[11px] text-gray-400">
                    <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#FF5B00]" /> In person</span>
                    <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#3b82f6]" /> Online</span>
                    <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#a855f7]" /> Secondary</span>
                    <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#6b7280]" /> Not sold</span>
                    <span className="text-xs px-2 py-1 rounded bg-black/20 border border-white/10 text-gray-300">{visibleMeetingMapPins.length} pins</span>
                  </div>
                  {meetingMapError && (
                    <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 text-red-300 px-3 py-2 text-xs">
                      {meetingMapError}
                    </div>
                  )}
                  <div className="mt-3 h-[220px] sm:h-[340px] rounded-xl border border-white/10 overflow-hidden relative z-0 isolate">
                    <div ref={meetingMapContainerRef} className="h-full w-full relative z-0" />
                    {meetingMapLoading && (
                      <div className="absolute inset-0 bg-black/55 flex items-center justify-center text-gray-200 text-sm">
                        <Loader2 size={16} className="animate-spin mr-2" />
                        Loading map pins…
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </header>

      <div className="max-w-[1440px] mx-auto px-3 sm:px-6 py-4 space-y-3 sm:space-y-4">
      {!isSalesAdmin && verifiedInbox.length > 0 && (
        <div className="relative rounded-2xl border border-sky-400/30 bg-sky-900/30 p-3 sm:p-4">
          <button
            type="button"
            onClick={() => setVerifiedInboxOpen((open) => !open)}
            className="w-full flex items-center justify-between gap-3 text-left"
          >
            <span className="inline-flex items-center gap-2 text-sm font-medium text-sky-100">
              <ShieldCheck size={16} />
              Tilbud verifisert
              <span className="inline-flex min-w-6 h-6 items-center justify-center rounded-full bg-sky-500 text-white text-xs font-semibold px-1.5">
                {verifiedInbox.length}
              </span>
            </span>
            <ChevronDown size={16} className={`text-sky-300 transition-transform ${verifiedInboxOpen ? '' : '-rotate-90'}`} />
          </button>
          {verifiedInboxOpen && (
            <div className="mt-3 rounded-xl border border-white/10 bg-[#1a1a1a] overflow-hidden">
              {verifiedInbox.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => openVerifiedOffer(client)}
                  className="w-full text-left px-3 py-2.5 text-sm text-white hover:bg-white/5 border-b border-white/5 last:border-b-0"
                >
                  {client.businessName || 'Uten navn'}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="rounded-2xl bg-[#2a2a2a] border border-white/10 p-3 sm:p-4 space-y-3">
        <div className="space-y-2">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {SALES_PIPELINE_STATES.map((state) => {
              const count = pipelineCounts[state.id as keyof typeof pipelineCounts] || 0;
              const selected = pipelineFilter === state.id;
              return (
                <button
                  key={state.id}
                  type="button"
                  onClick={() => setPipelineFilter(selected ? '' : state.id)}
                  className={`rounded-xl border px-3 py-2.5 text-left transition-colors ${
                    selected
                      ? 'bg-[#FF5B00] border-[#FF5B00] text-white'
                      : 'bg-black/20 border-white/10 text-gray-200 hover:bg-white/10'
                  }`}
                >
                  <span className={`block text-lg font-semibold tabular-nums leading-none ${selected ? 'text-white' : 'text-white'}`}>
                    {count}
                  </span>
                  <span className={`mt-1 block text-[12px] font-medium ${selected ? 'text-white' : 'text-gray-200'}`}>
                    {state.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {selectedCount > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {isSalesAdmin && salesOwners.length > 0 && (
              <div className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5 max-w-full">
                <Users size={14} className="text-[#FF5B00] shrink-0" />
                <select
                  value={bulkAssignOwnerId}
                  disabled={bulkBusy}
                  onChange={(event) => setBulkAssignOwnerId(event.target.value)}
                  className="bg-transparent text-xs text-gray-200 outline-none disabled:opacity-50 min-w-0"
                >
                  <option value="">Velg selger…</option>
                  {salesRepOptions.map((owner) => (
                    <option key={owner.accountKey} value={owner.accountKey}>
                      {ownerLabel(owner)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={bulkBusy || !bulkAssignOwnerId}
                  onClick={() => void runBulkAction('assign', { ownerId: bulkAssignOwnerId })}
                  className="px-2 py-1 rounded-md bg-[#FF5B00] text-white text-xs hover:bg-[#e55200] disabled:opacity-50"
                >
                  Tildel
                </button>
              </div>
            )}
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void runBulkAction('delete')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-900/40 text-red-200 text-xs hover:bg-red-900/50 disabled:opacity-50"
            >
              {bulkBusy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
              Delete
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void runBulkAction('not-sold')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-gray-200 text-xs hover:bg-white/15 disabled:opacity-50"
            >
              <ArchiveX size={13} />
              Not sold
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void runBulkAction('secondary')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-gray-200 text-xs hover:bg-white/15 disabled:opacity-50"
            >
              Secondary
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void runBulkAction('restore')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-gray-200 text-xs hover:bg-white/15 disabled:opacity-50"
            >
              <Undo2 size={13} />
              Restore
            </button>
            <button
              type="button"
              disabled={bulkBusy}
              onClick={() => void runBulkAction('send-welcome')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#FF5B00] text-white text-xs hover:bg-[#e55200] disabled:opacity-50"
            >
              {bulkBusy ? <Loader2 size={13} className="animate-spin" /> : <Mail size={13} />}
              Send bekreftelse
            </button>
          </div>
        )}
      </div>

      {(error || notice) && (
        <div className="space-y-2">
          {error && <div className="rounded-xl border border-red-500/20 bg-red-500/10 text-red-300 px-3 py-2.5 sm:px-4 sm:py-3 text-sm shadow-lg shadow-black/30">{error}</div>}
          {notice && <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-200 px-3 py-2.5 sm:px-4 sm:py-3 text-sm shadow-lg shadow-black/30">{notice}</div>}
        </div>
      )}


      {loading && clients.length === 0 ? (
        <div className="min-h-[180px] flex items-center justify-center text-gray-400">
          <Loader2 className="animate-spin mr-2" size={18} /> Loading sales clients…
        </div>
      ) : (
        <div className="space-y-3">
          {isSalesAdmin && (
            <div className="rounded-xl border border-[#FF5B00]/40 bg-[#2a2a2a] p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-sm font-semibold text-white">Tildel selger</div>
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    {awaitingRepClients.length} venter
                  </p>
                </div>
                <div className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-black/20 px-2 py-1.5">
                  <Users size={14} className="text-[#FF5B00]" />
                  <select
                    value={bulkAssignOwnerId}
                    disabled={bulkBusy || !salesRepOptions.length}
                    onChange={(event) => setBulkAssignOwnerId(event.target.value)}
                    className="bg-transparent text-xs text-gray-200 outline-none disabled:opacity-50"
                  >
                    <option value="">Velg selger…</option>
                    {salesRepOptions.map((owner) => (
                      <option key={owner.accountKey} value={owner.accountKey}>
                        {ownerLabel(owner)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={bulkBusy || !bulkAssignOwnerId || !selectedCount}
                    onClick={() => void runBulkAction('assign', { ownerId: bulkAssignOwnerId })}
                    className="px-2 py-1 rounded-md bg-[#FF5B00] text-white text-xs hover:bg-[#e55200] disabled:opacity-50"
                  >
                    Tildel
                  </button>
                </div>
              </div>
            </div>
          )}
          {pipelineFilter !== 'win' && (
          <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
            {timelineRows.map((row) => {
            if (row.kind === 'divider') {
              return (
                <div
                  key={row.id}
                  className="md:col-span-2 lg:col-span-3 h-px bg-gradient-to-r from-transparent via-neutral-400/70 to-transparent"
                  aria-hidden="true"
                />
              );
            }
            if (row.kind === 'header') {
              const collapsed = row.collapsed;
              const toneClass =
                row.tone === 'assign'
                  ? 'border-orange-300 bg-orange-50 text-orange-950'
                  : row.tone === 'recent'
                  ? 'border-amber-300 bg-amber-50 text-amber-900'
                  : row.tone === 'upcoming'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                    : row.tone === 'past'
                      ? 'border-red-200 bg-red-50 text-red-800'
                      : 'border-neutral-200 bg-neutral-50 text-neutral-700';
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => toggleTimelineBucket(row.id)}
                  className={`md:col-span-2 lg:col-span-3 rounded-xl border px-3 py-2.5 text-left ${toneClass}`}
                  aria-expanded={!collapsed}
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="block text-sm font-semibold">{row.title}</span>
                    <span className="inline-flex items-center gap-2 shrink-0">
                      <span className="text-sm font-semibold tabular-nums">{row.count}</span>
                      {row.count > SALES_COMPACT_PREVIEW ? (
                        <span className="text-xs font-medium opacity-80">
                          {collapsed ? 'Vis alle' : 'Vis færre'}
                        </span>
                      ) : null}
                      <ChevronDown size={16} className={`transition-transform ${collapsed ? '' : 'rotate-180'}`} />
                    </span>
                  </span>
                </button>
              );
            }
            if (row.kind === 'more') {
              return (
                <div key={row.id} className="md:col-span-2 lg:col-span-3">
                  {renderCategoryMore(row.bucketId, row.count, 'w-full')}
                </div>
              );
            }
            return renderSalesClientCard(row.client, false, row.compact);
          })}

          {timelineClients.length === 0 && pipelineFilter !== 'win' && (
            <div className="md:col-span-2 lg:col-span-3 rounded-2xl bg-[#2a2a2a] border border-white/10 p-8 text-center text-gray-400">
              {hasActiveFilters
                ? (
                  <>
                    No clients matched these filters
                    {clientSearchQuery ? <> for <strong className="text-white">"{clientSearchQuery}"</strong></> : null}.
                  </>
                )
                : (
                  <>
                    No {isSsuBracket ? 'SSU' : 'website'} sales clients in active/secondary timeline right now. Click <strong className="text-white">Add client</strong> to start.
                  </>
                )}
            </div>
          )}
        </div>
          </>
          )}
        </div>
      )}

      {winClients.length > 0 && (
        <div className="rounded-2xl bg-[#2a2a2a] border border-white/10 p-4 space-y-3">
          <button
            type="button"
            onClick={() => toggleTimelineBucket('wins')}
            className="w-full flex items-center justify-between gap-3 text-left"
          >
            <h3 className="text-white font-semibold">Wins</h3>
            <span className="inline-flex items-center gap-2 shrink-0">
              <span className="text-xs px-2 py-1 rounded bg-emerald-900/30 border border-emerald-700/30 text-emerald-200">
                {winClients.length} solgt
              </span>
              {winClients.length > SALES_COMPACT_PREVIEW ? (
                <span className="text-xs text-gray-300">
                  {collapsedBuckets.wins !== false ? 'Vis alle' : 'Vis færre'}
                </span>
              ) : null}
              <ChevronDown size={16} className={`text-gray-400 transition-transform ${collapsedBuckets.wins !== false ? '' : 'rotate-180'}`} />
            </span>
          </button>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {(collapsedBuckets.wins !== false ? winClients.slice(0, SALES_COMPACT_PREVIEW) : winClients).map((client) => (
              renderSalesClientCard(client, true, true)
            ))}
          </div>
          {renderCategoryMore('wins', winClients.length)}
        </div>
      )}

      {archivedClients.length > 0 && (
        <div className="rounded-2xl bg-[#2a2a2a] border border-white/10 p-4 space-y-3 opacity-80">
          <button
            type="button"
            onClick={() => toggleTimelineBucket('archived')}
            className="w-full flex items-center justify-between gap-3 text-left"
          >
            <h3 className="text-white font-semibold">Archived (Not sold)</h3>
            <span className="inline-flex items-center gap-2 shrink-0">
              <span className="text-xs px-2 py-1 rounded bg-black/20 border border-white/10 text-gray-300">
                {archivedClients.length} archived
              </span>
              {archivedClients.length > SALES_COMPACT_PREVIEW ? (
                <span className="text-xs text-gray-300">
                  {collapsedBuckets.archived !== false ? 'Vis alle' : 'Vis færre'}
                </span>
              ) : null}
              <ChevronDown size={16} className={`text-gray-400 transition-transform ${collapsedBuckets.archived !== false ? '' : 'rotate-180'}`} />
            </span>
          </button>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {(collapsedBuckets.archived !== false ? archivedClients.slice(0, SALES_COMPACT_PREVIEW) : archivedClients).map((client) => {
              const clientSelected = selectedClientIds.includes(client.id);
              const compactArchived = !peekCardIds[client.id];
              return (
              <div
                key={client.id}
                onClick={(event) => handleClientCardClick(event, client.id)}
                className={`rounded-xl border p-2.5 cursor-pointer ${
                  compactArchived ? '' : 'space-y-2'
                } ${
                  clientSelected
                    ? `bg-[#2a2a2a] hover:bg-[#323232] ${SALES_CARD_SELECTED}`
                    : 'bg-black/20 hover:bg-[#2f2f2f] border-white/10'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <input
                        type="checkbox"
                        checked={clientSelected}
                        onChange={() => toggleClientSelected(client.id)}
                        onClick={(event) => event.stopPropagation()}
                        aria-label={`Select ${client.businessName || 'archived client'}`}
                        className="h-4 w-4 shrink-0 accent-[#FF5B00] cursor-pointer"
                      />
                      <div className="text-sm font-medium text-white truncate">{client.businessName || 'Unnamed business'}</div>
                    </div>
                    <div className="mt-1 text-xs text-gray-400 truncate">
                      {[client.contactPerson || 'No contact person', client.contactPhone, client.meetingPlace || 'No address']
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                    {compactArchived ? (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          togglePeekCard(client.id);
                        }}
                        className="mt-0.5 mx-auto p-0.5 rounded text-gray-400 hover:text-white"
                        title="Vis mer på dette kortet"
                        aria-label="Vis mer på dette kortet"
                      >
                        <ChevronDown size={14} />
                      </button>
                    ) : null}
                  </div>
                  <span className="text-[11px] px-2 py-0.5 rounded bg-red-900/30 text-red-300 border border-red-700/30">
                    Not sold
                  </span>
                </div>
                {!compactArchived && (
                <>
                <div className="text-xs text-gray-400">
                  Archived: {formatDateTime(client.archive?.archivedAt || client.updatedAt)}
                </div>
                {client.archive?.reason ? (
                  <div className="text-xs text-gray-300">
                    Reason: {client.archive.reason}
                  </div>
                ) : (
                  <div className="text-xs text-gray-500">No reason added.</div>
                )}
                <ClientNotesField
                  label="Notater"
                  value={clientNoteDraft(client)}
                  saving={savingNoteId === client.id}
                  dirty={clientNoteDraft(client).trim() !== String(client.notes || '').trim()}
                  onChange={(value) => setNoteDrafts((prev) => ({ ...prev, [client.id]: value }))}
                  onSave={() => void saveClientNotes(client)}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void restoreArchivedClient(client)}
                    disabled={statusBusyId === `restore:${client.id}`}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/15 disabled:opacity-50"
                  >
                    {statusBusyId === `restore:${client.id}` ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
                    Restore to active
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteArchivedClient(client)}
                    disabled={deletingArchivedId === client.id}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-900/30 text-red-200 text-xs hover:bg-red-900/40 disabled:opacity-50"
                  >
                    {deletingArchivedId === client.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    Delete permanently
                  </button>
                </div>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    togglePeekCard(client.id);
                  }}
                  className="self-center mt-1 p-1 rounded-full bg-white/10 text-gray-300 hover:text-white"
                  title="Vis mindre"
                  aria-label="Vis mindre"
                >
                  <ChevronDown size={16} className="rotate-180 mx-auto" />
                </button>
                </>
                )}
              </div>
              );
            })}
          </div>
          {renderCategoryMore('archived', archivedClients.length)}
        </div>
      )}

      </div>

      {(showForm || inClientFlow) && (
        <div className={inClientFlow ? 'fixed inset-0 z-[80] flex flex-col bg-[#1a1a1a]' : 'fixed inset-0 z-[80] bg-black/70 flex items-center justify-center p-3 sm:p-4'}>
          {inClientFlow && (
            <div className="shrink-0 border-b border-[#E6E9EF] bg-white text-[#111827]">
              <div className="px-3 sm:px-5 pt-2 sm:pt-3 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold truncate text-sm sm:text-base">{flowClient?.businessName || 'Kunde'}</div>
                  <div className="hidden sm:block text-xs text-[#6B7280]">Kundekort, produktnotater og tilbud</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={saving || !clientCardDirty}
                    onClick={() => { void saveForm(undefined, { keepOpen: true }); }}
                    className={`px-3 py-2 rounded-lg text-sm font-medium ${
                      clientCardDirty
                        ? 'bg-[#FF5B00] text-white'
                        : 'bg-[#F3F4F6] text-[#9CA3AF] cursor-default'
                    }`}
                  >
                    {saving ? 'Lagrer…' : 'Lagre'}
                  </button>
                  <button type="button" onClick={requestCloseClientFlow} className="px-3 py-2 rounded-lg bg-[#F3F4F6] text-sm text-[#111827]">Lukk</button>
                </div>
              </div>
              {error ? <p className="px-3 sm:px-5 pt-2 text-xs text-red-600">{error}</p> : null}
              <div className="px-3 sm:px-5 py-0 sm:py-3">
                <SalesFlowSteps step={flowStep} onStep={(step) => void goFlowStep(step)} />
              </div>
            </div>
          )}
          <div className={inClientFlow
            ? `flex-1 min-h-0 ${flowStep === 2 ? 'overflow-hidden' : 'overflow-auto'}`
            : 'w-full max-w-3xl rounded-2xl bg-[#1f1f1f] border border-white/10 p-4 sm:p-6 max-h-[90vh] overflow-y-auto'}>
            {(!inClientFlow || flowStep === 1) && (
            <div className={inClientFlow ? 'max-w-3xl mx-auto p-3 sm:p-6' : ''}>
            <h3 className="text-lg sm:text-xl font-semibold text-white mb-4">{editingId ? 'Kundekort' : 'Add sales client'}</h3>
            {inClientFlow && contractMissing.length > 0 && (
              <div className="mb-4 rounded-xl border border-amber-400/40 bg-amber-950/40 px-4 py-3 text-sm text-amber-100">
                <div className="font-medium">Kontrakten mangler data</div>
                <div>{offerReadinessMessage(contractMissing)} Legg proff.no-lenke og adresse inn på dette kortet.</div>
              </div>
            )}
            <form onSubmit={(event) => { void saveForm(event, { keepOpen: inClientFlow }); }} className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-300 mb-1">Product</label>
                <select
                  value={form.product}
                  onChange={(e) =>
                    setForm((prev) => ({
                      ...prev,
                      product: e.target.value === 'ssu' ? 'ssu' : 'asoldi',
                      websiteDomain: e.target.value === 'ssu' ? '' : prev.websiteDomain,
                    }))
                  }
                  className="w-full px-3 sm:px-4 py-2.5 sm:py-3 rounded-lg bg-[#161616] border border-white/10 text-white"
                >
                  <option value="asoldi">Websites (Asoldi)</option>
                  <option value="ssu">SSU</option>
                </select>
              </div>
              <Field label="Business name" value={form.businessName} onChange={(value) => setForm((prev) => ({ ...prev, businessName: value }))} required />
              <Field label="Contact person" value={form.contactPerson} onChange={(value) => setForm((prev) => ({ ...prev, contactPerson: value }))} required />
              <Field
                label="Contact email"
                type="email"
                value={form.contactEmail}
                onChange={(value) => setForm((prev) => ({ ...prev, contactEmail: value }))}
              />
              <Field
                label="Website email"
                type="email"
                value={form.websiteEmail || form.contactEmail}
                hint="This is Til on the offer. It starts as the contact email. Change it here if the offer should go to another address. It is not edited on the offer page."
                onChange={(value) => {
                  const next = value.trim();
                  const contact = form.contactEmail.trim();
                  if (!next || next.toLowerCase() === contact.toLowerCase()) {
                    setWebsiteEmailTouched(false);
                    setForm((prev) => ({ ...prev, websiteEmail: '' }));
                    return;
                  }
                  setWebsiteEmailTouched(true);
                  setForm((prev) => ({ ...prev, websiteEmail: value }));
                }}
              />
              <Field label="Phone number" value={form.contactPhone} onChange={(value) => setForm((prev) => ({ ...prev, contactPhone: value }))} />
              <Field label="Industry" value={form.industry} onChange={(value) => setForm((prev) => ({ ...prev, industry: value }))} />
              {form.product !== 'ssu' && (
                <Field label="Website domain (optional)" value={form.websiteDomain} onChange={(value) => setForm((prev) => ({ ...prev, websiteDomain: value }))} />
              )}
              <Field label="Instagram URL" value={form.instagramUrl} onChange={(value) => setForm((prev) => ({ ...prev, instagramUrl: value }))} />
              <Field label="Facebook URL" value={form.facebookUrl} onChange={(value) => setForm((prev) => ({ ...prev, facebookUrl: value }))} />
              <div>
                <Field label="proff.no URL" value={form.proffUrl} onChange={(value) => setForm((prev) => ({ ...prev, proffUrl: value }))} />
                <p className="mt-1 text-[11px] text-gray-500">
                  Org. nr hentes fra lenken når den er lagt inn{form.orgNumber ? `: ${form.orgNumber}` : ''}. Uten lenke hentes ingenting. Adressen er feltet «Business address (shown on map)».
                </p>
              </div>
              <Field
                label="Google business profile URL"
                value={form.googleBusinessProfile}
                onChange={(value) => setForm((prev) => ({ ...prev, googleBusinessProfile: value }))}
              />

              <Field
                label={form.meetingMode === 'in-person' ? 'Place to meet' : 'Business address (shown on map)'}
                value={form.meetingPlace}
                onChange={(value) => setForm((prev) => ({ ...prev, meetingPlace: value }))}
              />

              <p className="text-[11px] text-gray-500">
                Møtetid og Online/IRL settes på møtehandlingen i målstegene. Adressen her brukes på kartet og til IRL-møter.
              </p>

              <TextArea label="Other links (one per line)" value={form.otherLinks} onChange={(value) => setForm((prev) => ({ ...prev, otherLinks: value }))} />

              <TextArea
                label="Sales notes (Notater on the card — not product notes)"
                value={form.notes}
                onChange={(value) => setForm((prev) => ({ ...prev, notes: value }))}
              />

              {editingId && (
                <div className="md:col-span-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      const client = clients.find((entry) => entry.id === editingId);
                      if (!client) return;
                      openSecondaryPicker([client]);
                    }}
                    className="px-4 py-2 rounded-lg bg-white/10 text-gray-200 text-sm hover:bg-white/15"
                  >
                    Ikke interessert i nettside
                  </button>
                  {clients.find((entry) => entry.id === editingId)?.status === 'secondary' && (
                    <button
                      type="button"
                      onClick={() => {
                        const client = clients.find((entry) => entry.id === editingId);
                        if (!client) return;
                        void restoreArchivedClient(client);
                      }}
                      className="px-4 py-2 rounded-lg bg-white/10 text-gray-200 text-sm hover:bg-white/15"
                    >
                      Restore active
                    </button>
                  )}
                </div>
              )}

              {!inClientFlow && (
              <div className="md:col-span-2 flex justify-end gap-2 mt-2">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg bg-white/10 text-white">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-[#FF5B00] text-white disabled:opacity-50">
                  {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create sales client'}
                </button>
              </div>
              )}
            </form>
            </div>
            )}
            {inClientFlow && flowStep === 2 && flowClient && (
              <MeetingNotesModal
                key={flowClient.id}
                embedded
                businessName={flowClient.businessName}
                quote={flowClient.details?.meetingQuote}
                workshopAction={flowClient.workshopAction}
                saving={savingNoteId === flowClient.id}
                onPersist={(payload) => saveMeetingNotes(flowClient, payload)}
                onPersistWorkshop={(payload) => saveWorkshopAction(flowClient, payload)}
                onFlushReady={(flush) => { notesFlushRef.current = flush; }}
                onContinue={() => void goFlowStep(3)}
              />
            )}
            {inClientFlow && flowStep === 3 && flowClient && (
              <SalesOfferComposer embedded clientId={flowClient.id} />
            )}
          </div>
          {inClientFlow && (
            <div className="shrink-0 sticky bottom-0 z-10 border-t border-[#E6E9EF] bg-white px-3 sm:px-5 py-3 flex items-center justify-between gap-3">
              <button
                type="button"
                disabled={saving || flowStep === 1}
                onClick={() => void goFlowStep((flowStep - 1) as 1 | 2 | 3)}
                className="px-4 py-2.5 rounded-lg bg-[#F3F4F6] text-sm font-medium text-[#111827] disabled:opacity-40"
              >
                Forrige
              </button>
              <button
                type="button"
                disabled={saving || flowStep === 3}
                onClick={() => void goFlowStep((flowStep + 1) as 1 | 2 | 3)}
                className="px-4 py-2.5 rounded-lg bg-[#FF5B00] text-sm font-medium text-white disabled:opacity-40"
              >
                {saving ? 'Lagrer…' : (
                  <>
                    <span className="sm:hidden">Neste</span>
                    <span className="hidden sm:inline">{flowStep === 1 ? 'Neste · Produktnotater' : flowStep === 2 ? 'Neste · Tilbud' : 'Neste'}</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      )}
      {calendarPanelOpen && (
        <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/60 p-3 sm:p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#2a2a2a] border border-white/10 p-4 sm:p-5 text-white shadow-xl" role="dialog" aria-modal="true" aria-labelledby="sales-calendar-title">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 id="sales-calendar-title" className="text-base font-semibold">Google Calendar</h3>
                <p className={`mt-1 text-xs ${calendarStatus?.connected ? 'text-green-300' : 'text-red-300'}`}>
                  {calendarStatus?.connected
                    ? (calendarStatus.googleEmail
                      ? `Connected as ${calendarStatus.googleEmail}${calendarStatus.googleName ? ` (${calendarStatus.googleName})` : ''}`
                      : 'Connected, but the Google account is unknown. Reconnect and pick the work account.')
                    : calendarStatus?.configured === false
                      ? 'Not configured on the server.'
                      : 'Not connected'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCalendarPanelOpen(false)}
                className="p-2 rounded-lg bg-white/10 hover:bg-white/15"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <p className="mt-3 text-[11px] text-gray-400">
              Logged in as {loggedInAs}. Calendar is a separate Google login for this sales user.
              {calendarStatus?.loginRole === 'admin'
                ? ' You are logged in as admin, so Connect binds the admin’s Google account. Each salesperson must log in at /sales as themselves and connect.'
                : ' Use a personal Gmail, or a Google account created with their @asoldi.com address.'}
            </p>
            {showCalendarConnect && (
              <button
                type="button"
                onClick={() => void connectGoogleCalendar()}
                className="mt-4 w-full inline-flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg bg-[#FF5B00] text-white text-sm hover:bg-[#e55200]"
              >
                {calendarConnecting ? <Loader2 size={14} className="animate-spin" /> : <Calendar size={14} />}
                {calendarConnecting
                  ? 'Waiting for Google…'
                  : calendarStatus?.connected ? 'Reconnect Google Calendar' : 'Connect Google Calendar'}
              </button>
            )}
          </div>
        </div>
      )}
      {secondaryPicker && (
        <div className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center bg-black/60 p-3 sm:p-4">
          <div className="w-full max-w-md rounded-2xl bg-[#2a2a2a] border border-white/10 p-4 sm:p-5 text-white shadow-xl" role="dialog" aria-modal="true" aria-labelledby="sales-secondary-title">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 id="sales-secondary-title" className="text-base font-semibold">Secondary</h3>
                <p className="mt-1 text-xs text-gray-400">
                  Velg Redesign, Consulting, eller et sekundært produkt for {secondaryPicker.label}.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSecondaryPicker(null)}
                className="p-2 rounded-lg bg-white/10 hover:bg-white/15"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {SECONDARY_INTEREST_PRIMARY.map((option) => {
                const selected = secondaryPicker.selected === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setSecondaryPicker((prev) => (prev ? { ...prev, selected: option.id } : prev))}
                    className={`rounded-xl border px-3 py-2.5 text-left text-sm font-medium ${
                      selected
                        ? 'bg-[#FF5B00] border-[#FF5B00] text-white'
                        : 'bg-black/20 border-white/10 text-gray-200 hover:bg-white/10'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            <p className="mt-4 text-[11px] uppercase tracking-wide text-gray-500">Sekundært</p>
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
              {SECONDARY_INTEREST_MORE.map((option) => {
                const selected = secondaryPicker.selected === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setSecondaryPicker((prev) => (prev ? { ...prev, selected: option.id } : prev))}
                    className={`rounded-xl border px-3 py-2.5 text-left text-sm font-medium ${
                      selected
                        ? 'bg-[#FF5B00] border-[#FF5B00] text-white'
                        : 'bg-black/20 border-white/10 text-gray-200 hover:bg-white/10'
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            {error ? <p className="mt-3 text-sm text-red-300">{error}</p> : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSecondaryPicker(null)}
                className="px-3 py-2 rounded-lg bg-white/10 text-sm text-gray-200 hover:bg-white/15"
              >
                Avbryt
              </button>
              <button
                type="button"
                disabled={!secondaryPicker.selected || bulkBusy || Boolean(statusBusyId)}
                onClick={() => void saveSecondaryPicker()}
                className="px-3 py-2 rounded-lg bg-[#FF5B00] text-sm font-medium text-white hover:bg-[#e55200] disabled:opacity-50"
              >
                {bulkBusy || statusBusyId ? 'Lagrer…' : 'Lagre'}
              </button>
            </div>
          </div>
        </div>
      )}
      {discardPrompt && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 text-[#111827] shadow-xl" role="dialog" aria-modal="true" aria-labelledby="unsaved-client-card-title">
            <h3 id="unsaved-client-card-title" className="text-lg font-semibold">Lagre endringer?</h3>
            <p className="mt-2 text-sm text-[#4B5563]">
              Kundekortet har endringer som ikke er lagret. Lagre og lukk, eller lukk uten å lagre.
            </p>
            {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setDiscardPrompt(false)} className="px-3 py-2 rounded-lg bg-[#F3F4F6] text-sm">
                Avbryt
              </button>
              <button type="button" onClick={closeClientFlow} className="px-3 py-2 rounded-lg border border-[#E5E7EB] text-sm">
                Lukk uten å lagre
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => void saveClientCardAndClose()}
                className="px-3 py-2 rounded-lg bg-[#FF5B00] text-sm font-medium text-white disabled:opacity-50"
              >
                {saving ? 'Lagrer…' : 'Lagre og lukk'}
              </button>
            </div>
          </div>
        </div>
      )}
      {showScriptsDock && !showForm && !flowClientId ? <SalesScriptsDock /> : null}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  required = false,
  hint = '',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-sm text-gray-300 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        required={required}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 sm:px-4 py-2.5 sm:py-3 rounded-lg bg-[#161616] border border-white/10 text-white"
      />
      {hint ? <p className="mt-1 text-xs text-gray-500">{hint}</p> : null}
    </div>
  );
}

function TextArea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="md:col-span-2">
      <label className="block text-sm text-gray-300 mb-1">{label}</label>
      <textarea
        rows={3}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 sm:px-4 py-2.5 sm:py-3 rounded-lg bg-[#161616] border border-white/10 text-white resize-y"
      />
    </div>
  );
}

function ClientNotesField({
  value,
  saving,
  dirty,
  onChange,
  onSave,
  label = 'Notater',
  action = null,
}: {
  value: string;
  saving: boolean;
  dirty: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  label?: string;
  action?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const hasNote = Boolean(value.trim());
  const showEditor = editing || dirty || saving;

  useEffect(() => {
    if (!showEditor) return;
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, [showEditor]);

  return (
    <div className="rounded-xl border border-amber-700/25 bg-amber-950/20 p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-amber-300">
          <StickyNote size={12} />
          {label}
        </div>
        <div className="flex items-center gap-1.5">
          {action}
          {(dirty || saving) && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onSave}
            disabled={saving || !dirty}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-amber-700/40 text-amber-100 text-[11px] hover:bg-amber-700/55 disabled:opacity-50"
          >
            {saving ? <Loader2 size={11} className="animate-spin" /> : null}
            {saving ? 'Saving…' : 'Save note'}
          </button>
        )}
        </div>
      </div>
      {showEditor ? (
        <textarea
          ref={textareaRef}
          rows={3}
          maxLength={8000}
          value={value}
          placeholder="Write a note for this client…"
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => {
            onSave();
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              onSave();
              setEditing(false);
            }
          }}
          className="w-full px-2.5 py-2 rounded-lg bg-black/30 border border-white/10 text-sm text-gray-100 placeholder:text-gray-500 resize-y whitespace-pre-wrap"
        />
      ) : hasNote ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="w-full text-left text-sm text-amber-50/90 whitespace-pre-wrap break-words max-h-32 overflow-y-auto"
          title="Click to edit note"
        >
          {value}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="w-full text-left text-xs text-gray-400 hover:text-gray-200"
        >
          Add a note…
        </button>
      )}
    </div>
  );
}
