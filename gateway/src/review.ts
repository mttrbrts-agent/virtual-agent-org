// Mira's reviews (decisions 35 and 36). The gateway, not the model, works out a PR's
// facts and risk, decides whether a merge may be proposed or run, and checks the
// text of every review it posts. Models return findings; code decides and acts.

import type { ReviewConfig } from "./config";
import type { Risk } from "./risk";
import type { Ctx } from "./context";
import type { Finding, Review } from "./db";
import type { GitHub, OpenPull, PrDetail, RepoRef, WorkflowRun } from "./github";
import { workflowRisks, workflowWarnings } from "./workflows";

/** Used when network.json predates config/review.yaml. Mirrors that file. */
export const DEFAULT_REVIEW: ReviewConfig = {
  areas: {
    correctness: "Bugs, logic errors, edge cases.",
    security: "Secrets, unsafe input, dependencies, workflow and build changes.",
    api_compat: "Breaking changes to public APIs or the Concerto metamodel.",
    tests: "Changes without tests, or tests that prove nothing.",
    design: "Code that doesn't fit, is too complex, or duplicates a helper.",
    docs: "User-facing changes without docs.",
    conventions: "The repo's AGENTS.md, CONTRIBUTING.md and CODEOWNERS.",
    hygiene: "DCO sign-off and licence headers.",
  },
  max_findings: 10,
  max_nits: 3,
  tone: { first_time: "welcoming", maintainer: "terse", default: "neutral" },
  risk: { high_over_lines: 400, high_paths: [".github/**", "**/auth/**", "**/crypto/**"], low_max_lines: 100, low_paths: ["*.md", "docs/**", "**/test/**"] },
  path_rules: [],
};

export const reviewConfig = (ctx: Ctx): ReviewConfig => ctx.network.review ?? DEFAULT_REVIEW;

export const SEVERITIES = ["blocking", "should-fix", "nit"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type { Risk } from "./risk";

export const FIRST_TIME = ["FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE", "MANNEQUIN"];
const TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"];

// ---- paths -----------------------------------------------------------------

/** "dir/**" is anything under dir, "*" stays within one folder, and a pattern without "/" also matches the file name anywhere. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${glob.includes("/") ? "" : "(?:.*/)?"}${re}$`, "i");
}

export const matching = (files: string[], globs: string[]) => {
  const res = globs.map(globToRegExp);
  return files.filter((f) => res.some((re) => re.test(f)));
};

/**
 * Paths that change what CI itself runs or installs. A PR touching any of these
 * never has its CI approved without Matt (github.approve_ci is queued instead).
 */
const CI_SENSITIVE = [
  /^\.github\//,
  /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|\.npmrc|\.yarnrc(\.yml)?|lerna\.json|nx\.json)$/,
  /(^|\/)(Cargo\.toml|Cargo\.lock|build\.rs|go\.mod|go\.sum|requirements[^/]*\.txt|pyproject\.toml|setup\.py|Gemfile(\.lock)?)$/,
  /(^|\/)([^/]+\.(csproj|fsproj|sln|props|targets)|nuget\.config|global\.json)$/i,
  /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|Makefile|Taskfile[^/]*|Justfile)$/,
  /(^|\/)[^/]+\.(sh|bash|ps1|bat|cmd)$/,
  /(^|\/)\.husky\//,
  // JVM and Python builds, and the test runners' own configuration.
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradlew(\.bat)?|gradle-wrapper\.(properties|jar))$/,
  /(^|\/)(conftest\.py|tox\.ini|noxfile\.py|setup\.cfg)$/,
  // Config that tools load and run as code: tsconfig, and jest/vitest/eslint/webpack-style *.config.* files.
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)[^/]+\.config\.(js|cjs|mjs|ts|cts|mts)$/,
  // What gets checked out or installed before anything runs.
  /(^|\/)(\.gitmodules|\.nvmrc|\.node-version|\.tool-versions)$/,
  /(^|\/)\.devcontainer\//,
];

export function ciSensitivePaths(files: string[]): string[] {
  return [...new Set(files.filter((f) => CI_SENSITIVE.some((re) => re.test(f))))];
}

