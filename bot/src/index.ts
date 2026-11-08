import { handleUpdate, type Update } from "./bot";
import { createGitHub } from "./github";
import { createTelegram } from "./telegram";

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (!env.WEBHOOK_SECRET || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
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
