import { useCallback, useEffect, useRef, useState } from 'react';

export type ClientPortalOffer = {
  id: string;
  code?: string;
  planId?: string;
  planName?: string;
  price?: string;
  note?: string;
  previewUrl?: string;
  letterHtml?: string;
  contractHtml?: string;
  accepted?: boolean;
  acceptedAt?: string;
  alternatives?: { index: number; label: string; name: string; price: string }[];
  chosenOfferIndex?: 0 | 1 | null;
};

const POLL_MS = 3000;

export function useClientOffer(token = '') {
  const [offer, setOffer] = useState<ClientPortalOffer | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState('');
  const requestId = useRef(0);

  const load = useCallback(async (silent = false) => {
    if (!token) {
      setOffer(null);
      setLoading(false);
      setError('');
      return;
    }
    const id = ++requestId.current;
    try {
      const response = await fetch('/api/client/offer', { headers: { Authorization: `Bearer ${token}` } });
      const payload = await response.json().catch(() => ({}));
      if (id !== requestId.current) return;
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke laste tilbudet.');
      setOffer((payload.offer as ClientPortalOffer) || null);
      setError('');
    } catch (err) {
      if (id !== requestId.current) return;
      if (!silent) setError(err instanceof Error ? err.message : 'Kunne ikke laste tilbudet.');
    } finally {
      if (id === requestId.current && !silent) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (!token) {
      setOffer(null);
      setLoading(false);
      setError('');
      return;
    }
    void load(false);
    const tick = () => {
      if (document.visibilityState === 'hidden') return;
      void load(true);
    };
    const timer = window.setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    window.addEventListener('focus', tick);
    return () => {
      requestId.current += 1;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('focus', tick);
    };
  }, [token, load]);

  return { offer, loading, error, refresh: load };
}
