import React, { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { ArrowLeft, Lock, Mail } from 'lucide-react';
import { BOOKER_PATH } from '../ansatt/path';

function safeNextPath(value = '') {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/')) return '';
  if (raw.startsWith('//') || raw.includes('://')) return '';
  return raw;
}

export const EmployeeLogin = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: email, password }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(data.message || 'Innlogging feilet. Sjekk brukernavn og passord.');
        return;
      }
      if (data.token) localStorage.setItem('employeeToken', data.token);
      window.dispatchEvent(new Event('employee-auth-changed'));
      const next = safeNextPath(searchParams.get('next') || '');
      const defaultPath =
        data?.user?.role === 'sales' ? '/sales' : data?.user?.role === 'developer' ? '/developer' : BOOKER_PATH;
      navigate(next || defaultPath, { replace: true });
    } catch {
      setError('Noe gikk galt. Prøv igjen.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Helmet>
        <title>Ansattinnlogging – Asoldi</title>
        <meta name="robots" content="noindex,nofollow" />
      </Helmet>
      <section className="min-h-screen bg-[#F8F9FB] px-6 py-12 flex items-center">
        <div className="max-w-[980px] mx-auto w-full grid lg:grid-cols-2 rounded-[28px] overflow-hidden border border-[#E6E9EF] bg-white shadow-[0_20px_50px_rgba(17,24,39,0.06)]">
          <div className="p-10 lg:p-12 bg-gradient-to-br from-[#FFF3EC] to-white border-b lg:border-b-0 lg:border-r border-[#F3D8C8]">
            <img src="/media/client-flow/login-hero.svg" alt="Asoldi login illustration" className="w-full h-auto rounded-2xl border border-[#F4D8C7]" />
            <h1 className="mt-6 text-3xl font-semibold text-[#111827]">Ansattportal</h1>
            <p className="mt-3 text-sm text-[#6B7280]">Logg inn for å få tilgang til møteflyt, oppfølging og kundedata.</p>
            <Link to="/login" className="mt-6 inline-flex items-center gap-2 text-sm text-[#374151] hover:text-[#111827]">
              <ArrowLeft size={14} />
              Tilbake til rollevalg
            </Link>
          </div>
          <div className="p-10 lg:p-12">
            <h2 className="text-2xl font-semibold text-[#111827]">Logg inn som ansatt</h2>
            <p className="text-sm text-[#6B7280] mt-2">Bruk e-post og passord.</p>
            <form onSubmit={handleLogin} className="mt-8 space-y-4">
              <label className="block">
                <span className="text-xs text-[#6B7280]">E-post</span>
                <span className="mt-1 flex items-center rounded-xl border border-[#E5E7EB] px-3 py-3 bg-[#F9FAFB]">
                  <Mail size={16} className="text-[#9CA3AF]" />
                  <input
                    type="text"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="ml-2 w-full bg-transparent outline-none text-[#111827]"
                    placeholder="din@asoldi.com"
                    required
                  />
                </span>
              </label>
              <label className="block">
                <span className="text-xs text-[#6B7280]">Passord</span>
                <span className="mt-1 flex items-center rounded-xl border border-[#E5E7EB] px-3 py-3 bg-[#F9FAFB]">
                  <Lock size={16} className="text-[#9CA3AF]" />
                  <input
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="ml-2 w-full bg-transparent outline-none text-[#111827]"
                    placeholder="********"
                    required
                  />
                </span>
              </label>
              <div className="text-right">
                <Link to="/login/forgot-password" className="text-sm text-[#6B7280] hover:text-[#111827] underline">
                  Glemt passord?
                </Link>
              </div>
              {error ? <p className="text-sm text-red-500">{error}</p> : null}
              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-xl bg-[#FF5B00] py-3 font-medium text-white hover:bg-[#E55200] disabled:opacity-50"
              >
                {loading ? 'Logger inn…' : 'Logg inn'}
              </button>
            </form>
          </div>
        </div>
      </section>
    </>
  );
};
