import { Check } from 'lucide-react';

type Step = 1 | 2 | 3;

const STEPS: { step: Step; label: string; goal: string }[] = [
  { step: 1, label: 'Kundekort', goal: 'Møte' },
  { step: 2, label: 'Produktnotater', goal: 'Tilbud' },
  { step: 3, label: 'Tilbud', goal: 'Tilbud' },
];

export function SalesFlowSteps({
  step,
  onStep,
  showGoals = false,
  done = {},
}: {
  step: Step;
  onStep: (step: Step) => void;
  /** Shows which sales goal each step belongs to. */
  showGoals?: boolean;
  /** Ticks steps whose checklist step is done (Les deg opp, Produktnotater, Send tilbud). */
  done?: Partial<Record<Step, boolean>>;
}) {
  const label = (item: (typeof STEPS)[number]) => (
    <>
      {showGoals ? (
        <span className="block text-[10px] font-medium uppercase tracking-wide opacity-70">{item.goal}</span>
      ) : null}
      <span className="inline-flex items-center justify-center gap-1">
        {done[item.step] ? <Check size={14} aria-label="Ferdig" /> : null}
        {item.step} · {item.label}
      </span>
    </>
  );
  return (
    <>
      <div className="flex sm:hidden items-center gap-1.5">
        {STEPS.map((item) => (
          <button
            key={item.step}
            type="button"
            onClick={() => onStep(item.step)}
            aria-label={item.label}
            aria-current={item.step === step ? 'step' : undefined}
            className="flex-1 py-2"
          >
            <span
              className={`block h-1 rounded-full ${
                item.step === step ? 'bg-[#FF5B00]' : done[item.step] ? 'bg-emerald-400' : 'bg-[#E6E9EF]'
              }`}
            />
          </button>
        ))}
      </div>
      <div className="hidden sm:grid grid-cols-3 gap-2">
        {STEPS.map((item) => (
          item.step === step ? (
            <span key={item.step} className="rounded-xl bg-[#FF5B00] text-white px-3 py-3 text-sm font-semibold text-center leading-tight">
              {label(item)}
            </span>
          ) : (
            <button
              key={item.step}
              type="button"
              onClick={() => onStep(item.step)}
              className={`rounded-xl border-2 bg-white px-3 py-3 text-sm font-semibold text-center hover:border-[#FF5B00] hover:text-[#FF5B00] leading-tight ${
                done[item.step] ? 'border-emerald-300 text-emerald-700' : 'border-[#E6E9EF] text-[#111827]'
              }`}
            >
              {label(item)}
            </button>
          )
        ))}
      </div>
    </>
  );
}
