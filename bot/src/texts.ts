import { NEW_USER_WINDOW_HOURS } from "./github";
import { MAX_SOURCES } from "./sources";
import type { User } from "./types";

export const HELP = [
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
  `Не больше ${MAX_SOURCES} источников. Список ваших источников видит владелец бота.`,
].join("\n");
export const WELCOME_BACK = `Вы уже подключены к Горизонту.\n\n${HELP}`;
export const REQUEST_SENT = "Заявка отправлена владельцу. Я напишу, когда её рассмотрят.";
export const REQUEST_PENDING = "Заявка уже на рассмотрении.";
export const REJECTED = "Владелец отклонил заявку.";
export const APPROVED = `Доступ открыт. Дайджест будет приходить в этот чат раз в ${NEW_USER_WINDOW_HOURS} ч, когда у вас появятся источники.\n\n${HELP}`;
export const UNKNOWN = "Не понимаю. Список команд — /help.";
export const NOT_OWNER = "Решать заявки может только владелец.";
export const BAD_CALLBACK = "Некорректная кнопка.";
export const ALREADY_USER = "Пользователь уже подключён.";
export const NEED_START = "Сначала подключитесь к Горизонту: /start.";
export const PRIVATE_FORWARD = "Подходят только публичные каналы с @username. Перешлите пост из такого канала или пришлите ссылку t.me/канал.";
export const FEED_NOT_FOUND = "Не нашёл RSS-фид по этой ссылке. Пришлите прямую ссылку на фид.";
export const CHOOSE_FEED = "На странице несколько фидов. Какой добавить?";
export const CHOICE_EXPIRED = "Выбор устарел, пришлите ссылку снова.";
export const STALE_BUTTON = "Кнопка устарела.";
export const SAVE_FAILED = "Не удалось сохранить, попробуйте ещё раз.";
export const LIMIT = `Уже ${MAX_SOURCES} источников, это максимум. Новый не добавлен.`;
export const NO_SOURCES = "Источников пока нет. Как добавить — /help.";
export const READ_FAILED = "Не удалось загрузить источники, попробуйте ещё раз.";
export const SOURCE_GONE = "Источника уже нет.";
export const SAVED = "Сохранено";
export const SETTINGS_READ_FAILED = "Не удалось загрузить настройки, попробуйте ещё раз.";
export const PRIVATE_CHAT = "в личный чат";
export const CONFIG_CHAT = "задан в конфиге";
export const CHANNEL_PROMPT = "Перешлите пост из канала или пришлите @имя / ссылку t.me/имя. Бот должен быть администратором канала с правом публикации.";
export const NOT_CHANNEL = "Это не канал. Перешлите пост из канала или пришлите @имя / ссылку t.me/имя. Отменить — любая команда.";
export const CHANNEL_NOT_FOUND = "Канал не найден. Проверьте имя или перешлите пост из канала.";
export const BOT_NOT_ADMIN = "Бот не администратор канала или не может публиковать. Добавьте бота в администраторы с правом публикации и пришлите канал снова.";
export const NOT_CHANNEL_ADMIN = "Вы не администратор этого канала.";
export const CHANNEL_CANCELLED = "Выбор канала отменён.";
export const CHECK_FAILED = "Не удалось проверить канал, попробуйте ещё раз.";

export const APPROVE_BUTTON = "Одобрить";
export const REJECT_BUTTON = "Отклонить";
export const APPROVED_MARK = "✅ Одобрено";
export const REJECTED_MARK = "❌ Отклонено";
export const ALREADY_USER_MARK = `✅ ${ALREADY_USER}`;
export const UNDO_BUTTON = "Отменить";
export const UNDONE_MARK = "Отменено";
export const REMOVED = "Удалено";
export const ENABLED = "Включено";
export const DISABLED = "Выключено";
export const ENABLE_BUTTON = "▶ Включить";
export const DISABLE_BUTTON = "⏸ Выключить";
export const DELETE_BUTTON = "🗑 Удалить";
export const BACK_BUTTON = "← К списку";
export const CONFIRM_DELETE_BUTTON = "Да, удалить";
export const KEEP_BUTTON = "Нет";
export const CHANNEL_BUTTON = "В канал";
export const PRIVATE_BUTTON = "В личный чат";
export const CANCEL_BUTTON = "Отмена";

export const added = (label: string) => `Добавлено: ${label}\nВсе источники — /list`;
export const duplicate = (label: string) => `Уже есть: ${label}.`;
export const chosen = (title: string) => `Выбран: ${title}`;
export const sourcesTitle = (count: number) => `Ваши источники (${count} из ${MAX_SOURCES}):`;
export const listItem = (enabled: boolean, label: string) => `${enabled ? "✅" : "⏸"} ${label}`;
export const sourceStatus = (enabled: boolean) => `Статус: ${enabled ? "включён" : "выключен"}`;
export const confirmDelete = (label: string) => `Удалить ${label}?`;
export const windowText = (hours: unknown) => `Дайджест приходит раз в ${String(hours)} ч.`;
export const windowButton = (hours: number, current: boolean) => `${current ? "✓ " : ""}${hours} ч`;
export const chatText = (label: string) => `Дайджест приходит: ${label}`;
export const inChannel = (name: string) => `в канал ${name}`;
export const chatSaved = (name: string) => `Дайджест будет приходить в канал ${name}.`;
export const createFailed = (userId: number, error: unknown) =>
  `Не удалось создать файл пользователя ${userId}: ${String(error)}. Нажмите «Одобрить» ещё раз.`;

export function requestText(user: User): string {
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
