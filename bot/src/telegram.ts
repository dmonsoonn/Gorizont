export interface Telegram {
  call(method: string, body: Record<string, unknown>): Promise<void>;
}

export function createTelegram(token: string, fetcher: typeof fetch): Telegram {
  return {
    async call(method, body) {
      const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result: { ok?: boolean; description?: string } = await response.json();
      if (!result.ok) {
        throw new Error(`Telegram ${method} failed: ${result.description ?? response.status}`);
      }
    },
  };
}
