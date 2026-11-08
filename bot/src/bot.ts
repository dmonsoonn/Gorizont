import { NEW_USER_WINDOW_HOURS, type GitHub } from "./github";
import type { Telegram } from "./telegram";

export const PENDING_TTL_SECONDS = 24 * 60 * 60;

const CALLBACK_PATTERN = /^(approve|reject):([1-9][0-9]{0,14})$/;

const HELP = "Команды:\n/start — подключиться к Горизонту\n/help — список команд";
const WELCOME_BACK = `Вы уже подключены к Горизонту.\n\n${HELP}`;
const REQUEST_SENT = "Заявка отправлена владельцу. Я напишу, когда её рассмотрят.";
const REQUEST_PENDING = "Заявка уже на рассмотрении.";
const REJECTED = "Владелец отклонил заявку.";
const APPROVED = `Доступ открыт. Дайджест будет приходить в этот чат раз в ${NEW_USER_WINDOW_HOURS} ч, когда у вас появятся источники.\n\n${HELP}`;
const UNKNOWN = "Не понимаю. Список команд — /help.";
const NOT_OWNER = "Решать заявки может только владелец.";
const BAD_CALLBACK = "Некорректная кнопка.";
const ALREADY_USER = "Пользователь уже подключён.";

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
}

export const pendingKey = (id: number) => `pending:${id}`;
export const rejectedKey = (id: number) => `rejected:${id}`;

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
  const command = (message.text ?? "").split(/\s/, 1)[0].split("@", 1)[0];

  if (command === "/help") {
    return reply(HELP);
  }
  if (command !== "/start") {
    return reply(UNKNOWN);
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

  if (query.from.id !== deps.ownerId) {
    return answer(NOT_OWNER);
  }
  const match = CALLBACK_PATTERN.exec(query.data ?? "");
  if (!match) {
    return answer(BAD_CALLBACK);
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
