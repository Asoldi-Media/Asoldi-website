import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ChevronDown, LogOut } from 'lucide-react';
import {
  AnsattAsoldiContent,
  AsoldiIntroPanel,
  AsoldiLydklippPanel,
  AsoldiPartnersPanel,
  AsoldiStatsPanel,
} from './ansatt/AnsattAsoldiContent';
import { AnsattSsuContent, SsuIntroPanel, SsuLydklippPanel, SsuPartnersPanel } from './ansatt/AnsattSsuContent';
import { RINGESYSTEM_HREF } from './ansatt/path';

const TAWK_SCRIPT_SRC = 'https://embed.tawk.to/69540cdf143421197fdc9ee5/1jdo54im0';

export type EmployeeProduct = 'asoldi' | 'ssu';
type PanelId = 'intro' | 'stats' | 'lydklipp' | 'partners';

function getEmployeeToken() {
  return typeof window !== 'undefined' ? localStorage.getItem('employeeToken') : null;
}

function clearEmployeeToken() {
  localStorage.removeItem('employeeToken');
}

function HeaderTab({
  id,
  label,
  open,
  onToggle,
}: {
  id: PanelId;
  label: string;
  open: PanelId | null;
  onToggle: (id: PanelId) => void;
}) {
  const active = open === id;
  return (
    <button
      type="button"
      onClick={() => onToggle(id)}
      className={`inline-flex items-center gap-1 px-3 py-2 rounded-lg text-sm ${
        active ? 'bg-[#FF5B00] text-white' : 'text-gray-700 hover:bg-gray-100'
      }`}
      aria-expanded={active}
    >
      {label}
      <ChevronDown size={14} className={`transition-transform ${active ? 'rotate-180' : ''}`} />
    </button>
  );
}

