import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Loader2 } from 'lucide-react';
import { ClientRouteGuard } from '../../components/client/ClientRouteGuard';
import { ClientPortalLayout } from '../../components/client/ClientPortalLayout';
import { useClientAuth } from '../../contexts/ClientAuthContext';
import { extractOfferLetterBody } from '../../../lib/offer-letter-html.js';
import { useClientOffer } from './useClientOffer';

const LETTER_CLASS =
  'text-[15px] leading-[1.7] text-[#1F2937] [&_p]:mb-3.5 [&_h2]:mt-6 [&_h2]:mb-2.5 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-[#111827] [&_a]:text-[#FF5B00] [&_a]:underline [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:my-3 [&_table]:w-full [&_strong]:text-[#111827]';

const CONTRACT_CLASS = [
  'offer-contract-doc text-[14px] leading-[1.7] text-[#1F2937]',
  '[&_.offer-contract-masthead]:mb-10 [&_.offer-contract-masthead]:border-b [&_.offer-contract-masthead]:border-[#E8E4DC] [&_.offer-contract-masthead]:pb-8 [&_.offer-contract-masthead]:text-center',
  '[&_.offer-contract-kicker]:text-[11px] [&_.offer-contract-kicker]:font-medium [&_.offer-contract-kicker]:uppercase [&_.offer-contract-kicker]:tracking-[0.18em] [&_.offer-contract-kicker]:text-[#6B7280]',
  '[&_h1]:mt-3 [&_h1]:font-serif [&_h1]:text-[2rem] [&_h1]:font-semibold [&_h1]:uppercase [&_h1]:leading-tight [&_h1]:tracking-[0.18em] [&_h1]:text-[#111827] sm:[&_h1]:text-[2.15rem]',
  '[&_.offer-contract-sub]:mt-2 [&_.offer-contract-sub]:text-sm [&_.offer-contract-sub]:text-[#6B7280]',
  '[&_.offer-contract-date]:mt-3 [&_.offer-contract-date]:text-xs [&_.offer-contract-date]:uppercase [&_.offer-contract-date]:tracking-[0.12em] [&_.offer-contract-date]:text-[#9CA3AF]',
  '[&_.offer-contract-parties]:mb-8 [&_.offer-contract-parties]:grid [&_.offer-contract-parties]:grid-cols-1 [&_.offer-contract-parties]:gap-8 sm:[&_.offer-contract-parties]:grid-cols-2',
  '[&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:border-b [&_h2]:border-[#E8E4DC] [&_h2]:pb-2 [&_h2]:text-[12px] [&_h2]:font-semibold [&_h2]:uppercase [&_h2]:tracking-[0.14em] [&_h2]:text-[#111827]',
  '[&_.offer-contract-parties_h2]:mt-0',
  '[&_dl]:space-y-1.5 [&_dl_div]:grid [&_dl_div]:grid-cols-[7.5rem_1fr] [&_dl_div]:gap-x-3 [&_dt]:text-[12px] [&_dt]:text-[#6B7280] [&_dd]:text-[14px] [&_dd]:text-[#111827]',
  '[&_p]:mt-2.5 [&_strong]:text-[#111827]',
  '[&_ul]:mt-2 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5',
  '[&_ol]:mt-2 [&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_.offer-contract-sign]:mt-6 [&_.offer-contract-sign]:grid [&_.offer-contract-sign]:grid-cols-1 [&_.offer-contract-sign]:gap-10 sm:[&_.offer-contract-sign]:grid-cols-2',
  '[&_.offer-contract-sign_h2]:mt-0',
  '[&_.offer-contract-sign-label]:mt-3 [&_.offer-contract-sign-label]:mb-1 [&_.offer-contract-sign-label]:text-[13px] [&_.offer-contract-sign-label]:text-[#1F2937]',
  '[&_.offer-contract-sign-line]:relative [&_.offer-contract-sign-line]:mt-2 [&_.offer-contract-sign-line]:flex [&_.offer-contract-sign-line]:min-h-[56px] [&_.offer-contract-sign-line]:items-end [&_.offer-contract-sign-line]:border-b [&_.offer-contract-sign-line]:border-[#222222]',
  '[&_.offer-contract-stamp]:mb-[-2px] [&_.offer-contract-stamp]:block [&_.offer-contract-stamp]:h-[52px] [&_.offer-contract-stamp]:w-auto [&_.offer-contract-stamp]:max-w-full [&_.offer-contract-stamp]:object-contain [&_.offer-contract-stamp]:object-left',
  '[&_.offer-contract-sign-date]:mt-2 [&_.offer-contract-sign-date]:text-[13px] [&_.offer-contract-sign-date]:text-[#1F2937]',
].join(' ');

