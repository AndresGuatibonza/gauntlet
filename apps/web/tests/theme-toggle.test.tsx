import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { THEME_BOOT_SCRIPT, THEME_STORAGE_KEY, ThemeToggle, readStoredTheme } from "@/components/theme-toggle";

type Listener = () => void;

/** jsdom has no matchMedia; this fake lets a test flip the OS theme. */
function installMatchMedia(prefersDark: boolean): { setDark: (dark: boolean) => void } {
  let dark = prefersDark;
  const listeners = new Set<Listener>();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() {
      return query.includes("dark") ? dark : !dark;
    },
    media: query,
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  })) as unknown as typeof window.matchMedia;
  return {
    setDark(next) {
      dark = next;
      listeners.forEach((fn) => fn());
    },
  };
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThemeToggle", () => {
  it("starts light when there is no stored choice, even on a dark OS", () => {
    installMatchMedia(true);
    const { getByRole } = render(<ThemeToggle />);
    const toggle = getByRole("switch", { name: "Dark mode" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("data-ready")).toBe("true");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("switches theme on click, sets data-theme and remembers the choice", () => {
    const { getByRole } = render(<ThemeToggle />);
    const toggle = getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(readStoredTheme()).toBe("light");
  });

  it("shows a stored dark choice (applied before paint) as on", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const { getByRole } = render(<ThemeToggle />);
    expect(getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });

  it("ignores OS changes", () => {
    const os = installMatchMedia(false);
    const { getByRole } = render(<ThemeToggle />);
    act(() => os.setDark(true));
    expect(getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("still switches when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { getByRole } = render(<ThemeToggle />);
    expect(() => fireEvent.click(getByRole("switch"))).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(readStoredTheme()).toBeNull();
  });
});

describe("THEME_BOOT_SCRIPT", () => {
  const boot = (): void => new Function(THEME_BOOT_SCRIPT)();

  it("applies a stored choice before React renders", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    boot();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("leaves the default (light) when nothing (or garbage) is stored", () => {
    boot();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "purple");
    boot();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("never throws when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(boot).not.toThrow();
  });
});
