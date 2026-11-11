export interface Telegram {
  call(method: string, body: Record<string, unknown>): Promise<void>;
  request(method: string, body: Record<string, unknown>): Promise<unknown>;
}

export interface ChatInfo {
  id: number;
  type: string;
  title?: string;
}

export interface Member {
  status: string;
  can_post_messages?: boolean;
}

export interface BotInfo {
  id: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isChat(value: unknown): value is ChatInfo {
  return isRecord(value) && typeof value.id === "number" && typeof value.type === "string" && (value.title === undefined || typeof value.title === "string");
}

export function isMember(value: unknown): value is Member {
  return isRecord(value) && typeof value.status === "string" && (value.can_post_messages === undefined || typeof value.can_post_messages === "boolean");
}

export function isBot(value: unknown): value is BotInfo {
  return isRecord(value) && typeof value.id === "number";
}

export function unexpected(method: string): Error {
  return new Error(`Telegram ${method} returned an unexpected response`);
}

export function shaped<T>(method: string, value: unknown, guard: (value: unknown) => value is T): T {
  if (!guard(value)) {
    throw unexpected(method);
  }
  return value;
}

export function createTelegram(token: string, fetcher: typeof fetch): Telegram {
  async function request(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result: { ok?: boolean; description?: string; result?: unknown } = await response.json();
    if (!result.ok) {
      throw new Error(`Telegram ${method} failed: ${result.description ?? response.status}`);
    }
    return result.result;
  }

  return {
    async call(method, body) {
      await request(method, body);
    },
    request,
  };
}
