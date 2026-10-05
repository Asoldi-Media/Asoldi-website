import React from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { intakeReview, STEP_LABELS } from '../../../lib/ai-assistant/intake.js';
import { clientMediaSrc } from '../../components/client/settings/clientDataTypes';

type ProductRow = {
  key: string;
  title: string;
  category: string;
  catalogIndex: number;
  categoryIndex: number;
  productIndex: number;
};

type ReviewStep = {
  step: string;
  label: string;
  status: string;
  summary?: string;
  url?: string;
  lines?: string[];
  people?: Array<{ name: string; title: string; imageUrl: string }>;
  groups?: Array<{ key?: string; label: string; urls?: string[]; items?: string[] }>;
};

type Props = {
  bank: Record<string, unknown>;
  token: string;
  currentStep: string;
  productRows: ProductRow[];
  layoutText: string;
  removingProducts: boolean;
  busy: boolean;
  onRemoveProduct: (row: ProductRow) => void;
  onClearProducts: () => void;
};

const EASE = [0.22, 1, 0.36, 1] as const;

function sceneFor(step: string) {
  if (step === 'media') return 'media';
  if (step === 'products') return 'products';
  return 'card';
}

function isVideo(url: string) {
  return /\.(mp4|mov|webm)(\?|$)/i.test(url);
}

function MediaThumb({ url, token }: { url: string; token: string }) {
  const src = clientMediaSrc(url, token);
  if (isVideo(url)) {
    return <video src={src} className="h-full w-full object-cover bg-gray-200" muted />;
  }
  return <img src={src} alt="" className="h-full w-full object-cover" />;
}

function GreySlot({ label }: { label?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/80 px-4 py-3">
      <p className="text-[14px] font-medium text-gray-300">{label || '—'}</p>
      <p className="text-[12px] mt-1 text-gray-300">Fylles inn her</p>
    </div>
  );
}

