// GitHub App auth and the few write operations the gateway performs after approval.

export interface RepoRef {
  owner: string;
  repo: string;
  number?: number;
}

/** Accepts "owner/repo", "owner/repo#123" or a github.com PR/issue URL. */
export function parseTarget(target: string): RepoRef | null {
  const url = target.match(/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:pull|issues)\/(\d+))?/);
  if (url) return { owner: url[1], repo: url[2], number: url[3] ? Number(url[3]) : undefined };
  const short = target.match(/^([\w.-]+)\/([\w.-]+)(?:#(\d+))?$/);
  if (short) return { owner: short[1], repo: short[2], number: short[3] ? Number(short[3]) : undefined };
  return null;
}

function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): ArrayBuffer {
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error(
      "GitHub App key is PKCS#1. Convert it: openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key-pkcs8.pem",
    );
  }
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function appJwt(appId: string, pem: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId }));
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(sig)}`;
}

export class GitHub {
  constructor(private token: string, private fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  static async forInstallation(appId: string, pem: string, installationId: string, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
    const jwt = await appJwt(appId, pem);
    const res = await fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "virtual-agent-org" },
    });
    if (!res.ok) throw new Error(`GitHub token mint failed: ${res.status} ${await res.text()}`);
    const { token } = (await res.json()) as { token: string };
    return new GitHub(token, fetchImpl);
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "virtual-agent-org",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  merge(r: Required<RepoRef>, method: "merge" | "squash" | "rebase" = "squash", sha?: string) {
    return this.call<{ merged: boolean; sha: string }>("PUT", `/repos/${r.owner}/${r.repo}/pulls/${r.number}/merge`, {
      merge_method: method,
      ...(sha ? { sha } : {}),
    });
  }

  close(r: Required<RepoRef>) {
    // The issues endpoint closes both issues and pull requests.
    return this.call("PATCH", `/repos/${r.owner}/${r.repo}/issues/${r.number}`, { state: "closed" });
  }

  comment(r: Required<RepoRef>, body: string) {
    return this.call<{ html_url: string }>("POST", `/repos/${r.owner}/${r.repo}/issues/${r.number}/comments`, { body });
  }

  pull(r: Required<RepoRef>) {
    return this.call<{ head: { sha: string; repo: { full_name: string } | null }; base: { repo: { full_name: string } }; state: string }>(
      "GET",
      `/repos/${r.owner}/${r.repo}/pulls/${r.number}`,
    );
  }

  /**
   * PRs and issues opened at or after `since` (ISO time), newest first, up to 100. The issues
   * endpoint lists both; its `since` filters by last update, so creation is checked here.
   */
  async openedSince(r: RepoRef, since: string): Promise<{ number: number; pr: boolean }[]> {
    const q = new URLSearchParams({ state: "all", since, sort: "created", direction: "desc", per_page: "100" });
    const items = await this.call<{ number: number; created_at: string; pull_request?: unknown }[]>("GET", `/repos/${r.owner}/${r.repo}/issues?${q}`);
    return items.filter((i) => Date.parse(i.created_at) >= Date.parse(since)).map((i) => ({ number: i.number, pr: !!i.pull_request }));
  }

  /** Whether a PR or issue is open, closed or merged, and which it is; the issues endpoint answers for both. */
  async issueState(r: Required<RepoRef>): Promise<{ state: "open" | "closed" | "merged"; pr: boolean }> {
    const i = await this.call<{ state: string; pull_request?: { merged_at: string | null } }>("GET", `/repos/${r.owner}/${r.repo}/issues/${r.number}`);
    const state = i.state === "open" ? "open" : i.pull_request?.merged_at ? "merged" : "closed";
    return { state, pr: !!i.pull_request };
  }

  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const r = await this.call<{ data?: T; errors?: { message: string }[] }>("POST", "/graphql", { query, variables });
    if (r.errors?.length || !r.data) throw new Error(`GitHub GraphQL: ${r.errors?.map((e) => e.message).join("; ") ?? "no data"}`);
    return r.data;
  }

  /** What a merge decision needs to know about a PR, in one read. */
  async prDetail(r: Required<RepoRef>): Promise<PrDetail> {
    const d = await this.graphql<{ repository: { pullRequest: PrDetail | null } }>(PR_DETAIL, { owner: r.owner, repo: r.repo, number: r.number });
    if (!d.repository.pullRequest) throw new Error(`${r.owner}/${r.repo}#${r.number} is not a pull request`);
    return d.repository.pullRequest;
  }

  /**
   * The workflow files on the default branch, in one read. Throws when one can't be
   * read in full, so a caller deciding whether CI is safe fails closed.
   */
  async workflowFiles(r: RepoRef): Promise<{ path: string; text: string }[]> {
    const d = await this.graphql<{ repository: { object: { entries: WorkflowEntry[] } | null } | null }>(WORKFLOW_FILES, { owner: r.owner, repo: r.repo });
    if (!d.repository) throw new Error(`${r.owner}/${r.repo} not found`);
    const out: { path: string; text: string }[] = [];
    for (const e of d.repository.object?.entries ?? []) {
      if (e.type !== "blob" || !/\.ya?ml$/.test(e.name)) continue;
      if (!e.object || e.object.isTruncated || e.object.text === null) throw new Error(`.github/workflows/${e.name} could not be read in full`);
      out.push({ path: `.github/workflows/${e.name}`, text: e.object.text });
    }
    return out;
  }

  /** The repo's open PRs, oldest first (up to 50). */
  async openPulls(r: RepoRef): Promise<OpenPull[]> {
    const d = await this.graphql<{ repository: { pullRequests: { nodes: OpenPull[] } } }>(OPEN_PULLS, { owner: r.owner, repo: r.repo });
    return d.repository.pullRequests.nodes;
  }

  /** Every workflow run at a commit, or null when GitHub has more than one page of them. */
  async runsAt(r: RepoRef, sha: string): Promise<WorkflowRun[] | null> {
    const res = await this.call<{ total_count: number; workflow_runs: WorkflowRun[] }>(
      "GET",
      `/repos/${r.owner}/${r.repo}/actions/runs?head_sha=${sha}&per_page=100`,
    );
    const runs = res.workflow_runs ?? [];
    return res.total_count > runs.length ? null : runs;
  }

  /** A review that only comments: the agents never approve or request changes as a reviewer. */
  createReview(r: Required<RepoRef>, p: { commit_id: string; body: string; comments: { path: string; line: number; body: string }[] }) {
    return this.call<{ html_url: string }>("POST", `/repos/${r.owner}/${r.repo}/pulls/${r.number}/reviews`, {
      commit_id: p.commit_id,
      body: p.body,
      event: "COMMENT",
      comments: p.comments.map((c) => ({ ...c, side: "RIGHT" })),
    });
  }

  async labels(r: Required<RepoRef>): Promise<string[]> {
    const ls = await this.call<{ name: string }[]>("GET", `/repos/${r.owner}/${r.repo}/issues/${r.number}/labels?per_page=100`);
    return ls.map((l) => l.name);
  }

  /** GitHub creates a label the repo doesn't have yet. */
  addLabels(r: Required<RepoRef>, names: string[]) {
    return this.call("POST", `/repos/${r.owner}/${r.repo}/issues/${r.number}/labels`, { labels: names });
  }

  /** The repo's own labels (the first 100). */
  async repoLabels(r: RepoRef): Promise<string[]> {
    const ls = await this.call<{ name: string }[]>("GET", `/repos/${r.owner}/${r.repo}/labels?per_page=100`);
    return ls.map((l) => l.name);
  }

  removeLabel(r: Required<RepoRef>, name: string) {
    return this.call("DELETE", `/repos/${r.owner}/${r.repo}/issues/${r.number}/labels/${encodeURIComponent(name)}`);
  }

  /** Changed file paths in a PR (up to 3,000, GitHub's own limit). */
  async pullFiles(r: Required<RepoRef>): Promise<string[]> {
    const out: string[] = [];
    for (let page = 1; page <= 30; page++) {
      const files = await this.call<{ filename: string; previous_filename?: string }[]>(
        "GET",
        `/repos/${r.owner}/${r.repo}/pulls/${r.number}/files?per_page=100&page=${page}`,
      );
      for (const f of files) out.push(f.filename, ...(f.previous_filename ? [f.previous_filename] : []));
      if (files.length < 100) break;
    }
    return out;
  }

  /** Workflow runs for a commit that are waiting for a maintainer to approve them. */
  async runsAwaitingApproval(r: RepoRef, sha: string): Promise<{ id: number; name: string; html_url: string }[]> {
    const res = await this.call<{ workflow_runs: { id: number; name: string; html_url: string }[] }>(
      "GET",
      `/repos/${r.owner}/${r.repo}/actions/runs?head_sha=${sha}&status=action_required&per_page=50`,
    );
    return res.workflow_runs ?? [];
  }

  approveRun(r: RepoRef, runId: number) {
    return this.call("POST", `/repos/${r.owner}/${r.repo}/actions/runs/${runId}/approve`);
  }

  /** Opens a PR that writes one file on a new branch from the default branch. */
  async proposeFile(r: RepoRef, p: { path: string; content: string; branch: string; title: string; body: string }) {
    const base = `/repos/${r.owner}/${r.repo}`;
    const repo = await this.call<{ default_branch: string }>("GET", base);
    const head = await this.call<{ object: { sha: string } }>("GET", `${base}/git/ref/heads/${repo.default_branch}`);
    await this.call("POST", `${base}/git/refs`, { ref: `refs/heads/${p.branch}`, sha: head.object.sha });
    let sha: string | undefined;
    try {
      sha = (await this.call<{ sha: string }>("GET", `${base}/contents/${encodePath(p.path)}?ref=${repo.default_branch}`)).sha;
    } catch (e) {
      if (!String(e).includes(": 404")) throw e; // a new file
    }
    await this.call("PUT", `${base}/contents/${encodePath(p.path)}`, {
      message: p.title,
      content: base64Utf8(p.content),
      branch: p.branch,
      ...(sha ? { sha } : {}),
    });
    return this.call<{ html_url: string; number: number }>("POST", `${base}/pulls`, {
      title: p.title,
      head: p.branch,
      base: repo.default_branch,
      body: p.body,
    });
  }

  /**
   * Several files in one commit on a new branch from the default branch, then a PR. A null
   * content deletes the file. A branch left by an earlier failed attempt is moved to the new commit.
   */
  async proposeChange(
    r: RepoRef,
    p: { branch: string; files: { path: string; content: string | null }[]; message: string; author: { name: string; email: string }; title: string; body: string },
  ): Promise<{ html_url: string; number: number }> {
    const base = `/repos/${r.owner}/${r.repo}`;
    const repo = await this.call<{ default_branch: string }>("GET", base);
    const head = (await this.call<{ object: { sha: string } }>("GET", `${base}/git/ref/heads/${repo.default_branch}`)).object.sha;
    const commit = await this.call<{ tree: { sha: string } }>("GET", `${base}/git/commits/${head}`);
    const tree = await this.call<{ sha: string }>("POST", `${base}/git/trees`, {
      base_tree: commit.tree.sha,
      tree: p.files.map((f) => ({ path: f.path, mode: "100644", type: "blob", ...(f.content === null ? { sha: null } : { content: f.content }) })),
    });
    const made = await this.call<{ sha: string }>("POST", `${base}/git/commits`, { message: p.message, tree: tree.sha, parents: [head], author: p.author });
    try {
      await this.call("POST", `${base}/git/refs`, { ref: `refs/heads/${p.branch}`, sha: made.sha });
    } catch (e) {
      if (!String(e).includes("Reference already exists")) throw e;
      await this.call("PATCH", `${base}/git/refs/heads/${p.branch}`, { sha: made.sha, force: true });
    }
    return this.call<{ html_url: string; number: number }>("POST", `${base}/pulls`, {
      title: p.title,
      head: p.branch,
      base: repo.default_branch,
      body: p.body,
    });
  }

  release(r: RepoRef, p: { tag: string; name?: string; body?: string; target?: string; draft?: boolean }) {
    return this.call<{ html_url: string }>("POST", `/repos/${r.owner}/${r.repo}/releases`, {
      tag_name: p.tag,
      name: p.name ?? p.tag,
      body: p.body ?? "",
      ...(p.target ? { target_commitish: p.target } : {}),
      draft: p.draft ?? false,
    });
  }
}

