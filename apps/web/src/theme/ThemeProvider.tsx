import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';
export type Accent = 'teal' | 'indigo';

interface ThemeValue {
  theme: Theme;
  accent: Accent;
  setTheme: (t: Theme) => void;
  setAccent: (a: Accent) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);
const KEY = 'resolvekit.theme';

function readStored(): { theme: Theme; accent: Accent } {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const v = JSON.parse(raw) as { theme?: unknown; accent?: unknown };
      return { theme: v.theme === 'dark' ? 'dark' : 'light', accent: v.accent === 'indigo' ? 'indigo' : 'teal' };
    }
  } catch {
    // Storage unavailable: fall back to the defaults.
  }
  return { theme: 'light', accent: 'teal' };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(() => (typeof window === 'undefined' ? { theme: 'light' as Theme, accent: 'teal' as Accent } : readStored()));

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = state.theme;
    root.dataset.accent = state.accent;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Not persisted; the choice still applies for this session.
    }
  }, [state]);

  const value = useMemo<ThemeValue>(
    () => ({
      ...state,
      setTheme: (theme) => setState((s) => ({ ...s, theme })),
      setAccent: (accent) => setState((s) => ({ ...s, accent })),
    }),
    [state],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error('useTheme must be used inside ThemeProvider');
  return v;
}
