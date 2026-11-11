import type { GitHub } from "./github";
import type { ForwardOrigin } from "./sources";
import type { Telegram } from "./telegram";

export const PENDING_TTL_SECONDS = 24 * 60 * 60;
export const FEEDS_TTL_SECONDS = 10 * 60;
export const CHANNEL_TTL_SECONDS = 10 * 60;

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

export interface View {
  text: string;
  parse_mode?: "HTML";
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
  link_preview_options?: { is_disabled: boolean };
}

export const pendingKey = (id: number) => `pending:${id}`;
export const rejectedKey = (id: number) => `rejected:${id}`;
export const feedsKey = (id: number) => `feeds:${id}`;
export const channelKey = (id: number) => `chat:${id}`;
