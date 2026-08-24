'use client';

import { useEffect, useState } from 'react';

const storageKey = 'starsnap-theme';

const applyTheme = (dark: boolean) => {
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute('content', dark ? '#121722' : '#f6f7fb');
};

export default function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const active = document.documentElement.classList.contains('dark');
    applyTheme(active);
    const frame = requestAnimationFrame(() => setDark(active));

    return () => cancelAnimationFrame(frame);
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    applyTheme(next);
    localStorage.setItem(storageKey, next ? 'dark' : 'light');
  };

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggleTheme}
      aria-label={dark ? '라이트 모드로 전환' : '다크 모드로 전환'}
      title={dark ? '라이트 모드' : '다크 모드'}
    >
      <span aria-hidden="true">{dark ? '☀' : '☾'}</span>
    </button>
  );
}
