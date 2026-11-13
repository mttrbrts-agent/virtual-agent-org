import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, readText } from "./lib";

// Mira's review method (decision 66): deploy.ts writes skills/pr-review/SKILL.md to the
// shared memory store, and her spec and the review check's brief name the mounted path.
const MOUNTED = "/mnt/memory/virtual-agent-org-shared/reference/skills/pr-review.md";

test("the PR review skill is in Agent Skills format with its licence notices", () => {
  const skill = readText("skills/pr-review/SKILL.md");
  assert.match(skill, /^---\nname: pr-review\ndescription: .+\n---\n/);
  assert.ok(existsSync(join(ROOT, "skills/pr-review/NOTICE.md")));
});

test("deploy, Mira's spec and the review check agree on where the skill is mounted", () => {
  assert.match(readText("scripts/deploy.ts"), /"\/reference\/skills\/pr-review\.md"/);
  assert.ok(readText("agents/mira.md").includes(MOUNTED));
  assert.ok(readFileSync(join(ROOT, "gateway/src/tools.ts"), "utf8").includes(MOUNTED));
});

test("every area the skill names is a review area", () => {
  const skill = readText("skills/pr-review/SKILL.md");
  const named = [...skill.matchAll(/^\*\*([a-z_]+)\*\*$/gm)].map((m) => m[1]);
  const areas = readText("config/review.yaml").match(/^areas:\n((?: {2}\w+:.*\n)+)/m)![1].match(/^ {2}(\w+):/gm)!.map((l) => l.trim().slice(0, -1));
  assert.deepEqual(named.sort(), areas.sort());
});
