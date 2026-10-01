import React from 'react';
import {
  User,
  Box,
  Image as ImageIcon,
  FileText,
  ListChecks,
  Database,
  CreditCard,
  UserCircle2,
} from 'lucide-react';
import type { DataTab, SettingsSection } from './clientDataTypes';


const DATA_ITEMS: Array<{ id: DataTab; label: string; icon: typeof User }> = [
  { id: 'bedrifts_kort', label: 'Bedrifts kort', icon: User },
  { id: 'produkter', label: 'Produkter', icon: Box },
  { id: 'media', label: 'Media', icon: ImageIcon },
  { id: 'generell', label: 'Generell info', icon: FileText },
  { id: 'v2', label: 'Nettsidebygger v2-spørsmål', icon: ListChecks },
];

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: typeof Database }> = [
  { id: 'kundedata', label: 'Kundedata', icon: Database },
  { id: 'fakturering', label: 'Fakturering', icon: CreditCard },
  { id: 'konto', label: 'Konto', icon: UserCircle2 },
];

type Props = {
  section: SettingsSection;
  dataTab: DataTab;
  onSection: (section: SettingsSection) => void;
  onDataTab: (tab: DataTab) => void;
};

export function SettingsInnerNav({ section, dataTab, onSection, onDataTab }: Props) {
  return (
    <aside className="w-[260px] shrink-0 border-r border-gray-100 bg-gray-50/40 p-4 flex flex-col overflow-y-auto">
      <div className="px-3 py-2 text-[12px] font-semibold text-gray-400 uppercase tracking-wider">
        Innstillinger
      </div>
      <div className="flex flex-col gap-1">
        {SECTIONS.map((entry) => {
          const Icon = entry.icon;
          const active = section === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onSection(entry.id)}
              className={`flex items-center gap-3 p-3 rounded-2xl text-left transition-colors ${
                active ? 'bg-gray-200/80' : 'hover:bg-gray-50'
              }`}
            >
              <Icon className={`w-4 h-4 ${active ? 'text-[#121212]' : 'text-gray-500'}`} />
              <span className={`text-[13px] ${active ? 'font-medium text-[#121212]' : 'text-gray-500'}`}>
                {entry.label}
              </span>
            </button>
          );
        })}
      </div>

      {section === 'kundedata' ? (
        <>
          <div className="px-3 pt-6 pb-2 text-[12px] font-semibold text-gray-400 uppercase tracking-wider">
            Din bedrift
          </div>
          <div className="flex flex-col gap-1.5">
            {DATA_ITEMS.map((item) => {
              const Icon = item.icon;
              const selected = dataTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onDataTab(item.id)}
                  className={`flex items-center gap-3 p-3 rounded-2xl text-left transition-colors ${
                    selected ? 'bg-gray-200/80' : 'hover:bg-gray-50'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${selected ? 'text-[#121212]' : 'text-gray-500'}`} />
                  <span className={`text-[13px] ${selected ? 'font-medium text-[#121212]' : 'text-gray-500'}`}>
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </aside>
  );
}