export const ClientOfferReview = () => {
  const navigate = useNavigate();
  const { token } = useClientAuth();
  const scroller = useRef<HTMLDivElement | null>(null);
  const { offer, loading, error: loadError } = useClientOffer(token);
  const [error, setError] = useState('');
  const [atBottom, setAtBottom] = useState(false);
  const [accepting, setAccepting] = useState(false);

  const letterHtml = useMemo(() => extractOfferLetterBody(offer?.letterHtml || ''), [offer?.letterHtml]);

  useEffect(() => {
    setError(loadError);
  }, [loadError]);

  function syncBottom() {
    const node = scroller.current;
    if (!node) return;
    const reached = node.scrollTop + node.clientHeight >= node.scrollHeight - 28;
    setAtBottom(reached || node.scrollHeight <= node.clientHeight + 8);
  }

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) {
      setAtBottom(false);
      return;
    }
    syncBottom();
    const observer = new ResizeObserver(() => syncBottom());
    observer.observe(node);
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    node.addEventListener('scroll', syncBottom, { passive: true });
    window.addEventListener('resize', syncBottom);
    return () => {
      observer.disconnect();
      node.removeEventListener('scroll', syncBottom);
      window.removeEventListener('resize', syncBottom);
    };
  }, [offer?.id, offer?.contractHtml, letterHtml]);

  async function accept() {
    if (!offer || offer.accepted || !atBottom) return;
    setAccepting(true);
    setError('');
    try {
      const response = await fetch('/api/client/offer/accept', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          language: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          platform: navigator.platform,
          screen: { width: window.screen.width, height: window.screen.height },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke lagre aksepten.');
      navigate('/kunde/hjem', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke lagre aksepten.');
    } finally {
      setAccepting(false);
    }
  }

  const canAccept = Boolean(offer && !offer.accepted && atBottom && !accepting && offer.contractHtml);

  return (
    <ClientRouteGuard>
      <Helmet>
        <title>Tilbud – Kundeportal</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <ClientPortalLayout>
        {loading ? (
          <div className="min-h-[280px] flex items-center justify-center text-[#6B7280]">
            <Loader2 className="animate-spin mr-2" size={18} /> Laster tilbudet…
          </div>
        ) : error && !offer ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-red-600 text-sm">{error}</div>
        ) : !offer ? (
          <div className="rounded-2xl border border-[#E7E9EE] bg-white px-5 py-8 text-sm text-[#6B7280]">
            Det ligger ingen tilbud på denne kontoen enda. Det vises her når selger sender det.
          </div>
        ) : (
          <div className="mx-auto max-w-[800px] space-y-6">
            <div>
              <p className="text-sm font-medium text-[#FF5B00]">Tilbud</p>
              <h1 className="mt-1 text-2xl font-semibold text-[#111827]">{offer.planName || 'Tilbud fra Asoldi'}</h1>
              <p className="mt-2 text-sm text-[#6B7280]">
                Bla gjennom avtalen under. Knappen blir oransje når du er ved bunnen.
              </p>
            </div>

            <section>
              <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.16em] text-[#9CA3AF]">Tilbudet</p>
              <div className={LETTER_CLASS}>
                {letterHtml ? (
                  <div dangerouslySetInnerHTML={{ __html: letterHtml }} />
                ) : (
                  <p>{offer.planName} · {offer.price}</p>
                )}
              </div>
            </section>

            <section className="flex max-h-[min(72vh,820px)] min-h-[420px] flex-col overflow-hidden rounded-2xl border border-[#D9D4C8] bg-[#EFECE4] shadow-[0_8px_30px_rgba(17,24,39,0.06)]">
              <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
                <div className="px-3 py-6 sm:px-8 sm:py-8">
                  <article className={`mx-auto max-w-[680px] bg-white px-7 py-10 shadow-[0_1px_2px_rgba(17,24,39,0.06)] sm:px-12 sm:py-12 ${CONTRACT_CLASS}`}>
                    {offer.contractHtml ? (
                      <div dangerouslySetInnerHTML={{ __html: offer.contractHtml }} />
                    ) : (
                      <p>Kontraktteksten følger med når tilbudet er sendt til kontoen din.</p>
                    )}
                  </article>
                </div>
              </div>
              <div className="shrink-0 border-t border-[#E5E1D8] bg-white/95 px-5 py-4 backdrop-blur-sm">
                {offer.accepted ? (
                  <p className="text-sm text-emerald-700">
                    Avtalen er akseptert {offer.acceptedAt ? new Date(offer.acceptedAt).toLocaleString('nb-NO') : ''}.
                  </p>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={!canAccept}
                      onClick={() => void accept()}
                      className={`w-full rounded-xl px-4 py-3.5 text-sm font-semibold transition-colors disabled:opacity-100 ${
                        canAccept
                          ? 'bg-[#FF5B00] text-white hover:bg-[#E55200]'
                          : 'cursor-not-allowed bg-[#E5E7EB] text-[#9CA3AF]'
                      }`}
                    >
                      {accepting ? 'Lagrer…' : 'Jeg aksepterer avtalen'}
                    </button>
                    {!atBottom ? (
                      <p className="mt-2 text-center text-xs text-[#9CA3AF]">Bla til bunnen av avtalen for å akseptere.</p>
                    ) : null}
                  </>
                )}
                {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
              </div>
            </section>
          </div>
        )}
      </ClientPortalLayout>
    </ClientRouteGuard>
  );
};
