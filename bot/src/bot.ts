import { discoverFeeds, fetchFeed, type Feed } from "./feeds";
import { NEW_USER_WINDOW_HOURS, type GitHub } from "./github";
import {
  addSource,
  countSources,
  keyHash,
  listSources,
  MAX_SOURCES,
  parseInput,
  removeSource,
  setEnabled,
  sourceKey,
  sourceLabel,
  sourceLink,
  type ForwardOrigin,
  type Listed,
  type Source,
  type UserData,
} from "./sources";
import { chatTarget, parseChannel, resetChat, setChat, setWindow, WINDOWS, windowOf } from "./settings";
import type { Telegram } from "./telegram";

export const PENDING_TTL_SECONDS = 24 * 60 * 60;
export const FEEDS_TTL_SECONDS = 10 * 60;
export const CHANNEL_TTL_SECONDS = 10 * 60;

const CALLBACK_PATTERN = /^(approve|reject):([1-9][0-9]{0,14})$/;
const UNDO_PATTERN = /^undo:([0-9a-f]{8})$/;
const FEED_PATTERN = /^feed:([0-9a-f]{8}):([0-4])$/;
const MANAGE_PATTERN = /^(?:ls|(src|off|on|del|rm):([0-9a-f]{8}))$/;
const WINDOW_PATTERN = /^win:(3|6|12|24)$/;
const CHAT_PATTERN = /^chat:(channel|private|cancel)$/;
const COMMAND_PATTERN = /^\/[A-Za-z0-9_]+$/;
const BUTTON_LENGTH = 60;

const HELP = [
  "Команды:",
  "/start — подключиться к Горизонту",
  "/list — ваши источники",
  "/window — как часто приходит дайджест",
  "/chat — куда приходит дайджест",
  "/help — список команд",
  "",
  "Чтобы добавить источник, пришлите ссылку или перешлите пост из канала:",
  "• Telegram: t.me/канал, @канал или пересланный пост",
  "• Reddit: r/сабреддит, u/пользователь или ссылка на них",
  "• GitHub: github.com/владелец/репозиторий (релизы) или github.com/пользователь (активность)",
  "• RSS: ссылка на фид или на сайт, фид найду сам",
  "",
  `Не больше ${MAX_SOURCES} источников. Список ваших источников хранится в публичном репозитории.`,
].join("\n");
const WELCOME_BACK = `Вы уже подключены к Горизонту.\n\n${HELP}`;
const REQUEST_SENT = "Заявка отправлена владельцу. Я напишу, когда её рассмотрят.";
const REQUEST_PENDING = "Заявка уже на рассмотрении.";
const REJECTED = "Владелец отклонил заявку.";
const APPROVED = `Доступ открыт. Дайджест будет приходить в этот чат раз в ${NEW_USER_WINDOW_HOURS} ч, когда у вас появятся источники.\n\n${HELP}`;
const UNKNOWN = "Не понимаю. Список команд — /help.";
const NOT_OWNER = "Решать заявки может только владелец.";
const BAD_CALLBACK = "Некорректная кнопка.";
const ALREADY_USER = "Пользователь уже подключён.";
const NEED_START = "Сначала подключитесь к Горизонту: /start.";
const PRIVATE_FORWARD = "Подходят только публичные каналы с @username. Перешлите пост из такого канала или пришлите ссылку t.me/канал.";
const FEED_NOT_FOUND = "Не нашёл RSS-фид по этой ссылке. Пришлите прямую ссылку на фид.";
const CHOOSE_FEED = "На странице несколько фидов. Какой добавить?";
const CHOICE_EXPIRED = "Выбор устарел, пришлите ссылку снова.";
const STALE_BUTTON = "Кнопка устарела.";
const SAVE_FAILED = "Не удалось сохранить, попробуйте ещё раз.";
const LIMIT = `Уже ${MAX_SOURCES} источников, это максимум. Новый не добавлен.`;
const NO_SOURCES = "Источников пока нет. Как добавить — /help.";
const READ_FAILED = "Не удалось загрузить источники, попробуйте ещё раз.";
const SOURCE_GONE = "Источника уже нет.";
const NOT_MODIFIED = "message is not modified";
const SAVED = "Сохранено";
const SETTINGS_READ_FAILED = "Не удалось загрузить настройки, попробуйте ещё раз.";
const PRIVATE_CHAT = "в личный чат";
const CHANNEL_PROMPT = "Перешлите пост из канала или пришлите @имя / ссылку t.me/имя. Бот должен быть администратором канала с правом публикации.";
const NOT_CHANNEL = "Это не канал. Перешлите пост из канала или пришлите @имя / ссылку t.me/имя. Отменить — любая команда.";
const CHANNEL_NOT_FOUND = "Канал не найден. Проверьте имя или перешлите пост из канала.";
const BOT_NOT_ADMIN = "Бот не администратор канала или не может публиковать. Добавьте бота в администраторы с правом публикации и пришлите канал снова.";
const NOT_CHANNEL_ADMIN = "Вы не администратор этого канала.";
const CHANNEL_CANCELLED = "Выбор канала отменён.";
const CHECK_FAILED = "Не удалось проверить канал, попробуйте ещё раз.";
const BAD_REQUEST = "Bad Request";

