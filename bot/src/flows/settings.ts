import { answerQuery, editMessage, editUser, reply, send } from "../replies";
import { chatTarget, parseChannel, resetChat, setChat, setWindow, WINDOWS, windowOf } from "../settings";
import type { ForwardOrigin, UserData } from "../sources";
import {
  BOT_NOT_ADMIN,
  CANCEL_BUTTON,
  CHANNEL_BUTTON,
  CHANNEL_CANCELLED,
  CHANNEL_NOT_FOUND,
  CHANNEL_PROMPT,
  chatSaved,
  chatText,
  CHECK_FAILED,
  CONFIG_CHAT,
  inChannel,
  NEED_START,
  NOT_CHANNEL,
  NOT_CHANNEL_ADMIN,
  PRIVATE_BUTTON,
  PRIVATE_CHAT,
  SAVE_FAILED,
  SAVED,
  SETTINGS_READ_FAILED,
  windowButton,
  windowText,
} from "../texts";
import { isBot, isChat, isMember, shaped, unexpected, type ChatInfo, type Member } from "../telegram";
import { CHANNEL_TTL_SECONDS, channelKey, type CallbackQuery, type Deps, type View } from "../types";

const BAD_REQUEST = "Bad Request";

export type ChatAction = "channel" | "private" | "cancel";

async function showSetting(userId: number, deps: Deps, render: (data: UserData) => Promise<View>): Promise<void> {
  let view: View;
  try {
    const file = await deps.github.readUser(userId);
    view = file ? await render(file.data) : { text: NEED_START };
  } catch (error) {
    console.error(error);
    view = { text: SETTINGS_READ_FAILED };
  }
  await send(userId, view, deps);
}

export function showWindow(userId: number, deps: Deps): Promise<void> {
  return showSetting(userId, deps, async (data) => windowView(data));
}

export function showChat(userId: number, deps: Deps): Promise<void> {
  return showSetting(userId, deps, async (data) => chatView(await chatLabel(data, deps)));
}

function windowView(data: UserData): View {
  const current = windowOf(data);
  return {
    text: windowText(current),
    reply_markup: {
      inline_keyboard: [WINDOWS.map((hours) => ({ text: windowButton(hours, hours === current), callback_data: `win:${hours}` }))],
    },
  };
}

function chatView(label: string): View {
  return {
    text: chatText(label),
    reply_markup: {
      inline_keyboard: [
        [
          { text: CHANNEL_BUTTON, callback_data: "chat:channel" },
          { text: PRIVATE_BUTTON, callback_data: "chat:private" },
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
    return CONFIG_CHAT;
  }
  try {
    const chat = shaped("getChat", await deps.telegram.request("getChat", { chat_id: target }), isChat);
    return inChannel(channelName(chat));
  } catch (error) {
    console.error(error);
    return inChannel(String(target));
  }
}

async function settle(query: CallbackQuery, result: View | "missing" | "failed", deps: Deps): Promise<void> {
  if (result === "missing" || result === "failed") {
    return answerQuery(query, deps, result === "missing" ? NEED_START : SAVE_FAILED);
  }
  await answerQuery(query, deps, SAVED);
  await editMessage(query, result, deps);
}

export async function chooseWindow(query: CallbackQuery, hours: number, deps: Deps): Promise<void> {
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

export async function chooseChat(query: CallbackQuery, action: ChatAction, deps: Deps): Promise<void> {
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
    await editMessage(query, { text: CHANNEL_PROMPT, reply_markup: { inline_keyboard: [[{ text: CANCEL_BUTTON, callback_data: "chat:cancel" }]] } }, deps);
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

async function lookup(deps: Deps, method: string, body: Record<string, unknown>): Promise<unknown> {
  try {
    return await deps.telegram.request(method, body);
  } catch (error) {
    if (String(error).includes(BAD_REQUEST)) {
      return null;
    }
    throw error;
  }
}

async function memberOf(chatId: number, userId: number, deps: Deps): Promise<Member | null> {
  const member = await lookup(deps, "getChatMember", { chat_id: chatId, user_id: userId });
  return member === null ? null : shaped("getChatMember", member, isMember);
}

async function checkChannel(ref: number | string, userId: number, deps: Deps): Promise<ChatInfo | string> {
  const chat = await lookup(deps, "getChat", { chat_id: ref });
  if (!isChat(chat)) {
    if (chat !== null) {
      console.error(unexpected("getChat"));
    }
    return CHANNEL_NOT_FOUND;
  }
  if (chat.type !== "channel") {
    return NOT_CHANNEL;
  }
  const me = shaped("getMe", await deps.telegram.request("getMe", {}), isBot);
  const bot = await memberOf(chat.id, me.id, deps);
  if (bot?.status !== "administrator" || !bot.can_post_messages) {
    return BOT_NOT_ADMIN;
  }
  const member = await memberOf(chat.id, userId, deps);
  return member?.status === "creator" || member?.status === "administrator" ? chat : NOT_CHANNEL_ADMIN;
}

export async function pickChannel(userId: number, text: string, origin: ForwardOrigin | undefined, deps: Deps): Promise<void> {
  const ref = parseChannel(text, origin);
  if (ref === null) {
    return reply(userId, NOT_CHANNEL, deps);
  }
  let channel: ChatInfo | string;
  try {
    channel = await checkChannel(ref, userId, deps);
  } catch (error) {
    console.error(error);
    return reply(userId, CHECK_FAILED, deps);
  }
  if (typeof channel === "string") {
    return reply(userId, channel, deps);
  }
  const saved = await editUser<"saved">(userId, deps, (data) => {
    const updated = setChat(data, channel.id);
    if (!updated.changed) {
      return { outcome: "saved" };
    }
    return { outcome: "saved", write: { data: updated.data, message: `chore(users): set chat for ${userId} via bot` } };
  });
  if (saved === "failed") {
    return reply(userId, SAVE_FAILED, deps);
  }
  await deps.kv.delete(channelKey(userId));
  await reply(userId, saved === "missing" ? NEED_START : chatSaved(channelName(channel)), deps);
}
