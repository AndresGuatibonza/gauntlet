import type { Metadata } from "next";
import Link from "next/link";
import { THEME_BOOT_SCRIPT, ThemeToggle } from "@/components/theme-toggle";
import { AccountNav } from "@/components/account-nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gauntlet",
  description: "Point Gauntlet at a public product URL and get ranked, evidence-backed improvement opportunities -- no account required.",
};

// Loaded via a plain <link> (fetched by the browser) rather than
// next/font/google (which fetches during `next build`/`next dev` through
// Node itself -- on a machine behind corporate TLS-inspecting endpoint
// security, that's one more thing routed through the exact certificate
// trust problem documented at length in the README, for a page font that
// isn't worth that risk). Fraunces is the display serif for big editorial
// headlines; Inter is the body/UI sans.
//
// THEME_BOOT_SCRIPT applies a stored light/dark choice before first paint
// (see components/theme-toggle.tsx). It sets data-theme on <html> before
// React hydrates, hence suppressHydrationWarning on that element only.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300..700&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <header className="site-header">
          <Link href="/" className="wordmark">
            Gauntlet
          </Link>
          <div className="header-actions">
            <AccountNav />
            <ThemeToggle />
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
