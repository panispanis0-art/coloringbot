import { parseTemplate, type Template } from '@shared';
import { kv } from './db';

export interface Settings {
  author: string;
  creator: string;
  producer: string;
  titleFromJobName: boolean;
  stripXmp: boolean;
  updateDates: boolean;
  /** export templates with the target form inside (needed by the bot) */
  exportWithForm: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  author: 'Alex',
  creator: '',
  producer: '',
  titleFromJobName: false,
  stripXmp: true,
  updateDates: true,
  exportWithForm: true,
};

const SETTINGS_KEY = 'pdf-job-filler.settings';

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export async function listTemplates(): Promise<Template[]> {
  const list = (await kv.get<Template[]>('templates')) ?? [];
  return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function saveTemplate(t: Template): Promise<void> {
  const list = (await kv.get<Template[]>('templates')) ?? [];
  const i = list.findIndex((x) => x.id === t.id);
  const next = { ...t, updatedAt: new Date().toISOString() };
  if (i >= 0) list[i] = next;
  else list.push(next);
  await kv.set('templates', list);
  if (!(await getActiveId())) await setActiveId(t.id);
}

export async function deleteTemplate(id: string): Promise<void> {
  const list = ((await kv.get<Template[]>('templates')) ?? []).filter((t) => t.id !== id);
  await kv.set('templates', list);
  if ((await getActiveId()) === id) await setActiveId(list[0]?.id ?? '');
}

export async function importTemplateJson(json: string): Promise<Template> {
  const t = parseTemplate(json);
  const list = (await kv.get<Template[]>('templates')) ?? [];
  // importing the same template again replaces it
  const i = list.findIndex((x) => x.id === t.id);
  if (i >= 0) list[i] = t;
  else list.push(t);
  await kv.set('templates', list);
  if (!(await getActiveId())) await setActiveId(t.id);
  return t;
}

export const getActiveId = () => kv.get<string>('activeTemplateId');
export const setActiveId = (id: string) => kv.set('activeTemplateId', id);

export const getFont = () => kv.get<{ name: string; bytes: Uint8Array }>('font');
export const setFont = (f: { name: string; bytes: Uint8Array } | undefined) => (f ? kv.set('font', f) : kv.del('font'));
