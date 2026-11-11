// Telegram update handling: who is speaking, what they may do, and routing.

import { agentFromText, failureText, messageAgent, postDecision, replyToAgentMessage } from "./agents";
import { decisionButtons, decisionCard } from "./format";
import type { SentMessage } from "./db";
import { cap, type Ctx } from "./context";
import { approve, askAda, markDone, pause, reject, resume, revoke, stop } from "./controls";
import type { Role } from "./env";
import { OVER_ALLOWANCE, describePerson, memberPrefix, roleFor, startedByFor, withinMemberAllowance } from "./people";
import { gatherStatus, refreshLive, statusPlain } from "./status";
import type { TgMessage, TgUpdate } from "./telegram";

const PERMS: Record<Role, Set<string>> = {
  owner: new Set(["instruct", "approve", "control", "ask", "status", "queue"]),
  member: new Set(["ask", "status", "queue"]),
};

export function roleOf(ctx: Ctx, userId: number | undefined): Role | null {
  return roleFor(ctx, "telegram", userId);
}

const HELP = `Commands
(plain text) — message Ada
/status — each agent: state, last report, open work, spend
/queue — open decisions with buttons
/approve D-41 · /reject D-41 <note>
/ask <agent> <text> — talk to one agent directly
/pause <agent> · /resume <agent>
/stop <agent|all> — interrupt sessions, reject its open decisions
/revoke <agent> confirm — stop and purge its credentials
/whoami`;

export async function handleUpdate(ctx: Ctx, u: TgUpdate): Promise<void> {
  if (u.callback_query) return handleCallback(ctx, u.callback_query);
  if (u.message?.text) return handleMessage(ctx, u.message);
}

async function handleCallback(ctx: Ctx, q: NonNullable<TgUpdate["callback_query"]>) {
  const role = roleOf(ctx, q.from.id);
  if (role !== "owner") {
    await ctx.tg.answerCallback(q.id, "Only the owner can decide.");
    return;
  }
  const [action, id] = (q.data ?? "").split(":");
  const chatId = q.message?.chat.id ?? ctx.ownerChatId;
  let reply = "";
  switch (action) {
    case "a":
      reply = await approve(ctx, id);
      break;
    case "r": {
      reply = await reject(ctx, id);
      const msgId = await ctx.tg.send(chatId, `Note for ${id}? Reply to this message, or ignore it.`, { forceReply: true });
      await ctx.db.addPendingReply(msgId, chatId, "reject_note", id);
      break;
    }
    case "k":
      reply = await askAda(ctx, id, { telegram: chatId });
      break;
    case "x":
      reply = await markDone(ctx, id);
      break;
  }
  await ctx.tg.answerCallback(q.id, reply.slice(0, 190));
  await refreshPressedCard(ctx, q.message, id);
}

/**
 * A card re-sent with send_to_matt (C-4) isn't the one the decision records, so the
 * decision's refresh updates only the original: update the one pressed as well.
 */
async function refreshPressedCard(ctx: Ctx, m: TgMessage | undefined, id: string | undefined) {
  if (!m || !id) return;
  const d = await ctx.db.getDecision(id);
  if (!d || d.tg_message_id === m.message_id) return;
  try {
    await ctx.tg.edit(m.chat.id, m.message_id, decisionCard(d), decisionButtons(d));
  } catch {
    // Too old to edit or unchanged; the decision record is authoritative.
  }
}

