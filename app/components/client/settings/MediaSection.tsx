import React, { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Edit, Image as ImageIcon, Plus, Upload, X } from 'lucide-react';
import type { ClientDataBank, MediaBucketKey } from './clientDataTypes';
import { MEDIA_BUCKETS, clientMediaSrc, randomId } from './clientDataTypes';
import { uploadClientMediaFiles } from './uploadClientMedia';

type MediaItem = {
  id: string;
  url: string;
  bucket: MediaBucketKey;
};

type Props = {
  token: string;
  clientData: ClientDataBank;
  setClientData: React.Dispatch<React.SetStateAction<ClientDataBank>>;
  onError: (message: string) => void;
};

function flattenMedia(bank: ClientDataBank): MediaItem[] {
  return MEDIA_BUCKETS.flatMap((bucket) =>
    (bank.media[bucket.key] || []).filter(Boolean).map((url, index) => ({
      id: `${bucket.key}-${index}-${url}`,
      url,
      bucket: bucket.key,
    }))
  );
}

function writeMedia(items: MediaItem[], briefs: ClientDataBank['media']['briefs']): ClientDataBank['media'] {
  const next = {
    mainHeroImages: [] as string[],
    galleryImages: [] as string[],
    logos: [] as string[],
    icons: [] as string[],
    uncategorized: [] as string[],
    teamImages: [] as string[],
    aboutImages: [] as string[],
    locationImages: [] as string[],
    illustrationImages: [] as string[],
    offeringImages: [] as string[],
    briefs,
  };
  for (const item of items) {
    next[item.bucket] = [...next[item.bucket], item.url];
  }
  return next;
}