export interface User {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface Message {
  message_id: number;
  chat: { id: number; type: string };
  from?: User;
  text?: string;
  caption?: string;
  forward_origin?: ForwardOrigin;
}

export interface CallbackQuery {
  id: string;
  from: User;
  data?: string;
  message?: Message;
}

export interface Update {
  message?: Message;
  callback_query?: CallbackQuery;
}

export interface Store {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Deps {
  telegram: Telegram;
  github: GitHub;
  kv: Store;
  ownerId: number;
  fetcher: typeof fetch;
}

export const pendingKey = (id: number) => `pending:${id}`;
export const rejectedKey = (id: number) => `rejected:${id}`;
export const feedsKey = (id: number) => `feeds:${id}`;
export const channelKey = (id: number) => `chat:${id}`;

export async function handleUpdate(update: Update, deps: Deps): Promise<void> {
  if (update.message) {
    await handleMessage(update.message, deps);
  } else if (update.callback_query) {
    await handleCallback(update.callback_query, deps);
  }
}

async function handleMessage(message: Message, deps: Deps): Promise<void> {
  if (message.chat.type !== "private" || !message.from) {
    return;
  }
  const user = message.from;
  const reply = (text: string) => deps.telegram.call("sendMessage", { chat_id: message.chat.id, text });
  const text = message.text ?? message.caption ?? "";
  const command = text.split(/\s/, 1)[0].split("@", 1)[0];
  const isCommand = !message.forward_origin && COMMAND_PATTERN.test(command);
  if ((await deps.kv.get(channelKey(user.id))) !== null) {
    if (!isCommand) {
      return pickChannel(user.id, text, message.forward_origin, deps);
    }
    await deps.kv.delete(channelKey(user.id));
  }
  if (message.forward_origin) {
    return addFromMessage(user.id, text, message.forward_origin, deps);
  }

  if (command === "/help") {
    return reply(HELP);
  }
  if (command === "/list") {
    return showList(user.id, deps);
  }
  if (command === "/window") {
    return showSetting(user.id, deps, async (data) => windowView(data));
  }
  if (command === "/chat") {
    return showSetting(user.id, deps, async (data) => chatView(await chatLabel(data, deps)));
  }
  if (command !== "/start") {
    return COMMAND_PATTERN.test(command) ? reply(UNKNOWN) : addFromMessage(user.id, text, message.forward_origin, deps);
  }
  if (await deps.github.userExists(user.id)) {
    return reply(WELCOME_BACK);
  }
  if ((await deps.kv.get(rejectedKey(user.id))) !== null) {
    return reply(REJECTED);
  }
  if ((await deps.kv.get(pendingKey(user.id))) !== null) {
    return reply(REQUEST_PENDING);
  }
  await deps.telegram.call("sendMessage", {
    chat_id: deps.ownerId,
    text: requestText(user),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Одобрить", callback_data: `approve:${user.id}` },
          { text: "Отклонить", callback_data: `reject:${user.id}` },
        ],
      ],
    },
  });
  await deps.kv.put(pendingKey(user.id), "1", { expirationTtl: PENDING_TTL_SECONDS });
  await reply(REQUEST_SENT);
}

