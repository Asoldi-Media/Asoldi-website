import React, { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { Footer } from './components/Footer';
import { ScrollToTop } from './components/ScrollToTop';
import { PageLoader } from './components/PageLoader';
import { EmployeeAuthProvider } from './contexts/EmployeeAuthContext';
import { ClientAuthProvider } from './contexts/ClientAuthContext';

const Home = lazy(() => import('./pages/Home').then((m) => ({ default: m.Home })));
const Pricing = lazy(() => import('./pages/Pricing').then((m) => ({ default: m.Pricing })));
const AboutUs = lazy(() => import('./pages/AboutUs').then((m) => ({ default: m.AboutUs })));
const WebDevelopment = lazy(() => import('./pages/WebDevelopment').then((m) => ({ default: m.WebDevelopment })));
const SocialMediaMarketing = lazy(() => import('./pages/SocialMediaMarketing').then((m) => ({ default: m.SocialMediaMarketing })));
const EmailMarketing = lazy(() => import('./pages/EmailMarketing').then((m) => ({ default: m.EmailMarketing })));
const PhotoVideo = lazy(() => import('./pages/PhotoVideo').then((m) => ({ default: m.PhotoVideo })));
const Clients = lazy(() => import('./pages/Clients').then((m) => ({ default: m.Clients })));
const Booking = lazy(() => import('./pages/Booking').then((m) => ({ default: m.Booking })));
const Page1000kr = lazy(() => import('./pages/1000kr').then((m) => ({ default: m.Page1000kr })));
const BliAnsatt = lazy(() => import('./pages/BliAnsatt').then((m) => ({ default: m.BliAnsatt })));
const Personvern = lazy(() => import('./pages/legal/Personvern').then((m) => ({ default: m.Personvern })));
const Vilkar = lazy(() => import('./pages/legal/Vilkar').then((m) => ({ default: m.Vilkar })));
const Databehandleravtale = lazy(() => import('./pages/legal/Databehandleravtale').then((m) => ({ default: m.Databehandleravtale })));
const Informasjonskapsler = lazy(() => import('./pages/legal/Informasjonskapsler').then((m) => ({ default: m.Informasjonskapsler })));
const Login = lazy(() => import('./pages/Login').then((m) => ({ default: m.Login })));
const EmployeeLogin = lazy(() => import('./pages/login/EmployeeLogin').then((m) => ({ default: m.EmployeeLogin })));
const ClientAuth = lazy(() => import('./pages/login/ClientAuth').then((m) => ({ default: m.ClientAuth })));
const ClientForgotPassword = lazy(() => import('./pages/login/ClientForgotPassword').then((m) => ({ default: m.ClientForgotPassword })));
const ClientResetPassword = lazy(() => import('./pages/login/ClientResetPassword').then((m) => ({ default: m.ClientResetPassword })));
const Admin = lazy(() => import('./pages/Admin/Admin').then((m) => ({ default: m.Admin })));
const LoginForgotPassword = lazy(() => import('./pages/LoginForgotPassword').then((m) => ({ default: m.LoginForgotPassword })));
const LoginResetPassword = lazy(() => import('./pages/LoginResetPassword').then((m) => ({ default: m.LoginResetPassword })));
const Ansatt = lazy(() => import('./pages/Ansatt').then((m) => ({ default: m.Ansatt })));
const SalesWorkspace = lazy(() => import('./pages/sales/SalesWorkspace').then((m) => ({ default: m.SalesWorkspace })));
const SalesEmailComposer = lazy(() => import('./pages/sales/SalesEmailComposer').then((m) => ({ default: m.SalesEmailComposer })));
const SalesOfferComposer = lazy(() => import('./pages/sales/SalesOfferComposer').then((m) => ({ default: m.SalesOfferComposer })));
const EmailTemplateStudioPage = lazy(() => import('./pages/sales/EmailTemplateStudio').then((m) => ({ default: m.EmailTemplateStudioPage })));
const DeveloperWorkspace = lazy(() => import('./pages/developer/DeveloperWorkspace').then((m) => ({ default: m.DeveloperWorkspace })));
const LaptopPreviews = lazy(() => import('./pages/sales/LaptopPreviews').then((m) => ({ default: m.LaptopPreviews })));
const ClientOnboarding = lazy(() => import('./pages/client/ClientOnboarding').then((m) => ({ default: m.ClientOnboarding })));
const ClientHome = lazy(() => import('./pages/client/ClientHome').then((m) => ({ default: m.ClientHome })));
const ClientOfferReview = lazy(() => import('./pages/client/ClientOfferReview').then((m) => ({ default: m.ClientOfferReview })));
const ClientServices = lazy(() => import('./pages/client/ClientServices').then((m) => ({ default: m.ClientServices })));
const ClientSettings = lazy(() => import('./pages/client/ClientSettings').then((m) => ({ default: m.ClientSettings })));
const ClientWebsiteStart = lazy(() => import('./pages/client/ClientWebsiteStart').then((m) => ({ default: m.ClientWebsiteStart })));
const ClientWebsitePlans = lazy(() => import('./pages/client/ClientWebsitePlans').then((m) => ({ default: m.ClientWebsitePlans })));
const ClientWebsiteCheckout = lazy(() => import('./pages/client/ClientWebsiteCheckout').then((m) => ({ default: m.ClientWebsiteCheckout })));
const ClientAiAssistant = lazy(() => import('./pages/client/ClientAiAssistant').then((m) => ({ default: m.ClientAiAssistant })));
const ClientAnalytics = lazy(() => import('./pages/client/ClientAnalytics').then((m) => ({ default: m.ClientAnalytics })));

function AppLayout() {
  const location = useLocation();
  const hideShell = /^\/(admin|superadmin|ansatt|sales|developer|previews|login|kunde|client)(\/|$)/.test(location.pathname);
  const useLightShell = /^\/(login|kunde|client)(\/|$)/.test(location.pathname);

  useEffect(() => {
    if (location.pathname === '/ansatt') return;
    const ids = ['tawk-script', 'tawkchat-container', 'tawkchat', 'tawkchat-minified-wrapper', 'tawkchat-minified-container'];
    ids.forEach((id) => {
      const el = document.getElementById(id);
      el?.parentNode?.removeChild(el);
    });
    document.querySelectorAll('iframe[src*="tawk.to"]').forEach((el) => el.parentNode?.removeChild(el));
    document.querySelectorAll('[id*="tawk"], [id*="Tawk"]').forEach((el) => el.parentNode?.removeChild(el));
    const styleId = 'hide-tawk-style';
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      style.textContent = '[id*="tawk"], [id*="Tawk"], iframe[src*="tawk.to"] { display: none !important; }';
      document.head.appendChild(style);
    }
    try {
      // @ts-expect-error best-effort cleanup
      delete window.Tawk_API;
      // @ts-expect-error best-effort cleanup
      delete window.Tawk_LoadStart;
    } catch {
      // ignore
    }
  }, [location.pathname]);

  return (
    <div className={`${useLightShell ? 'bg-[#F8F9FB] text-[#111827] selection:bg-black/10' : 'bg-[#050505] text-white selection:bg-white/20'} min-h-screen font-sans overflow-x-hidden`}>
      {!hideShell && <Navbar />}
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/about" element={<AboutUs />} />
          <Route path="/services/web-development" element={<WebDevelopment />} />
          <Route path="/services/social-media" element={<SocialMediaMarketing />} />
          <Route path="/services/email-marketing" element={<EmailMarketing />} />
          <Route path="/services/photo-video" element={<PhotoVideo />} />
          <Route path="/clients" element={<Clients />} />
          <Route path="/booking" element={<Booking />} />
          <Route path="/login" element={<Login />} />
          <Route path="/login/ansatt" element={<EmployeeLogin />} />
          <Route path="/login/kunde" element={<ClientAuth />} />
          <Route path="/login/kunde/forgot-password" element={<ClientForgotPassword />} />
          <Route path="/login/kunde/reset-password" element={<ClientResetPassword />} />
          <Route path="/login/client/forgot-password" element={<ClientForgotPassword />} />
          <Route path="/login/client/reset-password" element={<ClientResetPassword />} />
          <Route path="/login/forgot-password" element={<LoginForgotPassword />} />
          <Route path="/login/reset-password" element={<LoginResetPassword />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/superadmin" element={<Admin />} />
          <Route path="/ansatt" element={<Ansatt />} />
          <Route path="/sales" element={<SalesWorkspace />} />
          <Route path="/sales/email" element={<SalesEmailComposer />} />
          <Route path="/sales/offer" element={<SalesOfferComposer />} />
          <Route path="/sales/email/templates" element={<EmailTemplateStudioPage />} />
          <Route path="/developer" element={<DeveloperWorkspace />} />
          <Route path="/previews" element={<LaptopPreviews />} />
          <Route path="/kunde" element={<ClientHome />} />
          <Route path="/kunde/hjem" element={<ClientHome />} />
          <Route path="/kunde/tilbud" element={<ClientOfferReview />} />
          <Route path="/kunde/onboarding" element={<ClientOnboarding />} />
          <Route path="/kunde/tjenester" element={<ClientServices />} />
          <Route path="/kunde/ai-assistant" element={<ClientAiAssistant />} />
          <Route path="/kunde/analyse" element={<ClientAnalytics />} />
          <Route path="/kunde/analytics" element={<ClientAnalytics />} />
          <Route path="/client" element={<Navigate to="/kunde" replace />} />
          <Route path="/client/analyse" element={<Navigate to="/kunde/analyse" replace />} />
          <Route path="/client/innstillinger" element={<Navigate to="/kunde/innstillinger" replace />} />
          <Route path="/kunde/innstillinger" element={<ClientSettings />} />
          <Route path="/kunde/innstillinger/fakturering" element={<ClientSettings />} />
          <Route path="/kunde/innstillinger/billing" element={<ClientSettings />} />
          <Route path="/kunde/innstillinger/konto" element={<ClientSettings />} />
          <Route path="/kunde/tjenester/nettside/start" element={<ClientWebsiteStart />} />
          <Route path="/kunde/tjenester/nettside/planer" element={<ClientWebsitePlans />} />
          <Route path="/kunde/tjenester/nettside/checkout" element={<ClientWebsiteCheckout />} />
          <Route path="/1000kr" element={<Page1000kr />} />
          <Route path="/bli-ansatt" element={<BliAnsatt />} />
          <Route path="/personvern" element={<Personvern />} />
          <Route path="/vilkar" element={<Vilkar />} />
          <Route path="/databehandleravtale" element={<Databehandleravtale />} />
          <Route path="/informasjonskapsler" element={<Informasjonskapsler />} />
        </Routes>
      </Suspense>
      {!hideShell && <Footer />}
    </div>
  );
}

export default function App() {
  return (
    <Router>
      <EmployeeAuthProvider>
        <ClientAuthProvider>
          <ScrollToTop />
          <AppLayout />
        </ClientAuthProvider>
      </EmployeeAuthProvider>
    </Router>
  );
}
