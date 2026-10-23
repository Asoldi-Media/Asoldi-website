import React from 'react';
import { authHeaders } from '../shared';

type Props = {
  kind: 'client' | 'site';
  id: string;
  initial: boolean;
  onChange?: (isTest: boolean) => void;
};

/**
 * WS8.56 Superadmin switch: a test client or site stays workable on the boards but is left out of
 * reports, social proof, nurture and Myphoner sync, and joins delivery automation only as a pilot.
 */
export function TestFlagToggle({ kind, id, initial, onChange }: Props) {
  const [isTest, setIsTest] = React.useState(initial);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => setIsTest(initial), [initial, id]);

  async function toggle(next: boolean) {
    setBusy(true);
    setError('');
    const path = kind === 'client'
      ? `/api/admin/sales/${encodeURIComponent(id)}/test-flag`
      : `/api/hub/sites/${encodeURIComponent(id)}/test-flag`;
    try {
      const res = await fetch(path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ isTest: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 401 ? 'Krever Superadmin-innlogging.' : json.message || 'Kunne ikke lagre.');
        return;
      }
      setIsTest(json.isTest === true);
      onChange?.(json.isTest === true);
    } catch {
      setError('Kunne ikke lagre.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className="inline-flex items-center gap-2 text-gray-300 text-xs" title="Testkunder telles ikke i rapporter, sosiale bevis eller Myphoner, og automatiseres bare som pilot.">
      <input type="checkbox" checked={isTest} disabled={busy} onChange={(event) => void toggle(event.target.checked)} />
      {kind === 'client' ? 'Testkunde' : 'Testside'}
      {error ? <span className="text-red-400">{error}</span> : null}
    </label>
  );
}
