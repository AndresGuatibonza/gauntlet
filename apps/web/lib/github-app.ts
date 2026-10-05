/**
 * The Gauntlet GitHub App (PRD §8.6 "Support GitHub as the first repository
 * provider ... source-level permissions and easy disconnect/revocation").
 *
 * Why a GitHub App and not an OAuth scope: an OAuth "repo" scope grants
 * read AND write to every repository of the user. The App asks for
 * read-only Contents, only on the repositories the user (or their org
 * admin) selects, and is revoked by uninstalling it.
 *
 * Tokens:
 * - App JWT (RS256, 9 minutes): signed with the App's private key; only
 *   used to mint installation tokens.
 * - Installation token (1 hour): minted per deep scan, restricted to ONE
 *   repository and contents:read. Never stored.
 * - User-to-server token: from the OAuth code at connection, used once to
 *   list the installations and repositories THIS user can access (so a
 *   member can't connect an org repository they can't see), then dropped.
 *
 * Configuration (all required; without them the feature is hidden):
 * GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID,
 * GITHUB_APP_CLIENT_SECRET, GITHUB_APP_PRIVATE_KEY (PEM; "\n" escapes OK).
 */
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

type Env = Record<string, string | undefined>;

export interface GitHubAppConfig {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: KeyObject;
}

export class GitHubAppError extends Error {
  constructor(
    message: string,
    /** "gone": the installation or repository is no longer accessible; "denied": the user refused or the code is invalid. */
    public readonly kind: "gone" | "denied" | "rate_limited" | "failed",
  ) {
    super(message);
    this.name = "GitHubAppError";
  }
}

/** null when the App isn't configured (the feature stays hidden); throws on a malformed key. */
export function readGitHubAppConfig(env: Env = process.env): GitHubAppConfig | null {
  const appId = env["GITHUB_APP_ID"]?.trim();
  const slug = env["GITHUB_APP_SLUG"]?.trim();
  const clientId = env["GITHUB_APP_CLIENT_ID"]?.trim();
  const clientSecret = env["GITHUB_APP_CLIENT_SECRET"]?.trim();
  const rawKey = env["GITHUB_APP_PRIVATE_KEY"];
  if (!appId || !slug || !clientId || !clientSecret || !rawKey?.trim()) return null;
  if (!/^\d+$/.test(appId)) throw new Error("GITHUB_APP_ID must be the numeric App ID.");
  if (!/^[a-z0-9-]+$/i.test(slug)) throw new Error("GITHUB_APP_SLUG must be the App's URL name (letters, digits, hyphens).");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(rawKey.replace(/\\n/g, "\n").trim());
  } catch {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not a valid PEM private key.");
  }
  if (privateKey.asymmetricKeyType !== "rsa") throw new Error("GITHUB_APP_PRIVATE_KEY must be the App's RSA private key.");
  return { appId, slug, clientId, clientSecret, privateKey };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** The App's own JWT (GitHub: iat backdated 60 s for clock drift, at most 10 minutes). */
export function appJwt(config: Pick<GitHubAppConfig, "appId" | "privateKey">, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: config.appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(config.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

export interface GitHubHttp {
  fetchImpl?: typeof fetch;
  apiBase?: string;
  webBase?: string;
}

const API_VERSION = "2022-11-28";

async function githubFetch(http: GitHubHttp, url: string, init: RequestInit, what: string): Promise<Response> {
  const fetchImpl = http.fetchImpl ?? fetch;
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new GitHubAppError(`Could not reach GitHub (${what}): ${err instanceof Error ? err.message : String(err)}`, "failed");
  }
}

function failure(res: Response, what: string): GitHubAppError {
  if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
    return new GitHubAppError(`GitHub's rate limit was reached (${what}).`, "rate_limited");
  }
  if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 422) {
    return new GitHubAppError(`GitHub refused ${what} (HTTP ${res.status}).`, "gone");
  }
  return new GitHubAppError(`GitHub returned HTTP ${res.status} (${what}).`, "failed");
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "gauntlet-web",
  };
}

