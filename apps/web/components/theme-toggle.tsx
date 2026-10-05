"use client";

/**
 * Light/dark switch for the site header.
 *
 * Light is the default for everyone (whatever the OS prefers). Clicking sets
 * data-theme="light" | "dark" on <html> -- matching the token blocks in
 * app/globals.css -- and stores the choice, so it survives reloads. The
 * stored choice is applied before first paint by THEME_BOOT_SCRIPT (inlined
 * in app/layout.tsx), so a returning visitor never sees a flash of the
 * other theme. Until it has read the real theme after mount, the switch
 * renders its track without a thumb, so server and client markup match and
 * nothing jumps.
 *
 * Storage can be unavailable (private windows, blocked site data): every
 * access is wrapped, and the switch still works for the current page view.
 */
import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "gauntlet-theme";

/** Runs in <head> before paint; keep it tiny, dependency-free and ES5. */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export function readStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function storeTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Not persisted; the choice still applies to this page view.
  }
}

/** The theme on screen: dark only when chosen, light otherwise. */
export function currentTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function ThemeToggle(): React.JSX.Element {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(currentTheme());
  }, []);

  function toggle(): void {
    const next: Theme = (theme ?? currentTheme()) === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    storeTheme(next);
    setTheme(next);
  }

  const isDark = theme === "dark";
  return (
    <button
      type="button"
      role="switch"
      className="theme-toggle"
      aria-checked={isDark}
      aria-label="Dark mode"
      title={theme === null ? undefined : isDark ? "Switch to light theme" : "Switch to dark theme"}
      data-ready={theme !== null}
      onClick={toggle}
    >
      <span className="theme-toggle-track" aria-hidden="true">
        <SunIcon />
        <MoonIcon />
        <span className="theme-toggle-thumb" />
      </span>
    </button>
  );
}

function SunIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="4" fill="none" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" />
    </svg>
  );
}
