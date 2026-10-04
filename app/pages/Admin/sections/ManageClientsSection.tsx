import React, { useEffect, useState } from 'react';
import { ClientSitesSection } from './ClientSitesSection';
import { DevelopmentClientsSection } from './DevelopmentClientsSection';
import { SalesClientsSection } from './SalesClientsSection';
import { AdminBoardSection } from './AdminBoardSection';
import type { ManageClientsView, Site } from '../shared';

type Props = {
  sites: Site[];
  loading: boolean;
  copyKey: string | null;
  onAdd: () => void;
  onEdit: (site: Site) => void;
  onEditAdmin?: (site: Site) => void;
  onDelete: (id: string) => void;
  onCopyKey: (key: string) => void;
  issuedLocalBlog?: { siteId: string; token: string } | null;
  onIssueLocalBlogToken?: (site: Site) => void;
};

const EMPTY_OPENED: Record<ManageClientsView, boolean> = {
  clients: true,
  development: false,
  sales: false,
  admin: false,
};

export function ManageClientsSection({
  sites,
  loading,
  copyKey,
  onAdd,
  onEdit,
  onEditAdmin,
  onDelete,
  onCopyKey,
  issuedLocalBlog = null,
  onIssueLocalBlogToken,
}: Props) {
  const [view, setView] = useState<ManageClientsView>('clients');
  const [opened, setOpened] = useState(EMPTY_OPENED);
  const liveSites = sites.filter((site) => site.deliveryPhase !== 'development');

  useEffect(() => {
    setOpened((prev) => (prev[view] ? prev : { ...prev, [view]: true }));
  }, [view]);

  return (
    <div className={view === 'sales' || view === 'admin' || view === 'development' ? 'space-y-6' : 'max-w-6xl space-y-6'}>
      <div>
        <h1 className="text-2xl font-bold text-white mb-2">Manage clients</h1>
        <p className="text-gray-400 text-sm">
          Track live hub clients, websites in development, and sales prospects. Admin is the workshop desk for damian@asoldi.com. Development is the sales-win list. The list under it is before the contract and only shows Klar for preview. Development shows Klar for deployment, Iterasjon ferdig, and Publish.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setView('clients')}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${view === 'clients' ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-gray-300 hover:bg-white/15'}`}
        >
          Clients
        </button>
        <button
          type="button"
          onClick={() => setView('development')}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${view === 'development' ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-gray-300 hover:bg-white/15'}`}
        >
          Development
        </button>
        <button
          type="button"
          onClick={() => setView('sales')}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${view === 'sales' ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-gray-300 hover:bg-white/15'}`}
        >
          Sales
        </button>
        <button
          type="button"
          onClick={() => setView('admin')}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${view === 'admin' ? 'bg-[#FF5B00] text-white' : 'bg-white/10 text-gray-300 hover:bg-white/15'}`}
        >
          Admin
        </button>
      </div>

      {opened.clients ? (
        <div className={view === 'clients' ? '' : 'hidden'} hidden={view !== 'clients'}>
          <ClientSitesSection
            sites={liveSites}
            loading={loading}
            copyKey={copyKey}
            onAdd={onAdd}
            onEdit={onEdit}
            onEditAdmin={onEditAdmin}
            onDelete={onDelete}
            onCopyKey={onCopyKey}
            issuedLocalBlog={issuedLocalBlog}
            onIssueLocalBlogToken={onIssueLocalBlogToken}
            hideHeader
          />
        </div>
      ) : null}
      {opened.development ? (
        <div className={view === 'development' ? '' : 'hidden'} hidden={view !== 'development'}>
          <DevelopmentClientsSection hideHeader />
        </div>
      ) : null}
      {opened.sales ? (
        <div className={view === 'sales' ? '' : 'hidden'} hidden={view !== 'sales'}>
          <SalesClientsSection
            active={view === 'sales'}
            onMovedToDevelopment={() => setView('development')}
          />
        </div>
      ) : null}
      {opened.admin ? (
        <div className={view === 'admin' ? '' : 'hidden'} hidden={view !== 'admin'}>
          <AdminBoardSection />
        </div>
      ) : null}
    </div>
  );
}