async function handleCallback(query: CallbackQuery, deps: Deps): Promise<void> {
  const answer = (text?: string) =>
    deps.telegram.call("answerCallbackQuery", text ? { callback_query_id: query.id, text } : { callback_query_id: query.id });

  const undo = UNDO_PATTERN.exec(query.data ?? "");
  if (undo) {
    return undoSource(query, undo[1], deps);
  }
  const choice = FEED_PATTERN.exec(query.data ?? "");
  if (choice) {
    return chooseFeed(query, choice[1], Number(choice[2]), deps);
  }
  const manage = MANAGE_PATTERN.exec(query.data ?? "");
  if (manage) {
    return manageSource(query, (manage[1] ?? "ls") as Action, manage[2] ?? "", deps);
  }
  const hours = WINDOW_PATTERN.exec(query.data ?? "");
  if (hours) {
    return chooseWindow(query, Number(hours[1]), deps);
  }
  const chat = CHAT_PATTERN.exec(query.data ?? "");
  if (chat) {
    return chooseChat(query, chat[1] as ChatAction, deps);
  }
  const match = CALLBACK_PATTERN.exec(query.data ?? "");
  if (!match) {
    return answer(BAD_CALLBACK);
  }
  if (query.from.id !== deps.ownerId) {
    return answer(NOT_OWNER);
  }
  const userId = Number(match[2]);

  if (match[1] === "reject") {
    await deps.kv.put(rejectedKey(userId), "1");
    await deps.kv.delete(pendingKey(userId));
    await answer();
    await markDecision(query, "❌ Отклонено", deps);
    await deps.telegram.call("sendMessage", { chat_id: userId, text: REJECTED });
    return;
  }

  let result: "created" | "exists";
  try {
    result = await deps.github.createUser(userId);
  } catch (error) {
    await answer();
    await deps.telegram.call("sendMessage", {
      chat_id: deps.ownerId,
      text: `Не удалось создать файл пользователя ${userId}: ${String(error)}. Нажмите «Одобрить» ещё раз.`,
    });
    return;
  }
  await deps.kv.delete(pendingKey(userId));
  await deps.kv.delete(rejectedKey(userId));
  if (result === "exists") {
    await answer(ALREADY_USER);
    await markDecision(query, `✅ ${ALREADY_USER}`, deps);
    return;
  }
  await answer();
  await markDecision(query, "✅ Одобрено", deps);
  await deps.telegram.call("sendMessage", { chat_id: userId, text: APPROVED });
}

type Saved = "added" | "duplicate" | "limit" | "missing" | "failed";

interface Change<T> {
  outcome: T;
  write?: { data: UserData; message: string };
}

async function editUser<T>(userId: number, deps: Deps, change: (data: UserData) => Change<T>): Promise<T | "missing" | "failed"> {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const file = await deps.github.readUser(userId);
      if (!file) {
        return "missing";
      }
      const { outcome, write } = change(file.data);
      if (!write || (await deps.github.writeUser(userId, write.data, file.sha, write.message)) === "ok") {
        return outcome;
      }
    }
  } catch (error) {
    console.error(error);
  }
  return "failed";
}

function saveSource(userId: number, source: Source, deps: Deps): Promise<Saved> {
  return editUser<Saved>(userId, deps, (data) => {
    const result = addSource(data, source);
    if (typeof result === "string") {
      return { outcome: result };
    }
    return { outcome: "added", write: { data: result.data, message: `chore(users): add ${source.kind} source for ${userId} via bot` } };
  });
}

