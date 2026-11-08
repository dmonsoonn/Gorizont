import { describe, expect, it, vi } from "vitest";
import { handleUpdate, pendingKey, rejectedKey, PENDING_TTL_SECONDS, type Store, type Update } from "../src/bot";
import type { GitHub } from "../src/github";

const OWNER = 612722019;
const USER = { id: 123, first_name: "Вася", last_name: "Пупкин", username: "vasya" };

function setup(existing: number[] = []) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const users = new Set(existing);
  const github = {
    userExists: vi.fn(async (id: number) => users.has(id)),
    createUser: vi.fn(async (id: number): Promise<"created" | "exists"> => {
      if (users.has(id)) {
        return "exists";
      }
      users.add(id);
      return "created";
    }),
  } satisfies GitHub;
  const values = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const kv: Store = {
    get: async (key) => values.get(key) ?? null,
    put: async (key, value, options) => {
      values.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
  const deps = {
    telegram: { call: async (method: string, body: Record<string, unknown>) => void calls.push({ method, body }) },
    github,
    kv,
    ownerId: OWNER,
  };
  const run = (update: Update) => handleUpdate(update, deps);
  const sent = (chatId: number) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId);
  return { calls, users, github, values, ttls, run, sent };
}

function text(from: typeof USER, value: string, chatType = "private"): Update {
  return { message: { message_id: 1, chat: { id: from.id, type: chatType }, from, text: value } };
}

function press(data: string, fromId = OWNER): Update {
  return {
    callback_query: {
      id: "cb1",
      from: { id: fromId, first_name: "Owner" },
      data,
      message: { message_id: 77, chat: { id: OWNER, type: "private" }, text: "Новая заявка на доступ к Горизонту" },
    },
  };
}

describe("/start from a new user", () => {
  it("sends the request to the owner with buttons and confirms to the user", async () => {
    const bot = setup();
    await bot.run(text(USER, "/start"));

    const [request] = bot.sent(OWNER);
    expect(request.body.parse_mode).toBe("HTML");
    expect(request.body.text).toContain("<b>Вася Пупкин</b>");
    expect(request.body.text).toContain("@vasya");
    expect(request.body.text).toContain("<code>123</code>");
    expect(request.body.text).toContain('href="tg://user?id=123"');
    expect(request.body.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "Одобрить", callback_data: "approve:123" },
          { text: "Отклонить", callback_data: "reject:123" },
        ],
      ],
    });
    expect(bot.values.get(pendingKey(123))).toBe("1");
    expect(bot.ttls.get(pendingKey(123))).toBe(PENDING_TTL_SECONDS);
    expect(bot.sent(123).map((c) => c.body.text)).toEqual(["Заявка отправлена владельцу. Я напишу, когда её рассмотрят."]);
  });

  it("escapes HTML in names and handles a missing username", async () => {
    const bot = setup();
    await bot.run(text({ id: 5, first_name: "<i>&", last_name: "", username: "" }, "/start"));
    const [request] = bot.sent(OWNER);
    expect(request.body.text).toContain("<b>&lt;i&gt;&amp;</b>");
    expect(request.body.text).toContain("Username: нет");
  });

  it("does not notify the owner twice while the request is pending", async () => {
    const bot = setup();
    await bot.run(text(USER, "/start"));
    await bot.run(text(USER, "/start"));
    expect(bot.sent(OWNER)).toHaveLength(1);
    expect(bot.sent(123).at(-1)?.body.text).toBe("Заявка уже на рассмотрении.");
  });

  it("does not notify the owner after a rejection", async () => {
    const bot = setup();
    bot.values.set(rejectedKey(123), "1");
    await bot.run(text(USER, "/start"));
    expect(bot.sent(OWNER)).toHaveLength(0);
    expect(bot.sent(123).at(-1)?.body.text).toBe("Владелец отклонил заявку.");
  });
});

describe("messages", () => {
  it("greets an existing user without a request", async () => {
    const bot = setup([123]);
    await bot.run(text(USER, "/start"));
    expect(bot.sent(OWNER)).toHaveLength(0);
    expect(bot.sent(123)[0].body.text).toContain("Вы уже подключены");
    expect(bot.sent(123)[0].body.text).toContain("/help");
    expect(bot.values.size).toBe(0);
  });

  it.each(["/help", "/help@gorizont_bot", "/help extra"])("answers %s with the command list", async (value) => {
    const bot = setup();
    await bot.run(text(USER, value));
    expect(bot.sent(123).map((c) => c.body.text)).toEqual(["Команды:\n/start — подключиться к Горизонту\n/help — список команд"]);
    expect(bot.github.userExists).not.toHaveBeenCalled();
  });

  it("points to /help on unknown text", async () => {
    const bot = setup();
    await bot.run(text(USER, "привет"));
    await bot.run({ message: { message_id: 2, chat: { id: 123, type: "private" }, from: USER } });
    expect(bot.sent(123).map((c) => c.body.text)).toEqual(["Не понимаю. Список команд — /help.", "Не понимаю. Список команд — /help."]);
  });

  it("ignores messages outside private chats", async () => {
    const bot = setup();
    await bot.run(text(USER, "/start", "group"));
    expect(bot.calls).toHaveLength(0);
  });
});

