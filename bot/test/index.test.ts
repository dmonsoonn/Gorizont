import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";

const env = {
  WEBHOOK_SECRET: "hook-secret",
  TELEGRAM_BOT_TOKEN: "bot-token",
  GITHUB_TOKEN: "pat",
  GITHUB_REPO: "dmonsoonn/Gorizont",
  OWNER_ID: "612722019",
  KV: { get: async () => null, put: async () => {}, delete: async () => {} },
} as unknown as Env;

function post(body: string, secret: string | null = "hook-secret", method = "POST", workerEnv = env) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (secret !== null) {
    headers.set("X-Telegram-Bot-Api-Secret-Token", secret);
  }
  return worker.fetch(new Request("https://bot.example/", { method, headers, body: method === "POST" ? body : undefined }), workerEnv);
}

function stubFetch(response = () => Response.json({ ok: true })) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

const help = JSON.stringify({ message: { message_id: 1, chat: { id: 123, type: "private" }, from: { id: 123, first_name: "Вася" }, text: "/help" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webhook", () => {
  it.each([null, "", "wrong"])("rejects secret %s with 401", async (secret) => {
    const fetcher = stubFetch();
    const response = await post(help, secret);
    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([null, ""])("rejects everything when the Worker secret is unset and the header is %s", async (secret) => {
    const fetcher = stubFetch();
    const response = await post(help, secret, "POST", { ...env, WEBHOOK_SECRET: "" });
    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-POST requests", async () => {
    const fetcher = stubFetch();
    expect((await post("", "hook-secret", "GET")).status).toBe(405);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["{not json", "{}", "null", '{"edited_message":{}}'])("acknowledges %s without actions", async (body) => {
    const fetcher = stubFetch();
    const response = await post(body);
    expect(response.status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("routes a valid update to Telegram with the bot token", async () => {
    const fetcher = stubFetch();
    const response = await post(help);
    expect(response.status).toBe(200);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botbot-token/sendMessage");
    expect(JSON.parse(String(init?.body))).toMatchObject({ chat_id: 123 });
  });

  it("acknowledges the update even when Telegram fails", async () => {
    stubFetch(() => Response.json({ ok: false, description: "Forbidden: bot was blocked by the user" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await post(help);
    expect(response.status).toBe(200);
    expect(String(error.mock.calls[0][0])).toContain("bot was blocked");
  });
});
