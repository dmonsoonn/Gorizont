import { describe, expect, it, vi } from "vitest";
import { feedsKey, FEEDS_TTL_SECONDS, handleUpdate, pendingKey, rejectedKey, PENDING_TTL_SECONDS, type Store, type Update } from "../src/bot";
import { keyHash, sourceKey, type Source } from "../src/sources";
import type { GitHub } from "../src/github";

const OWNER = 612722019;
const USER = { id: 123, first_name: "Вася", last_name: "Пупкин", username: "vasya" };

function setup(existing: number[] = []) {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const users = new Set(existing);
  const files = new Map<number, Record<string, unknown>>();
  const commits: { id: number; message: string }[] = [];
  const state = { conflicts: 0, readError: false };
  const routes: Record<string, string> = {};
  const github = {
    userExists: vi.fn(async (id: number) => users.has(id)),
    createUser: vi.fn(async (id: number): Promise<"created" | "exists"> => {
      if (users.has(id)) {
        return "exists";
      }
      users.add(id);
      return "created";
    }),
    readUser: vi.fn(async (id: number) => {
      if (state.readError) {
        throw new Error("GitHub GET user failed: 502");
      }
      return users.has(id) ? { data: structuredClone(files.get(id) ?? { id }), sha: `sha${commits.length}` } : null;
    }),
    writeUser: vi.fn(async (id: number, data: Record<string, unknown>, _sha: string, message: string): Promise<"ok" | "conflict"> => {
      if (state.conflicts > 0) {
        state.conflicts--;
        return "conflict";
      }
      files.set(id, data);
      commits.push({ id, message });
      return "ok";
    }),
  } satisfies GitHub;
  const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
    String(input) in routes ? new Response(routes[String(input)]) : new Response("missing", { status: 404 }),
  );
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
    fetcher,
  };
  const run = (update: Update) => handleUpdate(update, deps);
  const sent = (chatId: number) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId);
  return { calls, users, files, commits, state, routes, fetcher, github, values, ttls, run, sent };
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
    expect(bot.sent(123).map((c) => c.body.text)).toEqual([
      [
        "Команды:",
        "/start — подключиться к Горизонту",
        "/help — список команд",
        "",
        "Чтобы добавить источник, пришлите ссылку или перешлите пост из канала:",
        "• Telegram: t.me/канал, @канал или пересланный пост",
        "• Reddit: r/сабреддит, u/пользователь или ссылка на них",
        "• GitHub: github.com/владелец/репозиторий (релизы) или github.com/пользователь (активность)",
        "• RSS: ссылка на фид или на сайт, фид найду сам",
        "",
        "Не больше 20 источников. Список ваших источников хранится в публичном репозитории.",
      ].join("\n"),
    ]);
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

const RSS = "<rss><channel><title>Блог</title></channel></rss>";
const OWNER_USER = { ...USER, id: OWNER };

function click(data: string, fromId = 123, messageText = "Добавлено: Telegram @durov_news"): Update {
  return {
    callback_query: {
      id: "cb2",
      from: { id: fromId, first_name: "Кто-то" },
      data,
      message: { message_id: 88, chat: { id: fromId, type: "private" }, text: messageText },
    },
  };
}

function lastText(bot: ReturnType<typeof setup>, chatId = 123) {
  return bot.sent(chatId).at(-1)?.body.text;
}

function undoData(source: Source) {
  return `undo:${keyHash(sourceKey(source))}`;
}

