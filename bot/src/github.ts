export const NEW_USER_WINDOW_HOURS = 6;

const BOT_IDENTITY = { name: "Gorizont bot", email: "bot@users.noreply.github.com" };

export interface UserFile {
  data: Record<string, unknown>;
  sha: string;
}

export interface GitHub {
  userExists(id: number): Promise<boolean>;
  createUser(id: number): Promise<"created" | "exists">;
  readUser(id: number): Promise<UserFile | null>;
  writeUser(id: number, data: Record<string, unknown>, sha: string, message: string): Promise<"ok" | "conflict">;
}

export function userFile(id: number): string {
  return `${JSON.stringify({ id, time_window_hours: NEW_USER_WINDOW_HOURS }, null, 2)}\n`;
}

function encodeBase64(text: string): string {
  return btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""));
}

function decodeBase64(content: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(content.replace(/\s/g, "")), (char) => char.charCodeAt(0)));
}

export function createGitHub(token: string, repo: string, fetcher: typeof fetch): GitHub {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "gorizont-bot",
  };
  const fileUrl = (id: number) => `https://api.github.com/repos/${repo}/contents/data/users/${id}.json`;

  async function userExists(id: number): Promise<boolean> {
    const response = await fetcher(fileUrl(id), { headers });
    if (response.status === 404) {
      return false;
    }
    if (!response.ok) {
      throw new Error(`GitHub GET user ${id} failed: ${response.status}`);
    }
    return true;
  }

  async function createUser(id: number): Promise<"created" | "exists"> {
    const response = await fetcher(fileUrl(id), {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `chore(users): add user ${id} via bot`,
        content: btoa(userFile(id)),
        author: BOT_IDENTITY,
        committer: BOT_IDENTITY,
      }),
    });
    if (response.status === 422 && (await userExists(id))) {
      return "exists";
    }
    if (!response.ok) {
      throw new Error(`GitHub PUT user ${id} failed: ${response.status}`);
    }
    return "created";
  }

  async function readUser(id: number): Promise<UserFile | null> {
    const response = await fetcher(fileUrl(id), { headers });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`GitHub GET user ${id} failed: ${response.status}`);
    }
    const file: { content: string; sha: string } = await response.json();
    return { data: JSON.parse(decodeBase64(file.content)), sha: file.sha };
  }

  async function writeUser(id: number, data: Record<string, unknown>, sha: string, message: string): Promise<"ok" | "conflict"> {
    const response = await fetcher(fileUrl(id), {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message,
        content: encodeBase64(`${JSON.stringify(data, null, 2)}\n`),
        sha,
        author: BOT_IDENTITY,
        committer: BOT_IDENTITY,
      }),
    });
    if (response.status === 409) {
      return "conflict";
    }
    if (!response.ok) {
      throw new Error(`GitHub PUT user ${id} failed: ${response.status}`);
    }
    return "ok";
  }

  return { userExists, createUser, readUser, writeUser };
}
