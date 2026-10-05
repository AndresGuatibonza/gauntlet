// @vitest-environment node
import { describe, it, expect } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  appJwt,
  authorizeUrl,
  exchangeOAuthCode,
  GitHubAppError,
  installUrl,
  listUserAccess,
  mintRepositoryToken,
  readGitHubAppConfig,
  type GitHubAppConfig,
} from "@/lib/github-app";
import { GITHUB_STATE_COOKIE, newGitHubState, verifyGitHubState } from "@/lib/github-state";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_SLUG: "gauntlet-dev",
    GITHUB_APP_CLIENT_ID: "Iv23liClient",
    GITHUB_APP_CLIENT_SECRET: "secret",
    GITHUB_APP_PRIVATE_KEY: PEM,
    ...overrides,
  };
}

function config(): GitHubAppConfig {
  return readGitHubAppConfig(env())!;
}

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (url: URL, init: RequestInit) => Response, calls: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return handler(new URL(String(input)), init);
  }) as typeof fetch;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("readGitHubAppConfig", () => {
  it("is null until every variable is set, so the feature stays hidden", () => {
    expect(readGitHubAppConfig({})).toBeNull();
    for (const name of ["GITHUB_APP_ID", "GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "GITHUB_APP_PRIVATE_KEY"]) {
      expect(readGitHubAppConfig(env({ [name]: "" })), name).toBeNull();
    }
    expect(readGitHubAppConfig(env())).toMatchObject({ appId: "123456", slug: "gauntlet-dev", clientId: "Iv23liClient" });
  });

  it("accepts a key pasted with escaped newlines, and refuses malformed values", () => {
    expect(readGitHubAppConfig(env({ GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, "\\n") }))).not.toBeNull();
    expect(() => readGitHubAppConfig(env({ GITHUB_APP_ID: "gauntlet" }))).toThrow(/numeric/);
    expect(() => readGitHubAppConfig(env({ GITHUB_APP_SLUG: "a/b" }))).toThrow(/URL name/);
    expect(() => readGitHubAppConfig(env({ GITHUB_APP_PRIVATE_KEY: "not a key" }))).toThrow(/not a valid PEM/);
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => readGitHubAppConfig(env({ GITHUB_APP_PRIVATE_KEY: ec }))).toThrow(/RSA/);
  });
});

describe("appJwt", () => {
  it("is an RS256 JWT for the App, backdated 60 s and valid under 10 minutes", () => {
    const token = appJwt(config(), 1_000_000);
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "123456" });
    const ok = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("mintRepositoryToken", () => {
  it("asks for read-only contents on exactly one repository", async () => {
    const calls: Call[] = [];
    const token = await mintRepositoryToken(config(), 77, 4242, { fetchImpl: fakeFetch(() => json({ token: "ghs_x" }, 201), calls) });
    expect(token).toBe("ghs_x");
    expect(calls[0]!.url).toBe("https://api.github.com/app/installations/77/access_tokens");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ repository_ids: [4242], permissions: { contents: "read", metadata: "read" } });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toMatch(/^Bearer ey/);
  });

  it.each([
    [404, {}, "gone"],
    [422, {}, "gone"],
    [403, { "x-ratelimit-remaining": "0" }, "rate_limited"],
    [500, {}, "failed"],
  ])("maps HTTP %s to %s", async (status, headers, kind) => {
    const err = await mintRepositoryToken(config(), 1, 2, { fetchImpl: fakeFetch(() => json({}, status, headers as Record<string, string>)) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubAppError);
    expect((err as GitHubAppError).kind).toBe(kind);
  });
});

describe("exchangeOAuthCode", () => {
  it("returns the user token and sends the client credentials", async () => {
    const calls: Call[] = [];
    const token = await exchangeOAuthCode(config(), "code-1", "https://g.app/api/github/callback", { fetchImpl: fakeFetch(() => json({ access_token: "ghu_y" }), calls) });
    expect(token).toBe("ghu_y");
    expect(calls[0]!.url).toBe("https://github.com/login/oauth/access_token");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      client_id: "Iv23liClient",
      client_secret: "secret",
      code: "code-1",
      redirect_uri: "https://g.app/api/github/callback",
    });
  });

  it("treats GitHub's 200 + error body as a refused code", async () => {
    const err = await exchangeOAuthCode(config(), "old", "r", { fetchImpl: fakeFetch(() => json({ error: "bad_verification_code" })) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "denied", message: expect.stringContaining("bad_verification_code") });
  });
});

