import { afterEach, describe, expect, it, vi } from "vitest";
import { channelKey, handleUpdate, type Store, type Update } from "../src/bot";
import type { GitHub } from "../src/github";

const USER = { id: 123, first_name: "Вася" };
const BOT_ID = 999;
const CHANNEL = { id: -100777, type: "channel", title: "Мой канал" };

type Answers = Record<string, unknown>;

function setup(answers: Answers, file: Record<string, unknown> = { id: USER.id }) {
  const sent: string[] = [];
  const requests: { method: string; body: Record<string, unknown> }[] = [];
  const commits: string[] = [];
  const values = new Map<string, string>();
  const github = {
    userExists: async () => true,
    createUser: async (): Promise<"created" | "exists"> => "exists",
    readUser: async () => ({ data: structuredClone(file), sha: "sha" }),
    writeUser: async (_id: number, _data: Record<string, unknown>, _sha: string, message: string): Promise<"ok" | "conflict"> => {
      commits.push(message);
      return "ok";
    },
  } satisfies GitHub;
  const kv: Store = {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
  const telegram = {
    call: async (method: string, body: Record<string, unknown>) => {
      if (method === "sendMessage") {
        sent.push(String(body.text));
      }
    },
    request: async (method: string, body: Record<string, unknown>) => {
      requests.push({ method, body });
      const key = method === "getChatMember" ? `${method}:${String(body.user_id)}` : method;
      return answers[key];
    },
  };
  const run = (update: Update) => handleUpdate(update, { telegram, github, kv, ownerId: 1, fetcher: fetch });
  return { sent, requests, commits, values, run };
}

function message(text: string): Update {
  return { message: { message_id: 1, chat: { id: USER.id, type: "private" }, from: USER, text } };
}

function logged(): string {
  return vi.mocked(console.error).mock.calls.map((call) => String(call[0])).join("\n");
}

const ADMIN = { status: "administrator", can_post_messages: true };
const CHECK_FAILED = "Не удалось проверить канал, попробуйте ещё раз.";

describe("Telegram responses of an unexpected shape", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["getMe without an id", { getMe: {} }],
    ["getMe that is not an object", { getMe: "ok" }],
    ["bot membership without a status", { getMe: { id: BOT_ID }, [`getChatMember:${BOT_ID}`]: { can_post_messages: true } }],
    ["user membership without a status", { getMe: { id: BOT_ID }, [`getChatMember:${BOT_ID}`]: ADMIN, [`getChatMember:${USER.id}`]: {} }],
  ])("asks to retry the channel check on %s", async (_name, answers) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bot = setup({ getChat: CHANNEL, ...answers });
    bot.values.set(channelKey(USER.id), "1");
    await bot.run(message("@my_chan"));
    expect(bot.sent).toEqual([CHECK_FAILED]);
    expect(logged()).toMatch(/Telegram (getMe|getChatMember) returned an unexpected response/);
    expect(bot.commits).toHaveLength(0);
    expect(bot.values.get(channelKey(USER.id))).toBe("1");
    expect(bot.requests.filter((r) => r.method === "getChatMember").every((r) => typeof r.body.user_id === "number")).toBe(true);
  });

  it("treats a chat of an unexpected shape as not found and logs it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bot = setup({ getChat: { type: "channel", title: "Без id" } });
    bot.values.set(channelKey(USER.id), "1");
    await bot.run(message("@my_chan"));
    expect(bot.sent).toEqual(["Канал не найден. Проверьте имя или перешлите пост из канала."]);
    expect(logged()).toMatch(/Telegram getChat returned an unexpected response/);
    expect(bot.commits).toHaveLength(0);
  });

  it("shows the channel id in /chat when getChat answers without an id", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const bot = setup({ getChat: { type: "channel", title: "Без id" } }, { id: USER.id, chat_id: CHANNEL.id });
    await bot.run(message("/chat"));
    expect(bot.sent).toEqual([`Дайджест приходит: в канал ${CHANNEL.id}`]);
    expect(logged()).toMatch(/Telegram getChat returned an unexpected response/);
  });

  it("still saves a channel when every answer has the expected shape", async () => {
    const bot = setup({ getChat: CHANNEL, getMe: { id: BOT_ID }, [`getChatMember:${BOT_ID}`]: ADMIN, [`getChatMember:${USER.id}`]: { status: "creator" } });
    bot.values.set(channelKey(USER.id), "1");
    await bot.run(message("@my_chan"));
    expect(bot.sent).toEqual(["Дайджест будет приходить в канал «Мой канал»."]);
    expect(bot.commits).toEqual([`chore(users): set chat for ${USER.id} via bot`]);
    expect(bot.values.has(channelKey(USER.id))).toBe(false);
  });
});
