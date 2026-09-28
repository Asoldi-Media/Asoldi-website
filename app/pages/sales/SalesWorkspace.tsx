import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Loader2, LogOut } from 'lucide-react';
import { SalesClientsSection } from '../Admin/sections/SalesClientsSection';
import { SalesScriptsDock } from './SalesScriptsDock';
import { API, getSalesToken } from '../Admin/shared';

export const SalesWorkspace = () => {
  const navigate = useNavigate();
  const [status, setStatus] = useState<'checking' | 'ready' | 'denied'>('checking');

  useEffect(() => {
    const token = getSalesToken();
    if (!token) {
      navigate('/login/ansatt', { replace: true });
      return;
    }
    let active = true;
    (async () => {
      try {
        const response = await fetch(`${API}/admin/sales/google/status`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!active) return;
        if (response.status === 401 || response.status === 403) {
          setStatus('denied');
          return;
        }
        setStatus('ready');
      } catch {
        if (active) setStatus('ready');
      }
    })();
    return () => {
      active = false;
    };
  }, [navigate]);

  function logout() {
    localStorage.removeItem('employeeToken');
    window.dispatchEvent(new Event('employee-auth-changed'));
    navigate('/login/ansatt', { replace: true });
  }

  if (status === 'checking') {
    return (
      <div className="staff-light min-h-screen bg-[#1a1a1a] flex items-center justify-center text-gray-300">
        <Loader2 className="animate-spin mr-2" size={20} /> Laster salgsarbeidsplass…
      </div>
    );
  }

  if (status === 'denied') {
    return (
      <div className="staff-light min-h-screen bg-[#1a1a1a] flex flex-col items-center justify-center gap-4 text-gray-300 px-6 text-center">
        <h1 className="text-xl font-semibold text-white">Ingen tilgang</h1>
        <p className="max-w-md text-sm text-gray-400">
          Denne kontoen har ikke salgsrolle. Be en administrator om å gi deg «sales»-rollen, eller logg inn med en
          salgskonto.
        </p>
        <button type="button" onClick={logout} className="px-4 py-2 rounded-lg bg-[#FF5B00] text-white hover:bg-[#e55200]">
          Til innlogging
        </button>
      </div>
    );
  }

  return (
    <>
      <Helmet>
        <title>Salgsarbeidsplass – Asoldi</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <div className="staff-light min-h-screen bg-[#1a1a1a] text-white">
        <header className="border-b border-white/10 bg-[#222]">
          <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-3 sm:py-4 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h1 className="text-base sm:text-lg font-semibold truncate">Salgsarbeidsplass</h1>
              <p className="hidden sm:block text-xs text-gray-400">Dine salgskunder, møter og din egen Google Kalender.</p>
            </div>
            <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
              <Link
                to="/sales/email/templates"
                className="inline-flex items-center px-2.5 sm:px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-xs sm:text-sm"
              >
                Maler
              </Link>
              <Link
                to="/previews"
                className="hidden sm:inline-flex items-center px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm"
              >
                Public previews
              </Link>
              <button
                type="button"
                onClick={logout}
                className="inline-flex items-center gap-2 px-2.5 sm:px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-xs sm:text-sm"
              >
                <LogOut size={15} />
                <span className="hidden sm:inline">Logg ut</span>
              </button>
            </div>
          </div>
        </header>
        <main className="max-w-[1200px] mx-auto px-3 sm:px-6 py-4 sm:py-8">
          <SalesClientsSection />
        </main>
        <SalesScriptsDock />
      </div>
    </>
  );
};