async function announce(userId: number, source: Source, saved: Saved, deps: Deps): Promise<void> {
  const label = sourceLabel(source);
  if (saved === "added") {
    await deps.telegram.call("sendMessage", {
      chat_id: userId,
      text: `Добавлено: ${label}\nВсе источники — /list`,
      reply_markup: { inline_keyboard: [[{ text: "Отменить", callback_data: `undo:${keyHash(sourceKey(source))}` }]] },
    });
    return;
  }
  const texts = { duplicate: `Уже есть: ${label}.`, limit: LIMIT, missing: NEED_START, failed: SAVE_FAILED };
  await deps.telegram.call("sendMessage", { chat_id: userId, text: texts[saved] });
}

async function addFromMessage(userId: number, text: string, origin: ForwardOrigin | undefined, deps: Deps): Promise<void> {
  const reply = (body: string) => deps.telegram.call("sendMessage", { chat_id: userId, text: body });
  const parsed = parseInput(text, origin);
  if ("error" in parsed) {
    return reply(parsed.error === "private_forward" ? PRIVATE_FORWARD : UNKNOWN);
  }
  if (!(await deps.github.userExists(userId))) {
    return reply(NEED_START);
  }
  if ("source" in parsed) {
    return announce(userId, parsed.source, await saveSource(userId, parsed.source, deps), deps);
  }
  const found = await discoverFeeds(parsed.feedUrl, deps.fetcher);
  if ("error" in found) {
    return reply(FEED_NOT_FOUND);
  }
  if ("choices" in found) {
    return offerFeeds(userId, keyHash(parsed.feedUrl), found.choices, deps);
  }
  const source: Source = { kind: "rss", name: found.feed.title, url: found.feed.url };
  await announce(userId, source, await saveSource(userId, source, deps), deps);
}

async function offerFeeds(userId: number, nonce: string, choices: Feed[], deps: Deps): Promise<void> {
  await deps.kv.put(feedsKey(userId), JSON.stringify({ nonce, choices }), { expirationTtl: FEEDS_TTL_SECONDS });
  await deps.telegram.call("sendMessage", {
    chat_id: userId,
    text: CHOOSE_FEED,
    reply_markup: {
      inline_keyboard: choices.map((feed, index) => [
        { text: clip(feed.title), callback_data: `feed:${nonce}:${index}` },
      ]),
    },
  });
}

async function chooseFeed(query: CallbackQuery, nonce: string, index: number, deps: Deps): Promise<void> {
  const userId = query.from.id;
  const stored = await deps.kv.get(feedsKey(userId));
  const offer: { nonce: string; choices: Feed[] } | null = stored ? JSON.parse(stored) : null;
  const choice = offer?.nonce === nonce ? offer.choices[index] : undefined;
  if (!choice) {
    await deps.telegram.call("answerCallbackQuery", { callback_query_id: query.id, text: CHOICE_EXPIRED });
    return;
  }
  await deps.telegram.call("answerCallbackQuery", { callback_query_id: query.id });
  const feed = await fetchFeed(choice.url, deps.fetcher);
  if (!feed) {
    await deps.telegram.call("sendMessage", { chat_id: userId, text: FEED_NOT_FOUND });
    return;
  }
  const source: Source = { kind: "rss", name: feed.title, url: feed.url };
  const saved = await saveSource(userId, source, deps);
  if (saved !== "failed") {
    await deps.kv.delete(feedsKey(userId));
    await markDecision(query, `Выбран: ${choice.title}`, deps);
  }
  await announce(userId, source, saved, deps);
}

async function undoSource(query: CallbackQuery, hash: string, deps: Deps): Promise<void> {
  const userId = query.from.id;
  const outcome = await editUser<"removed" | "stale">(userId, deps, (data) => {
    const removed = removeSource(data, hash);
    if (!removed) {
      return { outcome: "stale" };
    }
    return { outcome: "removed", write: { data: removed.data, message: `chore(users): remove ${removed.kind} source for ${userId} via bot` } };
  });
  if (outcome !== "removed") {
    await deps.telegram.call("answerCallbackQuery", { callback_query_id: query.id, text: outcome === "failed" ? SAVE_FAILED : STALE_BUTTON });
    return;
  }
  await deps.telegram.call("answerCallbackQuery", { callback_query_id: query.id });
  await markDecision(query, "Отменено", deps);
}

