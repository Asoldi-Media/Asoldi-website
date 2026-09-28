import React, { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { Loader2, Lock, MapPin, ShoppingBag, TrendingUp } from 'lucide-react';
import { ClientRouteGuard } from '../../components/client/ClientRouteGuard';
import { ClientPortalLayout } from '../../components/client/ClientPortalLayout';
import { useClientAuth } from '../../contexts/ClientAuthContext';

const RANGES = [
  { id: '7d', label: '7 dager' },
  { id: '14d', label: '14 dager' },
  { id: '30d', label: '30 dager' },
  { id: '90d', label: '90 dager' },
  { id: '6m', label: '6 mnd' },
  { id: '1y', label: '1 år' },
];

function nb(n: number, digits = 0) {
  return Number(n || 0).toLocaleString('nb-NO', { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function Sparkline({ points = [] as number[] }) {
  if (!points.length) return <div className="h-14 rounded-lg bg-[#F3F4F6]" />;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = Math.max(max - min, 1);
  const w = 180;
  const h = 52;
  const d = points.map((value, i) => {
    const x = (i / Math.max(points.length - 1, 1)) * w;
    const y = h - ((value - min) / span) * (h - 6) - 3;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-14">
      <path d={`${d} L${w},${h} L0,${h} Z`} fill="#FF5B00" opacity="0.12" />
      <path d={d} fill="none" stroke="#FF5B00" strokeWidth="2" />
    </svg>
  );
}

function pct(n: number) {
  return `${nb(n, 1)}%`;
}

function kr(n: number) {
  return `${nb(n, 0)} kr`;
}

function Funnel({ stages = [] }: { stages?: any[] }) {
  const max = Math.max(...stages.map((row) => Number(row.count) || 0), 1);
  if (!stages.length) return <p className="text-sm text-[#9CA3AF]">Ingen butikkøkter i perioden ennå.</p>;
  return (
    <ol className="space-y-3">
      {stages.map((stage: any, index: number) => (
        <li key={stage.id || stage.label}>
          <div className="flex items-end justify-between gap-3 mb-1">
            <p className="text-sm text-[#111827]">{stage.label}</p>
            <p className="text-xs text-[#9CA3AF]">{nb(stage.count)} · {pct(stage.share)}</p>
          </div>
          <div className="h-2.5 rounded-full bg-[#F3F4F6] overflow-hidden">
            <div className="h-full rounded-full bg-[#FF5B00]" style={{ width: `${Math.max(4, (Number(stage.count) / max) * 100)}%` }} />
          </div>
          {index > 0 && Number(stage.dropoff) > 0 ? (
            <p className="mt-1 text-[11px] text-rose-600">−{pct(stage.dropoff)} frafall · {pct(stage.kept)} gikk videre</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function Card({ label, value, points }: { label: string; value: string; points?: number[] }) {
  return (
    <div className="rounded-2xl border border-[#E7E9EE] bg-white p-4 shadow-[0_8px_24px_rgba(17,24,39,0.04)]">
      <p className="text-xs uppercase tracking-wide text-[#9CA3AF]">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-[#111827]">{value}</p>
      {points ? <div className="mt-2"><Sparkline points={points} /></div> : null}
    </div>
  );
}

export const ClientAnalytics = () => {
  const { token } = useClientAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [forbidden, setForbidden] = useState(false);
  const [data, setData] = useState<any>(null);
  const [range, setRange] = useState('30d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [tab, setTab] = useState('overview');

  async function load(nextRange = range) {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ range: nextRange });
      if (nextRange === 'custom' && from && to) {
        params.set('from', from);
        params.set('to', to);
      }
      const res = await fetch(`/api/client/analytics?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const payload = await res.json().catch(() => ({}));
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error(payload.message || 'Kunne ikke laste analyse.');
      setForbidden(false);
      setData(payload);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Kunne ikke laste analyse.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) void load('30d');
  }, [token]);

  const traffic = data?.traffic || {};
  const maps = data?.maps || {};
  const gbp = data?.gbp || {};
  const cta = data?.cta || {};
  const goals = data?.goals || {};
  const ecommerce = data?.ecommerce;
  const advanced = data?.access?.level === 'advanced';
  const series = traffic.series || [];

  return (
    <ClientRouteGuard>
      <Helmet>
        <title>Kundeportal – Analyse</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <ClientPortalLayout title="Analyse" subtitle="Trafikk, lokal rangering og Google Maps">
        {forbidden ? (
          <div className="mx-auto max-w-[720px] rounded-2xl border border-[#E7E9EE] bg-white p-10 text-center">
            <Lock className="mx-auto text-[#9CA3AF]" />
            <h2 className="mt-3 text-xl font-semibold">Analyse inngår fra SEO-nivået</h2>
            <p className="mt-2 text-sm text-[#6B7280]">Tier 1 har ikke analyseside. Oppgrader til SEO eller Nettbutikk for dashbord, bounce rate og Google Maps-rangering.</p>
            <Link to="/kunde/tjenester/nettside/planer" className="mt-5 inline-flex rounded-xl bg-[#FF5B00] px-4 py-2 text-sm text-white">Se planer</Link>
          </div>
        ) : loading ? (
          <div className="min-h-[240px] flex items-center justify-center text-[#6B7280]">
            <Loader2 className="animate-spin mr-2" size={18} /> Laster analyse…
          </div>
        ) : error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm text-[#6B7280]">{data?.subject?.name}</p>
                <p className="text-xs text-[#9CA3AF]">{data?.subject?.address || 'Legg inn adresse i innstillinger for lokal rangering'}</p>
              </div>
              <div className="flex flex-wrap gap-1 rounded-full bg-white border border-[#E7E9EE] p-1">
                {RANGES.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => { setRange(entry.id); void load(entry.id); }}
                    className={`px-3 py-1.5 rounded-full text-xs ${range === entry.id ? 'bg-[#111827] text-white' : 'text-[#6B7280]'}`}
                  >
                    {entry.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setRange('custom')}
                  className={`px-3 py-1.5 rounded-full text-xs ${range === 'custom' ? 'bg-[#111827] text-white' : 'text-[#6B7280]'}`}
                >
                  Egendefinert
                </button>
              </div>
            </div>

            {range === 'custom' ? (
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs text-[#6B7280]">
                  Fra
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 block rounded-lg border border-[#E7E9EE] px-3 py-2 text-sm text-[#111827]" />
                </label>
                <label className="text-xs text-[#6B7280]">
                  Til
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 block rounded-lg border border-[#E7E9EE] px-3 py-2 text-sm text-[#111827]" />
                </label>
                <button type="button" onClick={() => void load('custom')} className="rounded-lg bg-[#FF5B00] px-4 py-2 text-sm text-white">Vis periode</button>
              </div>
            ) : null}

            <div className="flex gap-2">
              <button type="button" onClick={() => setTab('overview')} className={`rounded-xl px-4 py-2 text-sm ${tab === 'overview' ? 'bg-[#111827] text-white' : 'bg-white border border-[#E7E9EE]'}`}>Trafikk</button>
              <button type="button" onClick={() => setTab('maps')} className={`rounded-xl px-4 py-2 text-sm ${tab === 'maps' ? 'bg-[#111827] text-white' : 'bg-white border border-[#E7E9EE]'}`}>Google Maps</button>
              {advanced ? (
                <button type="button" onClick={() => setTab('shop')} className={`rounded-xl px-4 py-2 text-sm ${tab === 'shop' ? 'bg-[#111827] text-white' : 'bg-white border border-[#E7E9EE]'}`}>Nettbutikk</button>
              ) : null}
            </div>

            {tab === 'overview' ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  <Card label="Besøk" value={nb(traffic.visits || 0)} points={series.map((row: any) => row.visits || 0)} />
                  <Card label="Unike visninger" value={nb(traffic.uniqueVisitors || 0)} points={series.map((row: any) => row.uniqueVisitors || 0)} />
                  <Card label="Avvisningsrate" value={`${nb(traffic.bounceRate || 0, 1)}%`} />
                  <Card label="Sider per besøk" value={nb(traffic.viewRate || 0, 1)} />
                </div>
                {cta.configured ? (
                  <div className="rounded-2xl border border-[#FF5B00]/30 bg-[#FFF7F2] p-5">
                    <p className="text-xs uppercase tracking-wide text-[#FF5B00]">Hovedhandling</p>
                    <h3 className="mt-1 font-semibold text-[#111827]">{goals.label || 'Ønsket side'}</h3>
                    <p className="text-xs text-[#9CA3AF] mt-1">Trafikk og klikk til {cta.path}</p>
                    <div className="mt-4 grid gap-3 sm:grid-cols-4">
                      <div><p className="text-xs text-[#9CA3AF]">Visninger av siden</p><p className="text-xl font-semibold">{nb(cta.pageviews)}</p></div>
                      <div><p className="text-xs text-[#9CA3AF]">Unike besøkende</p><p className="text-xl font-semibold">{nb(cta.visitors)}</p></div>
                      <div><p className="text-xs text-[#9CA3AF]">Klikk mot siden</p><p className="text-xl font-semibold">{nb(cta.clicks)}</p></div>
                      <div><p className="text-xs text-[#9CA3AF]">Andel av alle besøk</p><p className="text-xl font-semibold">{pct(cta.rate)}</p></div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-[#E5E7EB] bg-[#FCFCFD] p-5 text-sm text-[#6B7280]">
                    Hovedhandling settes i Website Maker under klientdetaljer (beskrivelse + valgfri URL). Da måler vi her hvor mange som kommer til den siden.
                  </div>
                )}
                {gbp?.insights ? (
                  <div className="rounded-2xl border border-[#E7E9EE] bg-white p-5">
                    <h3 className="font-semibold text-[#111827]">Google-bedriftsprofil</h3>
                    <div className="mt-3 grid gap-3 sm:grid-cols-4">
                      <div><p className="text-xs text-[#9CA3AF]">Kartvisninger</p><p className="text-xl font-semibold">{nb(gbp.insights.mapsViews)}</p></div>
                      <div><p className="text-xs text-[#9CA3AF]">Søkevisninger</p><p className="text-xl font-semibold">{nb(gbp.insights.searchViews)}</p></div>
                      <div><p className="text-xs text-[#9CA3AF]">Klikk til nettside</p><p className="text-xl font-semibold">{nb(gbp.insights.websiteClicks)}</p></div>
                      <div><p className="text-xs text-[#9CA3AF]">Anrop</p><p className="text-xl font-semibold">{nb(gbp.insights.callClicks)}</p></div>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-[#E5E7EB] bg-[#FCFCFD] p-5 text-sm text-[#6B7280]">
                    Koble til Google-bedriftsprofilen i <Link to="/kunde/innstillinger" className="text-[#FF5B00]">innstillinger</Link> for visninger og klikk direkte fra Google.
                  </div>
                )}
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-2xl border border-[#E7E9EE] bg-white overflow-hidden">
                    <div className="px-4 py-3 border-b border-[#F3F4F6] text-sm font-medium">Mest besøkte sider</div>
                    {(traffic.topPages || []).map((row: any) => (
                      <div key={row.path} className="flex justify-between px-4 py-2 text-sm border-t border-[#F8F9FB]">
                        <span className="truncate text-[#374151]">{row.path}</span>
                        <span className="font-medium">{nb(row.count)}</span>
                      </div>
                    ))}
                    {!(traffic.topPages || []).length ? <p className="px-4 py-6 text-sm text-[#9CA3AF]">Ingen treff i perioden. Telleren starter når besøkende åpner nettsiden.</p> : null}
                  </div>
                  <div className="rounded-2xl border border-[#E7E9EE] bg-white overflow-hidden">
                    <div className="px-4 py-3 border-b border-[#F3F4F6] text-sm font-medium">Trafikkilder</div>
                    {(traffic.referrers || []).map((row: any) => (
                      <div key={row.source} className="flex justify-between px-4 py-2 text-sm border-t border-[#F8F9FB]">
                        <span className="truncate text-[#374151]">{row.source}</span>
                        <span className="font-medium">{nb(row.count)}</span>
                      </div>
                    ))}
                    {!(traffic.referrers || []).length ? <p className="px-4 py-6 text-sm text-[#9CA3AF]">Ingen henvisninger i perioden.</p> : null}
                  </div>
                </div>
              </>
            ) : null}

            {tab === 'maps' ? (
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-4">
                  <Card label="Beste posisjon" value={maps.summary?.bestPosition ? `#${maps.summary.bestPosition}` : '—'} />
                  <Card label="Snittposisjon" value={maps.summary?.avgPosition ? nb(maps.summary.avgPosition, 1) : '—'} />
                  <Card label="Vurdering" value={maps.summary?.rating ? `${nb(maps.summary.rating, 1)} ★` : '—'} />
                  <Card label="Anmeldelser" value={nb(maps.summary?.reviews || 0)} />
                </div>
                <div className="rounded-2xl border border-[#E7E9EE] bg-white p-5">
                  <h3 className="font-semibold text-[#111827] flex items-center gap-2"><MapPin size={16} className="text-[#FF5B00]" /> Google Maps lokalpakke</h3>
                  <p className="text-xs text-[#9CA3AF] mt-1">
                    DataForSEO Google Maps SERP · søkeord fra nøkkelordplanen i Website Maker · {data?.subject?.address || 'mangler adresse'} · oppdateres hver {maps.intervalDays || 14}. dag
                  </p>
                  {maps.lastError ? <p className="mt-2 text-sm text-amber-700">{maps.lastError}</p> : null}
                  <ol className="mt-4 space-y-2">
                    {(maps.queries?.[0]?.pack || []).map((row: any) => (
                      <li key={`${row.position}-${row.title}`} className={`flex items-center justify-between rounded-xl border px-3 py-2.5 ${row.isSelf ? 'border-[#FF5B00] bg-[#FFF7F2]' : 'border-[#E7E9EE]'}`}>
                        <div className="flex items-center gap-3 min-w-0">
                          <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold ${row.isSelf ? 'bg-[#FF5B00] text-white' : 'bg-[#F3F4F6] text-[#374151]'}`}>{row.position}</span>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{row.title}</p>
                            <p className="text-xs text-[#9CA3AF] truncate">{row.address}</p>
                          </div>
                        </div>
                        <p className="text-xs text-[#6B7280]">{row.rating ? `${nb(row.rating, 1)} ★` : ''}</p>
                      </li>
                    ))}
                  </ol>
                  {!(maps.queries || []).length ? <p className="mt-4 text-sm text-[#9CA3AF]">Rangering kjøres automatisk når adresse og nøkkelord ligger i kundekortet.</p> : null}
                </div>
                <div className="rounded-2xl border border-[#E7E9EE] bg-white overflow-hidden">
                  <div className="px-4 py-3 text-sm font-medium border-b border-[#F3F4F6]">Søkeord</div>
                  {(maps.queries || []).map((row: any) => (
                    <div key={row.keyword} className="flex justify-between px-4 py-2.5 text-sm border-t border-[#F8F9FB]">
                      <span>{row.keyword}</span>
                      <span className="font-semibold text-[#FF5B00]">{row.found ? `#${row.position}` : 'Ikke funnet'}</span>
                    </div>
                  ))}
                </div>
                {(maps.history || []).length > 1 ? (
                  <div className="rounded-2xl border border-[#E7E9EE] bg-white p-5">
                    <h3 className="font-semibold text-[#111827] flex items-center gap-2"><TrendingUp size={16} className="text-[#FF5B00]" /> Utvikling hver 14. dag</h3>
                    <p className="text-xs text-[#9CA3AF] mt-1">
                      {maps.previousSummary?.bestPosition && maps.summary?.bestPosition
                        ? (maps.summary.bestPosition < maps.previousSummary.bestPosition
                          ? `Opp ${maps.previousSummary.bestPosition - maps.summary.bestPosition} plasser siden forrige måling`
                          : maps.summary.bestPosition > maps.previousSummary.bestPosition
                            ? `Ned ${maps.summary.bestPosition - maps.previousSummary.bestPosition} plasser siden forrige måling`
                            : 'Uendret siden forrige måling')
                        : 'Neste måling sammenlignes automatisk med denne.'}
                    </p>
                    <div className="mt-3"><Sparkline points={(maps.history || []).map((row: any) => (row.bestPosition ? 21 - row.bestPosition : 0))} /></div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-4">
                      {(maps.history || []).slice(-4).map((row: any) => (
                        <div key={row.ranAt} className="rounded-xl bg-[#F8F9FB] p-3 text-xs text-[#6B7280]">
                          <p>{new Date(row.ranAt).toLocaleDateString('nb-NO')}</p>
                          <p className="text-sm font-semibold text-[#111827] mt-1">#{row.bestPosition || '—'} · {nb(row.rating, 1)} ★</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {tab === 'shop' && advanced ? (
              <div className="space-y-4">
                <p className="text-sm text-[#6B7280]">
                  Salg og kasse-trakt for nettbutikken. Besøk, avvisning og sider ligger under Trafikk.
                </p>
                {!ecommerce ? (
                  <div className="rounded-2xl border border-[#E7E9EE] bg-white p-6 text-sm text-[#6B7280]">
                    Salgstall vises når CMS på nettsiden har ordre i perioden. Åpne Analyse i /admin for å synke siste tall hit.
                  </div>
                ) : (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <Card label="Totalt salg" value={kr(ecommerce.revenue)} points={(ecommerce.series || []).map((row: any) => row.revenue || 0)} />
                      <Card label="Bestillinger" value={nb(ecommerce.orders)} points={(ecommerce.series || []).map((row: any) => row.orders || 0)} />
                      <Card label="Snittbestilling" value={kr(ecommerce.aov)} />
                      <Card label="Butikkonvertering" value={pct(ecommerce.conversionRate)} />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                      <Card label="Enheter solgt" value={nb(ecommerce.unitsSold)} />
                      <Card label="Tilbakevendende" value={pct(ecommerce.returningRate)} />
                      <Card label="Nye kunder" value={nb(ecommerce.newCustomers)} />
                      <Card label="Kansellerte" value={nb(ecommerce.cancelled)} />
                    </div>
                    <div className="grid gap-4 lg:grid-cols-5">
                      <div className="lg:col-span-3 rounded-2xl border border-[#E7E9EE] bg-white p-5">
                        <h3 className="font-semibold text-[#111827]">Nettbutikk-trakt</h3>
                        <p className="text-xs text-[#9CA3AF] mt-1 mb-4">Frafall mellom produkt, kurv, kasse og kjøp.</p>
                        <Funnel stages={ecommerce.funnel || []} />
                      </div>
                      <div className="lg:col-span-2 space-y-3">
                        <div className="rounded-2xl border border-[#E7E9EE] bg-white p-5">
                          <p className="text-xs text-[#9CA3AF]">Forlatt handlekurv</p>
                          <p className="text-3xl font-semibold text-[#111827] mt-1">{pct(ecommerce.abandonment?.cart)}</p>
                          <p className="text-xs text-[#9CA3AF] mt-2">La i kurv, men startet ikke kasse.</p>
                        </div>
                        <div className="rounded-2xl border border-[#E7E9EE] bg-white p-5">
                          <p className="text-xs text-[#9CA3AF]">Forlatt kasse</p>
                          <p className="text-3xl font-semibold text-[#111827] mt-1">{pct(ecommerce.abandonment?.checkout)}</p>
                          <p className="text-xs text-[#9CA3AF] mt-2">Startet kasse, men fullførte ikke kjøp.</p>
                        </div>
                      </div>
                    </div>
                    <div className="rounded-2xl border border-[#E7E9EE] bg-white overflow-hidden">
                      <div className="px-4 py-3 border-b border-[#F3F4F6] text-sm font-medium flex items-center gap-2"><ShoppingBag size={14} className="text-[#FF5B00]" /> Mest solgte produkter</div>
                      {(ecommerce.topProducts || []).map((row: any) => (
                        <div key={row.name} className="flex justify-between px-4 py-2.5 text-sm border-t border-[#F8F9FB]">
                          <span className="text-[#374151]">{row.name}</span>
                          <span className="font-medium">{nb(row.count)} · {kr(row.revenue)}</span>
                        </div>
                      ))}
                      {!(ecommerce.topProducts || []).length ? <p className="px-4 py-6 text-sm text-[#9CA3AF]">Ingen ordre i perioden.</p> : null}
                    </div>
                    {ecommerce.savedAt ? (
                      <p className="text-xs text-[#9CA3AF]">Sist synket fra CMS {new Date(ecommerce.savedAt).toLocaleString('nb-NO')}</p>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}
          </div>
        )}
      </ClientPortalLayout>
    </ClientRouteGuard>
  );
};
