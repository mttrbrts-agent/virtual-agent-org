import { describeAction } from "./actions";
import { cap } from "./context";
import type { Decision } from "./db";
import type { DiscordButton, DiscordEmbed, DiscordPayload } from "./discordBot";
import { splitText } from "./telegram";
import type { InlineButton } from "./telegram";

export { safeJson } from "./actions";

const RISK = { low: "low risk", medium: "medium risk", high: "HIGH RISK" } as Record<string, string>;

/**
 * The Telegram card: who asks for what and why, then every field approval acts on,
 * from the same checked payload the executor runs. Telegram splits long cards.
 */
export function decisionCard(d: Decision): string {
  const view = describeAction(d);
  const lines = [`${d.id} · ${cap(d.agent)} · ${d.kind} · ${RISK[d.risk] ?? d.risk}`, "", d.summary, "", d.rationale, "", "If approved:", ...view.lines];
  for (const b of view.blocks) lines.push("", `${b.title}:`, b.text);
  if (d.status === "open" && d.checks_now) lines.push("", checksNowTitle(d), d.checks_now);
  if (d.status !== "open") lines.push("", `Status: ${d.status}${d.note ? ` — note: ${d.note}` : ""}`);
  if (d.result) lines.push(`Result: ${d.result}`);
  return lines.join("\n");
}

/** A merge card's checks as GitHub events last changed them (decision 62); the ones in the rationale are from when it was queued. */
const checksNowTitle = (d: Decision) => `Checks now (${d.checks_at ?? "recently"} UTC):`;

export function decisionButtons(d: Decision): InlineButton[][] {
  if (d.status === "open") {
    return [
      [
        { text: "Approve", callback_data: `a:${d.id}` },
        { text: "Reject", callback_data: `r:${d.id}` },
        { text: "Ask Ada", callback_data: `k:${d.id}` },
      ],
    ];
  }
  if (d.status === "approved") return [[{ text: "Mark done", callback_data: `x:${d.id}` }]];
  return [];
}

export function lines(items: string[]): string {
  return items.length ? items.join("; ") : "—";
}

/** Discord buttons; custom_id carries the action and decision id, as on Telegram. */
export function discordButtons(d: Decision): DiscordButton[] {
  if (d.status === "open") {
    return [
      { label: "Approve", custom_id: `a:${d.id}`, style: 3 },
      { label: "Reject", custom_id: `r:${d.id}`, style: 4 },
      { label: "Ask Ada", custom_id: `k:${d.id}`, style: 2 },
    ];
  }
  if (d.status === "approved") return [{ label: "Mark done", custom_id: `x:${d.id}`, style: 1 }];
  return [];
}

const RISK_COLOUR: Record<string, number> = { low: 0x2e9e5b, medium: 0xe0a100, high: 0xd03b3b };
const STATUS_ICON: Record<string, string> = { open: "🟡", approved: "✅", executed: "✅", rejected: "❌", failed: "⚠️", lapsed: "⏹️" };

const CONTENT_MAX = 1990;
const EMBED_PART = 4000; // each embed's description may be 4,096 characters
const EMBED_BUDGET = 5900; // and 6,000 across a message's embeds, titles included

/**
 * A merge card carries the whole case for the merge (C-6), so on Discord its
 * rationale goes in an embed, where it either fits or the card loses its Approve button,
 * rather than being cut silently to fit the message.
 */
const rationaleInEmbed = (d: Decision) => d.kind === "github.merge";

/** A card's long text as Discord embeds, and whether all of it fitted. */
function embedsFor(d: Decision): { embeds: DiscordEmbed[]; complete: boolean } {
  const embeds: DiscordEmbed[] = [];
  let budget = EMBED_BUDGET;
  const blocks = describeAction(d).blocks;
  for (const block of rationaleInEmbed(d) ? [{ title: "Why, and what the gateway found", text: d.rationale }, ...blocks] : blocks) {
    for (const [i, part] of splitText(block.text || "(empty)", EMBED_PART).entries()) {
      const title = i === 0 ? block.title.slice(0, 256) : undefined;
      const room = budget - (title?.length ?? 0);
      if (room < 100 || embeds.length === 10) return { embeds: cutShort(embeds), complete: false };
      const fits = part.length <= room;
      const description = fits ? part : `${part.slice(0, room - 40)}\n… (cut at Discord's limit)`;
      embeds.push({ ...(title ? { title } : {}), description, color: RISK_COLOUR[d.risk] });
      if (!fits) return { embeds, complete: false };
      budget -= description.length + (title?.length ?? 0);
    }
  }
  return { embeds, complete: true };
}

/** Marks the last embed as cut, when the next part didn't fit at all. */
function cutShort(embeds: DiscordEmbed[]): DiscordEmbed[] {
  const last = embeds.at(-1);
  if (last && !last.description.endsWith("(cut at Discord's limit)")) {
    last.description = `${last.description.slice(0, EMBED_PART - 40)}\n… (cut at Discord's limit)`;
  }
  return embeds;
}

/** Whether Discord can show everything approving this decision does. If it can't, approve it in Telegram. */
export function discordCardFits(d: Decision): boolean {
  return embedsFor(d).complete;
}

/**
 * The Discord card: who asks for what, and every field approval acts on, as the
 * message; the long text in embeds (6,000 characters there, against 2,000 in a
 * message). Text that doesn't fit is marked as cut, and the card then has no
 * Approve button: what can't be read can't be approved here.
 */
export function discordCard(d: Decision): DiscordPayload {
  const view = describeAction(d);
  const { embeds, complete } = embedsFor(d);
  const head = [
    `${STATUS_ICON[d.status] ?? "•"} **${d.id} · ${cap(d.agent)} · ${d.kind}** · ${RISK[d.risk] ?? d.risk}`,
    `**${d.summary}**`,
    rationaleInEmbed(d) ? "The change, the discussion and the checks are below." : d.rationale,
    "**If approved:**",
    ...view.lines.map((l) => `- ${l}`),
  ];
  if (d.status === "open" && d.checks_now) head.push(`**${checksNowTitle(d)}**`, d.checks_now);
  if (!complete && d.status === "open") head.push(`⚠ **Too long to show in full here. Read and approve it in Telegram: /approve ${d.id}**`);
  if (d.status !== "open") head.push(`**Status:** ${d.status}${d.note ? ` — ${d.note}` : ""}`);
  if (d.result) head.push(`**Result:** ${d.result}`);

  let content = head.join("\n");
  if (content.length > CONTENT_MAX) {
    // Shorten the rationale, never the decision line, what approval does, or the status.
    const over = content.length - CONTENT_MAX + 2;
    head[2] = `${head[2].slice(0, Math.max(0, head[2].length - over))}…`;
    content = head.join("\n");
  }
  const buttons = discordButtons(d).filter((b) => complete || !b.custom_id.startsWith("a:"));
  return { content, buttons, embeds };
}
