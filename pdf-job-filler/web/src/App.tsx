import { useCallback, useEffect, useState } from 'react';
import type { Template } from '@shared';
import { getActiveId, listTemplates, setActiveId } from '@/lib/store';
import { RunPage } from '@/pages/RunPage';
import { SetupPage } from '@/pages/SetupPage';
import { TemplatesPage } from '@/pages/TemplatesPage';
import { SettingsPage } from '@/pages/SettingsPage';

type Tab = 'run' | 'setup' | 'templates' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'run', label: 'Run' },
  { id: 'setup', label: 'Setup' },
  { id: 'templates', label: 'Templates' },
  { id: 'settings', label: 'Settings' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('run');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [activeId, setActive] = useState<string>();
  const [editing, setEditing] = useState<Template>();
  const [setupKey, setSetupKey] = useState(0);

  const refresh = useCallback(async () => {
    setTemplates(await listTemplates());
    setActive(await getActiveId());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const makeActive = async (id: string) => {
    await setActiveId(id);
    setActive(id);
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>PDF Job Filler</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'active' : ''}
              onClick={() => {
                if (t.id === 'setup' && tab !== 'setup') {
                  // a fresh Setup unless we came from "Edit"
                  setEditing(undefined);
                  setSetupKey((k) => k + 1);
                }
                setTab(t.id);
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {tab === 'run' && (
          <RunPage templates={templates} activeId={activeId} onActive={makeActive} goSetup={() => setTab('setup')} />
        )}
        {tab === 'setup' && (
          <SetupPage
            key={setupKey}
            editing={editing}
            onSaved={async (t) => {
              await refresh();
              setEditing(t);
            }}
          />
        )}
        {tab === 'templates' && (
          <TemplatesPage
            templates={templates}
            activeId={activeId}
            onActive={makeActive}
            onChanged={refresh}
            onEdit={(t) => {
              setEditing(t);
              setSetupKey((k) => k + 1);
              setTab('setup');
            }}
          />
        )}
        {tab === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}
