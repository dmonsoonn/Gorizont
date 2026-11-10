import { parseInput, type ForwardOrigin, type UserData } from "./sources";

export const WINDOWS = [3, 6, 12, 24] as const;
export const DEFAULT_WINDOW_HOURS = 1;

export interface Updated {
  data: UserData;
  changed: boolean;
}

export function windowOf(data: UserData): unknown {
  return data.time_window_hours ?? DEFAULT_WINDOW_HOURS;
}

export function setWindow(data: UserData, hours: number): Updated {
  const next = structuredClone(data);
  next.time_window_hours = hours;
  return { data: next, changed: data.time_window_hours !== hours };
}

export function setChat(data: UserData, chatId: number): Updated {
  const next = structuredClone(data);
  next.chat_id = chatId;
  return { data: next, changed: data.chat_id !== chatId };
}

export function resetChat(data: UserData): Updated {
  const next = structuredClone(data);
  delete next.chat_id;
  return { data: next, changed: "chat_id" in data };
}

export function chatTarget(data: UserData): "private" | "config" | number | string {
  const chatId = data.chat_id;
  if (chatId === undefined || chatId === data.id) {
    return "private";
  }
  if (typeof chatId === "string" && chatId.includes("${")) {
    return "config";
  }
  return typeof chatId === "number" ? chatId : String(chatId);
}

export function parseChannel(text: string, origin?: ForwardOrigin): number | string | null {
  if (origin) {
    return origin.type === "channel" && typeof origin.chat?.id === "number" ? origin.chat.id : null;
  }
  const parsed = parseInput(text);
  return "source" in parsed && parsed.source.kind === "telegram" ? `@${parsed.source.channel}` : null;
}
