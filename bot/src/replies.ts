import type { UserData } from "./sources";
import type { CallbackQuery, Deps, View } from "./types";

const NOT_MODIFIED = "message is not modified";
const BUTTON_LENGTH = 60;

export interface Change<T> {
  outcome: T;
  write?: { data: UserData; message: string };
}

export async function send(chatId: number, view: View, deps: Deps): Promise<void> {
  await deps.telegram.call("sendMessage", { chat_id: chatId, ...view });
}

export function reply(chatId: number, text: string, deps: Deps): Promise<void> {
  return send(chatId, { text }, deps);
}

export async function answerQuery(query: CallbackQuery, deps: Deps, text?: string): Promise<void> {
  await deps.telegram.call("answerCallbackQuery", text ? { callback_query_id: query.id, text } : { callback_query_id: query.id });
}

export async function editMessage(query: CallbackQuery, view: View, deps: Deps): Promise<void> {
  if (!query.message) {
    await send(query.from.id, view, deps);
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

export async function markDecision(query: CallbackQuery, status: string, deps: Deps): Promise<void> {
  if (!query.message?.text) {
    return;
  }
  await deps.telegram.call("editMessageText", {
    chat_id: query.message.chat.id,
    message_id: query.message.message_id,
    text: `${query.message.text}\n\n${status}`,
  });
}

export async function editUser<T>(userId: number, deps: Deps, change: (data: UserData) => Change<T>): Promise<T | "missing" | "failed"> {
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

export function clip(text: string): string {
  return Array.from(text).slice(0, BUTTON_LENGTH).join("");
}