type Action = "ls" | "src" | "off" | "on" | "del" | "rm";

interface View {
  text: string;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
  link_preview_options?: { is_disabled: boolean };
}

interface Managed {
  view: View;
  toast?: string;
}

async function showList(userId: number, deps: Deps): Promise<void> {
  let view: View;
  try {
    const file = await deps.github.readUser(userId);
    view = file ? listView(file.data) : { text: NEED_START };
  } catch (error) {
    console.error(error);
    view = { text: READ_FAILED };
  }
  await deps.telegram.call("sendMessage", { chat_id: userId, ...view });
}

async function manageSource(query: CallbackQuery, action: Action, hash: string, deps: Deps): Promise<void> {
  const userId = query.from.id;
  const answer = (text?: string) =>
    deps.telegram.call("answerCallbackQuery", text ? { callback_query_id: query.id, text } : { callback_query_id: query.id });
  const result = await editUser<Managed>(userId, deps, (data) => applyAction(data, action, hash, userId));
  if (result === "missing") {
    return answer(NEED_START);
  }
  if (result === "failed") {
    return answer(action === "off" || action === "on" || action === "rm" ? SAVE_FAILED : READ_FAILED);
  }
  await answer(result.toast);
  await editMessage(query, result.view, deps);
}

function applyAction(data: UserData, action: Action, hash: string, userId: number): Change<Managed> {
  const stale: Change<Managed> = { outcome: { view: listView(data), toast: SOURCE_GONE } };
  if (action === "rm") {
    const removed = removeSource(data, hash);
    if (!removed) {
      return stale;
    }
    return {
      outcome: { view: listView(removed.data), toast: "Удалено" },
      write: { data: removed.data, message: `chore(users): remove ${removed.kind} source for ${userId} via bot` },
    };
  }
  if (action === "off" || action === "on") {
    const enabled = action === "on";
    const updated = setEnabled(data, hash, enabled);
    const item = updated && listSources(updated.data).find((listed) => listed.hash === hash);
    if (!updated || !item) {
      return stale;
    }
    const outcome = { view: cardView(item), toast: enabled ? "Включено" : "Выключено" };
    if (!updated.changed) {
      return { outcome };
    }
    const verb = enabled ? "enable" : "disable";
    return { outcome, write: { data: updated.data, message: `chore(users): ${verb} ${updated.kind} source for ${userId} via bot` } };
  }
  if (action === "ls") {
    return { outcome: { view: listView(data) } };
  }
  const item = listSources(data).find((listed) => listed.hash === hash);
  if (!item) {
    return stale;
  }
  return { outcome: { view: action === "src" ? cardView(item) : confirmView(item) } };
}

function listView(data: UserData): View {
  const items = listSources(data);
  if (items.length === 0) {
    return { text: NO_SOURCES };
  }
  return {
    text: `Ваши источники (${countSources(data)} из ${MAX_SOURCES}):`,
    reply_markup: {
      inline_keyboard: items.map((item) => [
        { text: clip(`${item.enabled ? "✅" : "⏸"} ${sourceLabel(item.source)}`), callback_data: `src:${item.hash}` },
      ]),
    },
  };
}

function cardView(item: Listed): View {
  const toggle = item.enabled
    ? { text: "⏸ Выключить", callback_data: `off:${item.hash}` }
    : { text: "▶ Включить", callback_data: `on:${item.hash}` };
  return {
    text: [sourceLabel(item.source), `Статус: ${item.enabled ? "включён" : "выключен"}`, sourceLink(item.source)].join("\n"),
    reply_markup: {
      inline_keyboard: [[toggle, { text: "🗑 Удалить", callback_data: `del:${item.hash}` }], [{ text: "← К списку", callback_data: "ls" }]],
    },
    link_preview_options: { is_disabled: true },
  };
}