export interface PrDetail {
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  title: string;
  createdAt: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  mergeStateStatus: string;
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  authorAssociation: string;
  author: { login: string } | null;
  latestOpinionatedReviews: { nodes: { state: string; authorAssociation: string; author: { login: string } | null }[] };
  reviewThreads: { totalCount: number; nodes: { isResolved: boolean }[] };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

export interface OpenPull {
  number: number;
  title: string;
  isDraft: boolean;
  createdAt: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  authorAssociation: string;
  author: { login: string } | null;
  reviewDecision: string | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

export interface WorkflowRun {
  id: number;
  name: string;
  workflow_id: number;
  event: string;
  status: string; // queued | in_progress | completed | action_required | waiting | ...
  conclusion: string | null;
}

const PR_DETAIL = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      state isDraft title createdAt headRefOid additions deletions changedFiles
      mergeable mergeStateStatus reviewDecision authorAssociation author { login }
      latestOpinionatedReviews(first: 50) { nodes { state authorAssociation author { login } } }
      reviewThreads(first: 100) { totalCount nodes { isResolved } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    }
  }
}`;

interface WorkflowEntry {
  name: string;
  type: string;
  object: { text: string | null; isTruncated: boolean } | null;
}

// HEAD: is the default branch. A repo without workflows has no such tree (object is null).
const WORKFLOW_FILES = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    object(expression: "HEAD:.github/workflows") {
      ... on Tree { entries { name type object { ... on Blob { text isTruncated } } } }
    }
  }
}`;

const OPEN_PULLS = `query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 50, orderBy: { field: CREATED_AT, direction: ASC }) {
      nodes {
        number title isDraft createdAt headRefOid additions deletions authorAssociation author { login } reviewDecision
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
