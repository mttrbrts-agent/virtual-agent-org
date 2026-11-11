// Thin client for Claude Managed Agents (beta). Raw fetch so the Worker bundle stays
// small and every path is visible in one place.
//
// Verified against platform.claude.com/docs/en/managed-agents/* on 2026-10-31.
// Items marked VERIFY were not confirmed in the docs read; check them during Phase 0.

const BASE = "https://api.anthropic.com/v1";
const BETA = "managed-agents-2026-04-01";
const MEMORY_BETA = "agent-memory-2026-07-22"; // memory store endpoints only; never combine

export interface SessionEvent {
  id: string;
  type: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  evaluated_permission?: "allow" | "ask" | "deny";
  stop_reason?: { type: string; event_ids?: string[] };
  [k: string]: unknown;
}

export interface Session {
  id: string;
  status: "idle" | "running" | "rescheduling" | "terminated";
  agent?: { id: string; version?: number } | string;
  stop_reason?: { type: string; event_ids?: string[] };
  // Checked against the live API: a session reports cache writes as
  // `cache_creation`, split by cache lifetime, not as `cache_creation_input_tokens`.
  usage?: {
    list_cost?: { amount: string; currency: string };
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
    cache_creation_input_tokens?: number;
  };
  metadata?: Record<string, string>;
}

export class ManagedAgentsError extends Error {
  constructor(public status: number, public body: string, path: string) {
    super(`Managed Agents ${status} on ${path}: ${body.slice(0, 300)}`);
  }
}

