import { describe, expect, it } from "vitest";
import { approve } from "../src/controls";
import { decisionCard, discordCard, discordCardFits } from "../src/format";
import { parseTarget } from "../src/github";
import { splitText } from "../src/telegram";
import { handleTool } from "../src/tools";
import { HEAD, NETWORK, SAFE_WORKFLOW, fakeGitHub, makeTestCtx, type FakePr } from "./helpers";

describe("parsing", () => {
  it("parses GitHub targets", () => {
    expect(parseTarget("https://github.com/accordproject/concerto/pull/812")).toEqual({ owner: "accordproject", repo: "concerto", number: 812 });
    expect(parseTarget("accordproject/concerto#5")).toEqual({ owner: "accordproject", repo: "concerto", number: 5 });
    expect(parseTarget("nonsense")).toBeNull();
  });

  it("splits long Telegram messages on line breaks", () => {
    const parts = splitText(Array.from({ length: 300 }, (_, i) => `line ${i}`.padEnd(30, ".")).join("\n"), 4000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 4000)).toBe(true);
  });
});

describe("CI approval for fork PRs", () => {
  const fakeGh = (files: string[], head = "abcdef1234567", runs = [{ id: 7, name: "Build", html_url: "u" }], workflows: { path: string; text: string }[] | null = [SAFE_WORKFLOW]) => {
    const approved: number[] = [];
    const gh = {
      pullFiles: async () => files,
      pull: async () => ({ head: { sha: head, repo: { full_name: "fork/concerto" } }, base: { repo: { full_name: "accordproject/concerto" } }, state: "open" }),
      runsAwaitingApproval: async () => runs,
      approveRun: async (_r: unknown, id: number) => approved.push(id),
      workflowFiles: async () => (workflows ? workflows : Promise.reject(new Error("GitHub GraphQL: Resource not accessible by integration"))),
    };
    return { gh, approved };
  };
  const ask = (ctx: any, payload: unknown = { sha: "abcdef1" }, risk = "low") =>
    handleTool(ctx, "mira", "s", "request_action", { kind: "github.approve_ci", target: "accordproject/concerto#12", summary: "Approve CI", rationale: "Reviewed: docs and a parser fix", risk, payload });

  it("approves waiting runs at once when the PR changes no CI-sensitive files", async () => {
    const { gh, approved } = fakeGh(["src/parser.ts", "test/parser.test.ts", "README.md"]);
    const { ctx, fakes } = makeTestCtx({ dryRun: false, github: async () => gh as any });
    const out = await ask(ctx);
    expect(out).toMatch(/D-1 done: Approved 1 CI run \(Build\)/);
    expect(approved).toEqual([7]);
    expect(fakes.sent).toHaveLength(0);
    expect(fakes.dms).toHaveLength(0);
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("executed");
  });

  it.each([
    ["uses pull_request_target", [{ path: ".github/workflows/t.yml", text: "on: pull_request_target\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n" }]],
    ["runs on a self-hosted runner", [{ path: ".github/workflows/t.yml", text: "on: pull_request\njobs:\n  t:\n    runs-on: self-hosted\n    steps:\n      - run: echo\n" }]],
    ["can't be read", null],
  ] as const)("queues for Matt when the repo's workflows %s", async (_why, workflows) => {
    const { gh, approved } = fakeGh(["src/parser.ts"], undefined, undefined, workflows as any);
    const { ctx, fakes } = makeTestCtx({ dryRun: false, github: async () => gh as any });
    const out = await ask(ctx);
    expect(out).toMatch(/Queued for Matt as D-1: the repo's workflows aren't safe/);
    expect(approved).toEqual([]);
    const d = await ctx.db.getDecision("D-1");
    expect(d?.status).toBe("open");
    expect(d?.risk).toBe("high");
    expect(fakes.sent).toHaveLength(1);
  });

  it.each([".github/workflows/ci.yml", "package.json", "packages/core/package-lock.json", "scripts/release.sh", "Cargo.toml", "src/Concerto.csproj", "Dockerfile"])(
    "queues for Matt when the PR changes %s",
    async (file) => {
      const { gh, approved } = fakeGh(["src/a.ts", file]);
      const { ctx, fakes } = makeTestCtx({ dryRun: false, github: async () => gh as any });
      const out = await ask(ctx);
      expect(out).toMatch(/Queued for Matt as D-1/);
      expect(approved).toEqual([]);
      const d = await ctx.db.getDecision("D-1");
      expect(d?.risk).toBe("high");
      expect(d?.rationale).toContain(file);
      expect(fakes.sent).toHaveLength(1);
    },
  );

  it("queues for Matt when Mira herself marks it high risk", async () => {
    const { gh, approved } = fakeGh(["src/a.ts"]);
    const { ctx } = makeTestCtx({ dryRun: false, github: async () => gh as any });
    expect(await ask(ctx, { sha: "abcdef1" }, "high")).toMatch(/Queued as D-1/);
    expect(approved).toEqual([]);
  });

  it("refuses when new commits arrived after the review", async () => {
    const { gh, approved } = fakeGh(["src/a.ts"], "9999999aaaaaa");
    const { ctx } = makeTestCtx({ dryRun: false, github: async () => gh as any });
    expect(await ask(ctx)).toMatch(/failed: PR has new commits since the review/);
    expect(approved).toEqual([]);
  });

  it("needs the reviewed sha and an in-scope PR", async () => {
    const { gh } = fakeGh(["src/a.ts"]);
    const { ctx } = makeTestCtx({ dryRun: false, github: async () => gh as any });
    await expect(ask(ctx, {})).rejects.toThrow(/payload.sha is required/);
    await expect(
      handleTool(ctx, "mira", "s", "request_action", { kind: "github.approve_ci", target: "someone/else#1", summary: "s", rationale: "r", risk: "low", payload: { sha: "abcdef1" } }),
    ).rejects.toThrow(/not in the configured repos/);
  });
});