function confirmView(item: Listed): View {
  return {
    text: `Удалить ${sourceLabel(item.source)}?`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Да, удалить", callback_data: `rm:${item.hash}` },
          { text: "Нет", callback_data: `src:${item.hash}` },
        ],
      ],
    },
  };
}

async function editMessage(query: CallbackQuery, view: View, deps: Deps): Promise<void> {
  if (!query.message) {
    await deps.telegram.call("sendMessage", { chat_id: query.from.id, ...view });
    return;
  }
  try {
    await deps.telegram.call("editMessageText", { chat_id: query.message.chat.id, message_id: query.message.message_id, ...view });
  } catch (error) {
    if (!String(error).includes(NOT_MODIFIED)) {
      throw error;
    }
  }
}

interface ChatInfo {
  id: number;
  type: string;
  title?: string;
}

interface Member {
  status: string;
  can_post_messages?: boolean;
}

type ChatAction = "channel" | "private" | "cancel";

async function showSetting(userId: number, deps: Deps, render: (data: UserData) => Promise<View>): Promise<void> {
  let view: View;
  try {
    const file = await deps.github.readUser(userId);
    view = file ? await render(file.data) : { text: NEED_START };
  } catch (error) {
    console.error(error);
    view = { text: SETTINGS_READ_FAILED };
  }
  await deps.telegram.call("sendMessage", { chat_id: userId, ...view });
}

function windowView(data: UserData): View {
  const current = windowOf(data);
  return {
    text: `Дайджест приходит раз в ${String(current)} ч.`,
    reply_markup: {
      inline_keyboard: [WINDOWS.map((hours) => ({ text: `${hours === current ? "✓ " : ""}${hours} ч`, callback_data: `win:${hours}` }))],
    },
  };
}