export class ManagedClient {
  constructor(private apiKey: string, private fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  private async req<T>(method: string, path: string, body?: unknown, beta = BETA): Promise<T> {
    const res = await this.fetchImpl(`${BASE}${path}`, {
      method,
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": beta,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new ManagedAgentsError(res.status, text, path);
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ---- Sessions -----------------------------------------------------------

  createSession(p: {
    agentId: string;
    environmentId: string;
    vaultIds?: string[];
    memoryStoreIds?: { id: string; access: "read_write" | "read_only" }[];
    text?: string;
    budgetCents?: number;
    /** Runs this session on another model. VERIFY: same override shape as scheduled deployments. */
    model?: string;
  }): Promise<Session> {
    return this.req("POST", "/sessions", {
      agent: p.model ? { type: "agent_with_overrides", id: p.agentId, model: p.model } : p.agentId,
      environment_id: p.environmentId,
      vault_ids: p.vaultIds ?? [],
      resources: (p.memoryStoreIds ?? []).map((m) => ({
        type: "memory_store",
        memory_store_id: m.id,
        access: m.access,
      })),
      initial_events: p.text ? [userMessage(p.text)] : [],
      ...(p.budgetCents
        ? { budget: { type: "limit", max_list_cost: { amount: String(p.budgetCents), currency: "USD" } } }
        : {}),
    });
  }

  retrieveSession(id: string): Promise<Session> {
    return this.req("GET", `/sessions/${id}`);
  }

  // VERIFY: pagination field names for the events list (assumed data + next_page).
  async listEvents(id: string): Promise<SessionEvent[]> {
    const out: SessionEvent[] = [];
    let page: string | undefined;
    for (let i = 0; i < 20; i++) {
      const q = new URLSearchParams({ beta: "true", order: "asc", limit: "100" });
      if (page) q.set("page", page);
      const r = await this.req<{ data: SessionEvent[]; next_page?: string | null }>(
        "GET",
        `/sessions/${id}/events?${q}`,
      );
      out.push(...r.data);
      if (!r.next_page) break;
      page = r.next_page;
    }
    return out;
  }

  sendEvents(id: string, events: unknown[]): Promise<unknown> {
    return this.req("POST", `/sessions/${id}/events`, { events });
  }

  sendMessage(id: string, text: string) {
    return this.sendEvents(id, [userMessage(text)]);
  }

  // VERIFY: is_error is not shown in the docs examples; errors are sent as text.
  sendToolResult(id: string, toolUseId: string, text: string) {
    return this.sendEvents(id, [
      { type: "user.custom_tool_result", custom_tool_use_id: toolUseId, content: [{ type: "text", text }] },
    ]);
  }

  sendToolConfirmation(id: string, toolUseId: string, allow: boolean, denyMessage?: string) {
    return this.sendEvents(id, [
      {
        type: "user.tool_confirmation",
        tool_use_id: toolUseId,
        result: allow ? "allow" : "deny",
        ...(denyMessage ? { deny_message: denyMessage } : {}),
      },
    ]);
  }

  interrupt(id: string) {
    return this.sendEvents(id, [{ type: "user.interrupt" }]);
  }

  // ---- Deployments --------------------------------------------------------

  pauseDeployment(id: string) {
    return this.req("POST", `/deployments/${id}/pause?beta=true`, {});
  }
  unpauseDeployment(id: string) {
    return this.req("POST", `/deployments/${id}/unpause?beta=true`, {});
  }
  runDeployment(id: string) {
    return this.req("POST", `/deployments/${id}/run?beta=true`, {});
  }
  createDeployment(body: unknown): Promise<{ id: string }> {
    return this.req("POST", "/deployments?beta=true", body);
  }
  updateDeployment(id: string, body: unknown): Promise<{ id: string }> {
    return this.req("POST", `/deployments/${id}?beta=true`, body);
  }

  // ---- Agents, environments, vaults, memory (used by scripts/deploy.ts) ----

  createAgent(body: unknown): Promise<{ id: string; version: number }> {
    return this.req("POST", "/agents", body);
  }
  updateAgent(id: string, body: unknown): Promise<{ id: string; version: number }> {
    return this.req("POST", `/agents/${id}`, body);
  }
  archiveAgent(id: string) {
    return this.req("POST", `/agents/${id}/archive`, {});
  }
  createEnvironment(body: unknown): Promise<{ id: string }> {
    return this.req("POST", "/environments", body);
  }
  createVault(displayName: string, metadata: Record<string, string>): Promise<{ id: string }> {
    return this.req("POST", "/vaults", { display_name: displayName, metadata });
  }
  addVaultCredential(vaultId: string, body: unknown): Promise<{ id: string }> {
    return this.req("POST", `/vaults/${vaultId}/credentials`, body);
  }
  archiveVaultCredential(vaultId: string, credId: string) {
    return this.req("POST", `/vaults/${vaultId}/credentials/${credId}/archive`, {});
  }
  archiveVault(vaultId: string) {
    return this.req("POST", `/vaults/${vaultId}/archive`, {});
  }
  createMemoryStore(name: string, description: string): Promise<{ id: string }> {
    return this.req("POST", "/memory_stores", { name, description }, MEMORY_BETA);
  }
  writeMemory(storeId: string, path: string, content: string): Promise<{ id: string }> {
    return this.req("POST", `/memory_stores/${storeId}/memories`, { path, content }, MEMORY_BETA);
  }

  updateMemory(storeId: string, memoryId: string, content: string): Promise<{ id: string }> {
    return this.req("POST", `/memory_stores/${storeId}/memories/${memoryId}`, { content }, MEMORY_BETA);
  }

  /** Creates the memory at `path`, or replaces its content if the path already exists. */
  async upsertMemory(storeId: string, path: string, content: string): Promise<{ id: string; updated: boolean }> {
    try {
      const m = await this.writeMemory(storeId, path, content);
      return { id: m.id, updated: false };
    } catch (e) {
      const existing = e instanceof ManagedAgentsError && e.status === 409 ? conflictingMemoryId(e.body) : undefined;
      if (!existing) throw e;
      const m = await this.updateMemory(storeId, existing, content);
      return { id: m.id, updated: true };
    }
  }
}

/** From a memory_path_conflict_error body: the id of the memory already at that path. */
export function conflictingMemoryId(body: string): string | undefined {
  try {
    const err = (JSON.parse(body) as { error?: { type?: string; conflicting_memory_id?: string } }).error;
    return err?.type === "memory_path_conflict_error" ? err.conflicting_memory_id : undefined;
  } catch {
    return undefined;
  }
}

export function userMessage(text: string) {
  return { type: "user.message", content: [{ type: "text", text }] };
}

export function sessionAgentId(s: Session): string | undefined {
  if (!s.agent) return undefined;
  return typeof s.agent === "string" ? s.agent : s.agent.id;
}

export function costCents(s: Session): number {
  const a = s.usage?.list_cost?.amount;
  return a ? Number.parseInt(a, 10) || 0 : 0;
}

/** Cumulative token totals so far; missing fields count as 0. */
export function sessionTokens(s: Session): Tokens {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    input_tokens: n(s.usage?.input_tokens),
    output_tokens: n(s.usage?.output_tokens),
    cache_read_tokens: n(s.usage?.cache_read_input_tokens),
    // The flat field is what model requests report; keep it as a fallback.
    cache_write_tokens:
      n(s.usage?.cache_creation_input_tokens) ||
      n(s.usage?.cache_creation?.ephemeral_5m_input_tokens) + n(s.usage?.cache_creation?.ephemeral_1h_input_tokens),
  };
}

export interface Tokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export function messageText(e: SessionEvent): string {
  return (e.content ?? [])
    .filter((c) => c.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n")
    .trim();
}