export function MediaSection({ token, clientData, setClientData, onError }: Props) {
  const items = useMemo(() => flattenMedia(clientData), [clientData]);
  const [flow, setFlow] = useState<'idle' | 'choose_upload' | 'categorize'>('idle');
  const [mapsLink, setMapsLink] = useState(clientData.openingHours.googleBusinessSyncUrl);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  function commit(nextItems: MediaItem[]) {
    setClientData((prev) => ({
      ...prev,
      media: writeMedia(nextItems, prev.media.briefs),
    }));
  }

  async function addFiles(files: File[], bucket: MediaBucketKey = 'uncategorized') {
    if (!files.length) return;
    setUploading(true);
    try {
      const urls = await uploadClientMediaFiles(token, files);
      const next = [
        ...items,
        ...urls.map((url) => ({ id: randomId('media'), url, bucket })),
      ];
      commit(next);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Kunne ikke laste opp media.');
    } finally {
      setUploading(false);
    }
  }

  function pickFiles(bucket: MediaBucketKey = 'uncategorized') {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,video/*,application/pdf';
    input.multiple = true;
    input.onchange = () => {
      void addFiles(Array.from(input.files || []), bucket);
    };
    input.click();
  }

  const hasMedia = items.length > 0;

  return (
    <div className="w-full h-full min-h-[480px] relative">
      {!hasMedia ? (
        <div className="flex-1 flex flex-col items-center justify-center pt-16">
          <h3 className="text-[17px] font-semibold mb-6 text-[#121212]">Ingen media her</h3>
          <div className="w-[220px] h-[160px] rounded-2xl bg-gray-50 border border-dashed border-gray-200 flex items-center justify-center mb-8">
            <ImageIcon className="w-12 h-12 text-gray-300" />
          </div>
          <button
            type="button"
            onClick={() => setFlow('choose_upload')}
            className="flex items-center gap-2 border border-[#FF5B00] text-[#FF5B00] px-5 py-2 rounded-full text-sm font-semibold hover:bg-[#FF5B00]/5"
          >
            Legg til media <Plus className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="w-full flex flex-col pb-20">
          <div className="flex items-center justify-between mb-8">
            <h3 className="text-[20px] font-semibold text-[#121212]">Media galleri</h3>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setFlow('categorize')}
                className="flex items-center gap-2 bg-white border border-gray-200 text-[#121212] px-4 py-2 rounded-full text-[13px] font-medium shadow-sm hover:bg-gray-50"
              >
                <Edit className="w-3.5 h-3.5" /> Rediger
              </button>
              <button
                type="button"
                onClick={() => setFlow('choose_upload')}
                className="flex items-center gap-2 bg-white border border-gray-200 text-[#121212] px-4 py-2 rounded-full text-[13px] font-medium shadow-sm hover:bg-gray-50"
              >
                <Plus className="w-3.5 h-3.5" /> Legg til mer
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-10">
            {MEDIA_BUCKETS.map((bucket) => {
              const grouped = items.filter((item) => item.bucket === bucket.key);
              if (!grouped.length) return null;
              return (
                <div key={bucket.key}>
                  <h4 className="text-[15px] font-semibold text-[#121212] mb-4 flex items-center">
                    {bucket.label}
                    <span className="text-gray-400 font-normal ml-2 text-[13px] bg-gray-100 px-2 py-0.5 rounded-full">
                      {grouped.length}
                    </span>
                  </h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                    {grouped.map((item) => (
                      <div key={item.id} className="aspect-square bg-gray-100 rounded-xl overflow-hidden border border-gray-200 group relative">
                        <img src={clientMediaSrc(item.url, token)} className="w-full h-full object-cover" alt="" />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            onClick={() => commit(items.filter((row) => row.id !== item.id))}
                            className="absolute top-2 right-2 w-8 h-8 rounded-full bg-white text-red-500 flex items-center justify-center hover:bg-red-50 shadow-sm"
                            aria-label="Fjern fil"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <AnimatePresence>
        {flow === 'choose_upload' ? (
          <Modal onClose={() => setFlow('idle')}>
            <button type="button" className="absolute top-6 right-6 text-gray-400 hover:text-gray-600" onClick={() => setFlow('idle')}>
              <X className="w-6 h-6" />
            </button>
            <h2 className="text-[24px] font-bold text-[#121212] mb-4 tracking-tight">Express Media Innhenting</h2>
            <p className="text-[#121212] text-[15px] mb-8 max-w-[460px] leading-relaxed">
              Lim inn Google Business-lenken for synk, eller last opp filene manuelt.
            </p>
            <div className="w-full max-w-[440px] relative mb-8">
              <input
                type="text"
                value={mapsLink}
                onChange={(e) => setMapsLink(e.target.value)}
                placeholder="https://g.page/din-bedrift"
                className="w-full bg-gray-100/80 rounded-xl px-5 py-4 text-[15px] outline-none text-gray-700 placeholder-gray-400 focus:bg-white focus:ring-2 focus:ring-[#FF5B00]/20 text-center"
              />
            </div>
            <button
              type="button"
              className="w-full max-w-[440px] bg-[#FF5B00] text-white px-6 py-3 rounded-xl text-[15px] font-semibold mb-4"
              onClick={() => {
                setClientData((prev) => ({
                  ...prev,
                  openingHours: { ...prev.openingHours, googleBusinessSyncUrl: mapsLink.trim() },
                }));
                setFlow('categorize');
              }}
            >
              Fortsett
            </button>
            <button
              type="button"
              className="w-full max-w-[440px] bg-white border border-gray-200 text-[#121212] px-6 py-3.5 rounded-xl text-[15px] font-semibold hover:bg-gray-50"
              onClick={() => setFlow('categorize')}
            >
              Gå til manuell opplasting
            </button>
          </Modal>
        ) : null}

        {flow === 'categorize' ? (
          <Modal wide onClose={() => setFlow('idle')}>
            <div className="flex flex-col h-full min-h-0">
              <div className="flex items-start justify-between mb-6 gap-4 shrink-0">
                <div>
                  <h2 className="text-[24px] font-bold text-[#121212] tracking-tight">Kategoriser media (valgfritt)</h2>
                  <p className="text-[14px] text-gray-500 mt-1 max-w-[500px]">
                    Dra filene til riktig kategori. Alle eksisterende mapper fra kundeportalen er med.
                  </p>
                  {uploading ? <p className="text-[13px] text-[#FF5B00] mt-2">Laster opp…</p> : null}
                </div>
                <div className="flex gap-3">
                  <button type="button" onClick={() => setFlow('idle')} className="px-5 py-2.5 rounded-full border border-gray-200 text-[13px] font-semibold hover:bg-gray-50">
                    Hopp over
                  </button>
                  <button type="button" onClick={() => setFlow('idle')} className="px-5 py-2.5 rounded-full bg-[#FF5B00] text-white text-[13px] font-semibold hover:bg-[#e05000]">
                    Bekreft
                  </button>
                </div>
              </div>
              <div className="flex gap-6 flex-1 overflow-hidden min-h-0 bg-gray-50/50 rounded-2xl border border-gray-100 p-2">
                <div className="w-[35%] flex flex-col bg-white rounded-[20px] p-5 overflow-y-auto border border-gray-200/60">
                  <h3 className="text-[14px] font-semibold text-gray-700 mb-4 flex justify-between">
                    <span>Ukategoriserte filer</span>
                    <span className="bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full text-[12px]">
                      {items.filter((item) => item.bucket === 'uncategorized').length}
                    </span>
                  </h3>
                  <div className="grid grid-cols-2 gap-3 pb-8">
                    <button
                      type="button"
                      className="aspect-square bg-gray-50 border-2 border-dashed border-gray-200 rounded-xl flex flex-col items-center justify-center hover:bg-gray-100"
                      onClick={() => pickFiles('uncategorized')}
                    >
                      <Upload className="w-5 h-5 text-gray-400 mb-1" />
                      <span className="text-[11px] font-medium text-gray-500">Last opp fil</span>
                    </button>
                    {items.filter((item) => item.bucket === 'uncategorized').map((item) => (
                      <div
                        key={item.id}
                        draggable
                        onDragStart={() => setDraggingId(item.id)}
                        onDragEnd={() => setDraggingId(null)}
                        className="aspect-square bg-white border border-gray-200 rounded-xl overflow-hidden cursor-grab p-1"
                      >
                        <img src={clientMediaSrc(item.url, token)} className="w-full h-full object-contain rounded-lg pointer-events-none" alt="" />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="w-[65%] flex flex-col overflow-y-auto gap-4 pr-3 pb-8">
                  {MEDIA_BUCKETS.filter((bucket) => bucket.key !== 'uncategorized').map((bucket) => {
                    const grouped = items.filter((item) => item.bucket === bucket.key);
                    return (
                      <div
                        key={bucket.key}
                        className="bg-white border-2 border-dashed border-gray-200 rounded-[20px] p-5 min-h-[160px] flex flex-col"
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.dataTransfer.dropEffect = 'move';
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (!draggingId) return;
                          commit(items.map((item) => (item.id === draggingId ? { ...item, bucket: bucket.key } : item)));
                          setDraggingId(null);
                        }}
                      >
                        <div className="flex items-center justify-between mb-4">
                          <h4 className="text-[15px] font-semibold text-[#121212] flex items-center gap-2">
                            {bucket.label}
                            {grouped.length ? (
                              <span className="bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full text-[11px]">{grouped.length}</span>
                            ) : null}
                          </h4>
                          <button
                            type="button"
                            className="bg-gray-50 hover:bg-gray-100 text-gray-600 px-3 py-1.5 rounded-lg text-[12px] font-medium flex items-center gap-1.5"
                            onClick={() => pickFiles(bucket.key)}
                          >
                            <Upload className="w-3.5 h-3.5" /> Last opp
                          </button>
                        </div>
                        <div className="flex-1 flex gap-3 flex-wrap items-start content-start">
                          {grouped.map((item) => (
                            <div
                              key={item.id}
                              draggable
                              onDragStart={() => setDraggingId(item.id)}
                              onDragEnd={() => setDraggingId(null)}
                              className="w-24 h-24 bg-white rounded-[14px] overflow-hidden border border-gray-200 cursor-grab relative p-1 group"
                            >
                              <img src={clientMediaSrc(item.url, token)} className="w-full h-full object-contain rounded-lg pointer-events-none" alt="" />
                              <button
                                type="button"
                                onClick={() => commit(items.map((row) => (row.id === item.id ? { ...row, bucket: 'uncategorized' } : row)))}
                                className="absolute top-1 right-1 bg-white/90 w-6 h-6 rounded-full opacity-0 group-hover:opacity-100"
                                aria-label="Flytt til ukategorisert"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          {!grouped.length ? (
                            <div className="w-full min-h-[80px] flex items-center justify-center text-[13px] text-gray-400/80">
                              Dra filer hit for {bucket.label.toLowerCase()}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </Modal>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Modal({
  children,
  onClose,
  wide = false,
}: {
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[70] bg-[#121212]/40 backdrop-blur-[2px] flex items-center justify-center p-4 lg:p-8"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.95, opacity: 0, y: 20 }}
        className={`bg-white rounded-[32px] shadow-2xl w-full p-8 lg:p-10 flex flex-col items-center relative ${
          wide ? 'max-w-[1100px] h-[85vh] max-h-[800px] items-stretch' : 'max-w-[640px] max-h-[90vh] overflow-y-auto text-center'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}
