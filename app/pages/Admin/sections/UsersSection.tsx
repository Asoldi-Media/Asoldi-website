import React, { useEffect, useState } from 'react';
import type { AdminUser, ClientPaymentRequest, EmployeeRoleOption } from '../shared';
import { API, authHeaders, fromEmployeeRoleOption, toEmployeeRoleOption } from '../shared';

type UserForm = { username: string; password: string; name: string; phone: string };

type Props = {
  users: AdminUser[];
  paymentRequests: ClientPaymentRequest[];
  handlingPaymentRequestId: string | null;
  loading: boolean;
  userForm: UserForm;
  editingId: string | null;
  editPassword: string;
  userRoleSaving: string | null;
  onUserFormChange: (next: UserForm) => void;
  onAddUser: (e: React.FormEvent) => void;
  onStartEdit: (id: string | null) => void;
  onEditPasswordChange: (value: string) => void;
  onUpdateUser: (id: string, patch: { username?: string; password?: string; name?: string; phone?: string }) => void;
  onDeleteUser: (id: string) => void;
  onRoleChange: (id: string, option: EmployeeRoleOption) => void;
  onMarkPaymentRequestHandled: (userId: string) => void;
  savingUserId?: string | null;
  notice?: { kind: 'ok' | 'err'; text: string } | null;
};

/** Phone is mandatory for roles that sign customer e-mails (it is printed as {{signerPhone}}). */
function phoneRequiredFor(role: AdminUser['role']) {
  return role === 'sales';
}

/** "+4792331098" → "+47 923 31 098" for display; anything else is shown as stored. */
export function displayPhone(value = '') {
  const raw = String(value || '').trim();
  if (/^\+47\d{8}$/.test(raw)) {
    const local = raw.slice(3);
    return /^[49]/.test(local)
      ? `+47 ${local.slice(0, 3)} ${local.slice(3, 5)} ${local.slice(5)}`
      : `+47 ${local.slice(0, 2)} ${local.slice(2, 4)} ${local.slice(4, 6)} ${local.slice(6)}`;
  }
  return raw;
}

type AdminSender = { name: string; fromEmail: string; phone: string; username: string };

/** The admin account's own signature values (admin.json → survives deploys like users.json). */
function AdminSenderCard() {
  const [sender, setSender] = useState<AdminSender | null>(null);
  const [draft, setDraft] = useState<AdminSender>({ name: '', fromEmail: '', phone: '', username: '' });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    fetch(`${API}/admin/me/sender`, { headers: authHeaders() })
      .then((res) => res.json())
      .then((data: { sender?: AdminSender }) => {
        if (data.sender) {
          setSender(data.sender);
          setDraft({ ...data.sender, phone: displayPhone(data.sender.phone) });
        }
      })
      .catch(() => undefined);
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage('');
    try {
      const res = await fetch(`${API}/admin/me/sender`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: draft.name, fromEmail: draft.fromEmail, phone: draft.phone }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.message || 'Could not save');
        return;
      }
      setSender(data.sender);
      setDraft({ ...data.sender, phone: displayPhone(data.sender.phone) });
      setMessage(data.sender?.phone
        ? `Lagret. Telefon ${displayPhone(data.sender.phone)} er på plass.`
        : 'Lagret.');
    } finally {
      setSaving(false);
    }
  }

  const missingPhone = sender !== null && !sender.phone;

  return (
    <div className="rounded-xl bg-[#2a2a2a] border border-white/10 p-6 mb-8">
      <div className="flex items-center justify-between gap-3 mb-1">
        <h2 className="text-lg font-medium text-white">Your sender profile (admin)</h2>
        {missingPhone && (
          <span className="text-[11px] px-2 py-0.5 rounded bg-amber-900/30 border border-amber-700/30 text-amber-300">Phone required</span>
        )}
      </div>
      <p className="text-gray-400 text-xs mb-4">
        Used as the signature (name · e-mail · phone) when you send offers or confirmations from the admin account{sender?.username ? ` (${sender.username})` : ''}.
      </p>
      <form onSubmit={save} className="flex flex-wrap gap-4 items-end">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Name</label>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="First name"
            className="px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white w-40"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Send-from (@asoldi.com)</label>
          <input
            type="email"
            value={draft.fromEmail}
            onChange={(e) => setDraft({ ...draft, fromEmail: e.target.value })}
            placeholder="damian@asoldi.com"
            className="px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white w-56"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Phone <span className="text-amber-300">*</span></label>
          <input
            type="tel"
            value={draft.phone}
            onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
            placeholder="+47 923 31 098"
            className={`px-4 py-2 rounded-lg bg-[#1a1a1a] border text-white w-44 ${missingPhone ? 'border-amber-500/60' : 'border-white/20'}`}
          />
        </div>
        <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-[#FF5B00] text-white font-medium disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
        {message && <span className={`text-xs ${/lagret/i.test(message) || message === 'Saved.' ? 'text-emerald-300' : 'text-red-300'}`}>{message}</span>}
      </form>
    </div>
  );
}

