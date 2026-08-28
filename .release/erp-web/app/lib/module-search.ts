import type { ModuleId } from './erp-types';

export interface ModuleSearchEntry {
  id: ModuleId;
  label: string;
  shortLabel: string;
}

export function normalizeModuleSearchQuery(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR');
}

export function filterModuleSearchEntries<T extends ModuleSearchEntry>(modules: T[], query: string) {
  const normalizedQuery = normalizeModuleSearchQuery(query);
  if (!normalizedQuery) return modules;

  const tokens = normalizedQuery.split(' ');
  return modules.filter((module) => {
    const searchableText = normalizeModuleSearchQuery(`${module.label} ${module.shortLabel}`);
    return tokens.every((token) => searchableText.includes(token));
  });
}

export function shouldIgnoreModuleSearchKey(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>) {
  return event.isComposing || event.keyCode === 229;
}
