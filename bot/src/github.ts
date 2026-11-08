export const NEW_USER_WINDOW_HOURS = 6;

const BOT_IDENTITY = { name: "Gorizont bot", email: "bot@users.noreply.github.com" };

export interface GitHub {
  userExists(id: number): Promise<boolean>;
  createUser(id: number): Promise<"created" | "exists">;
}

export function userFile(id: number): string {
  return `${JSON.stringify({ id, time_window_hours: NEW_USER_WINDOW_HOURS }, null, 2)}\n`;
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

  return { userExists, createUser };
}