/**
 * Why approving fork PRs' CI in this repo isn't safe without Matt, from its workflows
 * on the default branch (decision 20): pull_request_target or workflow_run triggers,
 * runners that aren't GitHub-hosted, or secrets in pull_request workflows. Empty when
 * it is safe. Fails closed: workflows it can't read are a reason.
 */
export async function ciApprovalRisks(gh: Pick<GitHub, "workflowFiles">, ref: RepoRef): Promise<string[]> {
  let files: { path: string; text: string }[];
  try {
    files = await gh.workflowFiles(ref);
  } catch (e) {
    return [`couldn't read the repo's workflows (${e instanceof Error ? e.message : String(e)})`];
  }
  return files.flatMap((f) => [...workflowRisks(f.text), ...workflowWarnings(f.text)].map((r) => `${f.path}: ${r}`));
}

/** Files that tell reviewers, human or agent, what to do. A PR changing them is reviewed against the base branch's copy. */
const GUIDANCE = /(^|\/)((AGENTS|CONTRIBUTING|REVIEWING|CLAUDE)\.md|CODEOWNERS)$/;

export function riskBand(cfg: ReviewConfig, files: string[], lines: number): { risk: Risk; reasons: string[] } {
  const reasons: string[] = [];
  const high = [...new Set([...matching(files, cfg.risk.high_paths), ...ciSensitivePaths(files)])];
  if (high.length) reasons.push(`changes ${list(high)}`);
  const guidance = files.filter((f) => GUIDANCE.test(f));
  if (guidance.length) reasons.push(`changes review guidance (${list(guidance)})`);
  if (lines > cfg.risk.high_over_lines) reasons.push(`${lines} changed lines, over ${cfg.risk.high_over_lines}`);
  if (reasons.length) return { risk: "high", reasons };
  if (!files.length) return { risk: "medium", reasons: ["changed files unknown"] };
  const low = matching(files, cfg.risk.low_paths).length === files.length && lines <= cfg.risk.low_max_lines;
  if (low) return { risk: "low", reasons: [`only docs or tests, ${lines} changed lines`] };
  return { risk: "medium", reasons: [`changes code, ${lines} changed lines`] };
}

const list = (xs: string[], n = 5) => xs.slice(0, n).join(", ") + (xs.length > n ? ` and ${xs.length - n} more` : "");

// ---- CI --------------------------------------------------------------------

export type CiState = "success" | "pending" | "waiting" | "failure" | "none" | "unknown";

/**
 * Green means every workflow run at the head finished well and the checks rollup
 * agrees. Only the newest run of each workflow counts, so a re-run that passed
 * replaces the failure before it. Nothing reported at all is "none", which fails
 * closed: the runs may not have started, or may be held for approval.
 */
export function ciState(rollup: string | null | undefined, runs: WorkflowRun[] | null): CiState {
  if (runs === null) return "unknown";
  const current = latestRuns(runs);
  if (current.some((r) => r.status === "action_required" || r.status === "waiting")) return "waiting";
  if (current.some((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion ?? ""))) return "failure";
  if (rollup === "FAILURE" || rollup === "ERROR") return "failure";
  if (current.some((r) => r.status !== "completed")) return "pending";
  if (rollup === "PENDING" || rollup === "EXPECTED") return "pending";
  if (!current.length && !rollup) return "none";
  return "success";
}

/** The newest run of each workflow and event. */
function latestRuns(runs: WorkflowRun[]): WorkflowRun[] {
  const latest = new Map<string, WorkflowRun>();
  for (const r of runs) {
    const key = `${r.workflow_id}:${r.event}`;
    if (!latest.has(key) || latest.get(key)!.id < r.id) latest.set(key, r);
  }
  return [...latest.values()];
}

// ---- facts -------------------------------------------------------------------

