import { tickChanges } from "./changes";
import { handleUpdate } from "./commands";
import { verifyDiscord } from "./discordBot";
import { handleInteraction, type Interaction } from "./discordInteractions";
import { makeCtx } from "./context";
import { Db } from "./db";
import { checkEnv, type Env } from "./env";
import { applyEvent, dailyCheck, dispatchWakes, normalise, triageCheck } from "./githubEvents";
import { housekeeping, processSession, sweep } from "./sessions";
import type { TgUpdate } from "./telegram";
import { timingSafeEqual, verifyGitHub, verifyWebhook } from "./webhookVerify";

interface WebhookPayload {
  type: string;
  id: string;
  data?: { type?: string; id?: string };
}

export default {
  async fetch(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // Fail closed while a required secret is missing: no route runs half-configured.
    const problems = checkEnv(env);
    if (req.method === "GET" && url.pathname === "/health") {
      return problems.length ? new Response(`misconfigured:\n${problems.join("\n")}`, { status: 503 }) : new Response("ok");
    }
    if (problems.length) return new Response("gateway misconfigured", { status: 503 });

    if (req.method === "POST" && url.pathname === "/telegram") {
      const token = req.headers.get("x-telegram-bot-api-secret-token");
      if (!token || !timingSafeEqual(token, env.TELEGRAM_WEBHOOK_SECRET)) {
        return new Response("forbidden", { status: 403 });
      }
      const update = (await req.json()) as TgUpdate;
      const ctx = makeCtx(env);
      // Answer Telegram fast; do the work after the response.
      exec.waitUntil(
        handleUpdate(ctx, update).catch((e) => ctx.db.audit({ event_type: "gateway.telegram_error", detail: String(e) })),
      );
      return new Response("ok");
    }

    if (req.method === "POST" && url.pathname === "/discord") {
      if (!env.DISCORD_PUBLIC_KEY) return new Response("not found", { status: 404 });
      const raw = await req.text();
      if (!(await verifyDiscord(env.DISCORD_PUBLIC_KEY, req.headers, raw))) {
        return new Response("bad signature", { status: 401 });
      }
      const ctx = makeCtx(env);
      const body = await handleInteraction(ctx, JSON.parse(raw) as Interaction, (p) => exec.waitUntil(p));
      return Response.json(body);
    }

    if (req.method === "POST" && url.pathname === "/anthropic") {
      const raw = await req.text();
      if (!(await verifyWebhook(env.ANTHROPIC_WEBHOOK_SECRET, req.headers, raw))) {
        return new Response("bad signature", { status: 401 });
      }
      const payload = JSON.parse(raw) as WebhookPayload;
      const ctx = makeCtx(env);
      if (!(await ctx.db.claimEvent(`wh:${payload.id}`))) return new Response("duplicate");

      const type = payload.data?.type ?? "";
      const objectId = payload.data?.id ?? "";
      exec.waitUntil(
        (async () => {
          if (type.startsWith("session.") && objectId) {
            await processSession(ctx, objectId);
          } else if (type === "deployment_run.failed" || type === "deployment.paused") {
            await ctx.tg.send(ctx.ownerChatId, `Scheduled run problem: ${type} (${objectId}). Check the Console.`);
          }
          await ctx.db.audit({ event_type: `webhook.${type}`, detail: { id: objectId } });
        })().catch((e) => ctx.db.audit({ event_type: "gateway.webhook_error", detail: String(e) })),
      );
      return new Response("ok");
    }

    if (req.method === "POST" && url.pathname === "/github") {
      // Decision 62: the gateway's App sends events for the repos it is installed on.
      if (!env.GITHUB_WEBHOOK_SECRET) return new Response("not found", { status: 404 });
      const raw = await req.text();
      if (!(await verifyGitHub(env.GITHUB_WEBHOOK_SECRET, req.headers.get("x-hub-signature-256"), raw))) {
        return new Response("bad signature", { status: 401 });
      }
      const name = req.headers.get("x-github-event") ?? "";
      const delivery = req.headers.get("x-github-delivery") ?? "";
      if (name === "ping") return new Response("pong");
      const ctx = makeCtx(env);
      if (!delivery || !(await ctx.db.claimEvent(`gh:${delivery}`))) return new Response("duplicate");
      // GitHub gives up after 10 seconds: answer now, do the work after.
      exec.waitUntil(
        (async () => {
          for (const n of await normalise(ctx, name, delivery, JSON.parse(raw))) await applyEvent(ctx, n);
        })().catch((e) => ctx.db.audit({ event_type: "gateway.github_webhook_error", detail: { event: name, delivery, error: String(e) } })),
      );
      return new Response("ok");
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, exec: ExecutionContext) {
    const problems = checkEnv(env);
    if (problems.length) {
      exec.waitUntil(new Db(env.DB).audit({ event_type: "gateway.misconfigured", detail: { problems } }));
      return;
    }
    const ctx = makeCtx(env);
    exec.waitUntil(
      (async () => {
        await housekeeping(ctx).catch((e) => ctx.db.audit({ event_type: "gateway.housekeeping_error", detail: String(e) }));
        await tickChanges(ctx);
        await sweep(ctx);
        // Polls GitHub itself, so it runs whether or not the webhook is set up (decision 65).
        await triageCheck(ctx);
        // Decision 62 is opt-in: without the webhook secret the gateway neither polls GitHub nor wakes anyone.
        if (env.GITHUB_WEBHOOK_SECRET) {
          await dailyCheck(ctx).catch((e) => ctx.db.audit({ event_type: "gateway.github_daily_check_error", detail: String(e) }));
          await dispatchWakes(ctx);
        }
      })(),
    );
  },
};