export const Ansatt = () => {
  const navigate = useNavigate();
  const headerRef = useRef<HTMLElement | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [employeeProduct, setEmployeeProduct] = useState<EmployeeProduct>('asoldi');
  const [staffRole, setStaffRole] = useState<string>('employee');
  const [identity, setIdentity] = useState<{
    name?: string;
    username?: string;
    fromEmail?: string;
  } | null>(null);
  const [openPanel, setOpenPanel] = useState<PanelId | null>(null);

  useEffect(() => {
    const t = getEmployeeToken();
    if (!t) {
      navigate('/login', { replace: true });
      return;
    }
    let cancelled = false;
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${t}` } })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 401) {
          clearEmployeeToken();
          navigate('/login', { replace: true });
          return;
        }
        if (res.ok) {
          const data = await res.json();
          if (data.user?.role === 'developer') {
            navigate('/developer', { replace: true });
            return;
          }
          setStaffRole(data.user?.role || 'employee');
          setIdentity({
            name: data.user?.name,
            username: data.user?.username,
            fromEmail: data.user?.fromEmail,
          });
          setEmployeeProduct(data.user?.employeeProduct === 'ssu' ? 'ssu' : 'asoldi');
          setAllowed(true);
        } else {
          setAllowed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setAllowed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  useEffect(() => {
    if (!allowed) return;
    if (document.getElementById('tawk-script')) return;
    const s1 = document.createElement('script');
    const s0 = document.getElementsByTagName('script')[0];
    s1.id = 'tawk-script';
    s1.async = true;
    s1.src = TAWK_SCRIPT_SRC;
    s1.charset = 'UTF-8';
    s1.setAttribute('crossorigin', '*');
    if (s0?.parentNode) s0.parentNode.insertBefore(s1, s0);
    return () => {
      const script = document.getElementById('tawk-script');
      script?.parentNode?.removeChild(script);
      document.querySelectorAll('iframe[src*="tawk.to"]').forEach((el) => el.parentNode?.removeChild(el));
      const container = document.getElementById('tawkchat-container');
      container?.parentNode?.removeChild(container);
      const root = document.getElementById('tawkchat');
      root?.parentNode?.removeChild(root);
      try {
        // @ts-expect-error - best-effort global cleanup
        delete window.Tawk_API;
        // @ts-expect-error - best-effort global cleanup
        delete window.Tawk_LoadStart;
      } catch {
        // ignore
      }
    };
  }, [allowed]);

  useEffect(() => {
    if (!openPanel) return;
    function onDoc(event: MouseEvent) {
      if (headerRef.current && !headerRef.current.contains(event.target as Node)) {
        setOpenPanel(null);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpenPanel(null);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [openPanel]);

  const handleLogout = () => {
    clearEmployeeToken();
    navigate('/login', { replace: true });
  };

  const togglePanel = (id: PanelId) => {
    setOpenPanel((current) => (current === id ? null : id));
  };

  if (allowed === null) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <p className="text-gray-500">Laster…</p>
      </div>
    );
  }

  const isSsu = employeeProduct === 'ssu';

  return (
    <>
      <Helmet>
        <title>Møte booker – Asoldi</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>

      <div
        className="checklist-widget"
        style={{
          position: 'fixed',
          bottom: 20,
          left: 20,
          zIndex: 9999,
          fontFamily: 'Arial, sans-serif',
        }}
      >
        <input type="checkbox" id="ansatt-checklist-toggle" className="sr-only" aria-hidden="true" />
        <label
          htmlFor="ansatt-checklist-toggle"
          className="checklist-button cursor-pointer inline-block bg-white text-black py-3 px-4 rounded-full text-sm shadow-lg hover:bg-gray-100 border border-black/10"
        >
          📋 Møte-sjekkliste
        </label>
        <div className="ansatt-checklist-box mt-2 w-80 p-4 bg-white rounded-xl shadow-xl text-sm text-gray-800">
          <h4 className="m-0 mb-3 text-base font-semibold">Husk å skaffe før møtet</h4>
          <ol className="pl-5 m-0 space-y-2 list-decimal">
            <li>Skaff e-post til kunde</li>
            <li>Riktig telefonnummer til kunde</li>
            <li>Navn til møteperson</li>
            <li>Adresse for møtested</li>
            <li>Informer om at vi sender e-post: 1 dag før møtet for å verifisere</li>
          </ol>
        </div>
      </div>

      <div className="min-h-screen bg-white text-gray-900">
        <header ref={headerRef} className="relative border-b border-gray-200 bg-white z-40">
          <div className="px-4 py-3 flex flex-wrap items-center gap-2">
            <Link to="/" className="flex items-center gap-2 font-semibold mr-2">
              <span className="text-[#FF5B00]">Asoldi</span>
              <span className="text-gray-300">|</span>
              <span>Møte booker</span>
            </Link>
            <HeaderTab id="intro" label="Intro" open={openPanel} onToggle={togglePanel} />
            {!isSsu ? <HeaderTab id="stats" label="Statistikk" open={openPanel} onToggle={togglePanel} /> : null}
            <HeaderTab id="lydklipp" label="Lydklipp" open={openPanel} onToggle={togglePanel} />
            <HeaderTab id="partners" label="Partnere" open={openPanel} onToggle={togglePanel} />
            <a
              href={RINGESYSTEM_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center px-3 py-2 rounded-lg bg-[#FF5B00] text-white text-sm font-medium hover:bg-[#e55200]"
            >
              Gå til ringesystem
            </a>
            <div className="ml-auto flex items-center gap-2">
              {staffRole === 'sales' ? (
                <Link to="/sales" className="px-3 py-2 rounded-lg text-gray-600 hover:bg-gray-100 text-sm">
                  Salgstavle
                </Link>
              ) : null}
              <button
                type="button"
                onClick={handleLogout}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-gray-600 hover:bg-gray-100"
              >
                <LogOut size={18} /> Logg ut
              </button>
            </div>
          </div>
          {openPanel ? (
            <div className="absolute inset-x-0 top-full border-b border-gray-200 bg-white shadow-lg">
              <div className="max-w-5xl mx-auto px-4 py-6 max-h-[min(80vh,44rem)] overflow-y-auto">
                {openPanel === 'intro' ? (isSsu ? <SsuIntroPanel /> : <AsoldiIntroPanel />) : null}
                {openPanel === 'stats' && !isSsu ? <AsoldiStatsPanel identity={identity} /> : null}
                {openPanel === 'lydklipp' ? (isSsu ? <SsuLydklippPanel /> : <AsoldiLydklippPanel />) : null}
                {openPanel === 'partners' ? (isSsu ? <SsuPartnersPanel /> : <AsoldiPartnersPanel />) : null}
              </div>
            </div>
          ) : null}
        </header>

        <main className="max-w-5xl mx-auto px-4 py-8 pb-24">
          {isSsu ? <AnsattSsuContent /> : <AnsattAsoldiContent />}
        </main>
      </div>

      <style>{`
        .ansatt-checklist-box { display: none; }
        #ansatt-checklist-toggle:checked ~ .ansatt-checklist-box { display: block; }
      `}</style>
    </>
  );
};
