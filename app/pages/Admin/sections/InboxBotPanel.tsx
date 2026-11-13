import React, { Suspense, lazy, useState } from 'react';
import { Check, FileText, Loader2, Mail, UserRound } from 'lucide-react';
import { API, salesAuthHeaders, type SalesClient } from '../shared';

const PdfPreviewOverlay = lazy(() =>
  import('../../sales/PdfPreviewOverlay').then((mod) => ({ default: mod.PdfPreviewOverlay }))
);

type Props = {
  client: SalesClient;
};

export type InboxActivityRow = NonNullable<NonNullable<SalesClient['inboxBot']>['activity']>[number];

/** Why the bot stayed silent, keyed by the `stage:<key>` reason. */
const STAGE_LABEL: Record<string, string> = {
  offer: 'kunden er i Tilbud',
  signature: 'kunden er i Venter signering',
  won: 'kunden er Solgt',
  off: 'kunden er ikke aktiv i salg',
};

/** What the bot did when it answered the mail. */
const APPLIED_LABEL: Record<string, string> = {
  sales_book: 'Bot flyttet møtet',
  sales_propose: 'Bot svarte med ledige tider',
  sales_cancel: 'Bot avlyste møtet og ba om ny tid',
  sales_call: 'Bot svarte og lovet å ta kontakt',
  walk_away: 'Bot spurte hvorfor kunden sa nei',
  walk_away_final: 'Bot takket for svaret',
  gather: 'Bot svarte',
  workshop_book: 'Bot booket workshop',
  workshop_propose: 'Bot svarte med workshop-tider',
  workshop_call: 'Bot svarte og lovet å ta kontakt',
};

/** A card change that stands even when the reply mail did not go out. */
const UNMAILED_LABEL: Record<string, string> = {
  sales_book: 'Bot flyttet møtet (uten svar)',
  sales_cancel: 'Bot avlyste møtet (uten svar)',
  workshop_book: 'Bot booket workshop (uten svar)',
};

/** Why a mail was left for a rep, keyed by the reason (the part before any `:detail`). */
const NEEDS_HUMAN_LABEL: Record<string, string> = {
  'other-address': 'Trenger svar fra selger — kunden skrev fra en annen adresse',
  'ambiguous-sender': 'Trenger svar fra selger — adressen står på flere kort',
  'stale-mail': 'Trenger svar fra selger — gammel e-post, møtet ble ikke endret',
  'reply-failed': 'Trenger svar fra selger — svaret til kunden ble ikke sendt',
  'void-failed': 'Trenger svar fra selger — boten fikk ikke tatt bort møtet',
  'no-assigned-rep': 'Trenger svar fra selger — kortet har ingen selger',
  'question-with-booking': 'Bot flyttet møtet — kunden spurte også om noe',
  'time-unclear': 'Trenger svar fra selger — uklart hvilket tidspunkt kunden mener',
  'move-warning': 'Bot flyttet møtet — sjekk kalenderen, et steg etterpå feilet',
  'no-meet-link': 'Trenger svar fra selger — kunden spør etter møtelenken',
  'book-failed': 'Trenger svar fra selger — boten fikk ikke flyttet møtet',
};

/** The stage key from a `stage:<key>` reason, or '' when the reason is something else. */
function stageKey(row: InboxActivityRow) {
  const reason = String(row.reason || '');
  if (reason.startsWith('stage:')) return reason.slice('stage:'.length);
  return reason ? '' : String(row.stage || '');
}

/** Short Norwegian label for one bot activity row. */
export function inboxActivityLabel(row: InboxActivityRow) {
  if (row.status === 'needs_human') {
    const stage = STAGE_LABEL[stageKey(row)];
    if (stage) return `Ikke besvart — ${stage}`;
    if (row.reason === 'question:contract') return 'Spørsmål om kontrakten — trenger svar fra selger';
    const reasonLabel = NEEDS_HUMAN_LABEL[String(row.reason || '').split(':')[0]];
    if (reasonLabel) return reasonLabel;
    return 'Trenger svar fra selger';
  }
  if (row.status === 'applied') return APPLIED_LABEL[row.kind] || 'Bot svarte';
  if (row.status === 'skipped') return 'Hoppet over — eldre e-post i samme tråd';
  if (row.status === 'unmatched') return 'Ikke besvart';
  if (row.kind === 'silent' || row.intent === 'confirm') return 'Bekreftelse — ingen svar trengs';
  if (UNMAILED_LABEL[row.kind]) return UNMAILED_LABEL[row.kind];
  if (APPLIED_LABEL[row.kind]) return 'Svar ikke sendt';
  return 'Lest — ingen svar trengs';
}

/** The mail's summary, or its subject when the summary is only a row slug like `sales_book`. */
export function inboxActivityText(row: InboxActivityRow) {
  const summary = String(row.summary || '').trim();
  if (summary && summary !== row.kind && !/^[a-z0-9_:-]+$/.test(summary)) return summary;
  return String(row.subject || '').trim();
}

function activityTone(row: InboxActivityRow) {
  if (row.status === 'needs_human') return 'text-amber-200';
  if (row.status === 'applied') return 'text-emerald-200';
  return 'text-gray-300';
}

function formatReceivedAt(value = '') {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('nb-NO') : '';
}

