export interface Telegram {
  call(method: string, body: Record<string, unknown>): Promise<void>;
  request(method: string, body: Record<string, unknown>): Promise<unknown>;
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
