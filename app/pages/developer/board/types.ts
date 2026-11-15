// Shapes the developer board already returns. Optional fields are read when present.

export type BoardJob = {
  id?: string;
  kind?: string;
  status?: string;
  blocking?: string;
  warnings?: string[];
  at?: string;
  doneAt?: string;
  createdAt?: string;
  attempts?: number;
  hostId?: string;
  progress?: number;
  logTail?: string[];
};

export type GateLine = {
  id: string;
  group?: string;
  label?: string;
  askText?: string;
  gate?: string;
  level?: string;
  status?: string;
  evidence?: string;
  waiveOptions?: string[];
  waiver?: { option?: string; by?: string; at?: string } | null;
};

export type BoardGate = {
  status?: string;
  approved?: boolean;
  approvedAt?: string;
  lines?: GateLine[] | number;
  open?: number;
  blocking?: number;
  devComplete?: boolean;
  readyComplete?: boolean;
  passed?: boolean;
  missingDev?: string[];
  missingReady?: string[];
  info?: Array<{ id?: string; status?: string; detail?: string }>;
};

export type BoardDirective = {
  id: string;
  status?: string;
  ask?: string;
  note?: string;
  kind?: string;
  priority?: string;
  reason?: string;
  taskId?: string;
};

export type BoardItem = {
  id: string;
  salesClientId?: string;
  siteId?: string;
  businessName?: string;
  product?: string;
  offerTierId?: string;
  contractSigned?: boolean;
  developerOwnerId?: string;
  industry?: string;
  websiteDomain?: string;
  rankAt?: string;
  deliveryStage?: string;
  deliveryOverlay?: string;
  makerPort?: number | string;
  websiteDue?: { dueAt?: string; effectiveDate?: string; label?: string } | null;
  sitePlan?: {
    tierId?: string;
    services?: string[];
    status?: string;
    needsConfirmation?: boolean;
  } | null;
  delivery?: {
    stage?: string;
    overlay?: string;
    gate?: BoardGate | null;
    job?: BoardJob | null;
    info?: string[];
    pendingIteration?: unknown;
  } | null;
  hostStatus?: { hostId?: string; online?: boolean; lastHeartbeatAt?: string } | null;
  aiSpendSummary?: { totalUsd?: number; calls?: number } | null;
  changeRequestSummary?: { open?: number; used?: number; quota?: number } | null;
  briefSummary?: { version?: number; hash?: string; status?: string; builtAt?: string } | null;
  devSummary?: Record<string, unknown> | null;
  makerRun?: { runId?: string; dev?: DevPayload | null } | null;
  hubSite?: { id?: string; domain?: string } | null;
  development?: Record<string, boolean | undefined>;
  clientBrief?: { short?: string } | null;
  workshop?: { heldAt?: string; summary?: unknown } | null;
  workshopSummary?: unknown;
  iterationLog?: unknown[];
  cursorPrompt?: string;
  prompt?: string;
  blocking?: string[];
  pages?: Array<{ routePath?: string; pageTitle?: string; sourceRoutePath?: string }>;
};

export type BoardViewer = {
  isAdmin?: boolean;
  accountKey?: string;
  username?: string;
};

export type BoardAlert = {
  key?: string;
  kind?: string;
  message?: string;
};

export type BoardSnapshot = {
  items?: BoardItem[];
  developmentItems?: BoardItem[];
  previewItems?: BoardItem[];
  ssuItems?: BoardItem[];
  alerts?: BoardAlert[];
  viewer?: BoardViewer;
  rev?: number;
  removed?: string[];
};

export type BoardDetail = {
  id?: string;
  salesClientId?: string;
  gate?: BoardGate | null;
  brief?: { version?: number | null; hash?: string; directives?: number | BoardDirective[]; facts?: number } | null;
  jobs?: BoardJob[];
  changeRequests?: Array<{ id?: string; status?: string; title?: string; quotaUnits?: number; createdAt?: string }>;
  deliveryHistory?: unknown[];
  devReports?: Array<{ sessionId?: string; receivedAt?: string; status?: string }>;
  directives?: BoardDirective[];
};

export type DevCounts = {
  tasks?: number;
  done?: number;
  needsHuman?: number;
  failed?: number;
  reverted?: number;
};

export type DevPayload = {
  sessionId?: string;
  kind?: string;
  status?: string;
  briefHash?: string;
  costUsd?: number;
  counts?: DevCounts;
  auditBefore?: { hard?: number; soft?: number };
  auditAfter?: { hard?: number; soft?: number };
  directives?: BoardDirective[];
  questions?: Array<{ id?: string; text?: string; askClient?: boolean }>;
  qaProposal?: { textOk?: boolean; mediaOk?: boolean; responsiveOk?: boolean; evidence?: string };
  thumbs?: Array<{ taskId?: string; before?: string; after?: string }>;
  steps?: Record<string, string>;
};

export type DevReportResponse = {
  ok?: boolean;
  report?: { dev?: DevPayload | null } | null;
  receivedAt?: string;
};

export type CardCache = {
  detail: BoardDetail | null;
  report: DevReportResponse | null;
  directives: BoardDirective[];
};
