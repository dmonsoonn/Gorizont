import { handleUpdate, type Update } from "./bot";
import { createGitHub } from "./github";
import { createTelegram } from "./telegram";

function missingConfig(env: Env): string[] {
  const missing = (["TELEGRAM_BOT_TOKEN", "GITHUB_TOKEN", "GITHUB_REPO"] as const).filter((name) => !env[name]);
  return /^[1-9][0-9]*$/.test(env.OWNER_ID ?? "") ? missing : [...missing, "OWNER_ID"];
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    const missing = missingConfig(env);
    if (missing.length) {
      console.error(`Missing or invalid Worker config: ${missing.join(", ")}`);
      return new Response("Worker is not configured", { status: 500 });
    }
    let update: Update;
    try {
      update = await request.json();
    } catch {
      return new Response("ok");
    }
    try {
      await handleUpdate(update, {
        telegram: createTelegram(env.TELEGRAM_BOT_TOKEN, fetch),
        github: createGitHub(env.GITHUB_TOKEN, env.GITHUB_REPO, fetch),
        kv: env.KV,
        ownerId: Number(env.OWNER_ID),
        fetcher: fetch,
      });
    } catch (error) {
      console.error(error);
    }
    return new Response("ok");
  },
} satisfies ExportedHandler<Env>;
