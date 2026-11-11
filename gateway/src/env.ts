export interface Env {
  DB: D1Database;

  // Telegram
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string; // checked against X-Telegram-Bot-Api-Secret-Token
  OWNER_TELEGRAM_ID: string; // numeric user id; also the chat id for direct messages
  TSC_TELEGRAM_IDS?: string; // comma-separated numeric ids (Phase 3+)

  // Claude Managed Agents (a Console organisation API key)
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_WEBHOOK_SECRET: string; // whsec_...

  // GitHub App used ONLY by the gateway to execute approved actions
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string; // PKCS#8 PEM
  GITHUB_INSTALLATION_ID?: string;
  // The App's webhook secret (decision 62). Without it the /github endpoint is off.
  GITHUB_WEBHOOK_SECRET?: string;

  // Vimeo personal access token for the Accord Project account (decision 18A):
  // scopes public, private, edit. Held only by the gateway.
  VIMEO_ACCESS_TOKEN?: string;

  // Discord bot (decision 15B). All optional: without them the /discord endpoint is off.
  DISCORD_APP_ID?: string;
  DISCORD_PUBLIC_KEY?: string; // hex, from the Developer Portal's General Information page
  DISCORD_BOT_TOKEN?: string;
  OWNER_DISCORD_ID?: string; // the only Discord account with owner rights; never from people.yaml
  // JSON {"<name>": {"discord", "telegram"}} for people in people.yaml, set by `npm run people:ids`
  // from the git-ignored config/people.ids.yaml. Grants nothing to names not in people.yaml.
  PEOPLE_IDS?: string;

  // "true" until the Phase 0 gate: approved actions are logged, not executed
  DRY_RUN?: string;
}

/** Access level in the gateway. Only the OWNER_TELEGRAM_ID secret makes an owner;
 *  everyone listed in people.yaml is a member (ask Ada, /status, /queue). */
export type Role = "owner" | "member";

const REQUIRED = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "OWNER_TELEGRAM_ID", "ANTHROPIC_API_KEY", "ANTHROPIC_WEBHOOK_SECRET"] as const;

/**
 * The required secrets that are missing or malformed, by name only, never value.
 * Empty when the gateway can run; otherwise every route fails closed.
 */
export function checkEnv(env: Partial<Env>): string[] {
  const problems: string[] = REQUIRED.filter((k) => !env[k]?.trim()).map((k) => `${k} is not set`);
  if (env.OWNER_TELEGRAM_ID?.trim() && !/^\d+$/.test(env.OWNER_TELEGRAM_ID.trim())) problems.push("OWNER_TELEGRAM_ID is not a numeric Telegram id");
  return problems;
}
