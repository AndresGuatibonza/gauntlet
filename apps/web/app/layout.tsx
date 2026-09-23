import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gauntlet",
  description: "Point Gauntlet at a public product URL and get ranked, evidence-backed improvement opportunities -- no account required.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main>{children}</main>
      </body>
    </html>
  );
}
