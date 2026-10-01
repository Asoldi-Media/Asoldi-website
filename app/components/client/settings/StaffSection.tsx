import React, { useState } from 'react';
import { Plus, Trash2, Upload, Users } from 'lucide-react';
import type { ClientDataBank, StaffMember } from './clientDataTypes';
import { clientMediaSrc, randomId } from './clientDataTypes';
import { uploadClientMediaFile } from './uploadClientMedia';

type Props = {
  token: string;
  clientData: ClientDataBank;
  setClientData: React.Dispatch<React.SetStateAction<ClientDataBank>>;
  onError: (message: string) => void;
};

function emptyMember(): StaffMember {
  return {
    id: randomId('ansatt'),
    title: '',
    name: '',
    phone: '',
    email: '',
    imageUrl: '',
  };
}

export function StaffSection({ token, clientData, setClientData, onError }: Props) {
  const staff = clientData.staff || [];
  const [uploadingId, setUploadingId] = useState('');

  function commit(next: StaffMember[]) {
    setClientData((prev) => ({ ...prev, staff: next }));
  }

  async function uploadPhoto(memberId: string, file?: File | null) {
    if (!file) return;
    setUploadingId(memberId);
    try {
      const url = await uploadClientMediaFile(token, file);
      commit(staff.map((row) => (row.id === memberId ? { ...row, imageUrl: url } : row)));
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Kunne ikke laste opp bildet.');
    } finally {
      setUploadingId('');
    }
  }

  return (
    <div className="max-w-4xl w-full pb-20">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="text-[20px] font-semibold text-[#121212]">Ansatte</h3>
          <p className="text-sm text-gray-500 mt-1">Tittel, navn, telefon, e-post og bilde for hver person.</p>
        </div>
        <button
          type="button"
          onClick={() => commit([...staff, emptyMember()])}
          className="inline-flex items-center gap-2 border border-[#FF5B00] text-[#FF5B00] px-4 py-2 rounded-full text-sm font-semibold hover:bg-[#FF5B00]/5"
        >
          <Plus className="w-4 h-4" /> Legg til ansatt
        </button>
      </div>

      {staff.length === 0 ? (
        <div className="flex flex-col items-center justify-center pt-10">
          <div className="w-[220px] h-[160px] rounded-2xl bg-gray-50 border border-dashed border-gray-200 flex items-center justify-center mb-6">
            <Users className="w-12 h-12 text-gray-300" />
          </div>
          <p className="text-[15px] font-semibold text-[#121212] mb-4">Ingen ansatte lagt inn</p>
          <button
            type="button"
            onClick={() => commit([emptyMember()])}
            className="inline-flex items-center gap-2 border border-[#FF5B00] text-[#FF5B00] px-5 py-2 rounded-full text-sm font-semibold hover:bg-[#FF5B00]/5"
          >
            Legg til ansatt <Plus className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {staff.map((member, index) => (
            <article key={member.id} className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm flex flex-col md:flex-row gap-5">
              <label className="w-full md:w-32 h-32 shrink-0 rounded-2xl border-2 border-dashed border-gray-200 bg-gray-50 flex flex-col items-center justify-center overflow-hidden cursor-pointer hover:bg-gray-100 relative">
                {member.imageUrl ? (
                  <img src={clientMediaSrc(member.imageUrl, token)} alt="" className="w-full h-full object-cover" />
                ) : (
                  <>
                    <Upload className="w-6 h-6 text-gray-400 mb-1" />
                    <span className="text-[11px] text-gray-500 text-center px-2">
                      {uploadingId === member.id ? 'Laster…' : 'Bilde'}
                    </span>
                  </>
                )}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => {
                    void uploadPhoto(member.id, event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
              </label>
              <div className="flex-1 grid gap-3 sm:grid-cols-2">
                <label className="text-[12px] font-medium text-gray-500 uppercase tracking-wider">
                  Tittel
                  <input
                    value={member.title}
                    onChange={(event) => commit(staff.map((row, rowIndex) => (
                      rowIndex === index ? { ...row, title: event.target.value } : row
                    )))}
                    placeholder="Daglig leder"
                    className="mt-1 w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-[13px] text-[#121212] outline-none focus:border-[#FF5B00]"
                  />
                </label>
                <label className="text-[12px] font-medium text-gray-500 uppercase tracking-wider">
                  Navn
                  <input
                    value={member.name}
                    onChange={(event) => commit(staff.map((row, rowIndex) => (
                      rowIndex === index ? { ...row, name: event.target.value } : row
                    )))}
                    placeholder="Ola Nordmann"
                    className="mt-1 w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-[13px] text-[#121212] outline-none focus:border-[#FF5B00]"
                  />
                </label>
                <label className="text-[12px] font-medium text-gray-500 uppercase tracking-wider">
                  Telefon
                  <input
                    type="tel"
                    value={member.phone}
                    onChange={(event) => commit(staff.map((row, rowIndex) => (
                      rowIndex === index ? { ...row, phone: event.target.value } : row
                    )))}
                    placeholder="+47 000 00 000"
                    className="mt-1 w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-[13px] text-[#121212] outline-none focus:border-[#FF5B00]"
                  />
                </label>
                <label className="text-[12px] font-medium text-gray-500 uppercase tracking-wider">
                  E-post
                  <input
                    type="email"
                    value={member.email}
                    onChange={(event) => commit(staff.map((row, rowIndex) => (
                      rowIndex === index ? { ...row, email: event.target.value } : row
                    )))}
                    placeholder="ola@bedrift.no"
                    className="mt-1 w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-[13px] text-[#121212] outline-none focus:border-[#FF5B00]"
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={() => commit(staff.filter((row) => row.id !== member.id))}
                className="self-start text-gray-400 hover:text-red-500"
                aria-label="Fjern ansatt"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
