import React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronRight } from 'lucide-react';
import { INTAKE_STEPS, intakeReview, STEP_LABELS } from '../../../lib/ai-assistant/intake.js';
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
  viewStep: string;
  onSelectStep: (step: string) => void;
  onRemoveProduct: (row: ProductRow) => void;
  onClearProducts: () => void;
};

const EASE = [0.22, 1, 0.36, 1] as const;

function sceneFor(step: string) {
  if (step === 'media') return 'media';
  if (step === 'products') return 'products';
  if (step === 'logo') return 'logo';
  if (step === 'staff') return 'staff';
  if (step === 'hours') return 'hours';
  if (step === 'affiliations') return 'affiliations';
  if (step === 'done') return 'done';
  return 'products';
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
  viewStep,
  onSelectStep,
  onRemoveProduct,
  onClearProducts,
}: Props) {
  const review = intakeReview(bank || {}) as { steps: ReviewStep[]; current?: string };
  const byStep = Object.fromEntries(review.steps.map((step) => [step.step, step]));
  const mediaUrls = (byStep.media?.groups || []).flatMap((group) => group.urls || []);
  const people = byStep.staff?.people || [];
  const hourLines = byStep.hours?.status === 'filled' ? (byStep.hours.lines || []) : [];
  const partnerGroups = byStep.affiliations?.groups || [];
  const hasLogo = Boolean(byStep.logo?.url);

  const ordered = INTAKE_STEPS.map((step) => byStep[step]).filter(Boolean);
  const released = (chapter: ReviewStep) => {
    const flag = String((bank as { assistantIntake?: Record<string, string> })?.assistantIntake?.[chapter.step] || '');
    if (flag === 'more') return false;
    return chapter.status === 'filled' || chapter.status === 'skipped' || flag === 'done' || flag === 'skipped';
  };
  const frontier = ordered.findIndex((chapter) => !released(chapter));
  const chapters = frontier === -1 ? ordered : ordered.slice(0, frontier + 1);
  const preferred = viewStep || currentStep;
  const shownStep = chapters.some((chapter) => chapter.step === preferred)
    ? preferred
    : (chapters[chapters.length - 1]?.step || 'products');
  const scene = sceneFor(shownStep);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        {chapters.map((chapter) => {
          const selected = chapter.step === shownStep;
          return (
            <button
              key={chapter.step}
              type="button"
              aria-pressed={selected}
              disabled={busy}
              onClick={() => onSelectStep(chapter.step)}
              className={`flex items-center gap-1.5 w-fit text-left text-[14px] disabled:opacity-60 ${
                selected ? 'text-[#121212] font-medium' : 'text-gray-400 hover:text-gray-500'
              }`}
            >
              <span>{chapter.label || STEP_LABELS[chapter.step as keyof typeof STEP_LABELS]}</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          );
        })}
      </div>

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

        {scene === 'logo' ? (
          <motion.div
            key="logo"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -14 }}
            transition={{ duration: 0.4, ease: EASE }}
          >
            <div className={`h-16 w-16 rounded-xl border flex items-center justify-center ${
              hasLogo ? 'border-gray-200 bg-[#E4E4E1]' : 'border-dashed border-gray-300 bg-gray-50/80'
            }`}>
              <div className={`h-7 w-7 rounded-md bg-gray-300 ${hasLogo ? 'opacity-100' : 'opacity-50'}`} />
            </div>
            <p className="mt-3 text-[13px] text-gray-400">{hasLogo ? 'Logo lagret' : 'Ingen logo ennå'}</p>
          </motion.div>
        ) : null}

        {scene === 'staff' ? (
          <motion.div
            key="staff"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -14 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="flex flex-col gap-3"
          >
            {people.length ? people.map((person) => (
              <div key={`${person.name}-${person.title}`} className="rounded-xl border border-gray-100 bg-white px-4 py-3">
                <p className="text-[14px] font-medium text-[#121212]">{person.name || 'Ansatt'}</p>
                <p className="text-[12px] mt-1 text-gray-500">{person.title || 'Stilling'}</p>
              </div>
            )) : (
              <GreySlot label="Ansatt" />
            )}
          </motion.div>
        ) : null}

        {scene === 'hours' ? (
          <motion.div
            key="hours"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -14 }}
            transition={{ duration: 0.4, ease: EASE }}
          >
            {hourLines.length ? (
              <ul className="flex flex-col gap-1">
                {hourLines.map((line) => (
                  <li key={line} className="text-[13px] text-gray-500">{line}</li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-col gap-2">
                <GreySlot label="Mandag" />
                <GreySlot label="Tirsdag" />
              </div>
            )}
          </motion.div>
        ) : null}

        {scene === 'affiliations' ? (
          <motion.div
            key="affiliations"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -14 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="flex flex-col gap-3"
          >
            {partnerGroups.length ? partnerGroups.map((group) => (
              <div key={group.label} className="rounded-xl border border-gray-100 bg-white px-4 py-3">
                <p className="text-[12px] text-gray-400">{group.label}</p>
                <p className="text-[14px] text-[#121212] mt-1">{(group.items || []).join(', ')}</p>
              </div>
            )) : (
              <GreySlot label="Partnere" />
            )}
          </motion.div>
        ) : null}

        {scene === 'done' ? (
          <motion.p
            key="done"
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -14 }}
            transition={{ duration: 0.4, ease: EASE }}
            className="text-[13px] text-gray-400"
          >
            Velg et steg over for å se eller legge til mer.
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
