import React, { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, Loader2, Unlink } from 'lucide-react';
import { GOOGLE_BUSINESS_OAUTH_EVENT } from '../../../lib/google-business-oauth-ui.js';

type Status = {
  configured?: boolean;
  connected?: boolean;
  googleEmail?: string;
  locationTitle?: string;
  locationName?: string;
  lastError?: string;
  locations?: Array<{ name: string; title: string; address?: string }>;
};

export function GoogleBusinessConnectCard({ token }: { token: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function load() {
    const res = await fetch('/api/client/google-business/status', { headers: { Authorization: `Bearer ${token}` } });
    const payload = await res.json().catch(() => ({}));
    if (res.ok) setStatus(payload);
  }

  useEffect(() => {
    if (token) void load();
  }, [token]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== GOOGLE_BUSINESS_OAUTH_EVENT) return;
      void load();
      if (event.data.connected) setMessage('Google-bedriftsprofilen er koblet til.');
      else if (event.data.error) setMessage(String(event.data.error));
    }
    window.addEventListener('message', onMessage);
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(GOOGLE_BUSINESS_OAUTH_EVENT);
      channel.onmessage = (event) => onMessage({ origin: window.location.origin, data: event.data } as MessageEvent);
    } catch {
      // ignore
    }
    return () => {
      window.removeEventListener('message', onMessage);
      channel?.close();
    };
  }, [token]);

  async function connect() {
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch('/api/client/google-business/connect', { headers: { Authorization: `Bearer ${token}` } });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || 'Kunne ikke starte Google-tilkobling.');
      window.open(String(payload.authUrl || ''), 'asoldi-google-business', 'width=560,height=760');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Kunne ikke starte Google-tilkobling.');
    } finally {
      setBusy(false);
    }
  }

  async function chooseLocation(locationName: string) {
    setBusy(true);
    try {
      const res = await fetch('/api/client/google-business/location', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationName }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || 'Kunne ikke lagre lokasjon.');
      setStatus((prev) => ({ ...prev, ...payload }));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Kunne ikke lagre lokasjon.');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await fetch('/api/client/google-business/disconnect', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      setStatus({ configured: status?.configured, connected: false, locations: [] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-[#FFD7C2] bg-gradient-to-r from-[#FFF7F2] to-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[#111827]">Google-bedriftsprofil</h2>
          <p className="mt-1 text-sm text-[#6B7280] max-w-[560px]">
            Koble Google-kontoen som eier bedriftsprofilen. Da kan analysesiden vise visninger på Maps, klikk til nettsiden, anrop og veibeskrivelser — for akkurat deres lokasjon.
          </p>
        </div>
        {status?.connected ? (
          <button type="button" onClick={() => void disconnect()} disabled={busy} className="inline-flex items-center gap-2 rounded-xl border border-[#FECACA] px-3 py-2 text-sm text-[#B91C1C]">
            <Unlink size={14} /> Koble fra
          </button>
        ) : (
          <button type="button" onClick={() => void connect()} disabled={busy || status?.configured === false} className="inline-flex items-center gap-2 rounded-xl bg-[#111827] px-4 py-2 text-sm text-white disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ExternalLink size={14} />}
            Koble til Google
          </button>
        )}
      </div>
      {status?.configured === false ? (
        <p className="mt-3 text-sm text-amber-700">Google Business er ikke satt opp på Asoldi-huben ennå. Be oss aktivere CLIENT_GOOGLE_BUSINESS_REDIRECT_URI.</p>
      ) : null}
      {status?.connected ? (
        <p className="mt-3 inline-flex items-center gap-2 text-sm text-emerald-700">
          <CheckCircle2 size={14} />
          Koblet{status.googleEmail ? ` som ${status.googleEmail}` : ''}{status.locationTitle ? ` · ${status.locationTitle}` : ''}
        </p>
      ) : null}
      {status?.connected && (status.locations?.length || 0) > 1 && !status.locationName ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-[#374151]">Velg hvilken lokasjon som skal brukes i analysen:</p>
          {status.locations?.map((row) => (
            <button
              key={row.name}
              type="button"
              onClick={() => void chooseLocation(row.name)}
              className="block w-full rounded-xl border border-[#E5E7EB] bg-white px-3 py-2 text-left text-sm hover:border-[#FF5B00]"
            >
              <span className="font-medium">{row.title}</span>
              {row.address ? <span className="block text-xs text-[#6B7280]">{row.address}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {status?.lastError ? <p className="mt-2 text-sm text-amber-700">{status.lastError}</p> : null}
      {message ? <p className="mt-2 text-sm text-[#374151]">{message}</p> : null}
    </section>
  );
}
