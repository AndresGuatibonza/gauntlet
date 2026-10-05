/**
 * Header navigation (server part): reads whether accounts exist and the
 * verified session (getClaims), then renders the client SiteNav with it.
 */
import { readAuthConfig } from "@/lib/auth/config";
import { getSessionUser } from "@/lib/auth/server";
import { SiteNav } from "@/components/site-nav";

export async function AccountNav(): Promise<React.JSX.Element> {
  const accountsEnabled = readAuthConfig() !== null;
  const user = accountsEnabled ? await getSessionUser() : null;
  return <SiteNav accountsEnabled={accountsEnabled} signedIn={user !== null} login={user?.login ?? null} />;
}
