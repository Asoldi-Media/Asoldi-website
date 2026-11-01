import { useCallback, useEffect, useState } from 'react';

/**
 * The per-upload rights answer ("Vi har rett til å bruke disse bildene"). The hub answers 404 while the
 * rights checkbox is switched off; then `enabled` stays false and nothing is shown or sent.
 */
export function useMediaRights(token: string) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    fetch('/api/client/media-rights', { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { enabled?: boolean } | null) => {
        if (!cancelled) setEnabled(Boolean(data?.enabled));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [token]);

  const record = useCallback(async (urls: string[], confirmed: boolean) => {
    const items = urls.filter(Boolean).map((url) => ({ url, confirmed }));
    if (!enabled || !items.length) return;
    const response = await fetch('/api/client/media-rights', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error((payload as { message?: string }).message || 'Kunne ikke lagre bekreftelsen.');
    }
  }, [enabled, token]);

  /**
   * Records the answer once the uploads are already in Kundedata. Never throws: a refused answer is
   * reported through onError and the uploads stay.
   */
  const recordAfterUpload = useCallback((urls: string[], confirmed: boolean, onError: (message: string) => void) => {
    if (!enabled) return;
    record(urls, confirmed).catch((err: unknown) => {
      onError(err instanceof Error ? err.message : 'Kunne ikke lagre bekreftelsen.');
    });
  }, [enabled, record]);

  return { enabled, record, recordAfterUpload };
}
