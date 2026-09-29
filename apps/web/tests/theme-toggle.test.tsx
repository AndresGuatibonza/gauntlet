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
  it("starts from the OS theme when there is no stored choice", () => {
    installMatchMedia(false);
    const { getByRole } = render(<ThemeToggle />);
    const toggle = getByRole("switch", { name: "Dark mode" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("data-ready")).toBe("true");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("switches theme on click, sets data-theme and remembers the choice", () => {
    installMatchMedia(true);
    const { getByRole } = render(<ThemeToggle />);
    const toggle = getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(readStoredTheme()).toBe("dark");
  });

  it("follows OS changes until the visitor makes an explicit choice", () => {
    const os = installMatchMedia(true);
    const { getByRole } = render(<ThemeToggle />);
    const toggle = getByRole("switch");

    act(() => os.setDark(false));
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle); // explicit: dark
    act(() => os.setDark(false));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("still switches when storage is blocked", () => {
    installMatchMedia(true);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { getByRole } = render(<ThemeToggle />);
    expect(() => fireEvent.click(getByRole("switch"))).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(readStoredTheme()).toBeNull();
  });
});

describe("THEME_BOOT_SCRIPT", () => {
  const boot = (): void => new Function(THEME_BOOT_SCRIPT)();

  it("applies a stored choice before React renders", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    boot();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("leaves the OS in charge when nothing (or garbage) is stored", () => {
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
