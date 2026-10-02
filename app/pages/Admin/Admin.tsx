import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, ChevronDown, FileSignature, FileText, FolderCog, Globe, Image as ImageIcon, LogOut, Mail, Newspaper, Share2, ShoppingBag, Users, UserPlus } from 'lucide-react';
import { Helmet } from 'react-helmet-async';
import { ManageClientsSection } from './sections/ManageClientsSection';
import { PagesSection } from './sections/PagesSection';
import { UsersSection, displayPhone } from './sections/UsersSection';
import { EmployeesSection } from './sections/EmployeesSection';
import {
  API,
  DEFAULT_FEATURES,
  authHeaders,
  clearToken,
  getToken,
  setToken,
  type AdminUser,
  type ClientPaymentRequest,
  type EcommerceCatalogType,
  type EmployeeRoleOption,
  fromEmployeeRoleOption,
  type Features,
  type Site,
  type Tab,
  type WebsitePlanId,
  CATALOG_TYPE_OPTIONS,
  WEBSITE_PLAN_OPTIONS,
  featuresFromPlan,
} from './shared';

const EmailTemplateStudio = lazy(() =>
  import('../sales/EmailTemplateStudio').then((m) => ({ default: m.EmailTemplateStudio }))
);
const OfferReviewSection = lazy(() =>
  import('./sections/OfferReviewSection').then((m) => ({ default: m.OfferReviewSection }))
);
const MediaLibrarySection = lazy(() =>
  import('./sections/MediaLibrarySection').then((m) => ({ default: m.MediaLibrarySection }))
);

