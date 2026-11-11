import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const ROOT = join(import.meta.dirname, "..");

export const readYaml = <T>(rel: string): T => parse(readFileSync(join(ROOT, rel), "utf8")) as T;
export const readText = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

export interface Spec {
  name: string;
  title: string;
  phase: number;
  reports_to: string;
  body: string;
}

export function parseSpec(text: string): Spec {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("spec is missing frontmatter");
  const fm = parse(m[1]) as Omit<Spec, "body">;
  return { ...fm, body: m[2].trim() };
}

export function loadSpecs(): Record<string, Spec> {
  const dir = join(ROOT, "agents");
  const out: Record<string, Spec> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_"))) {
    const spec = parseSpec(readFileSync(join(dir, f), "utf8"));
    if (`${spec.name}.md` !== f) throw new Error(`${f}: name "${spec.name}" does not match file name`);
    out[spec.name] = spec;
  }
  return out;
}

export interface NetworkYaml {
  network: { name: string; timezone: string; current_phase: number; schedules_enabled?: boolean };
  github: { org: string; sandbox_repo: string; network_repo: string; repos: string[] };
  budgets: { monthly_credit_usd: number; member_daily_messages?: number; follow_up_daily_wakes?: number; follow_up_budget_usd?: number; mechanic_small_usd?: number; mechanic_large_usd?: number; github_wakes?: Record<string, { daily: number; usd: number }> };
  self_improvement?: { since: string | null; stale_days: number; proposal_gap_days?: number; min_decided?: number; min_days?: number; commit_author: { name: string; email: string } };
  agents: Record<string, number>;
}
export interface ModelsYaml {
  tiers: Record<string, string>;
  agents: Record<string, { default: string; tasks?: Record<string, string> }>;
}
export interface PermissionsYaml {
  discord_approval_max_risk?: "none" | "low" | "medium";
  approvals_app?: "discord" | "telegram" | "both";
  review_check_required?: boolean;
  action_kinds: Record<string, { risk: "low" | "medium" | "high"; executor: "github" | "discord" | "discord_ops" | "discord_dm" | "vimeo" | "manual" | "task"; auto?: boolean }>;
  agents: Record<
    string,
    {
      mcp_servers: Record<string, { mode: string }> | [];
      builtin_tools: string[];
      requestable: string[];
      /** Other agents whose memory stores this agent mounts read-only (decision 54). */
      reads_memory_of?: string[];
      /** "open" runs the agent in an environment with unrestricted outbound access (decision 54). Default "limited". */
      networking?: "limited" | "open";
    }
  >;
}
export interface SchedulesYaml {
  schedules: { name: string; agent: string; cron: string; budget_usd: number; prompt: string; tier?: string }[];
}
export interface PeopleYaml {
  people: {
    name: string;
    role: string | string[];
    maintains?: string[];
    github?: string;
    discord?: string | number;
    telegram?: string | number;
  }[];
}
/** config/people.ids.yaml (git-ignored): platform ids by the person's name in people.yaml. */
export type PeopleIdsYaml = Record<string, { discord?: string | number; telegram?: string | number }>;
export const PEOPLE_IDS_PATH = "config/people.ids.yaml";

export interface DiscordYaml {
  channels?: { announcements?: string | number; agent_ops?: string | number };
}
/** config/review.yaml: how Mira reviews (decisions 35 and 36). */
export interface ReviewYaml {
  areas: Record<string, string>;
  max_findings: number;
  max_nits: number;
  tone: { first_time: string; maintainer: string; default: string };
  risk: { high_over_lines: number; high_paths: string[]; low_max_lines: number; low_paths: string[] };
  path_rules?: { glob: string; note: string; repo?: string }[];
}
export interface McpYaml {
  servers: Record<string, { url: string; token_env: string }>;
  modes: Record<string, "always_allow" | "always_ask" | "auto">;
}

export function loadAll() {
  return {
    network: readYaml<NetworkYaml>("config/network.yaml"),
    models: readYaml<ModelsYaml>("config/models.yaml"),
    permissions: readYaml<PermissionsYaml>("config/permissions.yaml"),
    schedules: readYaml<SchedulesYaml>("config/schedules.yaml"),
    mcp: readYaml<McpYaml>("config/mcp_servers.yaml"),
    people: readYaml<PeopleYaml>("config/people.yaml"),
    peopleIds: existsSync(join(ROOT, PEOPLE_IDS_PATH)) ? (readYaml<PeopleIdsYaml>(PEOPLE_IDS_PATH) ?? {}) : {},
    discord: readYaml<DiscordYaml>("config/discord.yaml") ?? {},
    review: readYaml<ReviewYaml>("config/review.yaml"),
    specs: loadSpecs(),
  };
}

export const BUILTIN_TOOLS = ["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"];
/** Built-in tools that only touch the agent's own sandbox and memory stores (decision 40). */
export const FILE_TOOLS = ["read", "write", "edit", "glob"];
