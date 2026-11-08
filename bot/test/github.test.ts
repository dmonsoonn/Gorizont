import { describe, expect, it, vi } from "vitest";
import { createGitHub } from "../src/github";

const FILE_URL = "https://api.github.com/repos/dmonsoonn/Gorizont/contents/data/users/123.json";

function github(...statuses: number[]) {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("{}", { status: statuses.shift() }));
  return { fetcher, client: createGitHub("pat", "dmonsoonn/Gorizont", fetcher) };
}

describe("userExists", () => {
  it.each([
    [200, true],
    [404, false],
  ])("maps %i to %s", async (status, expected) => {
    const { fetcher, client } = github(status);
    await expect(client.userExists(123)).resolves.toBe(expected);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(FILE_URL);
    expect(init?.headers).toMatchObject({ Authorization: "Bearer pat", "User-Agent": "gorizont-bot" });
  });

  it("throws on other statuses", async () => {
    const { client } = github(500);
    await expect(client.userExists(123)).rejects.toThrow("500");
  });
});

describe("createUser", () => {
  it("commits the user file as the bot without a sha", async () => {
    const { fetcher, client } = github(201);
    await expect(client.createUser(123)).resolves.toBe("created");

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(FILE_URL);
    expect(init?.method).toBe("PUT");
    const body = JSON.parse(String(init?.body));
    expect(body.sha).toBeUndefined();
    expect(body.message).toBe("chore(users): add user 123 via bot");
    expect(body.author).toEqual({ name: "Gorizont bot", email: "bot@users.noreply.github.com" });
    expect(body.committer).toEqual(body.author);
    expect(JSON.parse(atob(body.content))).toEqual({ id: 123, time_window_hours: 6 });
  });

  it("treats 422 as an existing user when the file is there", async () => {
    const { fetcher, client } = github(422, 200);
    await expect(client.createUser(123)).resolves.toBe("exists");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails on 422 when the file is missing", async () => {
    const { client } = github(422, 404);
    await expect(client.createUser(123)).rejects.toThrow("422");
  });

  it("fails on server errors", async () => {
    const { client } = github(502);
    await expect(client.createUser(123)).rejects.toThrow("502");
  });
});

function encoded(data: unknown): string {
  const bytes = new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`);
  const base64 = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
  return base64.replace(/(.{60})/g, "$1\n");
}

describe("readUser", () => {
  it("decodes the file as UTF-8 and returns its sha", async () => {
    const data = { id: 123, sources: { rss: [{ name: "Блог 😀", url: "https://a.example/feed" }] } };
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ content: encoded(data), sha: "abc" }));
    const client = createGitHub("pat", "dmonsoonn/Gorizont", fetcher);
    await expect(client.readUser(123)).resolves.toEqual({ data, sha: "abc" });
    expect(fetcher.mock.calls[0][0]).toBe(FILE_URL);
  });

  it("returns null for a missing file and throws on other errors", async () => {
    await expect(github(404).client.readUser(123)).resolves.toBeNull();
    await expect(github(500).client.readUser(123)).rejects.toThrow("500");
  });
});

describe("writeUser", () => {
  it("commits the file with its sha as the bot", async () => {
    const { fetcher, client } = github(200);
    const data = { id: 123, chat_id: "${TELEGRAM_CHAT_ID}", sources: { rss: [{ name: "Блог", url: "https://a.example/feed" }] } };
    await expect(client.writeUser(123, data, "abc", "chore(users): add rss source for 123 via bot")).resolves.toBe("ok");

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(FILE_URL);
    expect(init?.method).toBe("PUT");
    const body = JSON.parse(String(init?.body));
    expect(body.sha).toBe("abc");
    expect(body.message).toBe("chore(users): add rss source for 123 via bot");
    expect(body.author).toEqual({ name: "Gorizont bot", email: "bot@users.noreply.github.com" });
    expect(body.committer).toEqual(body.author);
    const text = new TextDecoder().decode(Uint8Array.from(atob(body.content), (char) => char.charCodeAt(0)));
    expect(text).toBe(`${JSON.stringify(data, null, 2)}\n`);
  });

  it("reports a stale sha as a conflict", async () => {
    await expect(github(409).client.writeUser(123, { id: 123 }, "old", "m")).resolves.toBe("conflict");
  });

  it.each([422, 500])("throws on %i", async (status) => {
    await expect(github(status).client.writeUser(123, { id: 123 }, "abc", "m")).rejects.toThrow(String(status));
  });
});
