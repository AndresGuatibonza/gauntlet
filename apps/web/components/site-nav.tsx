"use client";

/**
 * The header's way around the site, so no area needs the Back button:
 * New scan, Reports and Experiments (signed in), and Sign in / Sign out.
 * The current area is marked (aria-current). On narrow screens the same
 * links fold into a "Menu" button that opens a panel; it closes on
 * navigation, Escape, or a click outside.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SiteNavProps {
  /** Supabase Auth is configured; without it there are no accounts to link to. */
  accountsEnabled: boolean;
  signedIn: boolean;
  login: string | null;
}

interface NavItem {
  href: string;
  label: string;
  /** Whether the current path belongs to this area. */
  matches: (path: string) => boolean;
}

export function navItems({ accountsEnabled, signedIn }: Pick<SiteNavProps, "accountsEnabled" | "signedIn">): NavItem[] {
  const items: NavItem[] = [{ href: "/", label: "New scan", matches: (p) => p === "/" }];
  if (accountsEnabled && signedIn) {
    items.push(
      { href: "/reports", label: "Reports", matches: (p) => p.startsWith("/reports") },
      { href: "/ledger", label: "Experiments", matches: (p) => p.startsWith("/ledger") },
    );
  }
  return items;
}

export function SiteNav({ accountsEnabled, signedIn, login }: SiteNavProps): React.JSX.Element {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const items = navItems({ accountsEnabled, signedIn });

  // Close on navigation.
  useEffect(() => setOpen(false), [pathname]);

  // Close on Escape or a click outside the menu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const links = items.map((item) => (
    <Link
      key={item.href}
      href={item.href}
      className="site-nav-link"
      aria-current={item.matches(pathname) ? "page" : undefined}
      onClick={() => setOpen(false)}
    >
      {item.label}
    </Link>
  ));

  const account = !accountsEnabled ? null : signedIn ? (
    <form action="/auth/signout" method="post" className="site-nav-account">
      <button type="submit" className="account-signout" title={login ? `Signed in as @${login}` : "Signed in"}>
        Sign out
      </button>
    </form>
  ) : (
    <Link
      href={`/signup?next=${encodeURIComponent(pathname)}`}
      className="site-nav-link site-nav-account"
      aria-current={pathname.startsWith("/signup") ? "page" : undefined}
    >
      Sign in
    </Link>
  );

  return (
    <div className="site-nav" ref={panel}>
      <nav className="site-nav-inline" aria-label="Main">
        {links}
        {account}
      </nav>
      <button
        type="button"
        className="site-nav-toggle"
        aria-expanded={open}
        aria-controls="site-nav-menu"
        onClick={() => setOpen((o) => !o)}
      >
        Menu
      </button>
      {open && (
        <nav id="site-nav-menu" className="site-nav-menu" aria-label="Main">
          {links}
          {account}
        </nav>
      )}
    </div>
  );
}