describe("owner decisions", () => {
  it("approve creates the user file and notifies both sides", async () => {
    const bot = setup();
    await bot.run(text(USER, "/start"));
    await bot.run(press("approve:123"));

    expect(bot.github.createUser).toHaveBeenCalledWith(123);
    expect(bot.users.has(123)).toBe(true);
    expect(bot.values.has(pendingKey(123))).toBe(false);
    expect(bot.calls).toContainEqual({ method: "answerCallbackQuery", body: { callback_query_id: "cb1" } });
    expect(bot.calls).toContainEqual({
      method: "editMessageText",
      body: { chat_id: OWNER, message_id: 77, text: "Новая заявка на доступ к Горизонту\n\n✅ Одобрено" },
    });
    const approved = bot.sent(123).at(-1)?.body.text;
    expect(approved).toContain("Доступ открыт");
    expect(approved).toContain("6 ч");
    expect(approved).toContain("/help");
  });

  it("reject remembers the user and notifies them", async () => {
    const bot = setup();
    await bot.run(text(USER, "/start"));
    await bot.run(press("reject:123"));

    expect(bot.github.createUser).not.toHaveBeenCalled();
    expect(bot.values.get(rejectedKey(123))).toBe("1");
    expect(bot.ttls.get(rejectedKey(123))).toBeUndefined();
    expect(bot.values.has(pendingKey(123))).toBe(false);
    expect(bot.calls).toContainEqual({
      method: "editMessageText",
      body: { chat_id: OWNER, message_id: 77, text: "Новая заявка на доступ к Горизонту\n\n❌ Отклонено" },
    });
    expect(bot.sent(123).at(-1)?.body.text).toBe("Владелец отклонил заявку.");

    await bot.run(text(USER, "/start"));
    expect(bot.sent(OWNER)).toHaveLength(1);
  });

  it("refuses decisions from anyone but the owner", async () => {
    const bot = setup();
    await bot.run(press("approve:123", 123));
    expect(bot.github.createUser).not.toHaveBeenCalled();
    expect(bot.calls).toEqual([
      { method: "answerCallbackQuery", body: { callback_query_id: "cb1", text: "Решать заявки может только владелец." } },
    ]);
  });

  it.each(["approve:abc", "approve:../x", "approve:0", "approve:", "approve:1 2", "approve:-5", "delete:123", "approve:12345678901234567"])(
    "refuses malformed callback data %s",
    async (data) => {
      const bot = setup();
      await bot.run(press(data));
      expect(bot.github.createUser).not.toHaveBeenCalled();
      expect(bot.values.size).toBe(0);
      expect(bot.calls).toEqual([{ method: "answerCallbackQuery", body: { callback_query_id: "cb1", text: "Некорректная кнопка." } }]);
    },
  );

  it("does not overwrite or re-greet an existing user", async () => {
    const bot = setup([123]);
    await bot.run(press("approve:123"));
    expect(bot.sent(123)).toHaveLength(0);
    expect(bot.calls).toContainEqual({ method: "answerCallbackQuery", body: { callback_query_id: "cb1", text: "Пользователь уже подключён." } });
  });

  it("keeps the request and tells the owner when GitHub fails", async () => {
    const bot = setup();
    await bot.run(text(USER, "/start"));
    bot.github.createUser.mockRejectedValueOnce(new Error("GitHub PUT user 123 failed: 502"));
    await bot.run(press("approve:123"));

    expect(bot.values.get(pendingKey(123))).toBe("1");
    expect(bot.sent(123).map((c) => c.body.text)).not.toContainEqual(expect.stringContaining("Доступ открыт"));
    expect(bot.sent(OWNER).at(-1)?.body.text).toContain("502");
    expect(bot.sent(OWNER).at(-1)?.body.text).toContain("ещё раз");
    expect(bot.calls.some((c) => c.method === "editMessageText")).toBe(false);
  });
});
