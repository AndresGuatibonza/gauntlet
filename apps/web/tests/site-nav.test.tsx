import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";

let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));

import { SiteNav, navItems } from "@/components/site-nav";

afterEach(() => {
  cleanup();
  pathname = "/";
});

describe("navItems", () => {
  it("offers Reports and Experiments only to signed-in users", () => {
    expect(navItems({ accountsEnabled: true, signedIn: true }).map((i) => i.href)).toEqual(["/", "/reports", "/ledger"]);
    expect(navItems({ accountsEnabled: true, signedIn: false }).map((i) => i.href)).toEqual(["/"]);
    expect(navItems({ accountsEnabled: false, signedIn: false }).map((i) => i.href)).toEqual(["/"]);
  });
});

describe("SiteNav", () => {
  it("marks the current area and offers sign-out when signed in", () => {
    pathname = "/reports";
    const { container, getAllByText } = render(<SiteNav accountsEnabled signedIn login="andres" />);
    const inline = container.querySelector(".site-nav-inline")!;
    const current = inline.querySelector('[aria-current="page"]')!;
    expect(current.textContent).toBe("Reports");
    expect(inline.querySelector('a[href="/ledger"]')!.textContent).toBe("Experiments");
    expect(getAllByText("Sign out")[0]!.closest("form")!.getAttribute("action")).toBe("/auth/signout");
  });

  it("offers sign-in that comes back to the current page", () => {
    pathname = "/scans/3f2a1c4e-9b7d-4e21-8a6f-0c5d2e7b9a10";
    const { getByText } = render(<SiteNav accountsEnabled signedIn={false} login={null} />);
    expect(getByText("Sign in").getAttribute("href")).toBe(`/signup?next=${encodeURIComponent(pathname)}`);
  });

  it("shows no account links when accounts are off", () => {
    const { queryByText } = render(<SiteNav accountsEnabled={false} signedIn={false} login={null} />);
    expect(queryByText("Sign in")).toBeNull();
    expect(queryByText("Sign out")).toBeNull();
  });

  it("opens the menu and closes it with Escape or a click outside", () => {
    const { getByRole, queryByRole, container } = render(
      <div>
        <SiteNav accountsEnabled signedIn login="andres" />
        <p>outside</p>
      </div>,
    );
    const toggle = getByRole("button", { name: "Menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("#site-nav-menu a[href='/reports']")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector("#site-nav-menu")).toBeNull();
    fireEvent.click(toggle);
    fireEvent.mouseDown(container.querySelector("p")!);
    expect(container.querySelector("#site-nav-menu")).toBeNull();
    expect(queryByRole("button", { name: "Menu" })).not.toBeNull();
  });
});