export function AssistantIntakePanel({
  bank,
  token,
  currentStep,
  productRows,
  layoutText,
  removingProducts,
  busy,
  onRemoveProduct,
  onClearProducts,
}: Props) {
  const review = intakeReview(bank || {}) as { steps: ReviewStep[] };
  const byStep = Object.fromEntries(review.steps.map((step) => [step.step, step]));
  const scene = sceneFor(currentStep);
  const heading = currentStep === 'done'
    ? 'Profil'
    : (STEP_LABELS[currentStep as keyof typeof STEP_LABELS] || STEP_LABELS.products);
  const mediaUrls = (byStep.media?.groups || []).flatMap((group) => group.urls || []);
  const staffCount = byStep.staff?.people?.length || 0;
  const hourLines = byStep.hours?.status === 'filled' ? (byStep.hours.lines || []) : [];
  const partnerCount = (byStep.affiliations?.groups || []).reduce((sum, group) => sum + (group.items?.length || 0), 0);
  const partnerMarks = Math.min(partnerCount, 3);
  const hasLogo = Boolean(byStep.logo?.url);

  return (
    <div className="flex flex-col gap-6">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={heading}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.28, ease: EASE }}
          className="text-[11px] font-bold tracking-[0.2em] text-[#121212] uppercase"
        >
          {heading}
        </motion.span>
      </AnimatePresence>

      <AnimatePresence mode="wait" initial={false}>
        {scene === 'products' ? (
          <motion.div
            key="products"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -14 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="flex flex-col gap-4"
          >
            <div className="border-b border-gray-50 pb-4">
              <span className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Produktsystem</span>
              <p className={`mt-2 text-[22px] font-semibold ${layoutText ? 'text-[#121212]' : 'text-gray-300'}`}>
                {layoutText || 'Normal / Meny / Tiers'}
              </p>
            </div>
            {productRows.length ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={removingProducts || busy}
                  onClick={onClearProducts}
                  className="text-[12px] text-gray-500 hover:text-red-600 disabled:opacity-40"
                >
                  Fjern alle
                </button>
              </div>
            ) : null}
            <div className="flex flex-col gap-3">
              {productRows.length ? (
                <AnimatePresence initial={false}>
                  {productRows.map((row) => (
                    <motion.div
                      key={row.key}
                      layout
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      transition={{ duration: 0.28, ease: EASE }}
                      className="rounded-xl border border-gray-100 bg-white px-4 py-3 flex items-center gap-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-medium text-[#121212] truncate">{row.title}</p>
                        <p className="text-[12px] mt-1 text-gray-500 truncate">{row.category || 'Produkt'}</p>
                      </div>
                      <button
                        type="button"
                        disabled={removingProducts || busy}
                        aria-label={`Fjern ${row.title}`}
                        onClick={() => onRemoveProduct(row)}
                        className="shrink-0 text-[12px] text-gray-400 hover:text-red-600 disabled:opacity-40"
                      >
                        Fjern
                      </button>
                    </motion.div>
                  ))}
                </AnimatePresence>
              ) : (
                <>
                  <GreySlot label="Kategori 1" />
                  <GreySlot label="Kategori 2" />
                </>
              )}
            </div>
          </motion.div>
        ) : null}

        {scene === 'media' ? (
          <motion.div
            key="media"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -14 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="flex flex-col gap-4"
          >
            <p className="text-[13px] text-gray-400">Bildene samles her etter hvert.</p>
            <div className="grid grid-cols-3 gap-2">
              <AnimatePresence initial={false}>
                {mediaUrls.map((url) => (
                  <motion.div
                    key={url}
                    layout
                    initial={{ opacity: 0, scale: 0.92 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.32, ease: EASE }}
                    className="aspect-square overflow-hidden rounded-xl bg-gray-100 border border-gray-100"
                  >
                    <MediaThumb url={url} token={token} />
                  </motion.div>
                ))}
              </AnimatePresence>
              {Array.from({ length: mediaUrls.length ? (mediaUrls.length < 9 ? 1 : 0) : 6 }).map((_, index) => (
                <div
                  key={`ghost-${index}`}
                  className="aspect-square rounded-xl border border-dashed border-gray-200 bg-gray-50/80"
                />
              ))}
            </div>
          </motion.div>
        ) : null}

        {scene === 'card' ? (
          <motion.div
            key="card"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -14 }}
            transition={{ duration: 0.4, ease: EASE }}
          >
            <motion.div layout className="rounded-2xl border border-gray-100 bg-[#F6F6F4] p-5">
              <div className="flex items-start gap-3">
                <motion.div
                  layout
                  animate={{ backgroundColor: hasLogo ? '#E4E4E1' : '#F3F3F1' }}
                  transition={{ duration: 0.35, ease: EASE }}
                  className={`h-14 w-14 shrink-0 rounded-xl border flex items-center justify-center ${
                    hasLogo ? 'border-gray-200' : 'border-dashed border-gray-300'
                  }`}
                >
                  <motion.div
                    animate={{ scale: hasLogo ? 1 : 0.86, opacity: hasLogo ? 1 : 0.55 }}
                    transition={{ type: 'spring', stiffness: 260, damping: 22 }}
                    className="h-7 w-7 rounded-md bg-gray-300"
                  />
                </motion.div>
                <div className="flex-1 pt-2">
                  <div className="h-2.5 w-24 rounded-full bg-gray-200" />
                  <div className="mt-2 h-2 w-16 rounded-full bg-gray-200/70" />
                </div>
              </div>

              <AnimatePresence initial={false}>
                {staffCount > 0 ? (
                  <motion.p
                    key="staff"
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.32, ease: EASE }}
                    className="mt-6 text-[15px] text-gray-500"
                  >
                    Ansatte —{' '}
                    <motion.span
                      key={staffCount}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="inline-block text-gray-600"
                    >
                      {staffCount}
                    </motion.span>
                  </motion.p>
                ) : null}
              </AnimatePresence>

              <AnimatePresence initial={false}>
                {hourLines.length ? (
                  <motion.ul
                    key="hours"
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.32, ease: EASE }}
                    className="mt-5 flex flex-col gap-1"
                  >
                    {hourLines.map((line) => (
                      <li key={line} className="text-[13px] text-gray-500">{line}</li>
                    ))}
                  </motion.ul>
                ) : null}
              </AnimatePresence>

              <AnimatePresence initial={false}>
                {partnerMarks > 0 ? (
                  <motion.div
                    key="partners"
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="mt-5 flex flex-col gap-2"
                  >
                    {Array.from({ length: partnerMarks }).map((_, index) => (
                      <motion.div
                        key={index}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.28, delay: index * 0.06, ease: EASE }}
                        className="h-8 rounded-lg border border-gray-200 bg-gray-200/50"
                      />
                    ))}
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {currentStep === 'done' ? (
        <Link to="/kunde/innstillinger" className="text-[12px] text-gray-400 underline">
          Åpne bedriftsinformasjon
        </Link>
      ) : null}
    </div>
  );
}
