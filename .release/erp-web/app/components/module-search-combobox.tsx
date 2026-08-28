'use client';

import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Search, type LucideIcon } from 'lucide-react';
import type { ModuleId } from '../lib/erp-types';
import { filterModuleSearchEntries, shouldIgnoreModuleSearchKey } from '../lib/module-search';

export interface ModuleSearchOption {
  id: ModuleId;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
}

interface ModuleSearchComboboxProps {
  modules: ModuleSearchOption[];
  activeModule: ModuleId;
  disabled?: boolean;
  onSelect: (id: ModuleId) => void;
}

export function ModuleSearchCombobox({
  modules,
  activeModule,
  disabled = false,
  onSelect,
}: ModuleSearchComboboxProps) {
  const generatedId = useId();
  const inputId = `${generatedId}-input`;
  const popupId = `${generatedId}-popup`;
  const listboxId = `${generatedId}-listbox`;
  const statusId = `${generatedId}-status`;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [searchContextModule, setSearchContextModule] = useState(activeModule);

  if (searchContextModule !== activeModule) {
    setSearchContextModule(activeModule);
    setQuery('');
    setOpen(false);
    setHighlightedIndex(-1);
  }

  const filteredModules = useMemo(
    () => filterModuleSearchEntries(modules, query),
    [modules, query],
  );
  const popupVisible = open && !disabled;
  const optionIds = useMemo(
    () => filteredModules.map((module) => `${generatedId}-option-${module.id}`),
    [filteredModules, generatedId],
  );
  const activeDescendant = popupVisible && highlightedIndex >= 0
    ? optionIds[highlightedIndex]
    : undefined;

  useEffect(() => {
    if (highlightedIndex < 0) return;
    document.getElementById(optionIds[highlightedIndex] ?? '')?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, optionIds]);

  function openMenuResults() {
    if (disabled) return;
    setOpen(true);
    setHighlightedIndex((current) => {
      if (current >= 0 && current < filteredModules.length) return current;
      const activeIndex = filteredModules.findIndex((module) => module.id === activeModule);
      return activeIndex >= 0 ? activeIndex : filteredModules.length > 0 ? 0 : -1;
    });
  }

  function selectModule(id: ModuleId) {
    if (disabled) return;
    setQuery('');
    setOpen(false);
    setHighlightedIndex(-1);
    onSelect(id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (shouldIgnoreModuleSearchKey(event.nativeEvent)) return;
    if (event.key === 'Escape') {
      if (!open && !query) return;
      event.preventDefault();
      setQuery('');
      setOpen(false);
      setHighlightedIndex(-1);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      setHighlightedIndex(-1);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        openMenuResults();
        return;
      }
      if (filteredModules.length === 0) return;
      setHighlightedIndex((current) => {
        if (event.key === 'ArrowDown') return current < 0 ? 0 : (current + 1) % filteredModules.length;
        return current < 0 ? filteredModules.length - 1 : (current - 1 + filteredModules.length) % filteredModules.length;
      });
      return;
    }
    if (!open || filteredModules.length === 0) return;
    if (event.key === 'Home') {
      event.preventDefault();
      setHighlightedIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setHighlightedIndex(filteredModules.length - 1);
    } else if (event.key === 'Enter' && highlightedIndex >= 0) {
      event.preventDefault();
      selectModule(filteredModules[highlightedIndex].id);
    }
  }

  return (
    <div className="relative w-full">
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-[var(--ss-text-muted)]" size={17} />
      <label className="sr-only" htmlFor={inputId}>메뉴 검색 및 이동</label>
      <input
        id={inputId}
        type="search"
        role="combobox"
        value={query}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={popupVisible}
        aria-controls={popupVisible ? listboxId : undefined}
        aria-activedescendant={activeDescendant}
        aria-describedby={popupVisible ? statusId : undefined}
        placeholder="메뉴 검색 또는 선택"
        onFocus={openMenuResults}
        onBlur={() => {
          window.setTimeout(() => {
            if (!document.getElementById(popupId)?.contains(document.activeElement)) {
              setOpen(false);
              setHighlightedIndex(-1);
            }
          }, 0);
        }}
        onChange={(event) => {
          const nextQuery = event.target.value;
          const nextModules = filterModuleSearchEntries(modules, nextQuery);
          setQuery(nextQuery);
          setOpen(true);
          setHighlightedIndex(nextModules.length > 0 ? 0 : -1);
        }}
        onKeyDown={handleKeyDown}
        className="star-control w-full bg-[var(--ss-surface-subtle)] pl-10 pr-3 text-sm"
      />

      {popupVisible ? (
        <div
          id={popupId}
          className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-[var(--ss-radius-lg)] border border-[var(--ss-border-strong)] bg-[var(--ss-surface)] shadow-[var(--ss-shadow-lg)]"
        >
          <p id={statusId} role="status" aria-live="polite" className="border-b border-[var(--ss-border)] bg-[var(--ss-surface-subtle)] px-3 py-2 text-xs font-semibold text-[var(--ss-text-subtle)]">
            {filteredModules.length > 0
              ? `이동할 메뉴 ${filteredModules.length.toLocaleString('ko-KR')}개`
              : '일치하는 메뉴가 없습니다'}
          </p>
          <ul
            id={listboxId}
            role="listbox"
            aria-label="이동할 ERP 메뉴"
            className={filteredModules.length > 0
              ? 'max-h-80 overflow-y-auto overscroll-contain p-1'
              : 'm-0 h-0 list-none overflow-hidden p-0'}
          >
            {filteredModules.map((module, index) => {
              const Icon = module.icon;
              const highlighted = highlightedIndex === index;
              const active = module.id === activeModule;
              return (
                <li key={module.id} role="presentation">
                  <button
                    id={optionIds[index]}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={highlighted}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => selectModule(module.id)}
                    className={`flex min-h-11 w-full items-center gap-3 rounded-[var(--ss-radius-md)] px-3 py-2.5 text-left transition ${
                      highlighted
                        ? 'bg-[var(--ss-brand-soft)] text-[var(--ss-text)]'
                        : 'bg-[var(--ss-surface)] text-[var(--ss-text)] hover:bg-[var(--ss-surface-hover)]'
                    }`}
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--ss-radius-sm)] bg-[var(--ss-surface-subtle)] text-[var(--ss-text-soft)]">
                      <Icon aria-hidden="true" size={17} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-bold">{module.label}</span>
                      <span className="block truncate text-xs text-[var(--ss-text-muted)]">{module.shortLabel}</span>
                    </span>
                    {active ? (
                      <span className="shrink-0 rounded-full bg-[var(--ss-surface)] px-2 py-1 text-[10px] font-bold text-[var(--ss-text-subtle)]">현재 메뉴</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {filteredModules.length === 0 ? (
            <p className="px-4 py-4 text-sm font-semibold text-[var(--ss-text-subtle)]">다른 메뉴 이름을 입력해 주세요.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
