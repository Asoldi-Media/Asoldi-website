import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { MeetingGuest, SalesClient } from '../shared';

const SOURCE_LABEL: Record<MeetingGuest['addedBy'], string> = {
  rep: '',
  bot: 'lagt til av bot',
  calendar: 'fra kalenderen',
};

const REJECT_LABEL: Record<string, string> = {
  invalid: 'ugyldig e-post',
  contact: 'er allerede kontaktpersonen',
  excluded: 'kan ikke legges til',
  limit: 'maks 10 gjester',
};

type SaveResponse = {
  client?: SalesClient;
  rejected?: Array<{ email: string; reason: string }>;
  warnings?: string[];
};

/** Extra people on the calendar invite besides the contact. Saves straight to the card. */
export function MeetingGuestsEditor({
  client,
  request,
  onSaved,
  onError,
}: {
  client: SalesClient;
  request: (path: string, init?: RequestInit) => Promise<any>;
  onSaved: (client: SalesClient) => void;
  onError: (message: string) => void;
}) {
  const guests = client.meetingGuests || [];
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  async function save(body: { add?: Array<{ email: string; name: string }>; remove?: string[] }) {
    setBusy(true);
    setNote('');
    onError('');
    try {
      const data = (await request(`/admin/sales/${client.id}/meeting-guests`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })) as SaveResponse;
      if (data?.client?.id) onSaved(data.client);
      const rejected = data?.rejected?.[0];
      if (rejected) setNote(`${rejected.email}: ${REJECT_LABEL[rejected.reason] || 'ble ikke lagt til'}`);
      else if (data?.warnings?.length) setNote(data.warnings.join(' '));
      return !rejected;
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Kunne ikke lagre gjestene');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const value = email.trim();
    if (!value) return;
    if (await save({ add: [{ email: value, name: name.trim() }] })) {
      setEmail('');
      setName('');
    }
  }

  return (
    <div className="rounded-xl bg-black/20 border border-white/10 p-3 space-y-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Møtegjester</div>
      {guests.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {guests.map((guest) => (
            <li
              key={guest.email}
              className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] text-gray-200"
            >
              <span>{guest.name ? `${guest.name} · ${guest.email}` : guest.email}</span>
              {SOURCE_LABEL[guest.addedBy] ? (
                <span className="text-gray-500">({SOURCE_LABEL[guest.addedBy]})</span>
              ) : null}
              <button
                type="button"
                disabled={busy}
                onClick={() => void save({ remove: [guest.email] })}
                className="text-gray-400 hover:text-white"
                title="Fjern gjesten"
                aria-label={`Fjern ${guest.email}`}
              >
                <X size={11} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <input
          type="email"
          value={email}
          disabled={busy}
          onChange={(event) => setEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add();
          }}
          placeholder="E-post"
          className="min-w-0 flex-1 rounded-md bg-black/30 border border-white/10 text-white text-xs px-2 py-1.5"
        />
        <input
          type="text"
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void add();
          }}
          placeholder="Navn (valgfritt)"
          className="min-w-0 flex-1 rounded-md bg-black/30 border border-white/10 text-white text-xs px-2 py-1.5"
        />
        <button
          type="button"
          disabled={busy || !email.trim()}
          onClick={() => void add()}
          className="rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-white hover:bg-white/20 disabled:opacity-40"
        >
          Legg til
        </button>
      </div>
      {note ? <p className="text-[11px] text-amber-300">{note}</p> : null}
      <p className="text-[11px] text-gray-500">Får kalenderinvitasjonen sammen med kontaktpersonen.</p>
    </div>
  );
}