describe("review check (decision 2A)", () => {
  const T = "accordproject/concerto#12";
  const setup = (pr: Partial<FakePr> = {}, dryRun = true) => {
    const gh = fakeGitHub(pr);
    const base = makeTestCtx().ctx.network;
    const network = { ...base, review_check_required: true, model_tiers: { deep: "claude-opus-5-5", standard: "claude-sonnet-5-5" } };
    return { gh, ...makeTestCtx({ dryRun, network, github: async () => gh as any }) };
  };
  const DRAFT = [{ path: "src/parser.ts", line: 10, severity: "blocking", area: "correctness", summary: "null deref when the input is empty", confidence: "high" }];
  const check = (ctx: any, sid: string, findings: unknown = DRAFT) =>
    handleTool(ctx, "mira", sid, "request_review_check", { target: T, sha: HEAD.slice(0, 10), findings, notes: "CI green" });
  const merge = (ctx: any, sid: string) =>
    handleTool(ctx, "mira", sid, "request_action", { kind: "github.merge", target: T, summary: "Merge", rationale: "r", risk: "medium", payload: { sha: HEAD } });

  it("refuses merge proposals from the session that wrote the review", async () => {
    const { ctx } = setup();
    await expect(merge(ctx, "sesn_review")).rejects.toThrow(/come from the review check/);
  });

  it("starts a fresh session with the typed draft and the gateway's facts", async () => {
    const { ctx, fakes } = setup();
    expect(await check(ctx, "sesn_review")).toMatch(/Review check T-1 started \(medium risk\)/);
    const create = fakes.calls.find((c) => c.method === "createSession")!.args[0] as any;
    expect(create.agentId).toBe("agent_mira");
    expect(create.text).toContain("treat it as claims to verify");
    expect(create.text).toContain("- blocking (high) · correctness · src/parser.ts:10: null deref when the input is empty");
    expect(create.text).toContain("medium risk (changes code, 40 changed lines)");
    expect(create.text).toContain("in a neutral tone");
    // Mira's review task in models.yaml (decision 65): the agent's own effort would be lower.
    expect(create.model).toEqual({ id: "claude-sonnet-5-5", effort: "high" });
    expect(create.budgetCents).toBe(150);
  });

  it("refuses findings that don't fit the PR or the review areas", async () => {
    const { ctx } = setup();
    // The tool's schema catches a severity outside its enum before the gateway reads the findings.
    await expect(check(ctx, "sesn_review", [{ severity: "major", area: "security", summary: "x" }])).rejects.toThrow(
      /findings\[0\]\.severity must be one of blocking, should-fix, nit/,
    );
    await expect(check(ctx, "sesn_review", [{ path: "src/other.ts", line: 3, severity: "nit", area: "style", summary: "x" }])).rejects.toThrow(
      /area must be one of[\s\S]*path src\/other.ts is not a file this PR changes/,
    );
  });

  it("checks high-risk PRs on the deep tier", async () => {
    const { ctx, fakes } = setup({ additions: 600 });
    await check(ctx, "sesn_review");
    const create = fakes.calls.find((c) => c.method === "createSession")!.args[0] as any;
    expect(create.model).toEqual({ id: "claude-opus-5-5", effort: "high" });
    expect(create.budgetCents).toBe(300);
  });

  it("falls back to the deep tier's model when models.yaml has no check task", async () => {
    const gh = fakeGitHub({ additions: 600 });
    const base = makeTestCtx().ctx.network;
    const mira = { ...base.agents.mira, tasks: undefined };
    const network = { ...base, review_check_required: true, agents: { ...base.agents, mira } };
    const { ctx, fakes } = makeTestCtx({ network, github: async () => gh as any });
    await check(ctx, "sesn_review");
    const create = fakes.calls.find((c) => c.method === "createSession")!.args[0] as any;
    expect(create.model).toEqual({ id: "claude-opus-5-5" });
  });

  it("refuses a draft of an old head, and a check starting another check", async () => {
    const { ctx, fakes, gh } = setup();
    await check(ctx, "sesn_review");
    await expect(check(ctx, Object.keys(fakes.sessions)[0])).rejects.toThrow(/You are the review check/);
    gh.pr.head = "9999999999999999999999999999999999999999";
    await expect(check(ctx, "sesn_review")).rejects.toThrow(/new commits \(head is 9999999\)/);
  });
});

