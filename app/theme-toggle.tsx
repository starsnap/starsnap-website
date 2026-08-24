'use client';

import { useEffect } from 'react';

type ColorTheme = 'light' | 'dark';

const storageKey = 'starsnap-theme';

const getStoredTheme = (): ColorTheme | null => {
  try {
    const stored = localStorage.getItem(storageKey);
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
};

const getSystemTheme = (): ColorTheme =>
  matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

const applyTheme = (theme: ColorTheme) => {
  const dark = theme === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute('content', dark ? '#121722' : '#f6f7fb');
};

export default function ThemeToggle() {
  useEffect(() => {
    const mediaQuery = matchMedia('(prefers-color-scheme: dark)');
    const handleSystemChange = () => {
      if (!getStoredTheme()) applyTheme(getSystemTheme());
    };
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      applyTheme(getStoredTheme() ?? getSystemTheme());
    };

    mediaQuery.addEventListener('change', handleSystemChange);
    window.addEventListener('storage', handleStorage);

    return () => {
      mediaQuery.removeEventListener('change', handleSystemChange);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const toggleTheme = () => {
    const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
    applyTheme(next);

    try {
      localStorage.setItem(storageKey, next);
    } catch {
      // The visual theme still changes when browser storage is unavailable.
    }
  };

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggleTheme}
      aria-label="색상 테마 전환"
      title="색상 테마 전환"
    >
      <span className="theme-icon-dark" aria-hidden="true">☾</span>
      <span className="theme-icon-light" aria-hidden="true">☀</span>
    </button>
  );
}
