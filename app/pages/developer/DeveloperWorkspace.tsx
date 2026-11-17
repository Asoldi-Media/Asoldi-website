import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { Loader2 } from 'lucide-react';
import { DevelopmentClientsSection } from '../Admin/sections/DevelopmentClientsSection';
import { API, getDevelopmentToken } from '../Admin/shared';
import { DeliveryBoard } from './DeliveryBoard';

type WorkspaceSettings = { devBoardV2?: boolean } | null | undefined;

/** True only when the optional flag is exactly true. A missing flag stays off. */
export function devBoardEnabled(settings: WorkspaceSettings): boolean {
  return Boolean(settings && settings.devBoardV2 === true);
}

type WorkspaceProps = {
  initialStatus?: 'checking' | 'ready' | 'denied';
  settings?: WorkspaceSettings;
  startLegacy?: boolean;
};

export const DeveloperWorkspace = ({ initialStatus, settings, startLegacy = false }: WorkspaceProps = {}) => {
  const navigate = useNavigate();
  const [status, setStatus] = useState<'checking' | 'ready' | 'denied'>(initialStatus || 'checking');
  const [boardOn, setBoardOn] = useState(() => devBoardEnabled(settings));
  const [legacyView, setLegacyView] = useState(startLegacy);

  useEffect(() => {
    if (initialStatus) return undefined;
    const token = getDevelopmentToken();
    if (!token) {
      navigate('/login/ansatt', { replace: true });
      return undefined;
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
        try {
          const body = await response.clone().json();
          const nested = body && typeof body === 'object' ? body.settings : undefined;
          if (active && (devBoardEnabled(nested) || devBoardEnabled(body))) setBoardOn(true);
        } catch {
          // The list body is optional. A missing flag stays off.
        }
        if (active) setStatus('ready');
      } catch {
        if (active) setStatus('ready');
      }
    })();
    return () => {
      active = false;
    };
  }, [navigate, initialStatus]);

  function logout() {
    localStorage.removeItem('employeeToken');
    window.dispatchEvent(new Event('employee-auth-changed'));
    navigate('/login/ansatt', { replace: true });
  }

  if (status === 'checking') {
    return (
      <div className="staff-light min-h-screen bg-[#1a1a1a] flex items-center justify-center text-gray-300">
        <Loader2 className="animate-spin mr-2" size={20} /> Laster utviklerterminal…
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

  if (boardOn && !legacyView) {
    return (
      <>
        <Helmet>
          <title>Utviklerterminal – Asoldi</title>
          <meta name="robots" content="noindex,nofollow" />
        </Helmet>
        <div className="staff-light developer-fill flex h-dvh w-full flex-col overflow-hidden bg-[#1a1a1a] text-white">
          <div className="flex shrink-0 items-center justify-end px-4 py-2">
            <button
              type="button"
              data-testid="legacy-view-toggle"
              aria-pressed="false"
              onClick={() => setLegacyView(true)}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
            >
              Gammel visning
            </button>
          </div>
          <DeliveryBoard onLogout={() => logout()} />
        </div>
      </>
    );
  }

  if (boardOn && legacyView) {
    return (
      <>
        <Helmet>
          <title>Utviklerterminal – Asoldi</title>
          <meta name="robots" content="noindex,nofollow" />
        </Helmet>
        <div className="staff-light developer-fill flex h-dvh w-full flex-col overflow-hidden bg-[#1a1a1a] text-white">
          <div className="flex shrink-0 items-center justify-end px-4 py-2">
            <button
              type="button"
              data-testid="legacy-view-toggle"
              aria-pressed="true"
              onClick={() => setLegacyView(false)}
              className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-gray-200 hover:bg-white/10"
            >
              Gammel visning
            </button>
          </div>
          <DevelopmentClientsSection onLogout={logout} />
        </div>
      </>
    );
  }

  return (
    <>
      <Helmet>
        <title>Utviklerterminal – Asoldi</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <div className="staff-light developer-fill flex h-dvh w-full flex-col overflow-hidden bg-[#1a1a1a] text-white">
        <DevelopmentClientsSection onLogout={logout} />
      </div>
    </>
  );
};
