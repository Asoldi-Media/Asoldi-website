import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { Box, ChevronDown, Edit, Eye, Loader2, Plus, Trash2, Upload, X } from 'lucide-react';
import {
  PRODUCT_LAYOUTS,
  buildEmptyCatalog,
  buildEmptyCategory,
  buildEmptyProductItem,
  layoutLabel,
} from '../../../../lib/client-product-catalog.js';
import type { CatalogCategory, CatalogProduct, ClientDataBank, ProductCatalog } from './clientDataTypes';
import { clientMediaSrc, resolveClientCatalogs } from './clientDataTypes';
import { uploadClientMediaFile } from './uploadClientMedia';

type LayoutId = ProductCatalog['layout'];
type Flow = 'empty' | 'choose_layout' | 'choose_upload' | 'editor';

type Props = {
  token: string;
  clientData: ClientDataBank;
  setClientData: React.Dispatch<React.SetStateAction<ClientDataBank>>;
  onError: (message: string) => void;
  onProfile?: (profile: any) => void;
};

export function ProductsSection({ token, clientData, setClientData, onError, onProfile }: Props) {
  const catalogs = clientData.productCatalogs;
  const catalog = catalogs[0] || null;
  const categories = catalog?.categories || [];
  const hasProducts = categories.some((row) => row.products.length > 0);
  const hasCatalog = Boolean(hasProducts || categories.length);
  const [flow, setFlow] = useState<Flow>(hasCatalog ? 'editor' : 'empty');

  React.useEffect(() => {
    if (hasCatalog && flow === 'empty') setFlow('editor');
  }, [hasCatalog, flow]);
  const [editingProduct, setEditingProduct] = useState<string | null>(null);
  const [editingCategory, setEditingCategory] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [previewImage, setPreviewImage] = useState('');
  const [busy, setBusy] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const layout: LayoutId = (catalog?.layout || 'normal') as LayoutId;

  const selectedCount = selectedIds.length;

  function syncCatalogs(nextCatalogs: ProductCatalog[]) {
    const resolved = resolveClientCatalogs({ productCatalogs: nextCatalogs, keepEmptyProducts: true });
    setClientData((prev) => ({
      ...prev,
      productCatalogs: resolved.productCatalogs,
      products: resolved.products,
    }));
  }

  function mutate(mutator: (current: ProductCatalog[]) => ProductCatalog[]) {
    syncCatalogs(mutator(catalogs.length ? catalogs : []));
  }

  function ensureCatalog(nextLayout: LayoutId = layout): ProductCatalog {
    return catalogs[0] || (buildEmptyCatalog(nextLayout, { withStarterCategory: false }) as ProductCatalog);
  }

  function chooseLayout(nextLayout: LayoutId) {
    mutate((current) => {
      const existing = current[0] || (buildEmptyCatalog(nextLayout, { withStarterCategory: false }) as ProductCatalog);
      return [{ ...existing, layout: nextLayout, label: layoutLabel(nextLayout) }];
    });
    setFlow('choose_upload');
  }

  async function importFromUrl() {
    const url = sourceUrl.trim();
    if (!url || !token) return;
    setBusy('scrape');
    try {
      const response = await fetch('/api/client/ai-assistant/products/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ url }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke hente produkter.');
      if (payload.jobId) {
        await pollJob(payload.jobId);
        return;
      }
      applyImported(payload);
      setFlow('editor');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Kunne ikke hente produkter.');
    } finally {
      setBusy('');
    }
  }

  async function pollJob(jobId: string) {
    for (let i = 0; i < 40; i += 1) {
      const response = await fetch(`/api/client/ai-assistant/products/jobs/${encodeURIComponent(jobId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (payload.status === 'done' || payload.catalogs?.length) {
        applyImported(payload);
        setFlow('editor');
        return;
      }
      if (payload.status === 'failed') throw new Error(payload.error || 'Import feilet.');
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
    }
    throw new Error('Importen tok for lang tid.');
  }

  function applyImported(payload: any) {
    if (payload.profile && onProfile) onProfile(payload.profile);
    const imported = (payload.catalogs || payload.profile?.clientDataBank?.productCatalogs || []) as ProductCatalog[];
    if (imported.length) syncCatalogs(imported);
  }

  async function importFiles(files: File[]) {
    if (!files.length || !token) return;
    setBusy('import');
    try {
      const body = new FormData();
      files.forEach((file) => body.append('files', file));
      const response = await fetch('/api/client/ai-assistant/products/import', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || 'Kunne ikke importere filen.');
      applyImported(payload);
      setFlow('editor');
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Kunne ikke importere filen.');
    } finally {
      setBusy('');
    }
  }

  function startManual() {
    mutate((current) => {
      const existing = current[0] || (buildEmptyCatalog(layout, { withStarterCategory: false }) as ProductCatalog);
      return [existing];
    });
    setFlow('editor');
  }

  function addCategory() {
    mutate((current) => {
      const existing = ensureCatalog();
      return [{
        ...existing,
        categories: [...(current[0]?.categories || existing.categories), buildEmptyCategory('Ny kategori') as CatalogCategory],
      }];
    });
    setFlow('editor');
  }

  function addProduct(categoryIndex: number) {
    mutate((current) => current.map((row, index) => (
      index !== 0 ? row : {
        ...row,
        categories: row.categories.map((category, catIndex) => (
          catIndex !== categoryIndex ? category : {
            ...category,
            products: [...category.products, buildEmptyProductItem() as CatalogProduct],
          }
        )),
      }
    )));
  }

  function updateProduct(categoryIndex: number, productIndex: number, patch: Partial<CatalogProduct>) {
    mutate((current) => current.map((row, index) => (
      index !== 0 ? row : {
        ...row,
        categories: row.categories.map((category, catIndex) => (
          catIndex !== categoryIndex ? category : {
            ...category,
            products: category.products.map((product, itemIndex) => (
              itemIndex !== productIndex ? product : {
                ...product,
                ...patch,
                ...(patch.title !== undefined ? { name: patch.title } : {}),
                ...(patch.imageUrl !== undefined ? { image: patch.imageUrl } : {}),
              }
            )),
          }
        )),
      }
    )));
  }

  async function uploadImage(categoryIndex: number, productIndex: number, file: File) {
    try {
      const url = await uploadClientMediaFile(token, file);
      updateProduct(categoryIndex, productIndex, { imageUrl: url, image: url });
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Kunne ikke laste opp produktbilde.');
    }
  }

  const layoutTitle = useMemo(() => layoutLabel(layout), [layout]);
  const showEditor = flow === 'editor' || hasCatalog;

  return (
    <div className="w-full pb-24">
      {!showEditor ? (
        <div className="flex flex-col items-center justify-center pt-16">
          <h3 className="text-[17px] font-semibold mb-6 text-[#121212]">Ingen produkter her</h3>
          <div className="w-[220px] h-[160px] rounded-2xl bg-gray-50 border border-dashed border-gray-200 flex items-center justify-center mb-8">
            <Box className="w-12 h-12 text-gray-300" />
          </div>
          <button
            type="button"
            onClick={() => setFlow('choose_layout')}
            className="flex items-center gap-2 border border-[#FF5B00] text-[#FF5B00] px-5 py-2 rounded-full text-sm font-semibold hover:bg-[#FF5B00]/5"
          >
            Legg til produkt <Plus className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="w-full flex flex-col">
          <div className="flex items-center gap-4 mb-4 flex-wrap">
            <h3 className="text-[20px] font-semibold text-[#121212] flex items-center gap-2">
              {layoutTitle}
              <button type="button" onClick={() => setFlow('choose_layout')} aria-label="Bytt layout">
                <Edit className="w-4 h-4 text-gray-400 hover:text-gray-600" />
              </button>
            </h3>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={addCategory}
                className="flex items-center gap-2 border border-gray-300 text-gray-700 px-4 py-1.5 rounded-full text-[13px] font-medium hover:bg-gray-50"
              >
                <Plus className="w-3.5 h-3.5" /> Legg til ny kategori
              </button>
              <button
                type="button"
                onClick={() => setFlow('choose_upload')}
                className="flex items-center gap-2 border border-gray-300 text-gray-700 px-4 py-1.5 rounded-full text-[13px] font-medium hover:bg-gray-50"
              >
                <Upload className="w-3.5 h-3.5" /> Last opp fil
              </button>
            </div>
          </div>

          {selectedCount > 0 ? (
            <div className="flex items-center gap-3 bg-gray-100 px-4 py-2 rounded-lg mb-6 border border-gray-200">
              <span className="text-[13px] font-medium text-gray-600 mr-auto">{selectedCount} valgt</span>
              <select
                className="bg-white border border-gray-200 rounded px-2 py-1 text-[12px]"
                defaultValue=""
                onChange={(e) => {
                  const targetId = e.target.value;
                  if (!targetId) return;
                  mutate((current) => current.map((row, index) => {
                    if (index !== 0) return row;
                    const moving: CatalogProduct[] = [];
                    const nextCategories = row.categories.map((category) => {
                      const stay = category.products.filter((product) => {
                        if (!selectedIds.includes(product.id)) return true;
                        moving.push(product);
                        return false;
                      });
                      return { ...category, products: stay };
                    });
                    return {
                      ...row,
                      categories: nextCategories.map((category) => (
                        category.id === targetId ? { ...category, products: [...category.products, ...moving] } : category
                      )),
                    };
                  }));
                  setSelectedIds([]);
                }}
              >
                <option value="" disabled>Flytt til kategori...</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  mutate((current) => current.map((row, index) => (
                    index !== 0 ? row : {
                      ...row,
                      categories: row.categories.map((category) => ({
                        ...category,
                        products: category.products.filter((product) => !selectedIds.includes(product.id)),
                      })),
                    }
                  )));
                  setSelectedIds([]);
                }}
                className="text-red-500 border border-red-200 hover:bg-red-500 hover:text-white px-3 py-1 rounded text-[12px] font-medium"
              >
                Slett
              </button>
            </div>
          ) : null}

          {categories.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 bg-gray-50 rounded-2xl border border-dashed border-gray-200 mt-4">
              <Box className="w-10 h-10 text-gray-300 mb-4" />
              <span className="text-gray-500 text-[15px] font-medium mb-1">Ingen kategorier ennå</span>
              <button type="button" onClick={addCategory} className="mt-4 flex items-center gap-2 bg-[#FF5B00] text-white px-5 py-2 rounded-full text-sm font-semibold">
                Opprett kategori <Plus className="w-4 h-4" />
              </button>
            </div>
          ) : null}

          {categories.map((category, categoryIndex) => {
            const isOpen = expanded[category.id] !== false;
            return (
              <div key={category.id} className="mb-10">
                <div className="flex items-center gap-4 mb-4">
                  <button type="button" onClick={() => setExpanded((prev) => ({ ...prev, [category.id]: !isOpen }))}>
                    <ChevronDown className={`w-5 h-5 text-gray-500 transition-transform ${isOpen ? '' : '-rotate-90'}`} />
                  </button>
                  {editingCategory === category.id ? (
                    <input
                      autoFocus
                      className="text-[16px] font-medium text-[#121212] bg-gray-100 px-2 py-0.5 rounded outline-none border border-gray-200"
                      defaultValue={category.name}
                      onBlur={(e) => {
                        const name = e.target.value;
                        mutate((current) => current.map((row, index) => (
                          index !== 0 ? row : {
                            ...row,
                            categories: row.categories.map((item, idx) => (idx === categoryIndex ? { ...item, name } : item)),
                          }
                        )));
                        setEditingCategory(null);
                      }}
                    />
                  ) : (
                    <button type="button" className="flex items-center gap-2 group" onClick={() => setEditingCategory(category.id)}>
                      <span className="text-[16px] font-medium text-[#121212]">{category.name}</span>
                      <Edit className="w-3.5 h-3.5 text-gray-400 opacity-0 group-hover:opacity-100" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => mutate((current) => current.map((row, index) => (
                      index !== 0 ? row : {
                        ...row,
                        categories: row.categories.filter((_, idx) => idx !== categoryIndex),
                      }
                    )))}
                    className="ml-auto w-8 h-8 rounded-full border border-red-200 text-red-500 hover:bg-red-50"
                    aria-label="Slett kategori"
                  >
                    <Trash2 className="w-4 h-4 mx-auto" />
                  </button>
                  <button
                    type="button"
                    onClick={() => addProduct(categoryIndex)}
                    className="flex items-center gap-1.5 border border-[#FF5B00] text-[#FF5B00] px-3.5 py-1.5 rounded-full text-[13px] font-semibold"
                  >
                    Legg til produkt <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
                {isOpen ? (
                  <div className="flex flex-col border border-gray-200 rounded-xl overflow-hidden bg-white">
                    <div className="grid grid-cols-[30px_minmax(0,1.5fr)_80px_minmax(0,2fr)_60px] gap-4 p-4 bg-gray-50/50 border-b border-gray-200 items-center">
                      <input
                        type="checkbox"
                        checked={category.products.length > 0 && category.products.every((product) => selectedIds.includes(product.id))}
                        onChange={(e) => {
                          const ids = category.products.map((product) => product.id);
                          setSelectedIds((prev) => (
                            e.target.checked
                              ? Array.from(new Set([...prev, ...ids]))
                              : prev.filter((id) => !ids.includes(id))
                          ));
                        }}
                      />
                      <span className="text-[13px] font-medium text-gray-500">Navn</span>
                      <span className="text-[13px] font-medium text-gray-500">Pris</span>
                      <span className="text-[13px] font-medium text-gray-500">Beskrivelse</span>
                      <span className="text-[13px] font-medium text-gray-500">Bilde</span>
                    </div>
                    {category.products.map((product, productIndex) => (
                      <React.Fragment key={product.id}>
                      {editingProduct === product.id ? (
                        <ProductEditor
                          product={product}
                          layout={layout}
                          token={token}
                          showAdvanced={showAdvanced}
                          setShowAdvanced={setShowAdvanced}
                          onChange={(patch) => updateProduct(categoryIndex, productIndex, patch)}
                          onUpload={(file) => void uploadImage(categoryIndex, productIndex, file)}
                          onClose={() => {
                            setEditingProduct(null);
                            setShowAdvanced(false);
                          }}
                        />
                      ) : (
                        <div className="grid grid-cols-[30px_minmax(0,1.5fr)_80px_minmax(0,2fr)_60px] gap-4 p-4 border-b last:border-b-0 border-gray-100 items-center hover:bg-gray-50 group">
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(product.id)}
                            onChange={() => setSelectedIds((prev) => (
                              prev.includes(product.id) ? prev.filter((id) => id !== product.id) : [...prev, product.id]
                            ))}
                          />
                          <div className="min-w-0">
                            <span className="font-medium text-[#121212] text-[14px] truncate block">{product.title || 'Uten navn'}</span>
                            <div className="flex items-center gap-3 opacity-0 group-hover:opacity-100">
                              <button type="button" className="text-[12px] text-gray-400 hover:text-[#FF5B00]" onClick={() => setEditingProduct(product.id)}>Rediger</button>
                              <button
                                type="button"
                                className="text-[12px] text-gray-400 hover:text-red-500"
                                onClick={() => mutate((current) => current.map((row, index) => (
                                  index !== 0 ? row : {
                                    ...row,
                                    categories: row.categories.map((item, idx) => (
                                      idx !== categoryIndex ? item : {
                                        ...item,
                                        products: item.products.filter((_, pIdx) => pIdx !== productIndex),
                                      }
                                    )),
                                  }
                                )))}
                              >
                                Slett
                              </button>
                            </div>
                          </div>
                          <span className="text-[14px]">{product.contactInsteadOfPrice ? 'Kontakt' : (product.price || '—')}</span>
                          <span className="text-[14px] text-gray-600 truncate">{product.description || (product.included || []).join(', ')}</span>
                          <button
                            type="button"
                            className="w-[50px] h-[36px] rounded-lg overflow-hidden border border-gray-200 bg-gray-50"
                            onClick={() => product.imageUrl && setPreviewImage(clientMediaSrc(product.imageUrl, token))}
                          >
                            {product.imageUrl ? (
                              <img src={clientMediaSrc(product.imageUrl, token)} className="w-full h-full object-cover" alt="" />
                            ) : (
                              <Eye className="w-4 h-4 mx-auto text-gray-300" />
                            )}
                          </button>
                        </div>
                      )}
                      </React.Fragment>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <AnimatePresence>
        {flow === 'choose_layout' ? (
          <Overlay onClose={() => setFlow(hasProducts || categories.length ? 'editor' : 'empty')}>
            <h2 className="text-2xl font-bold text-[#121212] mb-10 text-center">Hvordan vil du fremstille produktene</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 w-full mb-6">
              {PRODUCT_LAYOUTS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => chooseLayout(entry.id as LayoutId)}
                  className="group cursor-pointer flex flex-col items-center hover:-translate-y-1 transition-transform"
                >
                  <span className="font-semibold text-[17px] mb-4">{entry.label}</span>
                  <div className="w-full h-40 bg-white rounded-2xl border border-gray-200 group-hover:border-[#FF5B00] mb-4" />
                  <p className="text-[13px] text-gray-500 text-center">{entry.hint}</p>
                </button>
              ))}
            </div>
          </Overlay>
        ) : null}

        {flow === 'choose_upload' ? (
          <Overlay onClose={() => setFlow(hasProducts || categories.length ? 'editor' : 'empty')}>
            <h2 className="text-[24px] font-bold text-[#121212] mb-4">Express produkt utsjekking</h2>
            <p className="text-[15px] mb-8 max-w-[460px] text-center">Har du et dokument, excel, pdf eller en url med produkter kan du laste opp her</p>
            <div className="w-full max-w-[440px] flex flex-col items-center">
              <input
                type="text"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://eksempel.com/produkt"
                className="w-full bg-gray-100/80 rounded-xl px-5 py-4 text-[15px] outline-none text-center mb-4"
                onKeyDown={(e) => e.key === 'Enter' && void importFromUrl()}
              />
              <button
                type="button"
                disabled={busy === 'scrape' || !sourceUrl.trim()}
                onClick={() => void importFromUrl()}
                className="w-full bg-[#FF5B00] text-white rounded-xl py-3 text-sm font-semibold disabled:opacity-50 mb-6"
              >
                {busy === 'scrape' ? 'Henter…' : 'Hent fra URL'}
              </button>
              <label className="w-full border border-dashed border-gray-300 rounded-xl py-8 text-center cursor-pointer hover:bg-gray-50 mb-6">
                {busy === 'import' ? <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2" /> : <Upload className="w-6 h-6 text-gray-400 mx-auto mb-2" />}
                <span className="text-[13px] text-gray-600">Last opp CSV, Excel eller PDF</span>
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls,.pdf,.txt,.docx"
                  className="hidden"
                  multiple
                  onChange={(e) => {
                    void importFiles(Array.from(e.target.files || []));
                    e.target.value = '';
                  }}
                />
              </label>
              <button
                type="button"
                onClick={startManual}
                className="w-full bg-white border border-gray-200 rounded-xl py-4 font-semibold text-[15px]"
              >
                Legg inn produkter manuelt
              </button>
              <Link to="/kunde/ai-assistant" className="mt-4 text-[13px] text-[#FF5B00]">
                Åpne AI-assistenten
              </Link>
            </div>
          </Overlay>
        ) : null}
      </AnimatePresence>

      {previewImage ? (
        <div className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-8" onClick={() => setPreviewImage('')}>
          <button type="button" className="absolute top-6 right-6 text-white" aria-label="Lukk">
            <X className="w-6 h-6" />
          </button>
          <img src={previewImage} className="max-w-full max-h-[90vh] object-contain rounded-lg" alt="" />
        </div>
      ) : null}
    </div>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
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
        className="bg-white rounded-[32px] shadow-2xl max-w-[900px] w-full p-8 lg:p-12 flex flex-col items-center relative"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

function ProductEditor({
  product,
  layout,
  token,
  showAdvanced,
  setShowAdvanced,
  onChange,
  onUpload,
  onClose,
}: {
  product: CatalogProduct;
  layout: LayoutId;
  token: string;
  showAdvanced: boolean;
  setShowAdvanced: (value: boolean) => void;
  onChange: (patch: Partial<CatalogProduct>) => void;
  onUpload: (file: File) => void;
  onClose: () => void;
}) {
  return (
    <div className="p-6 bg-white border-b last:border-b-0 border-gray-100">
      <div className="flex flex-col md:flex-row gap-6">
        <div className="w-full md:w-1/3 flex flex-col gap-4">
          <label className="text-[12px] font-medium text-gray-700">
            Navn
            <input className={fieldClass} value={product.title} onChange={(e) => onChange({ title: e.target.value })} />
          </label>
          {layout === 'tiers' ? (
            <label className="text-[12px] font-medium text-gray-700">
              Undertittel
              <input className={fieldClass} value={product.subtitle} onChange={(e) => onChange({ subtitle: e.target.value })} />
            </label>
          ) : null}
          {layout === 'meny' ? (
            <label className="text-[12px] font-medium text-gray-700">
              Allergener
              <input className={fieldClass} value={product.allergens} onChange={(e) => onChange({ allergens: e.target.value })} />
            </label>
          ) : null}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[12px] font-medium text-gray-700">Pris</span>
              <label className="flex items-center gap-2 text-[11px] text-gray-500">
                <input
                  type="checkbox"
                  checked={product.contactInsteadOfPrice}
                  onChange={(e) => onChange({ contactInsteadOfPrice: e.target.checked })}
                />
                Ingen pris, kontakt i stedet
              </label>
            </div>
            <div className="flex gap-2">
              <input className={fieldClass} disabled={product.contactInsteadOfPrice} value={product.price} onChange={(e) => onChange({ price: e.target.value })} />
              <input className={fieldClass} disabled={product.contactInsteadOfPrice} placeholder={layout === 'meny' ? 'Ta-med-pris' : 'Sammenligningspris'} value={product.comparePrice} onChange={(e) => onChange({ comparePrice: e.target.value })} />
            </div>
          </div>
          <div className="flex gap-3">
            <button type="button" className="bg-[#FF5B00] text-white px-5 py-2.5 rounded-lg text-[13px] font-semibold" onClick={onClose}>Oppdater</button>
            <button type="button" className="bg-white border border-gray-200 text-gray-600 px-5 py-2.5 rounded-lg text-[13px] font-semibold" onClick={onClose}>Avbryt</button>
          </div>
        </div>
        <div className="w-full md:w-1/3">
          {layout === 'tiers' ? (
            <label className="text-[12px] font-medium text-gray-700">
              Hva er inkludert (ett punkt per linje)
              <textarea
                rows={8}
                className={fieldClass}
                value={(product.included || []).join('\n')}
                onChange={(e) => onChange({ included: e.target.value.split('\n').map((row) => row.trim()).filter(Boolean) })}
              />
            </label>
          ) : (
            <label className="text-[12px] font-medium text-gray-700">
              Beskrivelse
              <textarea rows={8} className={fieldClass} value={product.description} onChange={(e) => onChange({ description: e.target.value })} />
            </label>
          )}
        </div>
        <div className="w-full md:w-1/3">
          <label className="w-full h-[230px] border-2 border-dashed border-gray-200 rounded-xl flex flex-col items-center justify-center cursor-pointer hover:bg-gray-50 overflow-hidden relative">
            {product.imageUrl ? (
              <img src={clientMediaSrc(product.imageUrl, token)} className="w-full h-full object-cover" alt="" />
            ) : (
              <>
                <Upload className="w-8 h-8 text-gray-400 mb-3" />
                <span className="text-[13px] font-medium text-gray-500">Last opp produktbilde</span>
              </>
            )}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUpload(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      </div>
      <div className="border-t border-gray-100 pt-5 mt-5">
        <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="flex items-center gap-2 text-[13px] font-medium text-gray-500">
          <ChevronDown className={`w-4 h-4 ${showAdvanced ? 'rotate-180' : ''}`} /> Avansert valg
        </button>
        {showAdvanced ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-6">
            {layout === 'normal' ? (
              <label className="text-[12px] font-medium text-gray-700">
                Undertittel
                <input className={fieldClass} value={product.subtitle} onChange={(e) => onChange({ subtitle: e.target.value })} />
              </label>
            ) : null}
            {layout === 'meny' ? (
              <label className="text-[12px] font-medium text-gray-700">
                Ekstra tillegg (Navn (pris) per linje)
                <textarea
                  rows={4}
                  className={fieldClass}
                  value={(product.extraOptions || []).map((opt) => (opt.price ? `${opt.name} (${opt.price})` : opt.name)).join('\n')}
                  onChange={(e) => onChange({
                    extraOptions: e.target.value.split('\n').map((row) => {
                      const match = row.match(/^(.*?)(?:\s*\((.+)\))?$/);
                      return { name: String(match?.[1] || '').trim(), price: String(match?.[2] || '').trim() };
                    }).filter((row) => row.name || row.price),
                  })}
                />
              </label>
            ) : (
              <label className="text-[12px] font-medium text-gray-700">
                Ekstra infotekst (ett punkt per linje)
                <textarea
                  rows={4}
                  className={fieldClass}
                  value={(product.extraTexts || []).join('\n')}
                  onChange={(e) => onChange({ extraTexts: e.target.value.split('\n').map((row) => row.trim()).filter(Boolean) })}
                />
              </label>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const fieldClass = 'mt-1.5 w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-[13px] outline-none focus:border-[#FF5B00]';