describe("listUserAccess", () => {
  it("lists installations and, in each, the repositories this user can read (paginated, malformed rows dropped)", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, full_name: `acme/r${i}`, default_branch: "main", private: true }));
    const fetchImpl = fakeFetch((url) => {
      if (url.pathname === "/user/installations") {
        return json({ installations: [{ id: 1, account: { login: "acme", type: "Organization" } }, { id: "bad" }, { id: 2, account: { login: "me", type: "User" } }] });
      }
      if (url.pathname === "/user/installations/1/repositories") {
        return url.searchParams.get("page") === "1" ? json({ repositories: page1 }) : json({ repositories: [{ id: 9, full_name: "acme/last", default_branch: "" }] });
      }
      if (url.pathname === "/user/installations/2/repositories") return json({ repositories: [{ id: 5, full_name: "me/app", default_branch: "trunk", private: false }, { nope: 1 }] });
      return json({}, 404);
    });
    const access = await listUserAccess("ghu_y", { fetchImpl });
    expect(access.complete).toBe(true);
    expect(access.installations).toEqual([
      { installationId: 1, accountLogin: "acme", accountType: "Organization" },
      { installationId: 2, accountLogin: "me", accountType: "User" },
    ]);
    expect(access.repositories).toHaveLength(102);
    expect(access.repositories.find((r) => r.fullName === "acme/last")).toEqual({ installationId: 1, repositoryId: 9, fullName: "acme/last", defaultBranch: "main", private: false });
    expect(access.repositories.find((r) => r.fullName === "me/app")).toMatchObject({ installationId: 2, defaultBranch: "trunk" });
  });

  it("propagates a refused token", async () => {
    await expect(listUserAccess("expired", { fetchImpl: fakeFetch(() => json({}, 401)) })).rejects.toMatchObject({ kind: "gone" });
  });
});

describe("GitHub URLs", () => {
  it("installs through select_target and authorizes with the exact callback", () => {
    expect(installUrl({ slug: "gauntlet-dev" }, "s t")).toBe("https://github.com/apps/gauntlet-dev/installations/select_target?state=s%20t");
    const url = new URL(authorizeUrl({ clientId: "Iv1" }, "st", "https://g.app/api/github/callback"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "Iv1", state: "st", redirect_uri: "https://g.app/api/github/callback" });
  });
});

describe("GitHub state cookie", () => {
  const SCAN = "3f2a1c4e-9b7d-4e21-8a6f-0c5d2e7b9a10";

  it("round-trips the report to return to only when the state matches", () => {
    const { state, cookieValue } = newGitHubState(SCAN);
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyGitHubState(cookieValue, state)).toEqual({ scanId: SCAN });
    expect(verifyGitHubState(cookieValue, `${state.slice(0, -1)}x`)).toBeNull();
    expect(verifyGitHubState(cookieValue, "short")).toBeNull();
    expect(verifyGitHubState(undefined, state)).toBeNull();
    expect(verifyGitHubState(cookieValue, null)).toBeNull();
  });

  it("rejects a forged or malformed cookie", () => {
    const { state } = newGitHubState(SCAN);
    const forged = Buffer.from(JSON.stringify({ state, scanId: "../../evil" })).toString("base64url");
    expect(verifyGitHubState(forged, state)).toBeNull();
    expect(verifyGitHubState("%%%not-base64", state)).toBeNull();
    expect(GITHUB_STATE_COOKIE).toBe("gauntlet_github_state");
  });
});
