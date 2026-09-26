import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ArrowRight, Check, ChevronDown, Gift, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';
import { ClientRouteGuard } from '../../components/client/ClientRouteGuard';
import { ClientPortalLayout } from '../../components/client/ClientPortalLayout';
import { useClientAuth } from '../../contexts/ClientAuthContext';
import { findWebsitePlan } from '../../data/clientWebsitePlans';

type DashboardTodo = { id: string; title: string; description: string; actionLabel: string; route: string };

type DashboardResponse = {
  profile: any;
  dashboard: {
    todoList: DashboardTodo[];
    marketingElements: Array<{ key: string; label: string; status: string; health: string[]; createdAt: string }>;
    performance: {
      uniqueViews: number;
      bounceRate: number;
      bounceDeltaPct: number;
      purchases: number;
      clicks: number;
      monthLabel: string;
    };
    greetingName: string;
  };
};

type ClientOffer = {
  id: string;
  code: string;
  planId: string;
  planName: string;
  price: string;
  note: string;
  previewUrl: string;
  accepted?: boolean;
  acceptedAt?: string;
} | null;

type TodoEntry = DashboardTodo & { accent?: boolean };

function dismissStorageKey(userId: string) {
  return `clientTodoDismissed:${userId || 'anon'}`;
}

function readDismissed(userId: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(dismissStorageKey(userId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function writeDismissed(userId: string, ids: string[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(dismissStorageKey(userId), JSON.stringify(ids));
  } catch {
    // Ignore storage failures.
  }
}

export const ClientHome = () => {
  const navigate = useNavigate();
  const { token, user } = useClientAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState<DashboardResponse | null>(null);
  const [offer, setOffer] = useState<ClientOffer>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    setDismissed(readDismissed(user?.id || ''));
  }, [user?.id]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError('');
      try {
        const [dashboardRes, offerRes] = await Promise.all([
          fetch('/api/client/dashboard', { headers: { Authorization: `Bearer ${token}` } }),
          fetch('/api/client/offer', { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        const payload = await dashboardRes.json().catch(() => ({}));
        if (!dashboardRes.ok) throw new Error(payload.message || 'Kunne ikke laste dashboard.');
        setData(payload as DashboardResponse);
        const offerPayload = await offerRes.json().catch(() => ({}));
        setOffer(offerRes.ok ? (offerPayload.offer as ClientOffer) : null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Kunne ikke laste dashboard.');
      } finally {
        setLoading(false);
      }
    }
    if (token) void load();
  }, [token]);

  const performance = useMemo(() => data?.dashboard?.performance, [data]);
  const element = data?.dashboard?.marketingElements?.[0];

  const todos = useMemo<TodoEntry[]>(() => {
    const baseTodos = (data?.dashboard?.todoList || []) as TodoEntry[];
    if (!offer || offer.accepted) return baseTodos;
    const offerPlanName = offer.planName || findWebsitePlan(offer.planId)?.name || 'nettsideplan';
    const offerTodo: TodoEntry = {
      id: `offer-${offer.id}`,
      title: `Tilbud klart: ${offerPlanName}`,
      description: 'Les tilbudet og kontrakten. Du aksepterer nederst når du har lest gjennom.',
      actionLabel: 'Se tilbud',
      route: '/kunde/tilbud',
      accent: true,
    };
    return [offerTodo, ...baseTodos];
  }, [data, offer]);

  function toggleDismiss(id: string) {
    setDismissed((prev) => {
      const next = prev.includes(id) ? prev.filter((entry) => entry !== id) : [...prev, id];
      writeDismissed(user?.id || '', next);
      return next;
    });
  }

  return (
    <ClientRouteGuard>
      <Helmet>
        <title>Kundeportal – Hjem</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <ClientPortalLayout>
        {loading ? (
          <div className="min-h-[280px] flex items-center justify-center text-[#6B7280]">
            <Loader2 className="animate-spin mr-2" size={18} /> Laster dashboard…
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-red-600 text-sm">{error}</div>
        ) : (
          <div className="mx-auto max-w-[920px] space-y-10">
            <section>
              <p className="text-sm text-[#6B7280]">Velkommen tilbake</p>
              <h2 className="mt-1 text-3xl font-semibold tracking-tight text-[#111827]">
                Hei, {data?.dashboard?.greetingName || 'kunde'}
              </h2>
              <p className="mt-2 text-sm text-[#6B7280]">Her er neste steg i leveransen din.</p>
            </section>

            <section>
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-[#111827]">Din to-do liste</h3>
                <span className="text-xs text-[#9CA3AF]">
                  {todos.filter((todo) => !dismissed.includes(todo.id)).length} aktive
                </span>
              </div>
              <div className="mt-4 space-y-3">
                {todos.map((todo) => {
                  const isDone = dismissed.includes(todo.id);
                  return (
                    <div
                      key={todo.id}
                      className={`group flex items-center gap-4 rounded-2xl border px-5 py-4 transition-colors ${
                        isDone
                          ? 'border-[#EDEFF3] bg-[#FAFBFC]'
                          : todo.accent
                            ? 'border-[#FFC9AE] bg-gradient-to-r from-[#FFF3EC] to-white shadow-[0_8px_24px_rgba(255,91,0,0.08)]'
                            : 'border-[#E7E9EE] bg-white hover:border-[#D8DCE3]'
                      }`}
                    >
                      <span
                        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                          isDone
                            ? 'bg-[#E7F6EC] text-emerald-600'
                            : todo.accent
                              ? 'bg-[#FF5B00] text-white'
                              : 'bg-[#F2F4F7] text-[#6B7280]'
                        }`}
                      >
                        {isDone ? <Check size={16} /> : todo.accent ? <Sparkles size={16} /> : <ArrowRight size={16} />}
                      </span>

                      <button
                        type="button"
                        onClick={() => !isDone && navigate(todo.route)}
                        disabled={isDone}
                        className="flex-1 min-w-0 text-left disabled:cursor-default"
                      >
                        <p className={`text-sm font-semibold ${isDone ? 'text-[#9CA3AF] line-through' : 'text-[#111827]'}`}>
                          {todo.title}
                        </p>
                        <p className={`mt-0.5 text-xs ${isDone ? 'text-[#B6BBC4] line-through' : 'text-[#6B7280]'}`}>
                          {todo.description}
                        </p>
                      </button>

                      {!isDone ? (
                        <button
                          type="button"
                          onClick={() => navigate(todo.route)}
                          className={`hidden sm:inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors ${
                            todo.accent
                              ? 'bg-[#FF5B00] text-white hover:bg-[#E55200]'
                              : 'bg-[#111827] text-white hover:bg-[#1F2937]'
                          }`}
                        >
                          {todo.actionLabel}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => toggleDismiss(todo.id)}
                          className="hidden sm:inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-[#6B7280] hover:text-[#111827]"
                        >
                          <RotateCcw size={13} />
                          Angre
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => toggleDismiss(todo.id)}
                        aria-label={isDone ? 'Angre' : 'Kryss ut'}
                        title={isDone ? 'Angre' : 'Kryss ut'}
                        className="shrink-0 rounded-full p-1.5 text-[#9CA3AF] hover:bg-[#F2F4F7] hover:text-[#111827]"
                      >
                        {isDone ? <RotateCcw size={15} /> : <X size={16} />}
                      </button>
                    </div>
                  );
                })}

                {offer?.accepted ? (
                  <details className="rounded-2xl border border-[#E7E9EE] bg-white px-5 py-4">
                    <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-[#111827]">
                      Betaling
                      <ChevronDown size={16} className="text-[#9CA3AF]" />
                    </summary>
                    <p className="mt-3 text-sm text-[#6B7280]">Betaling åpnes når Asoldi slår på checkout for kontoen din.</p>
                  </details>
                ) : null}

                {todos.every((todo) => dismissed.includes(todo.id)) ? (
                  <div className="rounded-2xl border border-dashed border-[#E0E3E9] bg-[#FBFCFD] px-5 py-8 text-center text-sm text-[#9CA3AF]">
                    Alt er krysset ut. Bra jobba!
                  </div>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-[#E7E9EE] bg-white p-6">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-[#111827]">Din nettside</h3>
              </div>

              <div className="mt-4 rounded-xl border border-[#EDEFF3] bg-[#FCFCFD] p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-[#111827]">{element?.label || 'Nettside'}</p>
                    <p className="text-xs text-[#9CA3AF]">Status: {element?.status || 'Aktiv'}</p>
                  </div>
                  <span className="inline-flex items-center gap-2 rounded-full border border-[#E5E7EB] bg-white px-3 py-1 text-xs text-[#374151]">
                    <span className="h-2 w-2 rounded-full bg-[#FF5B00]" />
                    Nivå 1
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(element?.health || []).map((badge) => (
                    <span
                      key={badge}
                      className="rounded-full border border-[#EDEFF3] bg-white px-3 py-1 text-xs text-[#6B7280]"
                    >
                      {badge}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                <PerformanceCard title="Unike visninger" value={(performance?.uniqueViews ?? 0).toLocaleString('nb-NO')} />
                <PerformanceCard title="Avvisningsrate" value={`${performance?.bounceRate ?? 0}%`} hint={`+${performance?.bounceDeltaPct ?? 0}%`} />
                <PerformanceCard title="Kjøp" value={(performance?.purchases ?? 0).toLocaleString('nb-NO')} />
                <PerformanceCard title="Klikk" value={(performance?.clicks ?? 0).toLocaleString('nb-NO')} />
              </div>

              <p className="mt-3 text-[11px] text-[#B6BBC4]">{performance?.monthLabel || '1 mnd'} · demo-data</p>
            </section>

            <button
              type="button"
              onClick={() => navigate('/kunde/tjenester')}
              className="inline-flex items-center gap-2 rounded-xl border border-[#E7E9EE] bg-white px-4 py-2.5 text-sm text-[#374151] hover:border-[#D8DCE3]"
            >
              <Gift size={15} className="text-[#FF5B00]" />
              Se alle tjenester
            </button>
          </div>
        )}
      </ClientPortalLayout>
    </ClientRouteGuard>
  );
};

function PerformanceCard({ title, value, hint }: { title: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-[#EDEFF3] bg-[#FCFCFD] p-3.5">
      <p className="text-xs text-[#9CA3AF]">{title}</p>
      <p className="mt-1 text-xl font-semibold text-[#111827]">{value}</p>
      {hint ? <p className="mt-1 text-xs text-emerald-600">{hint}</p> : null}
    </div>
  );
}
