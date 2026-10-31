import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** Same cases as asoldi.com homepage + møte-booker partner results. */
const PROJECTS = [
  {
    name: 'Superhero Burger',
    result: '9 600',
    label: 'unike besøkende / mnd',
    detail: '320 unike besøkende om dagen. SEO/Maps-ranking og synkede SoMe-innlegg.',
    logo: '/media/logo.jpg',
  },
  {
    name: "S'wich restaurant",
    result: '#3',
    label: 'på «restaurant» i Trondheim',
    detail: 'Gikk fra nr. 10 til nr. 6 på Maps, og ranker nr. 3 etter 1 uke med nettside.',
    logo: '/media/7444a9e70b64378cb31902781eb700f98431feee.webp',
  },
  {
    name: 'Svelstad gård',
    result: '10',
    label: 'bestillinger første uke',
    detail: '400 nye besøkende første uka. Kontakt skjema og e-postliste for salgsnyheter.',
    logo: '/media/Uten-navn-1000-x-500-px3.webp',
  },
  {
    name: 'Mong Sushi',
    result: '8%+',
    label: 'konverteringsrate',
    detail: 'Meny, bilder og takeaway-bestilling. Enkel måte å sende henvendelser.',
    logo: '/media/mong sushi logo.webp',
  },
  {
    name: 'Værnes bar',
    result: '#1',
    label: 'på Google',
    detail: 'Bestilling, henvendelser og bordbooking — helhetlig restaurantløsning.',
    logo: '/media/Untitled_design__13_-removebg-preview.png',
  },
] as const;

const REVIEWS = [
  {
    name: 'Christopher Vrioni',
    role: 'Superhero Burger AS',
    quote:
      'Super happy with the website these guys made for us at superhero burger & superhero pizza (superheroinvest.no). They really done a good job... the whole process was smooth from start to finish. The site is clean, easy to use, and does exactly what we need it to.',
    image: '/media/christopher.avif',
  },
  {
    name: 'Naing Zaw Win',
    role: 'Mong Sushi',
    quote: 'Veldig fornøyd, veldig glad.',
    image: '/media/naing%20zaw%20win.jpg',
  },
] as const;

export function SalesProjectsPopup({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/50 p-3"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sales-projects-title"
        className="w-full max-w-2xl max-h-[88vh] overflow-hidden rounded-2xl bg-white text-[#111827] border border-[#E6E9EF] shadow-2xl flex flex-col"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#E6E9EF]">
          <h3 id="sales-projects-title" className="font-semibold text-sm sm:text-base">
            Tidligere prosjekter
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg bg-[#F3F4F6] text-[#111827] hover:bg-[#E5E7EB]"
            aria-label="Lukk"
          >
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto p-4 space-y-4">
          <ul className="space-y-3">
            {PROJECTS.map((project) => (
              <li key={project.name} className="rounded-xl border border-[#E6E9EF] bg-[#F8F9FB] p-3">
                <div className="flex items-start gap-3">
                  <img
                    src={project.logo}
                    alt=""
                    className="h-10 w-16 object-contain shrink-0"
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="font-semibold text-[#111827]">{project.name}</span>
                      <span className="text-[#FF5B00] font-semibold">{project.result}</span>
                      <span className="text-xs text-[#6B7280]">{project.label}</span>
                    </div>
                    <p className="mt-1 text-[13px] leading-snug text-[#374151]">{project.detail}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[#6B7280] mb-2">
              Anmeldelser
            </h4>
            <ul className="space-y-3">
              {REVIEWS.map((review) => (
                <li key={review.name} className="rounded-xl border border-[#E6E9EF] p-3">
                  <div className="flex items-center gap-2 mb-1.5">
                    <img
                      src={review.image}
                      alt=""
                      className="h-8 w-8 rounded-full object-cover"
                      onError={(event) => {
                        event.currentTarget.style.display = 'none';
                      }}
                    />
                    <div>
                      <div className="text-sm font-medium">{review.name}</div>
                      <div className="text-xs text-[#FF5B00]">{review.role}</div>
                    </div>
                  </div>
                  <p className="text-[13px] leading-snug text-[#374151]">«{review.quote}»</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