export interface PrFacts {
  target: string;
  sha: string;
  state: string;
  draft: boolean;
  title: string;
  author: string | null;
  author_association: string;
  first_time_contributor: boolean;
  tone: string;
  changed_lines: number;
  additions: number;
  deletions: number;
  files: string[];
  risk: Risk;
  risk_reasons: string[];
  ci: CiState;
  /** The newest run of each workflow at the head, e.g. "Build #812: success https://…". */
  ci_runs: string[];
  mergeable: string;
  merge_state: string;
  review_decision: string | null;
  approvals: string[];
  changes_requested: string[];
  unresolved_threads: number | null;
  age_days: number;
  path_notes: string[];
}

export function factsFrom(cfg: ReviewConfig, ref: Required<RepoRef>, pr: PrDetail, files: string[], runs: WorkflowRun[] | null, now = Date.now()): PrFacts {
  const target = `${ref.owner}/${ref.repo}#${ref.number}`;
  const author = pr.author?.login ?? null;
  const assoc = (pr.authorAssociation ?? "").toUpperCase();
  const lines = pr.additions + pr.deletions;
  // GitHub lists at most 3,000 files; past that the band can't be trusted to be low.
  const known = pr.changedFiles <= 3000 ? files : [];
  const { risk, reasons } = riskBand(cfg, known, lines);
  const latest = pr.latestOpinionatedReviews?.nodes ?? [];
  const human = (r: (typeof latest)[number]) => !!r.author && r.author.login !== author && !r.author.login.endsWith("[bot]");
  const threads = pr.reviewThreads;
  const repo = `${ref.owner}/${ref.repo}`.toLowerCase();
  return {
    target,
    sha: pr.headRefOid,
    state: pr.state,
    draft: pr.isDraft,
    title: pr.title,
    author,
    author_association: assoc,
    first_time_contributor: FIRST_TIME.includes(assoc),
    tone: FIRST_TIME.includes(assoc) ? cfg.tone.first_time : TRUSTED.includes(assoc) ? cfg.tone.maintainer : cfg.tone.default,
    changed_lines: lines,
    additions: pr.additions,
    deletions: pr.deletions,
    files,
    risk,
    risk_reasons: reasons,
    ci: ciState(pr.commits.nodes[0]?.commit.statusCheckRollup?.state, runs),
    ci_runs: latestRuns(runs ?? []).map((r) => {
      const url = (r as WorkflowRun & { html_url?: string }).html_url; // GitHub sends it; the type leaves it out
      return `${r.name} #${r.id}: ${r.status === "completed" ? r.conclusion ?? "completed" : r.status}${url ? ` ${url}` : ""}`;
    }),
    mergeable: pr.mergeable,
    merge_state: pr.mergeStateStatus,
    review_decision: pr.reviewDecision,
    approvals: latest.filter((r) => r.state === "APPROVED" && human(r) && TRUSTED.includes(r.authorAssociation)).map((r) => r.author!.login),
    changes_requested: latest.filter((r) => r.state === "CHANGES_REQUESTED" && !!r.author).map((r) => r.author!.login),
    unresolved_threads: threads.totalCount > threads.nodes.length ? null : threads.nodes.filter((t) => !t.isResolved).length,
    age_days: Math.floor((now - Date.parse(pr.createdAt)) / 86_400_000),
    path_notes: cfg.path_rules
      .filter((p) => (!p.repo || p.repo.toLowerCase() === repo) && matching(files, [p.glob]).length)
      .map((p) => `${p.glob}: ${p.note}`),
  };
}

export async function prFacts(ctx: Ctx, ref: Required<RepoRef>): Promise<PrFacts> {
  const gh = await ctx.github();
  const pr = await gh.prDetail(ref);
  const [files, runs] = await Promise.all([gh.pullFiles(ref), gh.runsAt(ref, pr.headRefOid).catch(() => null)]);
  return factsFrom(reviewConfig(ctx), ref, pr, files, runs);
}

// ---- merge checks -------------------------------------------------------------

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * What a merge needs (decision 35), checked when it is queued and again just before
 * it runs. A low-risk PR may merge on Matt's card approval without another
 * maintainer's review (decision 35), and so may a medium-risk one (C-6):
 * every other check here must still pass at the reviewed head, both times. A
 * high-risk PR needs a maintainer's approval on GitHub.
 */