describe("posting reviews (decision 36)", () => {
  const T = "accordproject/concerto#12";
  const setup = (pr: Partial<FakePr> = {}, dryRun = false) => {
    const gh = fakeGitHub(pr);
    const base = makeTestCtx().ctx.network;
    return { gh, ...makeTestCtx({ dryRun, network: { ...base, review_check_required: true }, github: async () => gh as any }) };
  };
  const startCheck = async (ctx: any, fakes: any) => {
    await handleTool(ctx, "mira", "sesn_review", "request_review_check", { target: T, sha: HEAD, findings: [] });
    return Object.keys(fakes.sessions).at(-1)!;
  };
  const submit = (ctx: any, sid: string, findings: unknown[] = [], summary = "A clear fix with a test. Thank you.") =>
    handleTool(ctx, "mira", sid, "submit_review", { target: T, summary, findings });
  const SHOULD = { path: "src/parser.ts", line: 12, severity: "should-fix", area: "tests", summary: "Add a test for the empty input." };

  it("only a review check submits, and only for its own PR", async () => {
    const { ctx, fakes } = setup();
    await expect(submit(ctx, "sesn_review")).rejects.toThrow(/Only a review check submits reviews/);
    const sid = await startCheck(ctx, fakes);
    await expect(handleTool(ctx, "mira", sid, "submit_review", { target: "accordproject/concerto#13", summary: "s", findings: [] })).rejects.toThrow(/This check is for accordproject\/concerto#12/);
  });

  it("posts one comment-only review with inline findings, records it, and sends no card", async () => {
    const { ctx, fakes, gh } = setup();
    const sid = await startCheck(ctx, fakes);
    const out = await submit(ctx, sid, [SHOULD, { severity: "nit", area: "docs", summary: "Mention the change in the changelog." }]);
    expect(out).toMatch(/^R-1 \(D-1\) Posted review: https:\/\/github.com\/\S+ and labelled it ai\/risk:medium, ai\/decision:needs-review\. Nothing blocking\. If CI is green/);
    expect(gh.posted).toHaveLength(1);
    const review = gh.posted[0];
    expect(review.commit_id).toBe(HEAD);
    expect(review.comments).toEqual([{ path: "src/parser.ts", line: 12, body: "**should-fix** · tests\n\nAdd a test for the empty input." }]);
    expect(review.body).toContain("Nothing blocking; some suggestions below.** Findings: 1 should-fix, 1 nit.");
    expect(review.body).toContain("- **nit** · docs: Mention the change in the changelog.");
    expect(review.body).toContain("Automated review by Mira, an Accord Project agent, at abcdef1");
    expect((await ctx.db.getDecision("D-1"))?.status).toBe("executed");
    expect(fakes.sent).toHaveLength(0);
    expect(fakes.dms).toHaveLength(0);
    const open = JSON.parse(await handleTool(ctx, "mira", "s", "review_findings", {}));
    expect(open.findings.map((f: any) => [f.id, f.severity, f.area])).toEqual([["F-1", "should-fix", "tests"], ["F-2", "nit", "docs"]]);
    await expect(submit(ctx, sid)).rejects.toThrow(/already posted at abcdef1/);
  });

  it("labels the PR with the risk band and what happens next, keeping other labels", async () => {
    const { ctx, fakes, gh } = setup({ labels: ["ai/kind:bugfix", "ai/risk:low", "ai/decision:needs-changes", "bug"] });
    const sid = await startCheck(ctx, fakes);
    expect(await submit(ctx, sid, [SHOULD])).toMatch(/Posted review: \S+ and labelled it ai\/risk:medium, ai\/decision:needs-review\. Nothing blocking/);
    expect(gh.pr.labels.sort()).toEqual(["ai/decision:needs-review", "ai/kind:bugfix", "ai/risk:medium", "bug"]);
  });

  it("labels a blocking review needs-changes", async () => {
    const { ctx, fakes, gh } = setup();
    const sid = await startCheck(ctx, fakes);
    await submit(ctx, sid, [{ ...SHOULD, severity: "blocking", area: "correctness" }]);
    expect(gh.pr.labels).toEqual(["ai/risk:medium", "ai/decision:needs-changes"]);
  });

  it("still records the review when GitHub refuses the labels", async () => {
    const { ctx, fakes, gh } = setup();
    gh.rejectLabels = true;
    const sid = await startCheck(ctx, fakes);
    expect(await submit(ctx, sid)).toMatch(/Posted review: \S+ but couldn't label it \(GitHub GET \/labels: 403/);
    expect((await ctx.db.latestReview(T))?.url).toMatch(/^https:\/\/github.com\//);
  });

  it("says a blocking review rules out the merge", async () => {
    const { ctx, fakes } = setup();
    const sid = await startCheck(ctx, fakes);
    expect(await submit(ctx, sid, [{ ...SHOULD, severity: "blocking", area: "correctness" }])).toMatch(/blocking findings: don't propose the merge/);
  });

  it("refuses text that pings people or bots, or talks about how it was made", async () => {
    const { ctx, fakes, gh } = setup();
    const sid = await startCheck(ctx, fakes);
    await expect(submit(ctx, sid, [], "Looks good. @dependabot merge")).rejects.toThrow(/mentions @dependabot/);
    await expect(submit(ctx, sid, [], "Thanks @contrib. The review check confirmed it.")).rejects.toThrow(/talks about how the review was made \("review check"\)/);
    await expect(submit(ctx, sid, [{ ...SHOULD, summary: "Use the `@Term` decorator, as @samlee said" }])).rejects.toThrow(/findings\[0\] mentions @samlee/);
    expect(gh.posted).toHaveLength(0);
    expect(await submit(ctx, sid, [{ ...SHOULD, summary: "Use the `@Term` decorator here, @contrib." }])).toMatch(/Posted review/);
  });

  it("keeps to the nit and finding limits", async () => {
    const { ctx, fakes } = setup();
    const sid = await startCheck(ctx, fakes);
    const nit = { severity: "nit", area: "docs", summary: "Typo." };
    await expect(submit(ctx, sid, [nit, nit, nit, nit])).rejects.toThrow(/keep at most 3 nits \(there are 4\)/);
  });

  it("moves findings into the summary when GitHub refuses the inline comments", async () => {
    const { ctx, fakes, gh } = setup();
    gh.rejectInline = true;
    const sid = await startCheck(ctx, fakes);
    expect(await submit(ctx, sid, [SHOULD])).toMatch(/GitHub refused the inline comments/);
    expect(gh.posted[0].comments).toEqual([]);
    expect(gh.posted[0].body).toContain("- `src/parser.ts:12` **should-fix** · tests: Add a test for the empty input.\n\n---");
  });

  it("stops if the PR moved on during the check", async () => {
    const { ctx, fakes, gh } = setup();
    const sid = await startCheck(ctx, fakes);
    gh.pr.head = "9999999999999999999999999999999999999999";
    await expect(submit(ctx, sid)).rejects.toThrow(/new commits \(head is 9999999, checked abcdef1\)/);
  });

  it("refuses to post when github.review isn't set up as an auto kind", async () => {
    const { ctx, fakes, gh } = setup();
    const sid = await startCheck(ctx, fakes);
    const { "github.review": _, ...kinds } = ctx.network.action_kinds;
    ctx.network = { ...ctx.network, action_kinds: kinds };
    await expect(submit(ctx, sid)).rejects.toThrow(/Posting reviews isn't set up/);
    expect(gh.posted).toHaveLength(0);
    expect(await ctx.db.latestReview(T)).toBeNull();
  });

  it("can't be requested through request_action", async () => {
    const { ctx } = setup();
    await expect(handleTool(ctx, "mira", "s", "request_action", { kind: "github.review", target: T, summary: "s", rationale: "r", risk: "low" })).rejects.toThrow();
  });
});

describe("merge checks (decision 35)", () => {
  const T = "accordproject/concerto#12";
  const setup = (pr: Partial<FakePr> = {}) => {
    const gh = fakeGitHub(pr);
    const base = makeTestCtx().ctx.network;
    return { gh, ...makeTestCtx({ dryRun: false, network: { ...base, review_check_required: true }, github: async () => gh as any }) };
  };
  /** Runs a review check that posts the given findings, and returns the check's session id. */
  const reviewed = async (ctx: any, fakes: any, findings: unknown[] = []) => {
    await handleTool(ctx, "mira", "sesn_review", "request_review_check", { target: T, sha: HEAD, findings: [] });
    const sid = Object.keys(fakes.sessions).at(-1)!;
    await handleTool(ctx, "mira", sid, "submit_review", { target: T, summary: "A clear fix.", findings });
    return sid;
  };
  const merge = (ctx: any, sid: string, payload: unknown = { sha: HEAD }) =>
    handleTool(ctx, "mira", sid, "request_action", { kind: "github.merge", target: T, summary: "Merge the parser fix", rationale: "Verified the fix.", risk: "low", payload });

  it("queues a ready PR with the checks on the card, and merges the checked head once approved", async () => {
    const { ctx, fakes, gh } = setup();
    const sid = await reviewed(ctx, fakes);
    expect(await merge(ctx, sid)).toMatch(/Queued as D-2/);
    const d = (await ctx.db.getDecision("D-2"))!;
    expect(d.risk).toBe("medium");
    expect(d.rationale).toContain("Gateway checks at abcdef1 (medium risk: changes code, 40 changed lines):");
    expect(d.rationale).toContain("✓ CI green: CI is success");
    expect(d.rationale).toContain("✓ maintainer approval: approved by samlee");
    expect(fakes.sent.at(-1)?.text ?? fakes.dms.at(-1)?.content).toContain("✓ review check: R-1, nothing blocking");
    expect(await approve(ctx, "D-2")).toBe("D-2: Merged as feedfac");
    expect(gh.merged).toEqual([{ method: "squash", sha: HEAD }]);
    expect((await ctx.db.latestReview(T))?.outcome).toBe("merged");
    expect((await ctx.db.latestReview(T))?.merge_decision_id).toBe("D-2");
  });

  it("needs the reviewed sha and a posted review without blocking findings", async () => {
    const { ctx, fakes } = setup();
    await handleTool(ctx, "mira", "sesn_review", "request_review_check", { target: T, sha: HEAD, findings: [] });
    const sid = Object.keys(fakes.sessions).at(-1)!;
    await expect(merge(ctx, sid, {})).rejects.toThrow(/payload.sha is required/);
    await expect(merge(ctx, sid)).rejects.toThrow(/✗ review check: no review posted at abcdef1/);
    await handleTool(ctx, "mira", sid, "submit_review", { target: T, summary: "s", findings: [{ severity: "blocking", area: "correctness", summary: "Breaks parsing." }] });
    await expect(merge(ctx, sid)).rejects.toThrow(/✗ review check: R-1 has blocking findings/);
    expect(fakes.sent.filter((m) => m.text.includes("github.merge"))).toHaveLength(0);
  });

  it("needs a maintainer's approval on GitHub only when the PR is high risk (C-6)", async () => {
    const big = setup({ reviews: [], additions: 300, deletions: 200 });
    await expect(merge(big.ctx, await reviewed(big.ctx, big.fakes))).rejects.toThrow(/✗ maintainer approval: none yet; a high-risk PR needs one/);

    const workflow = setup({ reviews: [], files: ["src/parser.ts", ".github/workflows/ci.yml"] });
    await expect(merge(workflow.ctx, await reviewed(workflow.ctx, workflow.fakes))).rejects.toThrow(/✗ maintainer approval: none yet; a high-risk PR needs one/);

    const code = setup({ reviews: [] });
    expect(await merge(code.ctx, await reviewed(code.ctx, code.fakes))).toMatch(/Queued as D-2/);
    const d = (await code.ctx.db.getDecision("D-2"))!;
    expect(d.risk).toBe("medium");
    expect(d.rationale).toContain("✓ maintainer approval: none on GitHub; for a medium-risk PR, Matt's approval of this card stands in for it");

    const docs = setup({ reviews: [], files: ["README.md", "docs/intro.md"], additions: 12, deletions: 3 });
    expect(await merge(docs.ctx, await reviewed(docs.ctx, docs.fakes))).toMatch(/Queued as D-2/);
    expect((await docs.ctx.db.getDecision("D-2"))!.rationale).toContain("✓ maintainer approval: not needed for a low-risk PR");

    const self = setup({ reviews: [{ login: "contrib", state: "APPROVED" }], additions: 300, deletions: 200 }); // the author's own approval doesn't count
    await expect(merge(self.ctx, await reviewed(self.ctx, self.fakes))).rejects.toThrow(/✗ maintainer approval: none yet; a high-risk PR needs one/);
  });

  it.each([
    [{ runs: [{ id: 1, workflow_id: 10, event: "pull_request", status: "action_required", conclusion: null }] }, /runs are waiting for approval/],
    [{ runs: [{ id: 1, workflow_id: 10, event: "pull_request", status: "completed", conclusion: "failure" }] }, /CI is failure/],
    [{ runs: [], rollup: null }, /no CI has reported at this commit/],
    [{ runs: null }, /CI is unknown/],
    [{ mergeState: "BLOCKED" }, /✗ mergeable: GitHub reports BLOCKED/],
    [{ reviews: [{ login: "samlee", state: "APPROVED" as const }, { login: "alikhan", state: "CHANGES_REQUESTED" as const }] }, /changes requested by alikhan/],
    [{ unresolved: 2 }, /✗ threads resolved: 2 unresolved/],
    [{ draft: true }, /✗ open: the PR is a draft/],
  ])("refuses when %o", async (pr, why) => {
    const { ctx, fakes } = setup(pr as Partial<FakePr>);
    await expect(merge(ctx, await reviewed(ctx, fakes))).rejects.toThrow(why);
  });

  it("raises PRs that change workflows to high risk, so the card stays on Telegram", async () => {
    const { ctx, fakes } = setup({ files: ["src/parser.ts", ".github/workflows/ci.yml"] });
    expect(await merge(ctx, await reviewed(ctx, fakes))).toMatch(/Queued as D-2/);
    expect((await ctx.db.getDecision("D-2"))!.risk).toBe("high");
    expect(fakes.dms.some((m) => m.content.includes("D-2"))).toBe(false);
  });

  it("checks again at approval and refuses if the PR changed", async () => {
    const { ctx, fakes, gh } = setup();
    await merge(ctx, await reviewed(ctx, fakes));
    gh.pr.head = "9999999999999999999999999999999999999999";
    expect(await approve(ctx, "D-2")).toMatch(/Not merged; the PR changed since the proposal:\n✗ reviewed head: head is 9999999, reviewed abcdef1/);
    expect(gh.merged).toEqual([]);
    expect((await ctx.db.getDecision("D-2"))?.status).toBe("failed");
  });

  it.each([
    ["CI fails", (gh: any) => (gh.pr.runs = [{ id: 2, workflow_id: 10, event: "pull_request", status: "completed", conclusion: "failure" }]), /✗ CI green: CI is failure/],
    ["a conflict appears", (gh: any) => (gh.pr.mergeable = "CONFLICTING"), /✗ mergeable: mergeable is CONFLICTING/],
    ["a thread is opened", (gh: any) => (gh.pr.unresolved = 1), /✗ threads resolved: 1 unresolved/],
    ["the head moves", (gh: any) => (gh.pr.head = "9999999999999999999999999999999999999999"), /✗ reviewed head: head is 9999999, reviewed abcdef1/],
  ])("refuses a medium-risk merge without a GitHub approval at approval time when %s", async (_why, change, why) => {
    const { ctx, fakes, gh } = setup({ reviews: [] });
    expect(await merge(ctx, await reviewed(ctx, fakes))).toMatch(/Queued as D-2/);
    change(gh);
    const out = await approve(ctx, "D-2");
    expect(out).toMatch(/Not merged; the PR changed since the proposal/);
    expect(out).toMatch(why);
    expect(gh.merged).toEqual([]);
    expect((await ctx.db.getDecision("D-2"))?.status).toBe("failed");
  });

  it("merges a medium-risk PR without a GitHub approval once Matt approves the card, if every check still passes", async () => {
    const { ctx, fakes, gh } = setup({ reviews: [] });
    expect(await merge(ctx, await reviewed(ctx, fakes))).toMatch(/Queued as D-2/);
    expect(await approve(ctx, "D-2")).toBe("D-2: Merged as feedfac");
    expect(gh.merged).toEqual([{ method: "squash", sha: HEAD }]);
  });

  it("puts the change, Mira's findings, the CI runs and the links on the merge card (C-6)", async () => {
    const { ctx, fakes } = setup({ files: ["src/parser.ts", "test/parser.test.ts"], additions: 30, deletions: 10 });
    const sid = await reviewed(ctx, fakes, [
      { path: "src/parser.ts", line: 10, severity: "nit", area: "conventions", summary: "Name the constant." },
      { path: "src/parser.ts", line: 12, severity: "should-fix", area: "tests", summary: "Add a test for empty input." },
    ]);
    expect(await merge(ctx, sid)).toMatch(/Queued as D-2/);
    const d = (await ctx.db.getDecision("D-2"))!;
    expect(d.rationale).toMatch(/^Verified the fix\.\n\nThe change at abcdef1: /);
    expect(d.rationale).toContain("- 2 files, +30 −10 lines: src/parser.ts, test/parser.test.ts");
    expect(d.rationale).toContain("- PR: https://github.com/accordproject/concerto/pull/12\n- Diff: https://github.com/accordproject/concerto/pull/12/files");
    expect(d.rationale).toMatch(/Mira's review R-1 \(D-1\) at abcdef1: 2 findings, https:\/\/github\.com\/\S+/);
    // Most severe first.
    expect(d.rationale).toContain("- should-fix · tests · src/parser.ts:12: Add a test for empty input.\n- nit · conventions · src/parser.ts:10: Name the constant.");
    expect(d.rationale).toContain("CI at abcdef1: success\n- wf10 #1: success");
    expect(d.rationale.indexOf("CI at abcdef1")).toBeLessThan(d.rationale.indexOf("Gateway checks at abcdef1"));
    expect(decisionCard(d)).toContain("- Diff: https://github.com/accordproject/concerto/pull/12/files");
  });

  it("shows a merge card's whole rationale on Discord in an embed, never cut silently", async () => {
    const { ctx, fakes } = setup({ reviews: [] });
    const sid = await reviewed(ctx, fakes);
    await merge(ctx, sid);
    const d = (await ctx.db.getDecision("D-2"))!;
    const card = discordCard(d);
    expect(card.content).not.toContain("Gateway checks at");
    expect(card.embeds![0]).toMatchObject({ title: "Why, and what the gateway found", description: d.rationale });
    expect(discordCardFits(d)).toBe(true);
    expect(card.buttons!.map((b) => b.label)).toEqual(["Approve", "Reject", "Ask Ada"]);

    const long = { ...d, rationale: `${"A long account of the discussion. ".repeat(250)}\n\n${d.rationale}` };
    expect(discordCardFits(long)).toBe(false);
    expect(discordCard(long).buttons!.map((b) => b.label)).toEqual(["Reject", "Ask Ada"]);
    expect(decisionCard(long)).toContain("Gateway checks at abcdef1");
  });

  it("applies the checks even when the review-check rule is off", async () => {
    const gh = fakeGitHub();
    const { ctx } = makeTestCtx({ dryRun: false, github: async () => gh as any });
    await expect(merge(ctx, "sesn_any")).rejects.toThrow(/✗ review check: no review posted/);
  });
});

describe("risk and CI in code", () => {
  it("matches globs like the config says", async () => {
    const { globToRegExp } = await import("../src/review");
    expect(globToRegExp("*.md").test("packages/core/README.md")).toBe(true);
    expect(globToRegExp("docs/**").test("docs/a/b.md")).toBe(true);
    expect(globToRegExp("docs/**").test("src/docs/a.md")).toBe(false);
    expect(globToRegExp("**/test/**").test("test/a.js")).toBe(true);
    expect(globToRegExp("**/test/**").test("packages/core/test/a.js")).toBe(true);
    expect(globToRegExp("*.test.ts").test("src/a.test.ts")).toBe(true);
    expect(globToRegExp(".releaserc*").test(".releaserc.json")).toBe(true);
  });

  it("bands risk from files and size", async () => {
    const { DEFAULT_REVIEW, riskBand } = await import("../src/review");
    expect(riskBand(DEFAULT_REVIEW, ["README.md", "packages/core/test/a.js"], 50).risk).toBe("low");
    expect(riskBand(DEFAULT_REVIEW, ["README.md"], 150).risk).toBe("medium");
    expect(riskBand(DEFAULT_REVIEW, ["src/a.ts"], 10).risk).toBe("medium");
    expect(riskBand(DEFAULT_REVIEW, ["src/a.ts", "package.json"], 10)).toEqual({ risk: "high", reasons: ["changes package.json"] });
    expect(riskBand(DEFAULT_REVIEW, ["AGENTS.md"], 4).reasons).toEqual(["changes review guidance (AGENTS.md)"]);
    expect(riskBand(DEFAULT_REVIEW, ["src/a.ts"], 401).risk).toBe("high");
    expect(riskBand(DEFAULT_REVIEW, [], 3).risk).toBe("medium");
  });

  it("counts only the newest run of each workflow, and fails closed", async () => {
    const { ciState } = await import("../src/review");
    const run = (id: number, conclusion: string | null, status = "completed", workflow_id = 10) => ({ id, name: "CI", workflow_id, event: "pull_request", status, conclusion });
    expect(ciState("SUCCESS", [run(1, "failure"), run(2, "success")])).toBe("success");
    expect(ciState("SUCCESS", [run(1, "success"), run(2, "cancelled")])).toBe("failure");
    expect(ciState("SUCCESS", [run(1, "success"), run(2, null, "in_progress", 11)])).toBe("pending");
    expect(ciState("SUCCESS", [run(1, null, "action_required")])).toBe("waiting");
    expect(ciState("PENDING", [run(1, "success")])).toBe("pending");
    expect(ciState("FAILURE", [])).toBe("failure");
    expect(ciState(null, [])).toBe("none");
    expect(ciState("SUCCESS", null)).toBe("unknown");
    expect(ciState("SUCCESS", [run(1, "skipped"), run(2, "neutral", "completed", 11)])).toBe("success");
  });

  it("gives Mira the facts, the tone, and the merge checks as they stand", async () => {
    const gh = fakeGitHub({ association: "FIRST_TIME_CONTRIBUTOR", files: ["src/samples/a.cto"] });
    const network = { ...NETWORK, review: { ...(await import("../src/review")).DEFAULT_REVIEW, path_rules: [{ glob: "src/samples/**", note: "Must compile." }] } };
    const { ctx } = makeTestCtx({ network, github: async () => gh as any });
    const f = JSON.parse(await handleTool(ctx, "mira", "s", "pr_facts", { target: "accordproject/concerto#12" }));
    expect(f).toMatchObject({ sha: HEAD, risk: "medium", first_time_contributor: true, tone: "welcoming", ci: "success", approvals: ["samlee"], path_notes: ["src/samples/**: Must compile."], last_review: null });
    expect(f.merge_checks).toContain("✗ review check: no review posted at abcdef1");
    await expect(handleTool(ctx, "mira", "s", "pr_facts", { target: "someone/else#1" })).rejects.toThrow(/not in the configured repos/);
    await expect(handleTool(ctx, "otto", "s", "pr_facts", { target: "accordproject/concerto#12" })).rejects.toThrow(/not available to otto/);
  });

  it("orders the review queue and marks PRs already reviewed at their head", async () => {
    const { queueFrom } = await import("../src/review");
    const now = Date.parse("2026-11-01T00:00:00Z");
    const pull = (number: number, days: number, extra: object = {}) => ({
      number, title: `PR ${number}`, isDraft: false, createdAt: new Date(now - days * 86_400_000).toISOString(), headRefOid: `sha${number}`,
      additions: 10, deletions: 0, authorAssociation: "CONTRIBUTOR", author: { login: "x" }, reviewDecision: null,
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] }, ...extra,
    });
    const q = queueFrom("accordproject/concerto", [pull(1, 20), pull(2, 3, { authorAssociation: "FIRST_TIME_CONTRIBUTOR" }), pull(3, 40, { isDraft: true })], new Set(["accordproject/concerto#1@sha1"]), now);
    expect(q.map((p) => [p.target, p.priority, p.reviewed_at_head])).toEqual([
      ["accordproject/concerto#2", 53, false],
      ["accordproject/concerto#1", 34, true],
      ["accordproject/concerto#3", 0, false],
    ]);
    // Age counts for two weeks at most (decision 39), so a fresh first-time PR isn't stuck behind the backlog.
    const fresh = queueFrom("accordproject/concerto", [pull(4, 365), pull(5, 1, { authorAssociation: "FIRST_TIME_CONTRIBUTOR" })], new Set(), now);
    expect(fresh.map((p) => [p.target, p.priority])).toEqual([["accordproject/concerto#5", 51], ["accordproject/concerto#4", 34]]);
  });
});

describe("review outcomes", () => {
  it("records what came of findings and reviews, and reports the precision by area", async () => {
    const gh = fakeGitHub();
    const base = makeTestCtx().ctx.network;
    const { ctx, fakes } = makeTestCtx({ dryRun: false, network: { ...base, review_check_required: true }, github: async () => gh as any });
    await handleTool(ctx, "mira", "sesn_review", "request_review_check", { target: "accordproject/concerto#12", sha: HEAD, findings: [] });
    const sid = Object.keys(fakes.sessions).at(-1)!;
    await handleTool(ctx, "mira", sid, "submit_review", {
      target: "accordproject/concerto#12", summary: "s",
      findings: [{ severity: "should-fix", area: "tests", summary: "a" }, { severity: "should-fix", area: "tests", summary: "b" }],
    });
    expect(await handleTool(ctx, "mira", "s", "record_finding_outcome", { id: "f-1", outcome: "acted" })).toBe("F-1: acted.");
    await handleTool(ctx, "mira", "s", "record_finding_outcome", { id: "F-2", outcome: "dismissed", note: "samlee: covered elsewhere" });
    await expect(handleTool(ctx, "mira", "s", "record_finding_outcome", { id: "F-9", outcome: "acted" })).rejects.toThrow(/No finding F-9/);
    await handleTool(ctx, "mira", "s", "record_review_outcome", { target: "accordproject/concerto#12", outcome: "closed", note: "superseded by #14" });
    await expect(handleTool(ctx, "mira", "s", "record_review_outcome", { target: "accordproject/concerto#99", outcome: "closed" })).rejects.toThrow(/has no posted review/);

    const r = JSON.parse(await handleTool(ctx, "mira", "s", "review_findings", { status: "all" }));
    expect(r.findings.map((f: any) => f.outcome)).toEqual(["acted", "dismissed"]);
    expect(r.stats.findings).toEqual([{ area: "tests", severity: "should-fix", posted: 2, acted: 1, dismissed: 1 }]);
    expect(r.stats.reviews).toEqual([{ risk: "medium", verdict: "comment", reviews: 1, merges_approved: null, merges_rejected: null, merged: 0, closed: 1, reverted_or_fixed: 0 }]);
    expect(JSON.parse(await handleTool(ctx, "mira", "s", "review_findings", {})).findings).toEqual([]);
  });
});

describe("AGENTS.md lessons (github.docs_pr)", () => {
  it("only writes guidance files", async () => {
    const { isGuidanceFile } = await import("../src/executors");
    expect(isGuidanceFile("AGENTS.md")).toBe(true);
    expect(isGuidanceFile("packages/concerto-core/AGENTS.md")).toBe(true);
    expect(isGuidanceFile("CONTRIBUTING.md")).toBe(true);
    expect(isGuidanceFile("src/index.ts")).toBe(false);
    expect(isGuidanceFile(".github/workflows/AGENTS.md.yml")).toBe(false);
    expect(isGuidanceFile("../AGENTS.md")).toBe(false);
  });

  it("opens a PR on a new branch when approved", async () => {
    const { executeDecision } = await import("../src/executors");
    const calls: [string, string, any][] = [];
    const { GitHub } = await import("../src/github");
    const fetchImpl = (async (url: string, init: any) => {
      const path = new URL(url).pathname + new URL(url).search;
      calls.push([init.method, path, init.body ? JSON.parse(init.body) : undefined]);
      const body =
        path === "/repos/accordproject/concerto" ? { default_branch: "main" }
        : path.startsWith("/repos/accordproject/concerto/git/ref/") ? { object: { sha: "base123" } }
        : path.startsWith("/repos/accordproject/concerto/contents/") && init.method === "GET" ? { sha: "old456" }
        : path.endsWith("/pulls") ? { html_url: "https://github.com/accordproject/concerto/pull/99", number: 99 }
        : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    const gh = new GitHub("t", fetchImpl);
    const { ctx } = makeTestCtx({ dryRun: false, github: async () => gh });
    const d = await ctx.db.createDecision({
      agent: "mira", kind: "github.docs_pr", target: "accordproject/concerto", summary: "Lessons", rationale: "Two PRs missed X", risk: "medium",
      payload: { path: "AGENTS.md", content: "# Agents\n\n## Reviewing\n- Check café metamodel versions", title: "Add review lessons" },
    });
    ctx.network = { ...ctx.network, action_kinds: { ...ctx.network.action_kinds, "github.docs_pr": { risk: "medium", executor: "github" } } };
    const r = await executeDecision(ctx, d);
    expect(r).toEqual({ ok: true, result: "Opened https://github.com/accordproject/concerto/pull/99" });
    expect(calls.find((c) => c[1] === "/repos/accordproject/concerto/git/refs")?.[2]).toEqual({ ref: "refs/heads/agents/mira-d-1", sha: "base123" });
    const put = calls.find((c) => c[0] === "PUT")!;
    expect(put[2].sha).toBe("old456");
    expect(Buffer.from(put[2].content, "base64").toString("utf8")).toContain("café");
    expect(calls.at(-1)![2].body).toContain("needs a maintainer's review");
  });
});

describe("labelling PRs (decision 41)", () => {
  const T = "accordproject/concerto#12";
  const setup = (pr: Partial<FakePr> = {}, dryRun = false) => {
    const gh = fakeGitHub(pr);
    return { gh, ...makeTestCtx({ dryRun, github: async () => gh as any }) };
  };
  const label = (ctx: any, input: object) => handleTool(ctx, "mira", "s", "label_pr", { target: T, ...input });

  it("adds labels one by one, keeping the gateway's labels", async () => {
    const { ctx, gh } = setup({ labels: ["ai/risk:low", "ai/decision:needs-review"] });
    expect(await label(ctx, { add: ["ai/kind:bugfix", "bug"] })).toBe(`${T} labels: ai/risk:low, ai/decision:needs-review, ai/kind:bugfix, bug`);
    expect(gh.pr.labels).toEqual(["ai/risk:low", "ai/decision:needs-review", "ai/kind:bugfix", "bug"]);
    const audit = await (ctx.db as any).db.prepare("SELECT agent, detail FROM audit WHERE event_type = 'gateway.labelled'").all();
    expect(audit.results).toMatchObject([{ agent: "mira" }]);
  });

  it("replaces the kind, so a PR has one at most", async () => {
    const { ctx, gh } = setup({ labels: ["ai/kind:docs", "ai/risk:low"] });
    await label(ctx, { add: ["ai/kind:feature"] });
    expect(gh.pr.labels).toEqual(["ai/risk:low", "ai/kind:feature"]);
    await expect(label(ctx, { add: ["ai/kind:docs", "ai/kind:bugfix"] })).rejects.toThrow(/one ai\/kind/);
  });

  it("removes labels and ignores ones the PR doesn't have", async () => {
    const { ctx, gh } = setup({ labels: ["bug", "ai/kind:docs"] });
    await label(ctx, { remove: ["bug", "dependencies"] });
    expect(gh.pr.labels).toEqual(["ai/kind:docs"]);
    await expect(label(ctx, {})).rejects.toThrow(/add or remove/);
  });

  it("refuses the gateway's labels, unknown kinds and labels the repo doesn't have", async () => {
    const { ctx, gh } = setup({ labels: ["ai/risk:low"] });
    await expect(label(ctx, { add: ["ai/risk:high"] })).rejects.toThrow(/set by the gateway/);
    await expect(label(ctx, { remove: ["ai/decision:needs-review"] })).rejects.toThrow(/set by the gateway/);
    await expect(label(ctx, { add: ["ai/kind:chore"] })).rejects.toThrow(/ai\/kind:chore is not a kind/);
    await expect(label(ctx, { add: ["wontfix"] })).rejects.toThrow(/wontfix is not a label in accordproject\/concerto/);
    expect(gh.pr.labels).toEqual(["ai/risk:low"]);
  });

  it("is Mira's, needs a PR in scope, and writes nothing in a dry run", async () => {
    const { ctx, gh } = setup({}, true);
    await expect(handleTool(ctx, "otto", "s", "label_pr", { target: T, add: ["bug"] })).rejects.toThrow(/not available to otto/);
    await expect(label(ctx, { target: "someone/else#1", add: ["bug"] })).rejects.toThrow(/not in the configured repos/);
    expect(await label(ctx, { add: ["bug"] })).toBe(`DRY RUN: would add bug on ${T}`);
    expect(gh.pr.labels).toEqual([]);
  });
});
