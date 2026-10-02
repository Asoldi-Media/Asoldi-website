import React, { useState } from 'react';

const ANSATT_CALENDAR_SOURCES = [
  'damian@asoldi.com',
  'alexander@asoldi.com',
];

export const CALENDAR_EMBED = (() => {
  const params = new URLSearchParams({
    ctz: 'Europe/Oslo',
    mode: 'WEEK',
    wkst: '2',
    showTitle: '0',
    showPrint: '0',
    showCalendars: '1',
    showTz: '0',
    hl: 'no',
  });
  for (const src of ANSATT_CALENDAR_SOURCES) {
    params.append('src', src);
  }
  return `https://calendar.google.com/calendar/embed?${params.toString()}`;
})();

export type StatItem = { value: string; label: string };
export type ProductItem = { title: string; body: string };
export type ProductSection = { title: string; items: readonly ProductItem[] };
export type LydklippClip = { file: string; isNew: boolean };

const LYDKLIPP_VISIBLE = 5;

export function WelcomeSection({ title }: { title: string }) {
  return (
    <section className="mb-10">
      <h1 className="text-2xl font-bold text-white mb-2">{title}</h1>
      <p className="text-gray-400 mb-6">Under finner du all informasjon du trenger for å booke møter</p>
      <a
        href="https://asoldi.myphoner.com/work"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center justify-center px-5 py-2.5 rounded-lg bg-[#FF5B00] text-white font-medium hover:bg-[#e55200] transition-colors"
      >
        Gå til ringesystem
      </a>
    </section>
  );
}

export function CalendarSection() {
  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold text-white mb-4">Booking informasjon</h2>
      <div className="rounded-2xl overflow-hidden border border-white/10 bg-[#1a1a1a]">
        <iframe
          title="Kalender"
          src={CALENDAR_EMBED}
          style={{ border: 0, width: '100%', minHeight: 400 }}
          width="800"
          height="600"
        />
      </div>
    </section>
  );
}

export function AboutUsSection({ children }: { children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-2xl md:text-3xl font-bold text-white mb-6">Hvem er vi</h2>
      <div className="rounded-2xl bg-[#1a1a1a] border border-white/10 p-6 md:p-8">
        <div className="space-y-4 text-gray-300 text-base md:text-lg leading-relaxed">{children}</div>
      </div>
    </section>
  );
}

export function InfoCards({
  targetAudience,
  goal,
}: {
  targetAudience: React.ReactNode;
  goal: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-xl bg-[#1a1a1a] border border-white/10 p-6">
          <h3 className="text-lg font-semibold text-white mb-3">Målgruppe</h3>
          <div className="text-gray-400 text-sm leading-relaxed">{targetAudience}</div>
        </div>
        <div className="rounded-xl bg-[#1a1a1a] border border-white/10 p-6">
          <h3 className="text-lg font-semibold text-white mb-3">Mål</h3>
          <div className="text-gray-400 text-sm leading-relaxed">{goal}</div>
        </div>
      </div>
    </section>
  );
}

function LydklippPlayer({ file, isNew }: LydklippClip) {
  const src = `/media/${encodeURIComponent(file)}`;
  return (
    <div className="relative rounded-xl bg-[#1a1a1a] border border-white/10 p-4">
      {isNew && (
        <span className="absolute top-3 right-3 z-10 rounded-full bg-[#FF5B00] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow-sm">
          New
        </span>
      )}
      <audio controls className="w-full" style={{ maxWidth: '100%' }}>
        <source src={src} type="audio/wav" />
        Din nettleser støtter ikke lydspiller.
      </audio>
    </div>
  );
}

export function LydklippSection({ clips = [] }: { clips?: readonly LydklippClip[] }) {
  const [expanded, setExpanded] = useState(false);
  const hasClips = clips.length > 0;

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold text-white mb-4">Lydklipp</h2>
      {!hasClips ? (
        <div className="rounded-xl bg-[#1a1a1a] border border-white/10 p-6 text-center">
          <p className="text-gray-400 text-sm">Ingen lydklipp tilgjengelig ennå.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {clips.slice(0, LYDKLIPP_VISIBLE).map((clip) => (
            <LydklippPlayer key={clip.file} file={clip.file} isNew={clip.isNew} />
          ))}
          {clips.length > LYDKLIPP_VISIBLE && (
            <>
              <button
                type="button"
                onClick={() => setExpanded((open) => !open)}
                className="w-full text-left text-sm font-medium text-[#FF5B00] hover:text-[#ff7b2e] transition-colors py-1"
                aria-expanded={expanded}
              >
                {expanded
                  ? 'Vis færre samtaler'
                  : `Se ${clips.length - LYDKLIPP_VISIBLE} flere samtaler`}
              </button>
              {expanded && (
                <div className="space-y-4">
                  {clips.slice(LYDKLIPP_VISIBLE).map((clip) => (
                    <LydklippPlayer key={clip.file} file={clip.file} isNew={clip.isNew} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

export function ProductSections({ sections }: { sections: readonly ProductSection[] }) {
  return (
    <>
      {sections.map((section) => (
        <section key={section.title} className="mb-10">
          <h2 className="text-xl font-semibold text-white mb-4">{section.title}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {section.items.map((item) => (
              <div key={item.title} className="rounded-xl bg-[#1a1a1a] border border-white/10 p-6">
                <h3 className="text-lg font-semibold text-white mb-2">{item.title}</h3>
                <p className="text-gray-400 text-sm">{item.body}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

export function StatsRow({ stats }: { stats: readonly StatItem[] }) {
  return (
    <section className="mb-10">
      <div className={`grid gap-4 grid-cols-2 ${stats.length >= 5 ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}>
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl bg-[#1a1a1a] border border-white/10 p-5 text-center"
          >
            <p className="text-2xl md:text-3xl font-bold text-[#FF5B00] mb-2">{stat.value}</p>
            <p className="text-gray-400 text-sm leading-snug">{stat.label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

export function PartnersSection({ children }: { children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-xl font-semibold text-white mb-4">Partnere og resultater</h2>
      <div className="space-y-6">{children}</div>
    </section>
  );
}
