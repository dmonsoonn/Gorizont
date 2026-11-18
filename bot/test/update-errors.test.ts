import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Update } from "../src/types";

const env = {
  WEBHOOK_SECRET: "hook-secret",
  TELEGRAM_BOT_TOKEN: "bot-token",
  GITHUB_TOKEN: "pat",
  GITHUB_REPO: "dmonsoonn/Gorizont",
  OWNER_ID: "42",
  KV: { get: async () => null, delete: async () => {} },
} as unknown as Env;

const user = { id: 123, first_name: "Вася" };
const message = { message_id: 1, from: user, chat: { id: user.id, type: "private" } };
const callback = { id: "button-1", from: user, message };
const fallback = "Что-то пошло не так, попробуйте позже";

function post(update: Update | string, secret = "hook-secret") {
  return worker.fetch(new Request("https://bot.example/", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    body: typeof update === "string" ? update : JSON.stringify(update),
  }), env);
}

function mockApis(telegramFailures: Record<string, string> = {}) {
  const telegram = vi.fn((method: string, _body: unknown) => {
    const description = telegramFailures[method];
    return Response.json(description ? { ok: false, description } : { ok: true });
  });
  const github = vi.fn(() => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => url.startsWith("https://api.github.com/")
    ? github()
    : telegram(url.split("/").at(-1)!, JSON.parse(String(init.body))));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  return { github, telegram, errors };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("update error replies", () => {
  it.each(["/start", "@example_channel"])("reports GitHub failures for %s in the originating chat", async (text) => {
    const { github, telegram, errors } = mockApis();
    const response = await post({ message: { ...message, text } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(github).toHaveBeenCalledTimes(1);
    expect(telegram.mock.calls).toEqual([["sendMessage", { chat_id: user.id, text: fallback }]]);
    expect(errors.mock.calls.map(([error]) => String(error))).toEqual(["Error: GitHub GET user 123 failed: 503"]);
  });

  it.each([
    ["chat:channel", fallback],
    ["ls", "Не удалось загрузить источники, попробуйте ещё раз."],
  ])("reports GitHub failures for %s on the callback", async (data, text) => {
    const { github, telegram, errors } = mockApis();
    const response = await post({ callback_query: { ...callback, data } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(github).toHaveBeenCalledTimes(1);
    expect(telegram.mock.calls).toEqual([["answerCallbackQuery", { callback_query_id: callback.id, text }]]);
    expect(errors.mock.calls.map(([error]) => String(error))).toEqual(["Error: GitHub GET user 123 failed: 503"]);
  });

  it.each([
    [{ message: { ...message, text: "/start" } }, "sendMessage"],
    [{ callback_query: { ...callback, data: "chat:channel" } }, "answerCallbackQuery"],
  ] as const)("logs the original exception and the delivery failure", async (update, method) => {
    const { telegram, errors } = mockApis({ [method]: "Delivery rejected" });
    const response = await post(update);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(telegram).toHaveBeenCalledExactlyOnceWith(method, expect.objectContaining({ text: fallback }));
    expect(errors.mock.calls.map(([error]) => String(error))).toEqual([
      "Error: GitHub GET user 123 failed: 503",
      `Error: Telegram ${method} failed: Delivery rejected`,
    ]);
  });

  it("logs delivery failure after the callback was already acknowledged", async () => {
    const { telegram, errors } = mockApis();
    telegram.mockImplementationOnce(() => Response.json({ ok: true }));
    telegram.mockImplementationOnce(() => Response.json({ ok: false, description: "Edit failed" }));
    telegram.mockImplementationOnce(() => Response.json({ ok: false, description: "Query is too old" }));
    const response = await post({ callback_query: { ...callback, data: "chat:cancel" } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(telegram.mock.calls.map(([method]) => method)).toEqual(["answerCallbackQuery", "editMessageText", "answerCallbackQuery"]);
    expect(telegram.mock.lastCall?.[1]).toEqual({ callback_query_id: callback.id, text: fallback });
    expect(errors.mock.calls.map(([error]) => String(error))).toEqual([
      "Error: Telegram editMessageText failed: Edit failed",
      "Error: Telegram answerCallbackQuery failed: Query is too old",
    ]);
  });

  it("keeps normal replies for successful commands", async () => {
    const { github, telegram, errors } = mockApis();
    expect((await post({ message: { ...message, text: "/help" } })).status).toBe(200);
    expect(telegram).toHaveBeenCalledExactlyOnceWith("sendMessage", { chat_id: user.id, text: expect.stringContaining("Команды:") });
    expect(github).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("keeps the owner check before acting on another user's approval", async () => {
    const { github, telegram, errors } = mockApis();
    expect((await post({ callback_query: { ...callback, data: "approve:456" } })).status).toBe(200);
    expect(telegram).toHaveBeenCalledExactlyOnceWith("answerCallbackQuery", { callback_query_id: callback.id, text: "Решать заявки может только владелец." });
    expect(github).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(["null", '{"message":{"chat":{"id":123,"type":"private"}}}', '{"callback_query":{}}'])
    ("ignores updates without a valid reply target (%s)", async (body) => {
      const { github, telegram } = mockApis();
      expect((await post(body)).status).toBe(200);
      expect(telegram).not.toHaveBeenCalled();
      expect(github).not.toHaveBeenCalled();
    });
});