function chatView(label: string): View {
  return {
    text: `Дайджест приходит: ${label}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "В канал", callback_data: "chat:channel" },
          { text: "В личный чат", callback_data: "chat:private" },
        ],
      ],
    },
  };
}

function channelName(chat: ChatInfo): string {
  return chat.title ? `«${chat.title}»` : String(chat.id);
}

async function chatLabel(data: UserData, deps: Deps): Promise<string> {
  const target = chatTarget(data);
  if (target === "private") {
    return PRIVATE_CHAT;
  }
  if (target === "config") {
    return "задан в конфиге";
  }
  try {
    const chat = (await deps.telegram.request("getChat", { chat_id: target })) as ChatInfo;
    return `в канал ${channelName(chat)}`;
  } catch (error) {
    console.error(error);
    return `в канал ${target}`;
  }
}

async function answerQuery(query: CallbackQuery, deps: Deps, text?: string): Promise<void> {
  await deps.telegram.call("answerCallbackQuery", text ? { callback_query_id: query.id, text } : { callback_query_id: query.id });
}

async function settle(query: CallbackQuery, result: View | "missing" | "failed", deps: Deps): Promise<void> {
  if (result === "missing" || result === "failed") {
    return answerQuery(query, deps, result === "missing" ? NEED_START : SAVE_FAILED);
  }
  await answerQuery(query, deps, SAVED);
  await editMessage(query, result, deps);
}

async function chooseWindow(query: CallbackQuery, hours: number, deps: Deps): Promise<void> {
  const userId = query.from.id;
  const result = await editUser<View>(userId, deps, (data) => {
    const updated = setWindow(data, hours);
    const outcome = windowView(updated.data);
    if (!updated.changed) {
      return { outcome };
    }
    return { outcome, write: { data: updated.data, message: `chore(users): set window ${hours}h for ${userId} via bot` } };
  });
  await settle(query, result, deps);
}

async function chooseChat(query: CallbackQuery, action: ChatAction, deps: Deps): Promise<void> {
  const userId = query.from.id;
  if (action === "cancel") {
    await deps.kv.delete(channelKey(userId));
    await answerQuery(query, deps);
    await editMessage(query, { text: CHANNEL_CANCELLED }, deps);
    return;
  }
  if (action === "channel") {
    if (!(await deps.github.userExists(userId))) {
      return answerQuery(query, deps, NEED_START);
    }
    await deps.kv.put(channelKey(userId), "1", { expirationTtl: CHANNEL_TTL_SECONDS });
    await answerQuery(query, deps);
    await editMessage(query, { text: CHANNEL_PROMPT, reply_markup: { inline_keyboard: [[{ text: "Отмена", callback_data: "chat:cancel" }]] } }, deps);
    return;
  }
  await deps.kv.delete(channelKey(userId));
  const result = await editUser<View>(userId, deps, (data) => {
    const updated = resetChat(data);
    const outcome = chatView(PRIVATE_CHAT);
    if (!updated.changed) {
      return { outcome };
    }
    return { outcome, write: { data: updated.data, message: `chore(users): reset chat for ${userId} via bot` } };
  });
  await settle(query, result, deps);
}

async function lookup<T>(deps: Deps, method: string, body: Record<string, unknown>): Promise<T | null> {
  try {
    return (await deps.telegram.request(method, body)) as T;
  } catch (error) {
    if (String(error).includes(BAD_REQUEST)) {
      return null;
    }
    throw error;
  }
}

async function checkChannel(ref: number | string, userId: number, deps: Deps): Promise<ChatInfo | string> {
  const chat = await lookup<ChatInfo>(deps, "getChat", { chat_id: ref });
  if (typeof chat?.id !== "number") {
    return CHANNEL_NOT_FOUND;
  }
  if (chat.type !== "channel") {
    return NOT_CHANNEL;
  }
  const me = (await deps.telegram.request("getMe", {})) as { id: number };
  const bot = await lookup<Member>(deps, "getChatMember", { chat_id: chat.id, user_id: me.id });
  if (bot?.status !== "administrator" || !bot.can_post_messages) {
    return BOT_NOT_ADMIN;
  }
  const member = await lookup<Member>(deps, "getChatMember", { chat_id: chat.id, user_id: userId });
  return member?.status === "creator" || member?.status === "administrator" ? chat : NOT_CHANNEL_ADMIN;
}

async function pickChannel(userId: number, text: string, origin: ForwardOrigin | undefined, deps: Deps): Promise<void> {
  const reply = (body: string) => deps.telegram.call("sendMessage", { chat_id: userId, text: body });
  const ref = parseChannel(text, origin);
  if (ref === null) {
    return reply(NOT_CHANNEL);
  }
  let channel: ChatInfo | string;
  try {
    channel = await checkChannel(ref, userId, deps);
  } catch (error) {
    console.error(error);
    return reply(CHECK_FAILED);
  }
  if (typeof channel === "string") {
    return reply(channel);
  }
  const saved = await editUser<"saved">(userId, deps, (data) => {
    const updated = setChat(data, channel.id);
    if (!updated.changed) {
      return { outcome: "saved" };
    }
    return { outcome: "saved", write: { data: updated.data, message: `chore(users): set chat for ${userId} via bot` } };
  });
  if (saved === "failed") {
    return reply(SAVE_FAILED);
  }
  await deps.kv.delete(channelKey(userId));
  await reply(saved === "missing" ? NEED_START : `Дайджест будет приходить в канал ${channelName(channel)}.`);
}

function clip(text: string): string {
  return Array.from(text).slice(0, BUTTON_LENGTH).join("");
}

async function markDecision(query: CallbackQuery, status: string, deps: Deps): Promise<void> {
  if (!query.message?.text) {
    return;
  }
  await deps.telegram.call("editMessageText", {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text: `${query.message.text}\n\n${status}`,
  });
}

function requestText(user: User): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return [
    "Новая заявка на доступ к Горизонту",
    `Имя: <b>${escapeHtml(name)}</b>`,
    `Username: ${user.username ? `@${escapeHtml(user.username)}` : "нет"}`,
    `ID: <code>${user.id}</code>`,
    `<a href="tg://user?id=${user.id}">Открыть профиль</a>`,
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