export function UsersSection(props: Props) {
  const {
    users,
    paymentRequests,
    handlingPaymentRequestId,
    loading,
    userForm,
    editingId,
    editPassword,
    userRoleSaving,
    onUserFormChange,
    onAddUser,
    onStartEdit,
    onEditPasswordChange,
    onUpdateUser,
    onDeleteUser,
    onRoleChange,
    onMarkPaymentRequestHandled,
    savingUserId = null,
    notice = null,
  } = props;

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-white mb-6">Users</h1>
      <p className="text-gray-400 text-sm mb-6">Users who can log in at `/login` as employees. New users default to role `none`. Click Save after editing a row — typing alone does not store the number.</p>
      {notice && (
        <div
          role="status"
          className={`mb-6 px-4 py-3 rounded-lg border text-sm ${
            notice.kind === 'ok'
              ? 'bg-emerald-950/70 border-emerald-700/50 text-emerald-100'
              : 'bg-red-950/70 border-red-700/50 text-red-100'
          }`}
        >
          {notice.text}
        </div>
      )}

      <div className="rounded-xl bg-[#2a2a2a] border border-white/10 p-6 mb-8">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="text-lg font-medium text-white">Payment requests (faktura)</h2>
          <span className="text-xs px-2 py-1 rounded bg-black/20 border border-white/10 text-gray-300">
            {paymentRequests.length} active
          </span>
        </div>
        {paymentRequests.length === 0 ? (
          <p className="text-sm text-gray-400">No faktura requests yet.</p>
        ) : (
          <div className="space-y-2">
            {paymentRequests.map((request) => (
              <div key={`${request.userId}:${request.requestedAt}`} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="text-white font-medium">{request.businessName || request.clientName || request.email}</span>
                      <span className="text-[11px] px-2 py-0.5 rounded bg-amber-900/30 border border-amber-700/30 text-amber-300">
                        Payment request
                      </span>
                      <span className="text-gray-400">{request.planName || 'Plan not set'}</span>
                    </div>
                    <div className="mt-1 text-xs text-gray-400">
                      Org: {request.invoiceRequest.orgNumber || '—'} • Invoice email: {request.invoiceRequest.invoiceEmail || request.email || '—'} • Requested:{' '}
                      {request.requestedAt ? new Date(request.requestedAt).toLocaleString('nb-NO') : '—'}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onMarkPaymentRequestHandled(request.userId)}
                    disabled={loading || handlingPaymentRequestId === request.userId}
                    className="shrink-0 text-xs px-2.5 py-1.5 rounded bg-emerald-600/90 text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    {handlingPaymentRequestId === request.userId ? 'Marking…' : 'Mark as handled'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <AdminSenderCard />

      <div className="rounded-xl bg-[#2a2a2a] border border-white/10 p-6 mb-8">
        <h2 className="text-lg font-medium text-white mb-1">Add user</h2>
        <p className="text-gray-400 text-xs mb-4">Phone is optional here, but required before a user can be given the Sales role (it is printed in every offer and confirmation they send).</p>
        <form onSubmit={onAddUser} className="flex flex-wrap gap-4 items-end">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Username</label>
            <input
              type="text"
              value={userForm.username}
              onChange={(e) => onUserFormChange({ ...userForm, username: e.target.value })}
              className="px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white w-56"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Password</label>
            <input
              type="password"
              value={userForm.password}
              onChange={(e) => onUserFormChange({ ...userForm, password: e.target.value })}
              className="px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white w-48"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Name</label>
            <input
              type="text"
              placeholder="First name"
              value={userForm.name}
              onChange={(e) => onUserFormChange({ ...userForm, name: e.target.value })}
              className="px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white w-40"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Phone</label>
            <input
              type="tel"
              placeholder="+47 923 31 098"
              value={userForm.phone}
              onChange={(e) => onUserFormChange({ ...userForm, phone: e.target.value })}
              className="px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white w-44"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !userForm.username.trim() || !userForm.password}
            className="px-4 py-2 rounded-lg bg-[#FF5B00] text-white font-medium disabled:opacity-50"
          >
            Add user
          </button>
        </form>
      </div>

      <div className="rounded-xl bg-[#2a2a2a] border border-white/10 overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-4 py-3 text-gray-400 font-medium">Username</th>
              <th className="px-4 py-3 text-gray-400 font-medium">Name</th>
              <th className="px-4 py-3 text-gray-400 font-medium">Phone</th>
              <th className="px-4 py-3 text-gray-400 font-medium">Role</th>
              <th className="px-4 py-3 text-gray-400 font-medium">Created</th>
              <th className="px-4 py-3 text-gray-400 font-medium w-48">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <EditableUserRow
                key={user.id}
                user={user}
                editing={editingId === user.id}
                editPassword={editPassword}
                userRoleSaving={userRoleSaving === user.id}
                onStartEdit={onStartEdit}
                onEditPasswordChange={onEditPasswordChange}
                onUpdateUser={onUpdateUser}
                onDeleteUser={onDeleteUser}
                onRoleChange={onRoleChange}
                saving={savingUserId === user.id}
              />
            ))}
          </tbody>
        </table>
        {users.length === 0 && <p className="px-4 py-8 text-gray-400 text-center">No users yet. Add one above.</p>}
      </div>
    </div>
  );
}

