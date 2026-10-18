import React, { useEffect, useState } from 'react';
import { ClientSitesSection } from './ClientSitesSection';
import { DevelopmentClientsSection } from './DevelopmentClientsSection';
import { SalesClientsSection } from './SalesClientsSection';
import { AdminBoardSection } from './AdminBoardSection';
import type { ManageClientsView, Site } from '../shared';

type Props = {
  /** Picked in the admin sidebar under Manage clients. */
  view: ManageClientsView;
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
  view,
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
  const [opened, setOpened] = useState(() => ({ ...EMPTY_OPENED, [view]: true }));
  const liveSites = sites.filter((site) => site.deliveryPhase !== 'development');

  useEffect(() => {
    setOpened((prev) => (prev[view] ? prev : { ...prev, [view]: true }));
  }, [view]);

  return (
    <div className={view === 'sales' || view === 'admin' || view === 'development' ? 'space-y-6' : 'max-w-6xl space-y-6'}>

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
          <SalesClientsSection active={view === 'sales'} />
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
