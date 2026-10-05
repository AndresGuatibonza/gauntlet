import { describe, it, expect } from "vitest";
import { createGitHubRepoReader } from "../src/github-repo-reader.js";
import { MAX_READ_FILE_BYTES, RepoAccessError } from "../src/repo-evidence.js";

const SHA = "b".repeat(40);

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>, calls: { url: string; headers: Record<string, string> }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.pathname + url.search, headers: init.headers as Record<string, string> });
    const route = routes[url.pathname + url.search] ?? routes[url.pathname];
    if (!route) return new Response("Not Found", { status: 404 });
    return route(url, init);
  }) as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function happyRoutes(): Record<string, Route> {
  return {
    "/repos/acme/web": () => json({ default_branch: "main" }),
    "/repos/acme/web/commits/main": () => json({ sha: SHA }),
    [`/repos/acme/web/git/trees/${SHA}?recursive=1`]: () =>
      json({
        truncated: false,
        tree: [
          { path: "src", type: "tree" },
          { path: "src/app.ts", type: "blob", size: 20 },
          { path: "src/my file#1.ts", type: "blob", size: 5 },
          { path: "big.json", type: "blob", size: MAX_READ_FILE_BYTES + 1 },
          { path: "logo.png", type: "blob", size: 4 },
        ],
      }),
    [`/repos/acme/web/contents/src/app.ts`]: () => new Response("export const a = 1;\n"),
    [`/repos/acme/web/contents/src/my%20file%231.ts`]: () => new Response("x\n"),
    [`/repos/acme/web/contents/logo.png`]: () => new Response("\u0000PNG"),
  };
}

describe("createGitHubRepoReader", () => {
  it("snapshots the default branch's commit and reads files at that commit", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const reader = createGitHubRepoReader({ token: "ghs_test", repository: "acme/web", fetchImpl: fakeFetch(happyRoutes(), calls) });
    const snapshot = await reader.snapshot();
    expect(snapshot).toEqual({
      repository: "acme/web",
      ref: SHA,
      truncated: false,
      entries: [
        { path: "src/app.ts", size: 20 },
        { path: "src/my file#1.ts", size: 5 },
        { path: "big.json", size: MAX_READ_FILE_BYTES + 1 },
        { path: "logo.png", size: 4 },
      ],
    });
    expect(await reader.readText("src/app.ts")).toBe("export const a = 1;\n");
    expect(await reader.readText("src/my file#1.ts")).toBe("x\n");
    // Never fetched: over the size limit, or not in the tree. Binary content is dropped.
    expect(await reader.readText("big.json")).toBeNull();
    expect(await reader.readText("nope.ts")).toBeNull();
    expect(await reader.readText("logo.png")).toBeNull();

    expect(calls.map((c) => c.url)).not.toContain("/repos/acme/web/contents/big.json");
    expect(calls.find((c) => c.url.startsWith("/repos/acme/web/contents/src/app.ts"))!.url).toBe(`/repos/acme/web/contents/src/app.ts?ref=${SHA}`);
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer ghs_test", "X-GitHub-Api-Version": "2022-11-28" });
    // The snapshot is taken once.
    await reader.snapshot();
    expect(calls.filter((c) => c.url === "/repos/acme/web").length).toBe(1);
  });

  it("uses an explicit ref without asking for the default branch", async () => {
    const routes = happyRoutes();
    routes["/repos/acme/web/commits/release%2F1.0"] = () => json({ sha: SHA });
    const reader = createGitHubRepoReader({ token: "t", repository: "acme/web", ref: "release/1.0", fetchImpl: fakeFetch(routes) });
    expect((await reader.snapshot()).ref).toBe(SHA);
  });

  it.each([
    [401, {}, "unauthorized"],
    [403, { "x-ratelimit-remaining": "0" }, "rate_limited"],
    [429, {}, "rate_limited"],
    [403, {}, "forbidden"],
    [404, {}, "not_found"],
    [502, {}, "failed"],
  ])("maps HTTP %s to a %s RepoAccessError", async (status, headers, kind) => {
    const reader = createGitHubRepoReader({
      token: "t",
      repository: "acme/web",
      fetchImpl: fakeFetch({ "/repos/acme/web": () => json({ message: "x" }, status, headers as Record<string, string>) }),
    });
    const err = await reader.snapshot().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepoAccessError);
    expect((err as RepoAccessError).kind).toBe(kind);
  });

  it("reports network failures, empty repositories and bad names", async () => {
    const down = createGitHubRepoReader({ token: "t", repository: "acme/web", fetchImpl: (async () => Promise.reject(new Error("ECONNRESET"))) as typeof fetch });
    await expect(down.snapshot()).rejects.toThrow(/Could not reach GitHub.*ECONNRESET/);
    const empty = createGitHubRepoReader({ token: "t", repository: "acme/web", fetchImpl: fakeFetch({ "/repos/acme/web": () => json({}) }) });
    await expect(empty.snapshot()).rejects.toThrow(/no default branch/);
    for (const bad of ["../etc", "acme/..", "acme/.", "-acme/web", "acme/web/extra", "acme", "acme/web?x=1", "ac--me/web"]) {
      expect(() => createGitHubRepoReader({ token: "t", repository: bad }), bad).toThrow(RepoAccessError);
    }
    for (const ok of ["acme/web", "Acme-Inc/web.site", "a/.github", "acme/my_repo-2"]) {
      expect(() => createGitHubRepoReader({ token: "t", repository: ok }), ok).not.toThrow();
    }
  });

  it("propagates a revoked token while reading a file instead of treating it as missing", async () => {
    const routes = happyRoutes();
    routes["/repos/acme/web/contents/src/app.ts"] = () => json({ message: "Bad credentials" }, 401);
    const reader = createGitHubRepoReader({ token: "t", repository: "acme/web", fetchImpl: fakeFetch(routes) });
    await expect(reader.readText("src/app.ts")).rejects.toMatchObject({ kind: "unauthorized" });
  });
});
