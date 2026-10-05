/**
 * GitHub source adapter (PRD §9 "Source Adapters ... GitHub"): a read-only
 * RepoReader over the GitHub REST API with an already-issued token. How the
 * token is obtained (a GitHub App installation token in the web app) is the
 * caller's concern; this module never stores it.
 *
 * Reads exactly: the commit SHA of a branch, the recursive tree at that
 * commit, and individual files at that commit. Every failure becomes a
 * RepoAccessError with a kind the caller can act on (revoked access, deleted
 * repository, rate limit, network).
 */
import { isRepositoryName, looksBinary, MAX_READ_FILE_BYTES, RepoAccessError, type RepoReader, type RepoSnapshot } from "./repo-evidence.js";

export interface GitHubRepoReaderOptions {
  token: string;
  /** "owner/name". */
  repository: string;
  /** Branch, tag or SHA; default: the repository's default branch. */
  ref?: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
}

const API_VERSION = "2022-11-28";

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function createGitHubRepoReader(options: GitHubRepoReaderOptions): RepoReader {
  const { token, repository } = options;
  if (!isRepositoryName(repository)) throw new RepoAccessError(`Not a repository name: "${repository}".`, "not_found");
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 20_000;
  let snapshot: RepoSnapshot | null = null;
  const sizes = new Map<string, number>();

  async function request(path: string, accept: string, what: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetchImpl(`${apiBase}${path}`, {
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "gauntlet-deep-scan",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RepoAccessError(`Could not reach GitHub while reading ${what}: ${err instanceof Error ? err.message : String(err)}`, "failed", err);
    }
    if (res.ok) return res;
    if (res.status === 401) throw new RepoAccessError(`GitHub rejected the access token while reading ${what}.`, "unauthorized");
    if (res.status === 403 || res.status === 429) {
      const limited = res.status === 429 || res.headers.get("x-ratelimit-remaining") === "0";
      throw new RepoAccessError(
        limited ? `GitHub's rate limit was reached while reading ${what}.` : `Gauntlet's access to ${repository} does not allow reading ${what}.`,
        limited ? "rate_limited" : "forbidden",
      );
    }
    if (res.status === 404) throw new RepoAccessError(`${what} was not found (the repository may have been deleted or access removed).`, "not_found");
    throw new RepoAccessError(`GitHub returned HTTP ${res.status} while reading ${what}.`, "failed");
  }

  async function json<T>(path: string, what: string): Promise<T> {
    const res = await request(path, "application/vnd.github+json", what);
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new RepoAccessError(`GitHub sent an unreadable response for ${what}.`, "failed", err);
    }
  }

  async function takeSnapshot(): Promise<RepoSnapshot> {
    if (snapshot) return snapshot;
    let ref = options.ref;
    if (!ref) {
      const repo = await json<{ default_branch?: string }>(`/repos/${repository}`, repository);
      if (!repo.default_branch) throw new RepoAccessError(`${repository} has no default branch (empty repository?).`, "not_found");
      ref = repo.default_branch;
    }
    const commit = await json<{ sha?: string }>(`/repos/${repository}/commits/${encodeURIComponent(ref)}`, `${repository}@${ref}`);
    if (!commit.sha || !/^[0-9a-f]{40}$/.test(commit.sha)) throw new RepoAccessError(`GitHub returned no commit for ${repository}@${ref}.`, "failed");
    const tree = await json<{ tree?: { path: string; type: string; size?: number }[]; truncated?: boolean }>(
      `/repos/${repository}/git/trees/${commit.sha}?recursive=1`,
      `the file tree of ${repository}`,
    );
    const entries = (tree.tree ?? [])
      .filter((e) => e.type === "blob" && typeof e.path === "string")
      .map((e) => ({ path: e.path, size: e.size ?? 0 }));
    for (const e of entries) sizes.set(e.path, e.size);
    snapshot = { repository, ref: commit.sha, entries, truncated: tree.truncated === true };
    return snapshot;
  }

  return {
    snapshot: takeSnapshot,

    async readText(path) {
      const { ref } = await takeSnapshot();
      const size = sizes.get(path);
      if (size === undefined || size > MAX_READ_FILE_BYTES) return null;
      let res: Response;
      try {
        res = await request(`/repos/${repository}/contents/${encodePath(path)}?ref=${ref}`, "application/vnd.github.raw", path);
      } catch (err) {
        if (err instanceof RepoAccessError && err.kind === "not_found") return null;
        throw err;
      }
      const content = await res.text();
      return looksBinary(content) ? null : content;
    },
  };
}