export function mergeChecks(f: PrFacts, reviewedSha: string, review: Review | null): Check[] {
  const head = f.sha.slice(0, 7);
  const c = (name: string, ok: boolean, detail: string): Check => ({ name, ok, detail });
  const mergeOk = f.mergeable === "MERGEABLE" && ["CLEAN", "HAS_HOOKS"].includes(f.merge_state);
  return [
    c("open", f.state === "OPEN" && !f.draft, f.state !== "OPEN" ? `the PR is ${f.state.toLowerCase()}` : f.draft ? "the PR is a draft" : "open, not a draft"),
    c("reviewed head", reviewedSha.length >= 7 && f.sha.startsWith(reviewedSha), `head is ${head}${reviewedSha ? `, reviewed ${reviewedSha.slice(0, 7)}` : ", no reviewed sha given"}`),
    c(
      "review check",
      !!review && review.sha === f.sha && review.verdict !== "request_changes",
      !review || review.sha !== f.sha ? `no review posted at ${head}` : review.verdict === "request_changes" ? `${review.id} has blocking findings` : `${review.id}, nothing blocking`,
    ),
    c("CI green", f.ci === "success", f.ci === "none" ? "no CI has reported at this commit" : f.ci === "waiting" ? "runs are waiting for approval" : `CI is ${f.ci}`),
    c("mergeable", mergeOk, mergeOk ? `GitHub reports ${f.merge_state}` : f.mergeable !== "MERGEABLE" ? `mergeable is ${f.mergeable}` : `GitHub reports ${f.merge_state}`),
    c(
      "no changes requested",
      !f.changes_requested.length && f.review_decision !== "CHANGES_REQUESTED",
      f.changes_requested.length ? `changes requested by ${f.changes_requested.join(", ")}` : "none",
    ),
    c("threads resolved", f.unresolved_threads === 0, f.unresolved_threads === null ? "too many threads to check" : `${f.unresolved_threads} unresolved`),
    f.risk === "low"
      ? c("maintainer approval", true, "not needed for a low-risk PR")
      : f.risk === "medium" && !f.approvals.length
        ? c("maintainer approval", true, "none on GitHub; for a medium-risk PR, Matt's approval of this card stands in for it")
        : c("maintainer approval", f.approvals.length > 0, f.approvals.length ? `approved by ${f.approvals.join(", ")}` : `none yet; a ${f.risk}-risk PR needs one`),
  ];
}

export const failed = (checks: Check[]) => checks.filter((c) => !c.ok);
export const checklist = (checks: Check[]) => checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`).join("\n");

const FINDING_CARD_MAX = 400;

/**
 * What the gateway itself puts on every github.merge card (C-6), from facts it
 * fetched rather than the proposer's word: the files and lines changed, Mira's review
 * and its findings by severity, the CI runs at the head, and links to the PR and diff.
 * The proposer's rationale above it describes the change and the discussion.
 */
export function mergeCard(f: PrFacts, review: Review | null, findings: Pick<Finding, "path" | "line" | "severity" | "area" | "summary">[]): string {
  const [repo, number] = f.target.split("#");
  const url = `https://github.com/${repo}/pull/${number}`;
  const shown = 10;
  const order = (s: string) => (SEVERITIES as readonly string[]).indexOf(s);
  const sorted = [...findings].sort((a, b) => order(a.severity) - order(b.severity));
  const cut = (t: string) => (t.length > FINDING_CARD_MAX ? `${t.slice(0, FINDING_CARD_MAX - 1)}…` : t);
  return [
    `The change at ${f.sha.slice(0, 7)}: "${f.title}" by ${f.author ?? "unknown"}`,
    `- ${f.files.length} file${f.files.length === 1 ? "" : "s"}, +${f.additions} −${f.deletions} lines: ${f.files.slice(0, shown).join(", ")}${f.files.length > shown ? ` and ${f.files.length - shown} more` : ""}`,
    `- PR: ${url}`,
    `- Diff: ${url}/files`,
    "",
    review
      ? `Mira's review ${review.id} (${review.decision_id ?? "no decision"}) at ${review.sha.slice(0, 7)}: ${findings.length} finding${findings.length === 1 ? "" : "s"}${review.url ? `, ${review.url}` : ""}`
      : `Mira's review: none at ${f.sha.slice(0, 7)}`,
    ...sorted.map((x) => `- ${x.severity} · ${x.area}${x.path ? ` · ${x.path}${x.line ? `:${x.line}` : ""}` : ""}: ${cut(x.summary)}`),
    "",
    `CI at ${f.sha.slice(0, 7)}: ${f.ci}`,
    ...(f.ci_runs.length ? f.ci_runs.map((r) => `- ${r}`) : ["- no workflow runs"]),
  ].join("\n");
}