export const Admin = () => {
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [tab, setTab] = useState<Tab>('clients');
  const [websiteNavOpen, setWebsiteNavOpen] = useState(true);
  const [pendingOffers, setPendingOffers] = useState(0);
  const [features, setFeatures] = useState<Features>(DEFAULT_FEATURES);
  const [siteName, setSiteName] = useState('');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [userForm, setUserForm] = useState({ username: '', password: '', name: '', phone: '' });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPassword, setEditPassword] = useState('');
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changePasswordError, setChangePasswordError] = useState('');
  const [userRoleSaving, setUserRoleSaving] = useState<string | null>(null);
  const [savingUserId, setSavingUserId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flashNotice(kind: 'ok' | 'err', text: string) {
    setNotice({ kind, text });
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 7000);
  }
  const [sites, setSites] = useState<Site[]>([]);
  const [issuedLocalBlog, setIssuedLocalBlog] = useState<{ siteId: string; token: string } | null>(null);
  const [paymentRequests, setPaymentRequests] = useState<ClientPaymentRequest[]>([]);
  const [markingPaymentRequestId, setMarkingPaymentRequestId] = useState<string | null>(null);
  const [addSiteOpen, setAddSiteOpen] = useState(false);
  const [addSiteName, setAddSiteName] = useState('');
  const [addSiteDomain, setAddSiteDomain] = useState('');
  const [addSitePlan, setAddSitePlan] = useState<WebsitePlanId>('tier-1-standard');
  const [addSiteCatalogType, setAddSiteCatalogType] = useState<EcommerceCatalogType>('normal');
  const [addSiteGithubRepo, setAddSiteGithubRepo] = useState('');
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null);
  const [editSiteDomain, setEditSiteDomain] = useState('');
  const [editSiteName, setEditSiteName] = useState('');
  const [editSitePlan, setEditSitePlan] = useState<WebsitePlanId>('tier-1-standard');
  const [editSiteCatalogType, setEditSiteCatalogType] = useState<EcommerceCatalogType>('normal');
  const [editSiteGithubRepo, setEditSiteGithubRepo] = useState('');
  const [editSiteFeatures, setEditSiteFeatures] = useState<Features>({
    users: true,
    analytics: false,
    ecommerce: false,
    blog: false,
    socialSync: false,
    emailMarketing: false,
    general: false,
  });
  const [copyKey, setCopyKey] = useState<string | null>(null);
  const [clientAdminSiteId, setClientAdminSiteId] = useState<string | null>(null);
  const [clientAdminForm, setClientAdminForm] = useState({
    name: '',
    email: '',
    username: '',
    avatarUrl: '',
    password: '',
    createdAt: '',
    passwordSet: false,
  });

  const fetchUsers = useCallback(async () => {
    const res = await fetch(`${API}/admin/users`, { headers: authHeaders() });
    if (res.status === 401) {
      clearToken();
      setLoggedIn(false);
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    setUsers(Array.isArray(data) ? data : []);
  }, []);

  const fetchSites = useCallback(async () => {
    const res = await fetch(`${API}/hub/sites`, { headers: authHeaders() });
    if (res.status === 401) {
      clearToken();
      setLoggedIn(false);
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    setSites(Array.isArray(data) ? data : []);
  }, []);

  const fetchPaymentRequests = useCallback(async () => {
    const res = await fetch(`${API}/admin/client-payment-requests`, { headers: authHeaders() });
    if (res.status === 401) {
      clearToken();
      setLoggedIn(false);
      return;
    }
    if (!res.ok) return;
    const data = await res.json().catch(() => ({}));
    setPaymentRequests(Array.isArray(data?.requests) ? data.requests : []);
  }, []);

  useEffect(() => {
    fetch(`${API}/cms/config`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.features) setFeatures(data.features);
        if (data?.name) setSiteName(data.name);
      })
      .catch(() => setFeatures(DEFAULT_FEATURES));
  }, []);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoggedIn(false);
      return;
    }
    Promise.all([fetchUsers(), fetchSites(), fetchPaymentRequests()]).then(() => setLoggedIn(true)).catch(() => setLoggedIn(false));
  }, [fetchUsers, fetchSites, fetchPaymentRequests]);

  // Badge for the Tilbud tab: how many offers are waiting for admin review.
  useEffect(() => {
    if (!loggedIn) return undefined;
    let cancelled = false;
    const poll = () => {
      fetch(`${API}/admin/offers?status=review-requested`, { headers: authHeaders() })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { counts?: Record<string, number> } | null) => {
          if (!cancelled && data) setPendingOffers(Number(data.counts?.['review-requested']) || 0);
        })
        .catch(() => undefined);
    };
    poll();
    const timer = setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loggedIn, tab]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError('');
    setLoading(true);
    try {
      const res = await fetch(`${API}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoginError(data.message || 'Invalid credentials');
        return;
      }
      setToken(data.token);
      setLoggedIn(true);
      await Promise.all([fetchUsers(), fetchSites(), fetchPaymentRequests()]);
    } catch {
      setLoginError('Network error');
    } finally {
      setLoading(false);
    }
  }

  function handleLogout() {
    clearToken();
    setLoggedIn(false);
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    if (!userForm.username.trim() || !userForm.password) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/admin/users`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...userForm, role: 'none' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        flashNotice('err', data.message || 'Failed to create user');
        return;
      }
      setUserForm({ username: '', password: '', name: '', phone: '' });
      flashNotice('ok', `User ${data.username || userForm.username} created.`);
      await fetchUsers();
    } finally {
      setLoading(false);
    }
  }

  async function handleMarkPaymentRequestHandled(userId: string) {
    if (!userId) return;
    setMarkingPaymentRequestId(userId);
    try {
      const res = await fetch(`${API}/admin/client-payment-requests/${encodeURIComponent(userId)}/mark-handled`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        flashNotice('err', data.message || 'Failed to mark payment request as handled');
        return;
      }
      flashNotice('ok', 'Payment request marked as handled.');
      await fetchPaymentRequests();
    } finally {
      setMarkingPaymentRequestId(null);
    }
  }

  async function handleUserRoleChange(id: string, option: EmployeeRoleOption) {
    const { role, employeeProduct } = fromEmployeeRoleOption(option);
    setUserRoleSaving(id);
    try {
      const body: { role: string; employeeProduct?: string } = { role };
      if (employeeProduct) body.employeeProduct = employeeProduct;
      const res = await fetch(`${API}/admin/users/${id}`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        flashNotice('err', data.message || 'Could not change role');
        return;
      }
      flashNotice('ok', 'Role saved.');
      setUsers((prev) =>
        prev.map((user) => {
          if (user.id !== id) return user;
          if (role !== 'employee') return { ...user, role, employeeProduct: undefined };
          return { ...user, role, employeeProduct: employeeProduct ?? 'asoldi' };
        }),
      );
    } finally {
      setUserRoleSaving(null);
    }
  }

  async function handleUpdateUser(id: string, patch: { username?: string; password?: string; name?: string; phone?: string } = {}) {
    setSavingUserId(id);
    setLoading(true);
    try {
      const body: { username?: string; password?: string; name?: string; phone?: string } = {};
      if (patch.username !== undefined) body.username = patch.username;
      if (patch.password !== undefined && patch.password !== '') body.password = patch.password;
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.phone !== undefined) body.phone = patch.phone;
      const res = await fetch(`${API}/admin/users/${id}`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        flashNotice('err', data.message || 'Update failed — nothing was stored.');
        return;
      }
      setEditingId(null);
      setEditPassword('');
      await fetchUsers();
      const saved = data.user as AdminUser | undefined;
      if (patch.password) {
        flashNotice('ok', `Password saved for ${saved?.username || 'user'}.`);
      } else if (saved?.phone) {
        flashNotice('ok', `Saved ${saved.username}. Phone ${displayPhone(saved.phone)} is stored.`);
      } else {
        flashNotice('ok', `Saved ${saved?.username || 'user'}.`);
      }
    } finally {
      setSavingUserId(null);
      setLoading(false);
    }
  }

  async function handleDeleteUser(id: string) {
    if (!confirm('Delete this user? They will no longer be able to log in.')) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/admin/users/${id}`, { method: 'DELETE', headers: authHeaders() });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        flashNotice('err', data.message || 'Delete failed');
        return;
      }
      flashNotice('ok', 'User deleted.');
      await fetchUsers();
    } finally {
      setLoading(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setChangePasswordError('');
    const res = await fetch(`${API}/admin/change-password`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setChangePasswordError(data.message || 'Failed');
      flashNotice('err', data.message || 'Could not change password');
      return;
    }
    setChangePasswordOpen(false);
    setCurrentPassword('');
    setNewPassword('');
    flashNotice('ok', 'Your password was changed.');
  }

  async function handleAddSite(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch(`${API}/hub/sites`, {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: addSiteName || 'New site',
          domain: addSiteDomain.trim(),
          websitePlan: addSitePlan,
          ecommerceCatalogType: addSitePlan === 'tier-3-ecommerce' || addSitePlan === 'custom' ? addSiteCatalogType : undefined,
          githubRepo: addSiteGithubRepo.trim(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        flashNotice('err', data.message || 'Failed to add site');
        return;
      }
      flashNotice('ok', 'Site saved.');
      setAddSiteOpen(false);
      setAddSiteName('');
      setAddSiteDomain('');
      setAddSitePlan('tier-1-standard');
      setAddSiteCatalogType('normal');
      setAddSiteGithubRepo('');
      await fetchSites();
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdateSite(id: string) {
    setLoading(true);
    try {
      const res = await fetch(`${API}/hub/sites/${id}`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: editSiteDomain,
          name: editSiteName,
          websitePlan: editSitePlan,
          features: editSiteFeatures,
          ecommerceCatalogType: editSiteFeatures.ecommerce ? editSiteCatalogType : null,
          githubRepo: editSiteGithubRepo.trim(),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        flashNotice('err', data.message || 'Failed to save site');
        return;
      }
      flashNotice('ok', 'Site saved.');
      setEditingSiteId(null);
      await fetchSites();
    } finally {
      setLoading(false);
    }
  }

  async function handleIssueLocalBlogToken(site: Site) {
    if (site.localBlog?.tokenSet && !confirm('Replace the local blog token? The previous Hostinger value will stop working.')) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/hub/sites/${site.id}/local-blog-token`, {
        method: 'POST',
        headers: authHeaders(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        flashNotice('err', data.message || 'Failed to issue the local blog token');
        return;
      }
      setIssuedLocalBlog({ siteId: site.id, token: String(data.token || '') });
      flashNotice('ok', 'Local blog token issued. Copy it into this site’s Hostinger env. It is not shown again.');
      await fetchSites();
    } finally {
      setLoading(false);
    }
  }

  async function handleDeleteSite(id: string) {
    if (!confirm('Remove this site from the hub?')) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/hub/sites/${id}`, { method: 'DELETE', headers: authHeaders() });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        flashNotice('err', data.message || 'Failed to delete site');
        return;
      }
      flashNotice('ok', 'Site removed.');
      await fetchSites();
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveClientAdmin() {
    if (!clientAdminSiteId) return;
    setLoading(true);
    try {
      const featureRes = await fetch(`${API}/hub/sites/${clientAdminSiteId}`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: editSiteFeatures }),
      });
      if (!featureRes.ok) {
        const data = await featureRes.json().catch(() => ({}));
        flashNotice('err', data.message || 'Could not save services');
        return;
      }
      const res = await fetch(`${API}/hub/sites/${clientAdminSiteId}/client-admin`, {
        method: 'PUT',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: clientAdminForm.name,
          email: clientAdminForm.email,
          username: clientAdminForm.username,
          avatarUrl: clientAdminForm.avatarUrl,
          password: clientAdminForm.password || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        flashNotice('err', data.message || 'Could not save client admin');
        return;
      }
      flashNotice('ok', 'Client admin saved.');
      setClientAdminSiteId(null);
      setClientAdminForm((form) => ({ ...form, password: '' }));
      await fetchSites();
    } finally {
      setLoading(false);
    }
  }

  function copySiteKey(key: string) {
    navigator.clipboard.writeText(key);
    setCopyKey(key);
    setTimeout(() => setCopyKey(null), 2000);
  }

  if (loggedIn === null) {
    return <div className="staff-light min-h-screen bg-[#1e1e1e] flex items-center justify-center text-gray-400">Loading…</div>;
  }

  if (!loggedIn) {
    return (
      <>
        <Helmet><title>Admin Login – Asoldi</title><meta name="robots" content="noindex,nofollow" /></Helmet>
        <div className="staff-light min-h-screen bg-[#050505] flex items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-2xl bg-[#1a1a1a] border border-white/10 p-8">
            <h1 className="text-xl font-bold text-white mb-6">Admin</h1>
            <form onSubmit={handleLogin} className="space-y-4">
              <input type="text" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} className="w-full px-4 py-3 rounded-lg bg-[#0a0a0a] border border-white/20 text-white" required />
              <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full px-4 py-3 rounded-lg bg-[#0a0a0a] border border-white/20 text-white" required />
              {loginError && <p className="text-red-400 text-sm">{loginError}</p>}
              <button type="submit" disabled={loading} className="w-full py-3 rounded-lg font-medium text-white bg-[#FF5B00] hover:bg-[#e55200] disabled:opacity-50">
                {loading ? 'Logging in…' : 'Log in'}
              </button>
            </form>
            <p className="mt-4 text-center"><Link to="/" className="text-sm text-gray-400 hover:text-white">← Back to site</Link></p>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Helmet><title>Admin – Asoldi</title><meta name="robots" content="noindex,nofollow" /></Helmet>
      <div className="staff-light min-h-screen bg-[#1e1e1e] flex">
        <aside className="w-60 bg-[#23282d] text-white flex flex-col fixed inset-y-0 left-0">
          <div className="p-4 border-b border-white/10">
            <Link to="/" className="text-lg font-semibold text-white">{siteName || 'Admin'}</Link>
            <p className="text-xs text-gray-400 mt-1">Client CMS</p>
          </div>
          <nav className="flex-1 p-2 space-y-1">
            <SidebarButton active={tab === 'clients'} onClick={() => setTab('clients')} icon={<Globe size={18} />} label="Manage clients" />
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setWebsiteNavOpen((open) => !open)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-left text-xs font-semibold uppercase tracking-wide ${
                  tab === 'pages' || tab === 'media' || tab === 'users' ? 'text-white' : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                <span className="inline-flex items-center gap-2">
                  <FolderCog size={16} />
                  Manage website
                </span>
                <ChevronDown size={14} className={`transition-transform ${websiteNavOpen ? '' : '-rotate-90'}`} />
              </button>
              {websiteNavOpen && (
                <div className="ml-3 mt-1 space-y-1">
                  <SidebarButton active={tab === 'pages'} onClick={() => setTab('pages')} icon={<FileText size={18} />} label="Pages" />
                  <SidebarButton active={tab === 'media'} onClick={() => setTab('media')} icon={<ImageIcon size={18} />} label="Media" />
                  {features.users !== false && <SidebarButton active={tab === 'users'} onClick={() => setTab('users')} icon={<Users size={18} />} label="Users" />}
                </div>
              )}
            </div>
            <SidebarButton active={tab === 'employees'} onClick={() => setTab('employees')} icon={<UserPlus size={18} />} label="Employees" />
            {features.ecommerce && <SidebarButton active={tab === 'ecommerce'} onClick={() => setTab('ecommerce')} icon={<ShoppingBag size={18} />} label="Ecommerce" />}
            {features.blog && <SidebarButton active={tab === 'blog'} onClick={() => setTab('blog')} icon={<Newspaper size={18} />} label="Blog" />}
            <SidebarButton active={tab === 'email'} onClick={() => setTab('email')} icon={<Mail size={18} />} label="E-post" />
            <SidebarButton
              active={tab === 'offers'}
              onClick={() => setTab('offers')}
              icon={<FileSignature size={18} />}
              label={pendingOffers ? `Tilbud (${pendingOffers})` : 'Tilbud'}
            />
            {features.socialSync && <SidebarButton active={tab === 'social'} onClick={() => setTab('social')} icon={<Share2 size={18} />} label="Social sync" />}
            {features.analytics && <SidebarButton active={tab === 'analytics'} onClick={() => setTab('analytics')} icon={<BarChart3 size={18} />} label="Analytics" />}
          </nav>
          <div className="p-2 border-t border-white/10 space-y-1">
            <button onClick={() => setChangePasswordOpen(true)} className="w-full px-3 py-2 text-left text-sm text-gray-400 hover:text-white">Change my password</button>
            <button onClick={handleLogout} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-gray-400 hover:bg-white/10 hover:text-white">
              <LogOut size={18} /> Log out
            </button>
          </div>
        </aside>

        <main className="flex-1 ml-60 p-8">
          {notice && (
            <div
              role="status"
              className={`fixed top-4 right-4 z-[80] max-w-sm px-4 py-3 rounded-lg border text-sm shadow-lg ${
                notice.kind === 'ok'
                  ? 'bg-emerald-950 border-emerald-600 text-emerald-50'
                  : 'bg-red-950 border-red-600 text-red-50'
              }`}
            >
              {notice.text}
            </div>
          )}
          {tab === 'clients' && (
            <ManageClientsSection
              sites={sites}
              loading={loading}
              copyKey={copyKey}
              onAdd={() => setAddSiteOpen(true)}
              onEdit={(site) => {
                setEditingSiteId(site.id);
                setEditSiteDomain(site.domain);
                setEditSiteName(site.name);
                setEditSitePlan(site.websitePlan || 'tier-1-standard');
                setEditSiteCatalogType(site.ecommerceCatalogType || 'normal');
                setEditSiteGithubRepo(site.cms?.githubRepo || '');
                setEditSiteFeatures({
                  users: site.features.users !== false,
                  analytics: !!site.features.analytics,
                  ecommerce: !!site.features.ecommerce,
                  blog: !!site.features.blog,
                  socialSync: !!site.features.socialSync,
                  emailMarketing: !!site.features.emailMarketing,
                  general: !!site.features.general,
                });
              }}
              onDelete={handleDeleteSite}
              onCopyKey={copySiteKey}
              issuedLocalBlog={issuedLocalBlog}
              onIssueLocalBlogToken={handleIssueLocalBlogToken}
              onEditAdmin={(site) => {
                setClientAdminSiteId(site.id);
                setClientAdminForm({
                  name: site.clientAdmin?.name || '',
                  email: site.clientAdmin?.email || '',
                  username: site.clientAdmin?.username || '',
                  avatarUrl: site.clientAdmin?.avatarUrl || '',
                  password: '',
                  createdAt: site.clientAdmin?.createdAt || site.createdAt || '',
                  passwordSet: !!site.clientAdmin?.passwordSet,
                });
                setEditSiteFeatures({
                  users: site.features.users !== false,
                  analytics: !!site.features.analytics,
                  ecommerce: !!site.features.ecommerce,
                  blog: !!site.features.blog,
                  socialSync: !!site.features.socialSync,
                  emailMarketing: !!site.features.emailMarketing,
                  general: !!site.features.general,
                });
              }}
            />
          )}
          {tab === 'pages' && <PagesSection />}
          {tab === 'media' && (
            <Suspense fallback={<div className="text-sm text-gray-400">Loading media…</div>}>
              <MediaLibrarySection />
            </Suspense>
          )}
          {tab === 'users' && (
            <UsersSection
              users={users}
              loading={loading}
              paymentRequests={paymentRequests}
              handlingPaymentRequestId={markingPaymentRequestId}
              userForm={userForm}
              editingId={editingId}
              editPassword={editPassword}
              userRoleSaving={userRoleSaving}
              onUserFormChange={setUserForm}
              onAddUser={handleAddUser}
              onStartEdit={setEditingId}
              onEditPasswordChange={setEditPassword}
              onUpdateUser={handleUpdateUser}
              onDeleteUser={handleDeleteUser}
              onRoleChange={handleUserRoleChange}
              onMarkPaymentRequestHandled={handleMarkPaymentRequestHandled}
              savingUserId={savingUserId}
              notice={notice}
            />
          )}
          {tab === 'employees' && <EmployeesSection />}
          {tab === 'analytics' && <PlaceholderSection title="Analytics" description="Connect Google Analytics or Business Profile. Coming soon." />}
          {tab === 'ecommerce' && <PlaceholderSection title="Ecommerce" description="Asoldi’s own shop catalog. Client product catalogs are managed on each client domain’s /admin." />}
          {tab === 'blog' && <PlaceholderSection title="Blog" description="Write and publish posts from this CMS. Coming soon." />}
          {tab === 'email' && (
            <Suspense fallback={<p className="text-gray-400">Laster e-posteditor…</p>}>
              <EmailTemplateStudio embedded />
            </Suspense>
          )}
          {tab === 'offers' && (
            <Suspense fallback={<p className="text-gray-400">Laster tilbud…</p>}>
              <OfferReviewSection />
            </Suspense>
          )}
          {tab === 'social' && <PlaceholderSection title="Social sync" description="Reviews and social media sync. Coming soon." />}
        </main>
      </div>

      {addSiteOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#2a2a2a] rounded-xl border border-white/10 p-6 max-w-md w-full">
            <h2 className="text-lg font-semibold text-white mb-4">Add site</h2>
            <form onSubmit={handleAddSite} className="space-y-4">
              <input type="text" value={addSiteName} onChange={(e) => setAddSiteName(e.target.value)} placeholder="Site name" className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white" />
              <input type="text" value={addSiteDomain} onChange={(e) => setAddSiteDomain(e.target.value)} placeholder="Domain" className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white" />
              <div>
                <label className="block text-xs text-gray-400 mb-1">Website plan</label>
                <select
                  value={addSitePlan}
                  onChange={(e) => setAddSitePlan(e.target.value as WebsitePlanId)}
                  className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white"
                >
                  {WEBSITE_PLAN_OPTIONS.map((plan) => (
                    <option key={plan.id} value={plan.id}>{plan.name}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">Sets default CMS modules. You can change them after adding the site.</p>
              </div>
              {(addSitePlan === 'tier-3-ecommerce' || addSitePlan === 'custom') && (
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Ecommerce catalog type</label>
                  <select
                    value={addSiteCatalogType}
                    onChange={(e) => setAddSiteCatalogType(e.target.value as EcommerceCatalogType)}
                    className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white"
                  >
                    {CATALOG_TYPE_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{option.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <input type="text" value={addSiteGithubRepo} onChange={(e) => setAddSiteGithubRepo(e.target.value)} placeholder="GitHub repo (e.g. damianhch/website---mong-sushi)" className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white" />
              <div className="flex gap-2">
                <button type="submit" disabled={loading} className="px-4 py-2 rounded-lg bg-[#FF5B00] text-white font-medium disabled:opacity-50">Add</button>
                <button type="button" onClick={() => setAddSiteOpen(false)} className="px-4 py-2 rounded-lg bg-white/10 text-white">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editingSiteId && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#2a2a2a] rounded-xl border border-white/10 p-6 max-w-md w-full">
            <h2 className="text-lg font-semibold text-white mb-4">Edit site</h2>
            <div className="space-y-4">
              <input type="text" value={editSiteName} onChange={(e) => setEditSiteName(e.target.value)} className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white" />
              <input type="text" value={editSiteDomain} onChange={(e) => setEditSiteDomain(e.target.value)} className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white" />
              <div>
                <label className="block text-xs text-gray-400 mb-1">Website plan</label>
                <select
                  value={editSitePlan}
                  onChange={(e) => {
                    const plan = e.target.value as WebsitePlanId;
                    setEditSitePlan(plan);
                    setEditSiteFeatures(featuresFromPlan(plan));
                    if (plan === 'tier-3-ecommerce' && !editSiteCatalogType) setEditSiteCatalogType('normal');
                  }}
                  className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white"
                >
                  {WEBSITE_PLAN_OPTIONS.map((plan) => (
                    <option key={plan.id} value={plan.id}>{plan.name}</option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">Changing plan applies default modules. You can still toggle them below.</p>
              </div>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-white"><input type="checkbox" checked={!!editSiteFeatures.users} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, users: e.target.checked }))} /> Users</label>
                <label className="flex items-center gap-2 text-white"><input type="checkbox" checked={!!editSiteFeatures.analytics} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, analytics: e.target.checked }))} /> Analytics</label>
                <label className="flex items-center gap-2 text-white"><input type="checkbox" checked={!!editSiteFeatures.ecommerce} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, ecommerce: e.target.checked }))} /> Ecommerce</label>
                <label className="flex items-center gap-2 text-white"><input type="checkbox" checked={!!editSiteFeatures.blog} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, blog: e.target.checked }))} /> Blog</label>
                <label className="flex items-center gap-2 text-white"><input type="checkbox" checked={!!editSiteFeatures.socialSync} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, socialSync: e.target.checked }))} /> Social sync</label>
                <label className="flex items-center gap-2 text-white"><input type="checkbox" checked={!!editSiteFeatures.emailMarketing} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, emailMarketing: e.target.checked }))} /> Email marketing</label>
                <label className="flex items-center gap-2 text-white"><input type="checkbox" checked={!!editSiteFeatures.general} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, general: e.target.checked }))} /> General (users & more)</label>
              </div>
              {editSiteFeatures.ecommerce && (
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Ecommerce catalog type</label>
                  <select
                    value={editSiteCatalogType}
                    onChange={(e) => setEditSiteCatalogType(e.target.value as EcommerceCatalogType)}
                    className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white"
                  >
                    {CATALOG_TYPE_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{option.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <input type="text" value={editSiteGithubRepo} onChange={(e) => setEditSiteGithubRepo(e.target.value)} placeholder="GitHub repo for CMS updates" className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white" />
              <div className="flex gap-2">
                <button type="button" onClick={() => handleUpdateSite(editingSiteId)} disabled={loading} className="px-4 py-2 rounded-lg bg-[#FF5B00] text-white font-medium disabled:opacity-50">Save</button>
                <button type="button" onClick={() => setEditingSiteId(null)} className="px-4 py-2 rounded-lg bg-white/10 text-white">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {clientAdminSiteId && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#2a2a2a] rounded-xl border border-white/10 p-6 max-w-lg w-full max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-semibold text-white mb-1">Client admin user</h2>
            <p className="text-xs text-gray-400 mb-4">Name, email, CMS login, avatar, and which services this client has. A new password syncs to their Hostinger CMS on the next config heartbeat.</p>
            <div className="space-y-3">
              <input type="text" value={clientAdminForm.name} onChange={(e) => setClientAdminForm((f) => ({ ...f, name: e.target.value }))} placeholder="Admin name" className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white" />
              <input type="email" value={clientAdminForm.email} onChange={(e) => setClientAdminForm((f) => ({ ...f, email: e.target.value }))} placeholder="Email" className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white" />
              <input type="text" value={clientAdminForm.username} onChange={(e) => setClientAdminForm((f) => ({ ...f, username: e.target.value }))} placeholder="CMS username" className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white" />
              <input type="url" value={clientAdminForm.avatarUrl} onChange={(e) => setClientAdminForm((f) => ({ ...f, avatarUrl: e.target.value }))} placeholder="Avatar URL" className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white" />
              {clientAdminForm.avatarUrl && <img src={clientAdminForm.avatarUrl} alt="" className="h-16 w-16 rounded-full object-cover" />}
              <input type="password" value={clientAdminForm.password} onChange={(e) => setClientAdminForm((f) => ({ ...f, password: e.target.value }))} placeholder={clientAdminForm.passwordSet ? 'New CMS password (leave blank to keep)' : 'CMS password'} className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white" />
              <p className="text-xs text-gray-500">Created {clientAdminForm.createdAt ? new Date(clientAdminForm.createdAt).toLocaleString() : 'when first saved'}</p>
              <div className="flex flex-wrap gap-3 pt-2">
                <label className="flex items-center gap-2 text-white text-sm"><input type="checkbox" checked={!!editSiteFeatures.users} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, users: e.target.checked }))} /> Users</label>
                <label className="flex items-center gap-2 text-white text-sm"><input type="checkbox" checked={!!editSiteFeatures.analytics} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, analytics: e.target.checked }))} /> Analytics</label>
                <label className="flex items-center gap-2 text-white text-sm"><input type="checkbox" checked={!!editSiteFeatures.ecommerce} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, ecommerce: e.target.checked }))} /> Ecommerce</label>
                <label className="flex items-center gap-2 text-white text-sm"><input type="checkbox" checked={!!editSiteFeatures.blog} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, blog: e.target.checked }))} /> Blog</label>
                <label className="flex items-center gap-2 text-white text-sm"><input type="checkbox" checked={!!editSiteFeatures.socialSync} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, socialSync: e.target.checked }))} /> Social</label>
                <label className="flex items-center gap-2 text-white text-sm"><input type="checkbox" checked={!!editSiteFeatures.emailMarketing} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, emailMarketing: e.target.checked }))} /> Email</label>
                <label className="flex items-center gap-2 text-white text-sm"><input type="checkbox" checked={!!editSiteFeatures.general} onChange={(e) => setEditSiteFeatures((prev) => ({ ...prev, general: e.target.checked }))} /> General</label>
              </div>
              <div className="flex gap-2 pt-2">
                <button type="button" onClick={handleSaveClientAdmin} disabled={loading} className="px-4 py-2 rounded-lg bg-[#FF5B00] text-white font-medium disabled:opacity-50">Save</button>
                <button type="button" onClick={() => setClientAdminSiteId(null)} className="px-4 py-2 rounded-lg bg-white/10 text-white">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {changePasswordOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-[#2a2a2a] rounded-xl border border-white/10 p-6 max-w-sm w-full">
            <h2 className="text-lg font-semibold text-white mb-4">Change my password</h2>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <input type="password" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white" required />
              <input type="password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="w-full px-4 py-2 rounded-lg bg-[#1a1a1a] border border-white/20 text-white" required />
              {changePasswordError && <p className="text-red-400 text-sm">{changePasswordError}</p>}
              <div className="flex gap-2">
                <button type="submit" className="px-4 py-2 rounded-lg bg-[#FF5B00] text-white font-medium">Save</button>
                <button type="button" onClick={() => setChangePasswordOpen(false)} className="px-4 py-2 rounded-lg bg-white/10 text-white">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
};

function SidebarButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left text-sm font-medium transition-colors ${active ? 'bg-[#FF5B00] text-white' : 'text-gray-300 hover:bg-white/10'}`}
    >
      {icon}
      {label}
    </button>
  );
}

function PlaceholderSection({ title, description }: { title: string; description: string }) {
  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold text-white mb-6">{title}</h1>
      <p className="text-gray-400">{description}</p>
    </div>
  );
}