const EditableUserRow: React.FC<{
  user: AdminUser;
  editing: boolean;
  editPassword: string;
  userRoleSaving: boolean;
  onStartEdit: (id: string | null) => void;
  onEditPasswordChange: (value: string) => void;
  onUpdateUser: (id: string, patch: { username?: string; password?: string; name?: string; phone?: string }) => void;
  onDeleteUser: (id: string) => void;
  onRoleChange: (id: string, option: EmployeeRoleOption) => void;
  saving?: boolean;
}> = function EditableUserRow({
  user,
  editing,
  editPassword,
  userRoleSaving,
  onStartEdit,
  onEditPasswordChange,
  onUpdateUser,
  onDeleteUser,
  onRoleChange,
  saving = false,
}) {
  const [draftUsername, setDraftUsername] = useState(user.username);
  const [draftName, setDraftName] = useState(user.name || '');
  const [draftPhone, setDraftPhone] = useState(user.phone || '');
  const phoneMissing = phoneRequiredFor(user.role) && !user.phone;

  useEffect(() => {
    if (!editing) {
      setDraftUsername(user.username);
      setDraftName(user.name || '');
      setDraftPhone(user.phone || '');
    }
  }, [editing, user.username, user.name, user.phone]);

  return (
    <tr className="border-b border-white/5">
      <td className="px-4 py-3 text-white">
        {editing ? (
          <input
            type="text"
            value={draftUsername}
            onChange={(e) => setDraftUsername(e.target.value)}
            className="px-2 py-1 rounded bg-[#1a1a1a] border border-white/20 text-white w-48"
          />
        ) : (
          <span onClick={() => onStartEdit(user.id)} className="cursor-pointer hover:underline">{user.username}</span>
        )}
      </td>
      <td className="px-4 py-3 text-white">
        {editing ? (
          <input
            type="text"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="First name"
            className="px-2 py-1 rounded bg-[#1a1a1a] border border-white/20 text-white w-36"
          />
        ) : (
          <span className="text-sm text-gray-200">{user.name || '—'}</span>
        )}
      </td>
      <td className="px-4 py-3 text-white">
        {editing ? (
          <input
            type="tel"
            value={draftPhone}
            onChange={(e) => setDraftPhone(e.target.value)}
            placeholder="+47 923 31 098"
            className={`px-2 py-1 rounded bg-[#1a1a1a] border text-white w-40 ${phoneMissing ? 'border-amber-500/60' : 'border-white/20'}`}
          />
        ) : phoneMissing ? (
          <button
            type="button"
            onClick={() => onStartEdit(user.id)}
            className="text-[11px] px-2 py-0.5 rounded bg-amber-900/30 border border-amber-700/30 text-amber-300 hover:bg-amber-900/50"
            title="Sales reps need a phone number – it is printed in their e-mails"
          >
            Missing – add phone
          </button>
        ) : (
          <span className="text-sm text-gray-200">{displayPhone(user.phone) || '—'}</span>
        )}
      </td>
      <td className="px-4 py-3">
        <select
          value={toEmployeeRoleOption(user)}
          onChange={(e) => onRoleChange(user.id, e.target.value as EmployeeRoleOption)}
          disabled={userRoleSaving}
          className="bg-[#1a1a1a] border border-white/20 text-white rounded px-2 py-1 text-sm min-w-[160px] disabled:opacity-50"
        >
          <option value="none">None</option>
          <option value="employee-asoldi">Employee: Asoldi</option>
          <option value="employee-ssu">Employee: SSU</option>
          <option value="sales">Sales</option>
          <option value="developer">Developer</option>
          <option value="client">Client</option>
        </select>
      </td>
      <td className="px-4 py-3 text-gray-400 text-sm">{new Date(user.createdAt).toLocaleDateString()}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <input
                type="password"
                placeholder="New password"
                value={editPassword}
                onChange={(e) => onEditPasswordChange(e.target.value)}
                className="px-2 py-1 rounded bg-[#1a1a1a] border border-white/20 text-white w-32 text-sm"
              />
              <button
                type="button"
                disabled={saving}
                onClick={() => onUpdateUser(user.id, { username: draftUsername, name: draftName, phone: draftPhone })}
                className="text-xs px-2 py-1 rounded bg-white/10 text-white disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                disabled={saving || !editPassword}
                onClick={() => editPassword && onUpdateUser(user.id, { password: editPassword })}
                className="text-xs px-2 py-1 rounded bg-[#FF5B00] text-white disabled:opacity-50"
              >
                Set password
              </button>
              <button type="button" onClick={() => onStartEdit(null)} className="text-gray-400 hover:text-white text-xs">Cancel</button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => onStartEdit(user.id)} className="text-xs text-[#FF5B00] hover:underline">Edit</button>
              <button type="button" onClick={() => onDeleteUser(user.id)} className="text-xs text-red-400 hover:underline">Delete</button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
};
