import { decide, start } from "./flows/access";
import { chooseChat, chooseWindow, pickChannel, showChat, showWindow } from "./flows/settings";
import { addFromMessage, chooseFeed, manageSource, showList, undoSource } from "./flows/sources";
import { answerQuery, reply } from "./replies";
import { BAD_CALLBACK, HELP, UNKNOWN } from "./texts";
import { channelKey, type CallbackQuery, type Deps, type Message, type Update } from "./types";

export {
  CHANNEL_TTL_SECONDS,
  channelKey,
  FEEDS_TTL_SECONDS,
  feedsKey,
  PENDING_TTL_SECONDS,
  pendingKey,
  rejectedKey,
  type Store,
  type Update,
} from "./types";

const COMMAND_PATTERN = /^\/[A-Za-z0-9_]+$/;

type Route = [RegExp, (query: CallbackQuery, match: RegExpExecArray, deps: Deps) => Promise<void>];

const ROUTES: Route[] = [
  [/^undo:([0-9a-f]{8})$/, (query, match, deps) => undoSource(query, match[1], deps)],
  [/^feed:([0-9a-f]{8}):([0-4])$/, (query, match, deps) => chooseFeed(query, match[1], Number(match[2]), deps)],
  [/^ls$/, (query, _match, deps) => manageSource(query, "ls", "", deps)],
  ...(["src", "off", "on", "del", "rm"] as const).map(
    (action): Route => [new RegExp(`^${action}:([0-9a-f]{8})$`), (query, match, deps) => manageSource(query, action, match[1], deps)],
  ),
  [/^win:(3|6|12|24)$/, (query, match, deps) => chooseWindow(query, Number(match[1]), deps)],
  ...(["channel", "private", "cancel"] as const).map(
    (action): Route => [new RegExp(`^chat:${action}$`), (query, _match, deps) => chooseChat(query, action, deps)],
  ),
  [/^(approve|reject):([1-9][0-9]{0,14})$/, (query, match, deps) => decide(query, match[1] === "approve", Number(match[2]), deps)],
];

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
    return reply(message.chat.id, HELP, deps);
  }
  if (command === "/list") {
    return showList(user.id, deps);
  }
  if (command === "/window") {
    return showWindow(user.id, deps);
  }
  if (command === "/chat") {
    return showChat(user.id, deps);
  }
  if (command === "/start") {
    return start(message.chat.id, user, deps);
  }
  return COMMAND_PATTERN.test(command) ? reply(message.chat.id, UNKNOWN, deps) : addFromMessage(user.id, text, undefined, deps);
}

async function handleCallback(query: CallbackQuery, deps: Deps): Promise<void> {
  const data = query.data ?? "";
  for (const [pattern, handle] of ROUTES) {
    const match = pattern.exec(data);
    if (match) {
      return handle(query, match, deps);
    }
  }
  await answerQuery(query, deps, BAD_CALLBACK);
}