describe("adding sources", () => {
  it.each([
    text(USER, "https://t.me/durov_news"),
    text(USER, "t.me/s/durov_news/42"),
    text(USER, "@durov_news"),
    { message: { message_id: 3, chat: { id: 123, type: "private" }, from: USER, forward_origin: { type: "channel", chat: { username: "durov_news" } } } },
    { message: { message_id: 3, chat: { id: 123, type: "private" }, from: USER, caption: "фото", forward_origin: { type: "channel", chat: { username: "durov_news" } } } },
  ])("adds a Telegram channel with an undo button (%#)", async (update) => {
    const bot = setup([123]);
    await bot.run(update);
    expect(bot.files.get(123)).toEqual({ id: 123, sources: { telegram: { channels: [{ channel: "durov_news" }] } } });
    expect(bot.commits).toEqual([{ id: 123, message: "chore(users): add telegram source for 123 via bot" }]);
    expect(bot.sent(123)).toEqual([
      {
        method: "sendMessage",
        body: {
          chat_id: 123,
          text: "Добавлено: Telegram @durov_news",
          reply_markup: { inline_keyboard: [[{ text: "Отменить", callback_data: undoData({ kind: "telegram", channel: "durov_news" }) }]] },
        },
      },
    ]);
  });

  it.each(["/start", "/help", "/list что-то"])("treats a forwarded post starting with %s as its channel", async (value) => {
    const bot = setup([123]);
    await bot.run({
      message: { message_id: 3, chat: { id: 123, type: "private" }, from: USER, text: value, forward_origin: { type: "channel", chat: { username: "durov_news" } } },
    });
    expect(bot.files.get(123)).toEqual({ id: 123, sources: { telegram: { channels: [{ channel: "durov_news" }] } } });
    expect(bot.sent(OWNER)).toHaveLength(0);
    expect(bot.sent(123).map((c) => c.body.text)).toEqual(["Добавлено: Telegram @durov_news"]);
  });

  it.each([
    ["r/rust", { reddit: { subreddits: [{ subreddit: "rust" }] } }, "subreddit", "Reddit r/rust"],
    ["/r/rust", { reddit: { subreddits: [{ subreddit: "rust" }] } }, "subreddit", "Reddit r/rust"],
    ["https://www.reddit.com/user/spez", { reddit: { users: [{ username: "spez" }] } }, "reddit_user", "Reddit u/spez"],
    ["https://github.com/astral-sh/uv", { github: [{ type: "repo_releases", owner: "astral-sh", repo: "uv" }] }, "github_repo", "GitHub astral-sh/uv (релизы)"],
    ["github.com/torvalds", { github: [{ type: "user_events", username: "torvalds" }] }, "github_user", "GitHub torvalds (активность)"],
  ])("adds %s", async (value, sources, kind, label) => {
    const bot = setup([123]);
    await bot.run(text(USER, value));
    expect(bot.files.get(123)).toEqual({ id: 123, sources });
    expect(bot.commits).toEqual([{ id: 123, message: `chore(users): add ${kind} source for 123 via bot` }]);
    expect(lastText(bot)).toBe(`Добавлено: ${label}`);
    expect(bot.fetcher).not.toHaveBeenCalled();
  });

  it("adds a direct RSS feed with its title", async () => {
    const bot = setup([123]);
    bot.routes["https://blog.example/feed"] = RSS;
    await bot.run(text(USER, "https://blog.example/feed"));
    expect(bot.files.get(123)).toEqual({ id: 123, sources: { rss: [{ name: "Блог", url: "https://blog.example/feed" }] } });
    expect(bot.commits).toEqual([{ id: 123, message: "chore(users): add rss source for 123 via bot" }]);
    expect(lastText(bot)).toBe("Добавлено: RSS «Блог»");
  });

  it("finds the only feed of a site", async () => {
    const bot = setup([123]);
    bot.routes["https://blog.example/"] = '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>';
    bot.routes["https://blog.example/feed.xml"] = RSS;
    await bot.run(text(USER, "blog.example"));
    expect(bot.files.get(123)).toEqual({ id: 123, sources: { rss: [{ name: "Блог", url: "https://blog.example/feed.xml" }] } });
  });

  it("offers a choice of feeds and adds the chosen one", async () => {
    const bot = setup([123]);
    bot.routes["https://blog.example/"] = [
      "<html><head>",
      '<link rel="alternate" type="application/rss+xml" title="Посты" href="/feed.xml">',
      '<link rel="alternate" type="application/rss+xml" title="Комментарии" href="/comments.xml">',
      "</head></html>",
    ].join("");
    bot.routes["https://blog.example/comments.xml"] = "<rss><channel><title>Комментарии блога</title></channel></rss>";
    await bot.run(text(USER, "https://blog.example/"));

    const nonce = keyHash("https://blog.example/");
    expect(bot.commits).toHaveLength(0);
    expect(bot.ttls.get(feedsKey(123))).toBe(FEEDS_TTL_SECONDS);
    expect(bot.sent(123).at(-1)?.body).toEqual({
      chat_id: 123,
      text: "На странице несколько фидов. Какой добавить?",
      reply_markup: {
        inline_keyboard: [[{ text: "Посты", callback_data: `feed:${nonce}:0` }], [{ text: "Комментарии", callback_data: `feed:${nonce}:1` }]],
      },
    });

    await bot.run(click(`feed:${nonce}:1`, 123, "На странице несколько фидов. Какой добавить?"));
    expect(bot.files.get(123)).toEqual({ id: 123, sources: { rss: [{ name: "Комментарии блога", url: "https://blog.example/comments.xml" }] } });
    expect(bot.values.has(feedsKey(123))).toBe(false);
    expect(bot.calls).toContainEqual({ method: "answerCallbackQuery", body: { callback_query_id: "cb2" } });
    expect(bot.calls).toContainEqual({
      method: "editMessageText",
      body: { chat_id: 123, message_id: 88, text: "На странице несколько фидов. Какой добавить?\n\nВыбран: Комментарии" },
    });
    expect(lastText(bot)).toBe("Добавлено: RSS «Комментарии блога»");
  });

  it("undo removes the source with a second commit", async () => {
    const bot = setup([123]);
    await bot.run(text(USER, "@durov_news"));
    await bot.run(click(undoData({ kind: "telegram", channel: "durov_news" })));
    expect(bot.files.get(123)).toEqual({ id: 123, sources: { telegram: { channels: [] } } });
    expect(bot.commits.map((c) => c.message)).toEqual([
      "chore(users): add telegram source for 123 via bot",
      "chore(users): remove telegram source for 123 via bot",
    ]);
    expect(bot.calls).toContainEqual({
      method: "editMessageText",
      body: { chat_id: 123, message_id: 88, text: "Добавлено: Telegram @durov_news\n\nОтменено" },
    });
  });

  it("refuses the 21st source", async () => {
    const bot = setup([123]);
    const channels = Array.from({ length: 20 }, (_, i) => ({ channel: `channel_${i}` }));
    bot.files.set(123, { id: 123, sources: { telegram: { channels } } });
    await bot.run(text(USER, "r/rust"));
    expect(bot.commits).toHaveLength(0);
    expect(lastText(bot)).toBe("Уже 20 источников, это максимум. Новый не добавлен.");
  });

  it("reports a duplicate without a commit", async () => {
    const bot = setup([123]);
    bot.files.set(123, { id: 123, sources: { telegram: { channels: [{ channel: "durov_news" }] } } });
    await bot.run(text(USER, "https://t.me/s/Durov_News"));
    expect(bot.commits).toHaveLength(0);
    expect(lastText(bot)).toBe("Уже есть: Telegram @Durov_News.");
  });

  it("keeps the owner's fields", async () => {
    const bot = setup([OWNER]);
    bot.files.set(OWNER, { id: OWNER, chat_id: "${TELEGRAM_CHAT_ID}", time_window_hours: 1 });
    await bot.run(text(OWNER_USER, "@durov_news"));
    expect(bot.files.get(OWNER)).toEqual({
      id: OWNER,
      chat_id: "${TELEGRAM_CHAT_ID}",
      time_window_hours: 1,
      sources: { telegram: { channels: [{ channel: "durov_news" }] } },
    });
  });

  it("explains sources and the public repository after approval", async () => {
    const bot = setup();
    await bot.run(text(USER, "/start"));
    await bot.run(press("approve:123"));
    expect(lastText(bot)).toContain("пришлите ссылку");
    expect(lastText(bot)).toContain("публичном репозитории");
  });

  it("retries once on a write conflict", async () => {
    const bot = setup([123]);
    bot.state.conflicts = 1;
    await bot.run(text(USER, "@durov_news"));
    expect(bot.github.readUser).toHaveBeenCalledTimes(2);
    expect(bot.commits).toHaveLength(1);
    expect(lastText(bot)).toBe("Добавлено: Telegram @durov_news");
  });
});

