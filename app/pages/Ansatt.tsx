import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { LogOut } from 'lucide-react';
import { AnsattAsoldiContent } from './ansatt/AnsattAsoldiContent';
import { AnsattSsuContent } from './ansatt/AnsattSsuContent';

const TAWK_SCRIPT_SRC = 'https://embed.tawk.to/69540cdf143421197fdc9ee5/1jdo54im0';

export type EmployeeProduct = 'asoldi' | 'ssu';

function getEmployeeToken() {
  return typeof window !== 'undefined' ? localStorage.getItem('employeeToken') : null;
}

function clearEmployeeToken() {
  localStorage.removeItem('employeeToken');
}

export const Ansatt = () => {
  const navigate = useNavigate();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [employeeProduct, setEmployeeProduct] = useState<EmployeeProduct>('asoldi');
  const [staffRole, setStaffRole] = useState<string>('employee');
  const [identity, setIdentity] = useState<{
    name?: string;
    username?: string;
    fromEmail?: string;
  } | null>(null);

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

  const handleLogout = () => {
    clearEmployeeToken();
    navigate('/login', { replace: true });
  };

  if (allowed === null) {
    return (
      <div className="min-h-screen bg-[#050505] flex items-center justify-center">
        <p className="text-gray-400">Laster…</p>
      </div>
    );
  }

  return (
    <>
      <Helmet>
        <title>Ansatt – Asoldi</title>
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

      <div className="min-h-screen bg-[#050505] text-white">
        <header className="border-b border-white/10 px-4 py-3 flex items-center justify-between bg-[#0a0a0a]">
          <Link to="/" className="flex items-center gap-2 text-white font-semibold">
            <span className="text-[#FF5B00]">Asoldi</span>
            <span className="text-gray-400">|</span>
            <span>Ansatt</span>
          </Link>
          <div className="flex items-center gap-2">
            {staffRole === 'sales' ? (
              <Link to="/sales" className="px-3 py-2 rounded-lg text-gray-400 hover:bg-white/10 hover:text-white text-sm">
                Salgstavle
              </Link>
            ) : null}
            <button
              type="button"
              onClick={handleLogout}
              className="flex items-center gap-2 px-3 py-2 rounded-lg text-gray-400 hover:bg-white/10 hover:text-white"
            >
              <LogOut size={18} /> Logg ut
            </button>
          </div>
        </header>

        <main className="max-w-5xl mx-auto px-4 py-8 pb-24">
          {employeeProduct === 'ssu' ? <AnsattSsuContent /> : <AnsattAsoldiContent identity={identity} />}
        </main>
      </div>

      <style>{`
        .ansatt-checklist-box { display: none; }
        #ansatt-checklist-toggle:checked ~ .ansatt-checklist-box { display: block; }
      `}</style>
    </>
  );
};
