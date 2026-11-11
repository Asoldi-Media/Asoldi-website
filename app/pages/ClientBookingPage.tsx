import React, { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

type Slot = { start: string; end: string };
type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; purpose: string; businessName: string; durationMinutes: number; slots: Slot[]; booked: string };

const MESSAGES: Record<string, string> = {
  disabled: 'Lenken er ikke gyldig.',
  invalid: 'Lenken er ikke gyldig.',
  expired: 'Lenken har utløpt. Svar på e-posten, så sender vi en ny.',
  used: 'Denne lenken er allerede brukt.',
  'rate-limited': 'For mange forsøk. Vent litt og prøv igjen.',
};

function osloLabel(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return { key: '', day: '', time: '' };
  const day = new Intl.DateTimeFormat('nb-NO', { timeZone: 'Europe/Oslo', weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  const time = new Intl.DateTimeFormat('nb-NO', { timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit' }).format(date);
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Oslo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return { key, day: day.charAt(0).toUpperCase() + day.slice(1), time };
}

function messageFor(status: number, body: { code?: string; message?: string }) {
  if (status === 429) return MESSAGES['rate-limited'];
  if (body.code && MESSAGES[body.code]) return MESSAGES[body.code];
  if (body.code === 'calendar-unavailable') return body.message || 'Kalenderen er ikke tilgjengelig akkurat nå. Svar på e-posten vi sendte, så finner vi en tid.';
  if (status === 410 && body.code === 'used') return MESSAGES.used;
  return body.message || 'Noe gikk galt. Prøv igjen, eller svar på e-posten.';
}

export function ClientBookingPage() {
  const { token = '' } = useParams();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [selected, setSelected] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ start: string; end: string; rescheduleUrl: string } | null>(null);

  async function loadSlots(current = token) {
    setLoad({ kind: 'loading' });
    setNotice('');
    try {
      const res = await fetch(`/api/public/booking/${encodeURIComponent(current)}/slots`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoad({ kind: 'error', message: messageFor(res.status, body) });
        return;
      }
      setLoad({
        kind: 'ready',
        purpose: body.purpose === 'iteration' ? 'iteration' : 'workshop',
        businessName: String(body.businessName || ''),
        durationMinutes: Number(body.durationMinutes) || 30,
        slots: Array.isArray(body.slots) ? body.slots : [],
        booked: String(body.booked || ''),
      });
    } catch {
      setLoad({ kind: 'error', message: 'Kunne ikke hente ledige tider. Prøv igjen.' });
    }
  }

  useEffect(() => {
    if (!token) {
      setLoad({ kind: 'error', message: MESSAGES.invalid });
      return undefined;
    }
    void loadSlots(token);
    return undefined;
    // The token in the address is the only input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const groups = useMemo(() => {
    if (load.kind !== 'ready') return [];
    const byDay = new Map<string, { day: string; slots: Slot[] }>();
    for (const slot of load.slots) {
      const label = osloLabel(slot.start);
      const group = byDay.get(label.key) || { day: label.day, slots: [] };
      group.slots.push(slot);
      byDay.set(label.key, group);
    }
    return [...byDay.values()];
  }, [load]);

  async function confirm() {
    if (load.kind !== 'ready' || !selected) return;
    setBusy(true);
    setNotice('');
    try {
      const res = await fetch(`/api/public/booking/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: selected }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        setSelected('');
        setNotice('Den tiden er tatt. Velg en annen.');
        if (Array.isArray(body.slots)) {
          setLoad({ ...load, slots: body.slots });
        } else {
          await loadSlots(token);
        }
        return;
      }
      if (!res.ok) {
        setLoad({ kind: 'error', message: messageFor(res.status, body) });
        return;
      }
      setDone({
        start: String(body.booking?.start || selected),
        end: String(body.booking?.end || ''),
        rescheduleUrl: typeof body.rescheduleUrl === 'string' && body.rescheduleUrl.startsWith('https://') ? body.rescheduleUrl : '',
      });
    } catch {
      setNotice('Kunne ikke booke tiden. Prøv igjen.');
    } finally {
      setBusy(false);
    }
  }

  const title = load.kind === 'ready' && load.purpose === 'iteration' ? 'Iterasjonsmøte' : 'Workshop';
  const when = done ? osloLabel(done.start) : null;

  return (
    <main className="mx-auto w-full max-w-lg overflow-x-hidden px-4 py-10 text-white">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {load.kind === 'ready' && load.businessName ? (
        <p className="mt-2 text-sm text-gray-300">{load.businessName}</p>
      ) : null}
      {load.kind === 'loading' ? <p className="mt-6 text-sm text-gray-300" role="status">Henter ledige tider…</p> : null}
      {load.kind === 'error' ? <p className="mt-6 text-sm text-red-300" role="alert">{load.message}</p> : null}
      {done && when ? (
        <div className="mt-6 space-y-3 rounded-lg border border-white/10 bg-[#161616] p-4" role="status">
          <p className="font-medium">Tiden er booket.</p>
          <p>{when.day} kl. {when.time} (Oslo-tid).</p>
          {done.rescheduleUrl ? (
            <a
              href={done.rescheduleUrl}
              className="inline-block rounded-lg bg-white/10 px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              Velg en annen tid
            </a>
          ) : null}
        </div>
      ) : null}
      {load.kind === 'ready' && !done ? (
        <div className="mt-6 space-y-4">
          <p className="text-sm text-gray-300">Velg en tid ({load.durationMinutes} min). Tidene er i Oslo.</p>
          {load.booked ? <p className="text-sm text-gray-300">Gjeldende tid: {osloLabel(load.booked).day} kl. {osloLabel(load.booked).time}.</p> : null}
          {groups.length ? (
            <div className="space-y-4" role="group" aria-label="Ledige tider">
              {groups.map((group) => (
                <section key={group.day}>
                  <h2 className="text-sm font-medium text-gray-200">{group.day}</h2>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {group.slots.map((slot) => {
                      const label = osloLabel(slot.start);
                      const on = selected === slot.start;
                      return (
                        <button
                          key={slot.start}
                          type="button"
                          aria-pressed={on}
                          aria-label={`${group.day} klokka ${label.time}`}
                          onClick={() => setSelected(slot.start)}
                          className={`min-h-11 min-w-[5.5rem] rounded-lg px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white ${on ? 'bg-white text-black' : 'bg-white/10 text-white hover:bg-white/15'}`}
                        >
                          {label.time}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-300">Ingen ledige tider i perioden. Svar på e-posten, så finner vi en tid.</p>
          )}
          {notice ? <p className="text-sm text-amber-200" role="alert">{notice}</p> : null}
          <button
            type="button"
            disabled={!selected || busy}
            onClick={() => void confirm()}
            className="min-h-11 w-full rounded-lg bg-white px-3 py-2 text-sm font-medium text-black disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            {busy ? 'Booker…' : 'Bekreft tiden'}
          </button>
        </div>
      ) : null}
    </main>
  );
}
