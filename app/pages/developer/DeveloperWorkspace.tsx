import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Loader2, LogOut } from 'lucide-react';
import { DevelopmentClientsSection } from '../Admin/sections/DevelopmentClientsSection';
import { API, getDevelopmentToken } from '../Admin/shared';

export const DeveloperWorkspace = () => {
  const navigate = useNavigate();
  const [status, setStatus] = useState<'checking' | 'ready' | 'denied'>('checking');

  useEffect(() => {
    const token = getDevelopmentToken();
    if (!token) {
      navigate('/login/ansatt', { replace: true });
      return;
    }
    let active = true;
    (async () => {
      try {
        const response = await fetch(`${API}/admin/development`, {
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
        <Loader2 className="animate-spin mr-2" size={20} /> Laster utviklerarbeidsplass…
      </div>
    );
  }

  if (status === 'denied') {
    return (
      <div className="staff-light min-h-screen bg-[#1a1a1a] flex flex-col items-center justify-center gap-4 text-gray-300 px-6 text-center">
        <h1 className="text-xl font-semibold text-white">Ingen tilgang</h1>
        <p className="max-w-md text-sm text-gray-400">
          Denne kontoen har ikke developer-rollen. Be en administrator om å sette rollen til «Developer».
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
        <title>Utvikling – Asoldi</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <div className="staff-light min-h-screen bg-[#1a1a1a] text-white">
        <header className="border-b border-white/10 bg-[#222]">
          <div className="max-w-[1200px] mx-auto px-6 py-4 flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold">Utvikling</h1>
              <p className="text-xs text-gray-400">
                Én kundeliste med fire måltrinn: Klar for preview, Klar for deployment, Iterasjon ferdig, Publish.
              </p>
            </div>
            <button
              type="button"
              onClick={logout}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-white/10 hover:bg-white/15 text-sm"
            >
              <LogOut size={15} />
              Logg ut
            </button>
          </div>
        </header>
        <main className="max-w-[1200px] mx-auto px-6 py-8">
          <DevelopmentClientsSection />
        </main>
      </div>
    </>
  );
};