async function handleMessage(ctx: Ctx, m: TgMessage) {
  const role = roleOf(ctx, m.from?.id);
  if (!role) {
    await ctx.db.audit({ event_type: "telegram.unauthorised", detail: { from: m.from?.id, username: m.from?.username } });
    return; // silent: don't confirm the bot exists to strangers
  }
  if (m.chat.type !== "private" && !m.text?.startsWith("/")) {
    // In groups, only commands are handled, so chatter doesn't reach Ada.
    return;
  }
  const can = (p: string) => PERMS[role].has(p);
  const reply = (text: string) => ctx.tg.send(m.chat.id, text, { replyTo: m.message_id });
  const text = m.text!.trim();
  const owner = role === "owner";
  const failed = async (e: unknown) =>
    reply(await failureText(ctx, owner, e, "gateway.telegram_error", { from: m.from?.id, command: text.split(/\s/)[0] }));

  /** Sends to an agent as whoever is speaking: a member's message is marked as theirs and counted. */
  const toAgent = async (agent: string, body: string) => {
    if (!owner && !(await withinMemberAllowance(ctx, "telegram", m.from?.id))) {
      await reply(OVER_ALLOWANCE);
      return false;
    }
    const prefix = owner ? "" : memberPrefix(ctx, "telegram", m.from?.id);
    await messageAgent(ctx, agent, { telegram: m.chat.id }, prefix + body, startedByFor(ctx, "telegram", m.from?.id, role));
    return true;
  };

  // Replies to a force-reply prompt (e.g. a rejection note).
  if (m.reply_to_message && role === "owner") {
    const pending = await ctx.db.takePendingReply(m.reply_to_message.message_id);
    if (pending?.kind === "reject_note") {
      await reply(await reject(ctx, pending.ref, text));
      return;
    }
  }

  // A reply to an agent's message goes to the session that wrote it. An older or
  // untracked bot message goes to the agent named at its start, with it quoted.
  const answered = m.reply_to_message;
  if (answered && m.chat.type === "private" && !text.startsWith("/") && (can("instruct") || can("ask"))) {
    let sent = await ctx.db.findSent("telegram", m.chat.id, answered.message_id);
    if (!sent && answered.from?.is_bot && answered.text?.trim()) {
      sent = { agent: agentFromText(ctx, answered.text), session_id: null, text: answered.text } as SentMessage;
    }
    if (sent) {
      try {
        if (!owner && !(await withinMemberAllowance(ctx, "telegram", m.from?.id))) {
          await reply(OVER_ALLOWANCE);
          return;
        }
        const prefix = owner ? "" : memberPrefix(ctx, "telegram", m.from?.id);
        await replyToAgentMessage(ctx, sent, { telegram: m.chat.id }, prefix + text, startedByFor(ctx, "telegram", m.from?.id, role));
      } catch (e) {
        await failed(e);
      }
      return;
    }
  }

  if (!text.startsWith("/")) {
    if (!can("instruct") && !can("ask")) return;
    try {
      await toAgent("ada", text);
    } catch (e) {
      await failed(e);
    }
    return;
  }

  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const agentArg = (args[0] ?? "").toLowerCase();
  const knownAgent = (a: string) => !!ctx.network.agents[a];
  const allAgents = Object.keys(ctx.network.agents);

  try {
    switch (cmd) {
      case "/start":
      case "/help":
        await reply(HELP);
        return;
      case "/whoami":
        await reply(`${describePerson(ctx, "telegram", m.from?.id)} · Telegram id ${m.from?.id} · access: ${role}`);
        return;
      case "/status":
        if (!can("status")) return;
        await reply(await statusText(ctx));
        return;
      case "/queue": {
        if (!can("queue")) return;
        const open = await ctx.db.listDecisions({ status: "open" });
        if (!open.length) {
          await reply("Queue is empty.");
          return;
        }
        if (role === "owner") for (const d of open.slice(0, 10)) await postDecision(ctx, d);
        else await reply(open.map((d) => `${d.id} · ${cap(d.agent)} · ${d.summary}`).join("\n"));
        if (open.length > 10) await reply(`${open.length - 10} more. Clear these first.`);
        return;
      }
      case "/approve":
        if (!can("approve")) return;
        await reply(await approve(ctx, args[0] ?? ""));
        return;
      case "/reject":
        if (!can("approve")) return;
        await reply(await reject(ctx, args[0] ?? "", args.slice(1).join(" ") || undefined));
        return;
      case "/ask": {
        if (!can("ask")) return;
        if (!knownAgent(agentArg) || args.length < 2) {
          await reply("Usage: /ask <agent> <text>");
          return;
        }
        if (!(await toAgent(agentArg, args.slice(1).join(" ")))) return;
        await ctx.db.audit({ agent: agentArg, event_type: "owner.direct_ask", detail: { by: role } });
        return;
      }
      case "/pause":
      case "/resume":
      case "/stop":
      case "/revoke": {
        if (!can("control")) return;
        const targets = agentArg === "all" && cmd === "/stop" ? allAgents : knownAgent(agentArg) ? [agentArg] : [];
        if (!targets.length) {
          await reply(`Usage: ${cmd} <agent>${cmd === "/stop" ? "|all" : ""}`);
          return;
        }
        if (cmd === "/revoke" && args[1] !== "confirm") {
          await reply(`Revoking ${agentArg} stops it and purges its credentials. Send: /revoke ${agentArg} confirm`);
          return;
        }
        const fn = { "/pause": pause, "/resume": resume, "/stop": stop, "/revoke": revoke }[cmd]!;
        const out: string[] = [];
        for (const t of targets) out.push(await fn(ctx, t));
        await reply(out.join("\n\n"));
        return;
      }
      default:
        await reply(`Unknown command. ${HELP}`);
    }
  } catch (e) {
    await failed(e);
  }
}

/** Refreshes the live sessions first, so the answer isn't only as fresh as the last webhook. */
export async function statusText(ctx: Ctx): Promise<string> {
  await refreshLive(ctx);
  return statusPlain(await gatherStatus(ctx));
}