// ---- the review queue ---------------------------------------------------------

/**
 * Open PRs in the order Mira should look at them: first-time contributors, then
 * age, then green CI and small size. Age counts for two weeks at most, so new PRs
 * aren't stuck behind the backlog (decision 39). Drafts and PRs already reviewed at
 * their current head are listed but marked.
 */
export function queueFrom(repo: string, pulls: OpenPull[], reviewed: Set<string>, now = Date.now()) {
  return pulls
    .map((p) => {
      const target = `${repo}#${p.number}`;
      const assoc = (p.authorAssociation ?? "").toUpperCase();
      const age = Math.floor((now - Date.parse(p.createdAt)) / 86_400_000);
      const lines = p.additions + p.deletions;
      const ci = p.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null;
      const first = FIRST_TIME.includes(assoc);
      const priority = p.isDraft ? 0 : (first ? 30 : 0) + Math.min(age, 14) + (ci === "SUCCESS" ? 10 : 0) + (lines <= 100 ? 10 : 0);
      return {
        target,
        title: p.title,
        author: p.author?.login ?? null,
        first_time_contributor: first,
        draft: p.isDraft,
        age_days: age,
        changed_lines: lines,
        ci,
        review_decision: p.reviewDecision,
        reviewed_at_head: reviewed.has(`${target.toLowerCase()}@${p.headRefOid}`),
        sha: p.headRefOid,
        priority,
      };
    })
    .sort((a, b) => b.priority - a.priority);
}

// ---- findings and review text -------------------------------------------------

export interface ReviewFinding {
  path: string | null;
  line: number | null;
  severity: Severity;
  area: string;
  summary: string;
  confidence?: "high" | "medium";
}

/** Checks findings against the config and the PR's files. Returns the findings or the problems with them. */
export function parseFindings(cfg: ReviewConfig, input: unknown, files: string[], opts: { limits: boolean }): { findings: ReviewFinding[]; errors: string[] } {
  if (!Array.isArray(input)) return { findings: [], errors: ["findings must be a list (it may be empty)"] };
  const errors: string[] = [];
  const findings: ReviewFinding[] = [];
  const areas = Object.keys(cfg.areas);
  const known = new Set(files);
  input.forEach((raw, i) => {
    const f = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const at = `findings[${i}]`;
    const severity = f.severity as Severity;
    if (!SEVERITIES.includes(severity)) errors.push(`${at}.severity must be one of ${SEVERITIES.join(", ")}`);
    const area = String(f.area ?? "");
    if (!areas.includes(area)) errors.push(`${at}.area must be one of ${areas.join(", ")}`);
    const summary = typeof f.summary === "string" ? f.summary.trim() : "";
    if (!summary) errors.push(`${at}.summary is required`);
    if (summary.length > 1500) errors.push(`${at}.summary is over 1,500 characters`);
    const path = typeof f.path === "string" && f.path.trim() ? f.path.trim().replace(/^\/+/, "") : null;
    if (path && !known.has(path)) errors.push(`${at}.path ${path} is not a file this PR changes`);
    const line = f.line === undefined || f.line === null ? null : Number(f.line);
    if (line !== null && !(Number.isInteger(line) && line > 0)) errors.push(`${at}.line must be a positive whole number or null`);
    if (line !== null && !path) errors.push(`${at} has a line but no path`);
    const confidence = f.confidence === "high" || f.confidence === "medium" ? f.confidence : undefined;
    findings.push({ path, line, severity, area, summary, ...(confidence ? { confidence } : {}) });
  });
  if (opts.limits) {
    const nits = findings.filter((f) => f.severity === "nit").length;
    if (nits > cfg.max_nits) errors.push(`keep at most ${cfg.max_nits} nits (there are ${nits})`);
    if (findings.length > cfg.max_findings) errors.push(`keep at most ${cfg.max_findings} findings (there are ${findings.length})`);
  }
  return { findings, errors };
}

