export const API = '/api';

export function getToken() {
  return localStorage.getItem('adminToken') || localStorage.getItem('superAdminToken');
}

// Sales workspace (role=sales) authenticates with the staff token; the admin panel uses the admin token.
export function getSalesToken() {
  const admin = localStorage.getItem('adminToken') || localStorage.getItem('superAdminToken');
  const employee = localStorage.getItem('employeeToken');
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/sales')) {
    return employee || admin;
  }
  return admin || employee;
}

export function salesAuthHeaders() {
  const token = getSalesToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function getDevelopmentToken() {
  return getToken() || localStorage.getItem('employeeToken');
}

export function developmentAuthHeaders() {
  const token = getDevelopmentToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function setToken(token: string) {
  localStorage.setItem('adminToken', token);
  localStorage.setItem('superAdminToken', token);
}

export function clearToken() {
  localStorage.removeItem('adminToken');
  localStorage.removeItem('superAdminToken');
}

export function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export type Tab = 'clients' | 'pages' | 'media' | 'users' | 'analytics' | 'ecommerce' | 'employees' | 'blog' | 'social' | 'email' | 'offers';

export type MediaItem = {
  name: string;
  url: string;
  size: number;
  kind: 'image' | 'video' | 'audio' | 'document' | 'other';
  mime: string;
  alt: string;
  tags: string[];
  uploadedBy: string;
  createdAt: string;
  source: 'disk' | 'git' | 'both';
};

export type Features = {
  users?: boolean;
  analytics?: boolean;
  ecommerce?: boolean;
  blog?: boolean;
  socialSync?: boolean;
  emailMarketing?: boolean;
  general?: boolean;
};
export type WebsitePlanId = 'tier-1-standard' | 'tier-2-seo' | 'tier-3-ecommerce' | 'custom';
export type EcommerceCatalogType = 'menu' | 'tiers' | 'normal';
export type DeliveryPhase = 'development' | 'client';
export type SalesDevelopment = {
  hostingerEnvironmentSetup: boolean;
  githubRepoPushed: boolean;
  v1Ferdig: boolean;
  nettsideFerdig: boolean;
};
export type UserRole = 'employee' | 'client' | 'sales' | 'developer' | 'none';
export type EmployeeProduct = 'asoldi' | 'ssu';
export type EmployeeRoleOption = 'none' | 'client' | 'sales' | 'developer' | 'employee-asoldi' | 'employee-ssu';

export type AdminUser = {
  id: string;
  username: string;
  createdAt: string;
  role: UserRole;
  employeeProduct?: EmployeeProduct;
  name?: string;
  fromEmail?: string;
  /** E.164-ish ("+4792331098"). Required for sales reps — printed in every e-mail they send. */
  phone?: string;
};

export type ClientPaymentRequest = {
  userId: string;
  email: string;
  clientName: string;
  businessName: string;
  planName: string;
  paymentStatus: string;
  paymentMethod: string;
  requestedAt: string;
  updatedAt: string;
  invoiceRequest: {
    orgNumber: string;
    businessName: string;
    invoiceEmail: string;
    requestedAt: string;
  };
};

export function toEmployeeRoleOption(user: AdminUser): EmployeeRoleOption {
  if (user.role === 'client') return 'client';
  if (user.role === 'sales') return 'sales';
  if (user.role === 'developer') return 'developer';
  if (user.role === 'employee') {
    return user.employeeProduct === 'ssu' ? 'employee-ssu' : 'employee-asoldi';
  }
  return 'none';
}

export function fromEmployeeRoleOption(option: EmployeeRoleOption): {
  role: UserRole;
  employeeProduct?: EmployeeProduct;
} {
  switch (option) {
    case 'client':
      return { role: 'client' };
    case 'sales':
      return { role: 'sales' };
    case 'developer':
      return { role: 'developer' };
    case 'employee-asoldi':
      return { role: 'employee', employeeProduct: 'asoldi' };
    case 'employee-ssu':
      return { role: 'employee', employeeProduct: 'ssu' };
    default:
      return { role: 'none' };
  }
}
export type SiteCmsMeta = {
  githubRepo?: string;
  lastSeenAt?: string;
  packageVersion?: string;
  adminUrl?: string;
  desiredPackageVersion?: string;
};

export type Site = {
  id: string;
  site_key: string;
  domain: string;
  name: string;
  features: Features;
  websitePlan?: WebsitePlanId;
  ecommerceCatalogType?: EcommerceCatalogType | null;
  cms?: SiteCmsMeta;
  clientAdmin?: {
    name?: string;
    email?: string;
    username?: string;
    avatarUrl?: string;
    createdAt?: string;
    updatedAt?: string;
    passwordSet?: boolean;
  };
  createdAt: string;
  deliveryPhase?: DeliveryPhase;
  development?: SalesDevelopment;
};

export type ManageClientsView = 'clients' | 'development' | 'sales';

export type SalesGoalKey = 'meetingHeld' | 'offerSent' | 'contractSigned' | 'paymentReceived';

export type SalesNextActionPreset = 'meeting' | 'meetingBooked' | 'findMeetingTime' | 'sms24h' | 'sms1h' | 'call2h' | 'sendOffer' | 'checkIn' | 'upsell' | 'oppgrader' | 'oppfolging' | 'oppfolging1mnd' | 'custom';

export type SalesActionFormat = 'email' | 'sms' | 'ring' | 'mote';

export type SalesNextAction = {
  id: string;
  goalKey: SalesGoalKey | 'afterSale';
  presetKey: SalesNextActionPreset;
  name: string;
  note: string;
  format: SalesActionFormat;
  dueAt: string;
  doneAt: string;
  createdAt: string;
  relativeToMeetingHours: number | null;
  addToCalendar: boolean;
  calendarEventId: string;
};

export type SalesProgression = {
  meetingHeld: boolean;
  step0AgreeMeetingTime: boolean;
  offerSent: boolean;
  checkIn1: boolean;
  checkIn2: boolean;
  contractSigned: boolean;
  paymentReceived: boolean;
  domainConnected: boolean;
  live: boolean;
};

export type DevelopmentItem = {
  id: string;
  salesClientId: string;
  siteId: string;
  businessName: string;
  contactPerson: string;
  contactEmail: string;
  contactPhone: string;
  meetingPlace: string;
  industry?: string;
  websiteDomain: string;
  notes: string;
  /** Agreed meeting time (ISO) when the sales client has one. */
  meetingAt?: string;
  /** Active next action due time / name from the sales card. */
  nextActionAt?: string;
  nextActionName?: string;
  /** Time used for ranking: next action due, else meeting time. */
  rankAt?: string;
  makerRun: SalesMakerRunMeta | null;
  websiteImport: SalesWebsiteImportMeta | null;
  hubSite?: SalesClient['hubSite'] | null;
  siteKey: string;
  development: SalesDevelopment;
};

export type SalesReminders = {
  thankYouSentAt: string;
  reminder3dAt?: string;
  reminder3dSentAt?: string;
  reminder24hAt: string;
  reminder24hSentAt: string;
  reminder1hAt: string;
  reminder1hSentAt: string;
  skipDueToShortNotice: boolean;
};

export type SalesSender = {
  name: string;
  fullName: string;
  fromEmail: string;
  from: string;
  replyTo: string;
  /** Formatted for display ("+47 923 31 098"); '' when the rep has no number yet. */
  phone?: string;
};

export type SalesCalendarMeta = {
  eventId: string;
  htmlLink: string;
  meetLink: string;
  calendarId: string;
  accountKey: string;
  syncedAt: string;
  guestInvitedAt?: string;
  firefliesInvitedAt?: string;
  firefliesLiveJoinedAt?: string;
  firefliesLiveJoinAttemptAt?: string;
  firefliesLiveJoinError?: string;
  inviteSequence?: number;
};

export type SalesWebsiteImportMeta = {
  importedAt: string;
  publishedAt?: string;
  sourceRunId: string;
  sourceStep: string;
  sourceBaseUrl: string;
  siteFolder: string;
  importRoot: string;
  previewUrl: string;
  previewSlug?: string;
  publicUrl?: string;
  publicPreviewPublishedAt?: string;
};

export type SalesMakerRunMeta = {
  runId: string;
  dashboardUrl: string;
  previewUrl: string;
  latestReadyStep: string;
  latestStepStatus: string;
  intakeStatus?: string;
  exportPath: string;
  statusUpdatedAt: string;
  fieldsSyncedAt?: string;
  industry: string;
  createdAt: string;
};

export type SalesArchiveMeta = {
  archivedAt: string;
  reason: string;
};

export type SalesClientDetails = {
  instagramUrl: string;
  facebookUrl: string;
  proffUrl: string;
  otherLinks: string;
  googleBusinessProfile: string;
  emailCustomNeed: string;
  editEmailBeforeSend?: boolean;
  meetingQuote?: {
    tierId: string;
    customMode: boolean;
    oneTime: boolean;
    pages: number;
    selected: string[];
    oneTimeAddOns: string[];
    customSections: string;
    startDate: string;
    productNotes?: string;
    productGoal: string;
    identity: string;
  };
};

export type SalesMyphonerMeta = {
  leadId: string;
  leadIds: string[];
  listId: string;
  listName: string;
  leadResourceUrl: string;
  winnerCategory: string;
  winnerComment: string;
  lastWinnerWebhookAt: string;
  lastRecordingWebhookAt: string;
  latestEventAt: string;
  latestCallId: string;
  latestCallStartedAt: string;
  latestCallDurationSeconds: number;
  latestCallUserEmail: string;
  bookedByEmail?: string;
  bookedByName?: string;
  bookedAt?: string;
  latestCallDestinationNumber: string;
  latestRecordingUrl: string;
  latestRecordingSyncReason: string;
};

export type SalesProduct = 'asoldi' | 'ssu';

export type SalesClientMeeting = {
  meetingId: string;
  title: string;
  when: string;
  startedAt: string;
  durationMinutes: number | '';
  meetLink?: string;
  transcriptUrl: string;
  videoUrl: string;
  confidence: 'high' | 'medium' | 'low' | 'manual';
  score: number;
  reasons: string[];
  summary: string;
  actionItems: string[];
  hasTranscript: boolean;
  liveJoinedAt?: string;
  source?: string;
  linkedAt: string;
  linkedBy: string;
  forSalesMeeting?: boolean;
};

export type OfferProduct = {
  id: string;
  kind: 'tier' | 'custom';
  tierId: string;
  name: string;
  pages: number;
  includes: string[];
  note: string;
  priceExMva: number;
  deliveryWeeks: number;
};

export type OfferContractSummary = {
  title: string;
  products: OfferProduct[];
  monthlyExMva: number;
  deliveryWeeks: number;
  extraTerms: string[];
  scopeSummary: string;
};

export type SalesOfferStatus = 'draft' | 'review-requested' | 'verified' | 'sent';

export type SalesOffer = {
  id: string;
  salesClientId: string;
  ownerId: string;
  createdBy: string;
  status: SalesOfferStatus;
  reviewRequested: boolean;
  tierId: string;
  /** Rep absorbed the VAT: listed prices are what the client pays incl. 25 % MVA (default false = MVA on top). */
  mvaIncluded: boolean;
  email: { subject: string; preheader: string; html: string };
  /** Empty fields fall back to the client card. contactEmail is the Til override. */
  party?: {
    businessName: string;
    orgNumber: string;
    address: string;
    contactPerson: string;
    contactEmail: string;
  };
  products: OfferProduct[];
  contract: { summary: OfferContractSummary | null; generatedAt: string; pdfPath: string };
  meetingId: string;
  meetingSource?: '' | 'manual';
  adminNote: string;
  clientIntent?: {
    headline: string;
    wants: string[];
    plan: string;
    notes: string;
    goal: string;
    identity: string;
    customSections: string;
    uncertainties: string[];
    source: 'ai' | 'fallback';
    sourceHash: string;
    generatedAt: string;
  } | null;
  history: { at: string; by: string; action: string; note: string }[];
  reviewRequestedAt: string;
  verifiedAt: string;
  verifiedBy: string;
  previewHash: string;
  previewedAt: string;
  sentAt: string;
  sentTo: string;
  sentBy: string;
  delivery?: 'email' | 'portal' | 'both';
  websiteCode?: string;
  createdAt: string;
  updatedAt: string;
  /** Server-side presentation flags (presentOffer). */
  needsVerification?: boolean;
  canSend?: boolean;
  contractAvailable?: boolean;
  /** The rep approved a full preview of exactly the current content. */
  previewCurrent?: boolean;
  /** Template placeholders still left in the email (must be filled or deleted before sending). */
  placeholders?: string[];
};

export type SalesClient = {
  id: string;
  product: SalesProduct;
  businessName: string;
  contactPerson: string;
  contactEmail: string;
  /** Account email on asoldi.com. Separate from the contact email used for meeting mail. */
  clientEmail?: string;
  portalUserId?: string;
  portalBusinessId?: string;
  portalConnectedAt?: string;
  portalTierId?: string;
  /** Public website email. Empty means use contactEmail until the Maker draft adds another. */
  websiteEmail?: string;
  contactPhone: string;
  meetingPlace: string;
  /** 9-digit Norwegian org number (contract parties block). */
  orgNumber?: string;
  /** Registered business address for the contract; falls back to meetingPlace in the UI. */
  businessAddress?: string;
  /** Status of the client's current offer (joined server-side from sales-offers). */
  offerStatus?: SalesOfferStatus | '';
  industry: string;
  meetingMode: 'online' | 'in-person';
  meetingDurationMinutes: number;
  agreedTime: boolean;
  meetingAt: string;
  websiteDomain: string;
  notes: string;
  details: SalesClientDetails;
  myphoner: SalesMyphonerMeta;
  progression: SalesProgression;
  salesMigrations?: { meetingHeldOrphansV1?: boolean };
  nextActions: SalesNextAction[];
  development?: SalesDevelopment;
  reminders: SalesReminders;
  calendar: SalesCalendarMeta;
  /** Fireflies meetings linked to this client (auto-matched or linked by admin). */
  meetings?: SalesClientMeeting[];
  lockedOfferMeetingId?: string;
  websiteImport: SalesWebsiteImportMeta;
  makerRun: SalesMakerRunMeta;
  hubSite?: {
    siteKey: string;
    domain: string;
    id: string;
    createdAt: string;
    liveUrl?: string;
  };
  status: 'active' | 'not-sold' | 'secondary';
  ownerId?: string;
  archive: SalesArchiveMeta;
  createdAt: string;
  updatedAt: string;
};

export const DEFAULT_FEATURES: Features = {
  users: true,
  analytics: false,
  ecommerce: false,
  blog: false,
  socialSync: false,
  emailMarketing: false,
  general: false,
};

export const WEBSITE_PLAN_OPTIONS: { id: WebsitePlanId; name: string }[] = [
  { id: 'tier-1-standard', name: 'Tier 1: Standard' },
  { id: 'tier-2-seo', name: 'Tier 2: SEO' },
  { id: 'tier-3-ecommerce', name: 'Tier 3: Nettbutikk' },
  { id: 'custom', name: 'Custom' },
];

export const CATALOG_TYPE_OPTIONS: { id: EcommerceCatalogType; name: string }[] = [
  { id: 'menu', name: 'Menu (groups, allergens)' },
  { id: 'tiers', name: 'Tiers (plans, bullets, CTA)' },
  { id: 'normal', name: 'Normal products (categories, subtitle)' },
];

export function featuresFromPlan(planId: WebsitePlanId): Features {
  switch (planId) {
    case 'tier-2-seo':
      return { users: true, analytics: true, ecommerce: false, blog: true, socialSync: true, emailMarketing: true, general: false };
    case 'tier-3-ecommerce':
      return { users: true, analytics: true, ecommerce: true, blog: true, socialSync: true, emailMarketing: true, general: true };
    case 'custom':
      return { ...DEFAULT_FEATURES };
    case 'tier-1-standard':
    default:
      return { ...DEFAULT_FEATURES };
  }
}

export const SITE_PAGES = [
  { path: '/', label: 'Home' },
  { path: '/pricing', label: 'Pricing' },
  { path: '/about', label: 'About' },
  { path: '/booking', label: 'Booking' },
  { path: '/clients', label: 'Clients' },
  { path: '/services/web-development', label: 'Web Development' },
  { path: '/services/social-media', label: 'Social Media Marketing' },
  { path: '/services/email-marketing', label: 'Email Marketing' },
  { path: '/services/photo-video', label: 'Photo & Video' },
  { path: '/1000kr', label: '1000kr' },
  { path: '/bli-ansatt', label: 'Bli ansatt' },
  { path: '/login', label: 'Login' },
  { path: '/ansatt', label: 'Ansatt' },
];

export type EmployeeChecklist = {
  contractSent: boolean;
  contractSigned: boolean;
  oneWeekMeeting: boolean;
  monthlyReview: boolean;
  systemAccessGranted: boolean;
  personalDetailsReceived: boolean;
};

export type EmployeeNote = {
  id: string;
  content: string;
  createdAt: string;
  createdBy: string;
};

export type EmployeeStats = {
  totalCalls: number;
  meetingsBooked: number;
  hoursCalled: number;
  conversionRate: number;
  lastSyncDate: string;
};

export type EmployeePayment = {
  hourlyRate: number;
  commissionPerMeeting: number;
  totalOwed: number;
  lastPaymentDate: string;
  nextPayday: string;
  paymentMethod: 'bank' | 'other';
  bankAccount: string;
};

export type EmployeeWorker = {
  id: string;
  name: string;
  email: string;
  role: 'caller' | 'admin' | 'other';
  status: 'active' | 'inactive' | 'onboarding';
  startDate: string;
  avatarUrl?: string;
  contractUrl?: string;
  wordpressId?: number | null;
  wordpressCreatedAt?: string;
  checklist: EmployeeChecklist;
  myphonerStats: EmployeeStats;
  paymentInfo: EmployeePayment;
  notes: EmployeeNote[];
  createdAt: string;
  updatedAt: string;
};

export type EmployeeDashboardStats = {
  totalWorkers: number;
  activeWorkers: number;
  totalMeetingsThisMonth: number;
  totalHoursThisMonth: number;
  totalOwedThisMonth: number;
  daysUntilPayday: number;
  isOverdue: boolean;
  pendingOnboarding: number;
};
