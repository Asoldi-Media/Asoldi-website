type Step = 1 | 2 | 3;

const STEPS: { step: Step; label: string }[] = [
  { step: 1, label: 'Kundekort' },
  { step: 2, label: 'Produktnotater' },
  { step: 3, label: 'Tilbud' },
];

export function SalesFlowSteps({ step, onStep }: { step: Step; onStep: (step: Step) => void }) {
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
                item.step === step ? 'bg-[#FF5B00]' : 'bg-[#E6E9EF]'
              }`}
            />
          </button>
        ))}
      </div>
      <div className="hidden sm:grid grid-cols-3 gap-2">
        {STEPS.map((item) => (
          item.step === step ? (
            <span key={item.step} className="rounded-xl bg-[#FF5B00] text-white px-3 py-3 text-sm font-semibold text-center leading-tight">
              {item.step} · {item.label}
            </span>
          ) : (
            <button
              key={item.step}
              type="button"
              onClick={() => onStep(item.step)}
              className="rounded-xl border-2 border-[#E6E9EF] bg-white px-3 py-3 text-sm font-semibold text-center text-[#111827] hover:border-[#FF5B00] hover:text-[#FF5B00] leading-tight"
            >
              {item.step} · {item.label}
            </button>
          )
        ))}
      </div>
    </>
  );
}