/** Amber pill when the bot left a client mail for a rep to answer. */
export function InboxNeedsReplyPill({ client, className = '' }: { client: SalesClient; className?: string }) {
  const count = Number(client.inboxBot?.needsHuman) || 0;
  if (count <= 0) return null;
  const latest = (client.inboxBot?.activity || []).find((row) => row.status === 'needs_human');
  const title = latest
    ? inboxActivityText(latest) || inboxActivityLabel(latest)
    : 'Kunden har sendt en e-post som venter svar';
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-amber-400/50 bg-amber-500/20 text-amber-100 text-[11px] font-medium ${className}`}
    >
      <Mail size={11} strokeWidth={2.5} />
      E-post venter svar
    </span>
  );
}

function formatSignedAt(value = '') {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleString('nb-NO', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Agreement proof: signing date + kundeprofil, never a generated PDF. */
export function SignedContractPill({ client, className = '' }: { client: SalesClient; className?: string }) {
  const signedAt = String(client.contractSignedAt || client.inboxBot?.signed?.receivedAt || '').trim();
  const isSigned = Boolean(client.progression?.contractSigned || signedAt);
  if (!isSigned) return null;
  const dateLabel = formatSignedAt(signedAt);
  const hasProfile = Boolean(client.portalUserId);
  const title = hasProfile
    ? `Avtale signert${dateLabel ? ` ${dateLabel}` : ''}. Kunden har laget kundeprofil.`
    : `Avtale signert${dateLabel ? ` ${dateLabel}` : ''}. Kunden har ikke laget kundeprofil ennå.`;
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-emerald-400/50 bg-emerald-500/20 text-emerald-100 text-[11px] font-medium ${className}`}
    >
      <Check size={11} strokeWidth={3} />
      {dateLabel ? `Signert ${dateLabel}` : 'Signert'}
      <span className="inline-flex items-center gap-0.5 opacity-90">
        <UserRound size={11} />
        {hasProfile ? 'Kundeprofil' : 'Ingen kundeprofil'}
      </span>
    </span>
  );
}

export function InboxBotPanel({ client }: Props) {
  const contracts = client.inboxBot?.contracts || [];
  const elements = client.inboxBot?.elements || [];
  const staged = Number(client.inboxBot?.stagedElements) || 0;
  const activity = client.inboxBot?.activity || [];
  const [previewUrl, setPreviewUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  if (!contracts.length && !elements.length && !staged && !activity.length) return null;

  async function openPdf(fileName: string) {
    setBusy(fileName);
    setError('');
    try {
      const response = await fetch(
        `${API}/admin/sales/${encodeURIComponent(client.id)}/inbox-contracts/${encodeURIComponent(fileName)}`,
        { headers: salesAuthHeaders(), cache: 'no-store' }
      );
      if (!response.ok) throw new Error('Kunne ikke åpne kontrakten.');
      const blob = await response.blob();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke åpne kontrakten.');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="rounded-lg border border-white/10 bg-black/20 p-2.5 space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-gray-400">Innboks</div>
      {contracts.map((row) => (
        <div key={row.id || row.fileName} className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs text-white truncate">{row.summary || row.subject || 'Kontrakt mottatt'}</p>
            <p className="text-[11px] text-gray-500 truncate">
              {row.signedVerdict === 'preview_accept'
                ? 'Signert med kundeprofil'
                : row.signedVerdict === 'email' || row.status === 'accepted'
                  ? 'Signert (e-post)'
                  : row.signedVerdict === 'likely'
                    ? 'Signert (sjekket bunnen)'
                    : row.signedVerdict === 'possible'
                      ? 'Mulig signert — sjekk bunnen'
                      : row.signedVerdict === 'unsigned' || row.status === 'unsigned_copy'
                        ? 'Usignert kopi'
                        : 'Kontrakt'}
              {row.from ? ` · ${row.from}` : ''}
              {row.receivedAt ? ` · ${new Date(row.receivedAt).toLocaleString('nb-NO')}` : ''}
            </p>
          </div>
          {row.fileName && row.signedVerdict !== 'preview_accept' ? (
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={() => void openPdf(row.fileName)}
              className="inline-flex items-center gap-1 shrink-0 px-2 py-1 rounded-lg bg-white/10 text-white text-[11px] hover:bg-white/15 disabled:opacity-50"
            >
              {busy === row.fileName ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />}
              Vis PDF
            </button>
          ) : null}
        </div>
      ))}
      {elements.map((row) => (
        <p key={row.id} className="text-[11px] text-gray-400 truncate">
          {row.status === 'filed' ? 'Lagt i kundedata' : row.status === 'staged' ? 'Venter på Connect' : 'Vedlegg'}
          {row.buckets?.length ? ` · ${row.buckets.join(', ')}` : ''}
          {row.summary ? ` · ${row.summary}` : ''}
        </p>
      ))}
      {staged && !elements.length ? (
        <p className="text-[11px] text-amber-200">
          {staged === 1 ? '1 vedlegg venter på portal-Connect.' : `${staged} vedlegg venter på portal-Connect.`}
        </p>
      ) : null}
      {activity.length ? (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium text-gray-300">E-post fra kunden</div>
          {activity.map((row, index) => {
            const detail = [inboxActivityText(row), formatReceivedAt(row.receivedAt)].filter(Boolean).join(' · ');
            return (
              <div key={row.id || `${row.kind}-${index}`} className="min-w-0" title={row.subject || undefined}>
                <p className={`text-xs truncate ${activityTone(row)}`}>{inboxActivityLabel(row)}</p>
                {detail ? <p className="text-[11px] text-gray-500 truncate">{detail}</p> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {error ? <p className="text-[11px] text-red-300">{error}</p> : null}
      {previewUrl ? (
        <Suspense fallback={null}>
          <PdfPreviewOverlay
            url={previewUrl}
            title="Mottatt kontrakt"
            onClose={() => {
              URL.revokeObjectURL(previewUrl);
              setPreviewUrl('');
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