export function verdictOf(findings: ReviewFinding[]): Review["verdict"] {
  if (findings.some((f) => f.severity === "blocking")) return "request_changes";
  return findings.length ? "comment" : "approve";
}

// Words that only make sense inside the agent network, never in a public review.
const META = /\/notes\/|request_review_check|submit_review|request_action|record_review_outcome|record_finding_outcome|pr_facts|pr_queue|system prompt|review check|draft review|my instructions|memory store/i;

/**
 * Problems with text the gateway is about to post publicly. Code is ignored, so a
 * decorator like `@Term` in backticks is fine; any other @mention except the PR's
 * author is refused, because it would ping someone or trigger a bot (@dependabot merge).
 */
export function publicTextProblems(text: string, author: string | null): string[] {
  const problems: string[] = [];
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const mentions = [...prose.matchAll(/(^|[^\w/.-])@([A-Za-z0-9][A-Za-z0-9-]{0,38})\b/g)].map((m) => m[2]);
  const others = [...new Set(mentions.filter((m) => !author || m.toLowerCase() !== author.toLowerCase()))];
  if (others.length) problems.push(`mentions ${others.map((m) => `@${m}`).join(", ")}: mention no one but the PR's author, and put code in backticks`);
  const meta = prose.match(META);
  if (meta) problems.push(`talks about how the review was made ("${meta[0]}"): write only about the PR`);
  return problems;
}

const VERDICT_LINE: Record<Review["verdict"], string> = {
  request_changes: "Changes are needed before this can merge.",
  comment: "Nothing blocking; some suggestions below.",
  approve: "No problems found.",
};

/**
 * Labels the gateway sets on a PR when it posts a review (decision 38), from facts it
 * worked out itself. Mira sets the PR's ai/kind:* label in triage; nothing else here
 * touches it.
 */
export const GATEWAY_LABEL = /^ai\/(risk|decision):/;

/** The kinds Mira may give a PR, one at a time, through label_pr (decision 41). */
export const KIND_LABELS = ["docs", "typo", "bugfix", "feature", "refactor", "deps", "ci/build", "test", "spam", "unclear"].map((k) => `ai/kind:${k}`);

export function reviewLabels(risk: Risk, verdict: Review["verdict"]): string[] {
  return [`ai/risk:${risk}`, `ai/decision:${verdict === "request_changes" ? "needs-changes" : "needs-review"}`];
}

/** The review as GitHub gets it: a summary body and inline comments for findings with a line. */
export function renderReview(sha: string, summary: string, findings: ReviewFinding[]) {
  const verdict = verdictOf(findings);
  const label = (f: ReviewFinding) => `**${f.severity}** · ${f.area}`;
  const counts = SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");
  const unplaced = findings.filter((f) => f.line === null);
  const body = [
    summary.trim(),
    "",
    `**${VERDICT_LINE[verdict]}**${counts ? ` Findings: ${counts}.` : ""}`,
    ...(unplaced.length ? ["", ...unplaced.map((f) => `- ${label(f)}${f.path ? ` · \`${f.path}\`` : ""}: ${f.summary}`)] : []),
    "",
    "---",
    `<sub>Automated review by Mira, an Accord Project agent, at ${sha.slice(0, 7)}. Findings are labelled blocking, should-fix or nit; a maintainer makes the final call.</sub>`,
  ].join("\n");
  const comments = findings
    .filter((f): f is ReviewFinding & { path: string; line: number } => f.line !== null && f.path !== null)
    .map((f) => ({ path: f.path, line: f.line, body: `${label(f)}\n\n${f.summary}` }));
  return { verdict, body, comments };
}