describe("adding sources: refusals", () => {
  it("asks a stranger to /start first without touching GitHub files or the network", async () => {
    const bot = setup();
    await bot.run(text(USER, "@durov_news"));
    await bot.run(text(USER, "https://blog.example/feed"));
    expect(bot.sent(123).map((c) => c.body.text)).toEqual(["Сначала подключитесь к Горизонту: /start.", "Сначала подключитесь к Горизонту: /start."]);
    expect(bot.github.readUser).not.toHaveBeenCalled();
    expect(bot.github.writeUser).not.toHaveBeenCalled();
    expect(bot.fetcher).not.toHaveBeenCalled();
  });

  it.each(["https://t.me/+AbCdEf", "https://t.me/joinchat/AbCdEf", "javascript:alert(1)", "ftp://example.com/feed", "https://example.com/${OPENAI_API_KEY}", "/list"])(
    "does not understand %s",
    async (value) => {
      const bot = setup([123]);
      await bot.run(text(USER, value));
      expect(bot.sent(123).map((c) => c.body.text)).toEqual(["Не понимаю. Список команд — /help."]);
      expect(bot.github.userExists).not.toHaveBeenCalled();
      expect(bot.commits).toHaveLength(0);
    },
  );

  it.each([{ type: "user" }, { type: "hidden_user" }, { type: "chat" }, { type: "channel", chat: {} }])("refuses a forward from %j", async (origin) => {
    const bot = setup([123]);
    await bot.run({ message: { message_id: 3, chat: { id: 123, type: "private" }, from: USER, text: "пост", forward_origin: origin } });
    expect(lastText(bot)).toContain("только публичные каналы");
    expect(bot.commits).toHaveLength(0);
  });

  it("reports a missing feed", async () => {
    const bot = setup([123]);
    bot.routes["https://blog.example/"] = "<html><head></head></html>";
    await bot.run(text(USER, "https://blog.example/"));
    expect(lastText(bot)).toBe("Не нашёл RSS-фид по этой ссылке. Пришлите прямую ссылку на фид.");
    expect(bot.commits).toHaveLength(0);
  });

  it.each([
    ["two conflicts", (bot: ReturnType<typeof setup>) => void (bot.state.conflicts = 2)],
    ["a GitHub error", (bot: ReturnType<typeof setup>) => void (bot.state.readError = true)],
  ])("reports a failed save after %s", async (_name, breakIt) => {
    const bot = setup([123]);
    breakIt(bot);
    await bot.run(text(USER, "@durov_news"));
    expect(bot.commits).toHaveLength(0);
    expect(bot.files.has(123)).toBe(false);
    expect(lastText(bot)).toBe("Не удалось сохранить, попробуйте ещё раз.");
  });

  it("undo by someone without that source changes nothing", async () => {
    const bot = setup([123, 456]);
    await bot.run(text(USER, "@durov_news"));
    const data = undoData({ kind: "telegram", channel: "durov_news" });
    await bot.run(click(data, 456));
    await bot.run(click(data, 789));
    expect(bot.files.get(123)).toEqual({ id: 123, sources: { telegram: { channels: [{ channel: "durov_news" }] } } });
    expect(bot.commits).toHaveLength(1);
    expect(bot.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body.text)).toEqual(["Кнопка устарела.", "Кнопка устарела."]);
    expect(bot.calls.some((c) => c.method === "editMessageText")).toBe(false);
  });

  it("undo twice reports a stale button", async () => {
    const bot = setup([123]);
    await bot.run(text(USER, "@durov_news"));
    const data = undoData({ kind: "telegram", channel: "durov_news" });
    await bot.run(click(data));
    await bot.run(click(data));
    expect(bot.commits).toHaveLength(2);
    expect(bot.calls.at(-1)).toEqual({ method: "answerCallbackQuery", body: { callback_query_id: "cb2", text: "Кнопка устарела." } });
  });

  it("refuses an expired, foreign or replaced feed choice", async () => {
    const bot = setup([123, 456]);
    const nonce = keyHash("https://blog.example/");
    await bot.run(click(`feed:${nonce}:0`));
    bot.values.set(feedsKey(123), JSON.stringify({ nonce: "00000000", choices: [{ url: "https://blog.example/feed.xml", title: "Посты" }] }));
    await bot.run(click(`feed:${nonce}:0`));
    await bot.run(click("feed:00000000:3"));
    await bot.run(click("feed:00000000:0", 456));
    expect(bot.calls.map((c) => c.body.text)).toEqual(Array(4).fill("Выбор устарел, пришлите ссылку снова."));
    expect(bot.fetcher).not.toHaveBeenCalled();
    expect(bot.commits).toHaveLength(0);
  });
});