/** A one-hour token that can only read the contents of one repository. */
export async function mintRepositoryToken(
  config: GitHubAppConfig,
  installationId: number,
  repositoryId: number,
  http: GitHubHttp = {},
): Promise<string> {
  const apiBase = http.apiBase ?? "https://api.github.com";
  const res = await githubFetch(
    http,
    `${apiBase}/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: { ...apiHeaders(appJwt(config)), "Content-Type": "application/json" },
      body: JSON.stringify({ repository_ids: [repositoryId], permissions: { contents: "read", metadata: "read" } }),
    },
    "an access token for the repository",
  );
  if (!res.ok) throw failure(res, "an access token for the repository");
  const body = (await res.json().catch(() => null)) as { token?: string } | null;
  if (!body?.token) throw new GitHubAppError("GitHub returned no installation token.", "failed");
  return body.token;
}

/** Exchanges the OAuth callback code for the user's token (used once, never stored). */
export async function exchangeOAuthCode(config: GitHubAppConfig, code: string, redirectUri: string, http: GitHubHttp = {}): Promise<string> {
  const webBase = http.webBase ?? "https://github.com";
  const res = await githubFetch(
    http,
    `${webBase}/login/oauth/access_token`,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "gauntlet-web" },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri }),
    },
    "the sign-in code",
  );
  const body = (await res.json().catch(() => null)) as { access_token?: string; error?: string } | null;
  if (!res.ok || !body?.access_token) {
    // GitHub answers 200 with {"error": "bad_verification_code"} for an expired or reused code.
    throw new GitHubAppError(`GitHub did not accept the sign-in code${body?.error ? ` (${body.error})` : ""}.`, "denied");
  }
  return body.access_token;
}

export interface UserInstallation {
  installationId: number;
  accountLogin: string;
  accountType: string;
}

export interface AccessibleRepository {
  installationId: number;
  repositoryId: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 5;

async function paginate<T>(http: GitHubHttp, firstUrl: string, token: string, what: string, pick: (body: unknown) => T[]): Promise<{ items: T[]; complete: boolean }> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${firstUrl}${firstUrl.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`;
    const res = await githubFetch(http, url, { headers: apiHeaders(token) }, what);
    if (!res.ok) throw failure(res, what);
    const pageItems = pick(await res.json().catch(() => null));
    items.push(...pageItems);
    if (pageItems.length < PAGE_SIZE) return { items, complete: true };
  }
  return { items, complete: false };
}

/**
 * The App's installations this user can access, and in each, the
 * repositories both the installation and the user can access (GitHub's
 * /user/installations/{id}/repositories does that intersection).
 */
export async function listUserAccess(
  userToken: string,
  http: GitHubHttp = {},
): Promise<{ installations: UserInstallation[]; repositories: AccessibleRepository[]; complete: boolean }> {
  const apiBase = http.apiBase ?? "https://api.github.com";
  const inst = await paginate(http, `${apiBase}/user/installations`, userToken, "your GitHub App installations", (body) => {
    const list = (body as { installations?: unknown[] } | null)?.installations ?? [];
    return list.flatMap((raw) => {
      const i = raw as { id?: unknown; account?: { login?: unknown; type?: unknown } | null };
      return typeof i.id === "number" && typeof i.account?.login === "string"
        ? [{ installationId: i.id, accountLogin: i.account.login, accountType: typeof i.account.type === "string" ? i.account.type : "User" }]
        : [];
    });
  });
  const repositories: AccessibleRepository[] = [];
  let complete = inst.complete;
  for (const installation of inst.items) {
    const repos = await paginate(
      http,
      `${apiBase}/user/installations/${installation.installationId}/repositories`,
      userToken,
      `the repositories of ${installation.accountLogin}`,
      (body) => {
        const list = (body as { repositories?: unknown[] } | null)?.repositories ?? [];
        return list.flatMap((raw) => {
          const r = raw as { id?: unknown; full_name?: unknown; default_branch?: unknown; private?: unknown };
          return typeof r.id === "number" && typeof r.full_name === "string"
            ? [{
                installationId: installation.installationId,
                repositoryId: r.id,
                fullName: r.full_name,
                defaultBranch: typeof r.default_branch === "string" && r.default_branch ? r.default_branch : "main",
                private: r.private === true,
              }]
            : [];
        });
      },
    );
    repositories.push(...repos.items);
    complete &&= repos.complete;
  }
  return { installations: inst.items, repositories, complete };
}

/** Where the user installs the App (or changes its repositories), coming back to our callback. */
export function installUrl(config: Pick<GitHubAppConfig, "slug">, state: string, webBase = "https://github.com"): string {
  return `${webBase}/apps/${config.slug}/installations/select_target?state=${encodeURIComponent(state)}`;
}

/** Where an already-installed user authorizes the App, so we can list what they can access. */
export function authorizeUrl(config: Pick<GitHubAppConfig, "clientId">, state: string, redirectUri: string, webBase = "https://github.com"): string {
  const params = new URLSearchParams({ client_id: config.clientId, state, redirect_uri: redirectUri });
  return `${webBase}/login/oauth/authorize?${params.toString()}`;
}
