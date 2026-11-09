import { describe, expect, it } from "vitest";
import {
  addSource,
  countSources,
  keyHash,
  listSources,
  parseInput,
  removeSource,
  setEnabled,
  sourceKey,
  sourceLabel,
  sourceLink,
  type Source,
} from "../src/sources";

const channel = (name: string) => ({ source: { kind: "telegram", channel: name } });

describe("parseInput", () => {
  it.each([
    "https://t.me/durov_news",
    "t.me/durov_news",
    "https://t.me/s/durov_news",
    "https://t.me/durov_news/123",
    "https://t.me/s/durov_news/123",
    "https://telegram.me/durov_news",
    "@durov_news",
    "  @durov_news  посмотри",
  ])("reads %s as a Telegram channel", (value) => {
    expect(parseInput(value)).toEqual(channel("durov_news"));
  });

  it.each([
    ["r/rust", { kind: "subreddit", subreddit: "rust" }],
    ["/r/rust/", { kind: "subreddit", subreddit: "rust" }],
    ["https://www.reddit.com/r/rust/", { kind: "subreddit", subreddit: "rust" }],
    ["https://old.reddit.com/r/rust/comments/abc/title/", { kind: "subreddit", subreddit: "rust" }],
    ["u/spez", { kind: "reddit_user", username: "spez" }],
    ["https://reddit.com/u/spez", { kind: "reddit_user", username: "spez" }],
    ["https://www.reddit.com/user/spez/", { kind: "reddit_user", username: "spez" }],
    ["https://github.com/astral-sh/uv", { kind: "github_repo", owner: "astral-sh", repo: "uv" }],
    ["github.com/astral-sh/uv.git", { kind: "github_repo", owner: "astral-sh", repo: "uv" }],
    ["https://github.com/astral-sh/uv/releases/tag/1.0", { kind: "github_repo", owner: "astral-sh", repo: "uv" }],
    ["https://github.com/torvalds", { kind: "github_user", username: "torvalds" }],
  ])("reads %s", (value, source) => {
    expect(parseInput(value)).toEqual({ source });
  });

  it.each([
    ["https://simonwillison.net/", "https://simonwillison.net/"],
    ["simonwillison.net/atom/everything/", "https://simonwillison.net/atom/everything/"],
    ["http://example.com/feed.xml", "http://example.com/feed.xml"],
  ])("treats %s as a feed lookup", (value, feedUrl) => {
    expect(parseInput(value)).toEqual({ feedUrl });
  });

  it.each([
    "",
    "привет",
    "https://t.me/+AbCdEf",
    "https://t.me/joinchat/AbCdEf",
    "https://t.me/c/123456/7",
    "https://t.me/s",
    "https://t.me/abc",
    "@abc",
    "https://t.me/durov_news/about",
    "r/x",
    "https://reddit.com/",
    "https://reddit.com/comments/abc",
    "https://github.com/",
    "https://github.com/settings/profile",
    "ftp://example.com/feed",
    "javascript:alert(1)",
    "localhost:8080/feed",
    "https://user:pass@example.com/feed",
    "https://example.com/${SECRET}",
    "@durov_news ${X}",
    `https://example.com/${"a".repeat(2048)}`,
  ])("rejects %j", (value) => {
    expect(parseInput(value)).toEqual({ error: "unknown" });
  });

  it("reads a forward from a public channel", () => {
    expect(parseInput("", { type: "channel", chat: { username: "durov_news" } })).toEqual(channel("durov_news"));
  });

  it.each([
    { type: "channel", chat: {} },
    { type: "user" },
    { type: "hidden_user" },
    { type: "chat", chat: { username: "some_group" } },
  ])("rejects a forward from %j", (origin) => {
    expect(parseInput("https://t.me/durov_news", origin)).toEqual({ error: "private_forward" });
  });
});

describe("sourceLabel", () => {
  it.each<[Source, string]>([
    [{ kind: "rss", name: "Блог", url: "https://a.example/feed" }, "RSS «Блог»"],
    [{ kind: "telegram", channel: "durov_news" }, "Telegram @durov_news"],
    [{ kind: "subreddit", subreddit: "rust" }, "Reddit r/rust"],
    [{ kind: "reddit_user", username: "spez" }, "Reddit u/spez"],
    [{ kind: "github_repo", owner: "astral-sh", repo: "uv" }, "GitHub astral-sh/uv (релизы)"],
    [{ kind: "github_user", username: "torvalds" }, "GitHub torvalds (активность)"],
  ])("labels %j", (source, label) => {
    expect(sourceLabel(source)).toBe(label);
  });
});

describe("keyHash", () => {
  it("is 8 hex characters and stable", () => {
    expect(keyHash("telegram:durov_news")).toMatch(/^[0-9a-f]{8}$/);
    expect(keyHash("telegram:durov_news")).toBe(keyHash("telegram:durov_news"));
    expect(keyHash("telegram:durov_news")).not.toBe(keyHash("telegram:durov_new"));
  });
});

describe("addSource", () => {
  const tg: Source = { kind: "telegram", channel: "durov_news" };

  it("creates a minimal sources block for a new user", () => {
    const result = addSource({ id: 123, time_window_hours: 6 }, tg);
    expect(result).toEqual({ data: { id: 123, time_window_hours: 6, sources: { telegram: { channels: [{ channel: "durov_news" }] } } } });
  });

  it.each<[Source, Record<string, unknown>]>([
    [{ kind: "rss", name: "Блог", url: "https://a.example/feed" }, { rss: [{ name: "Блог", url: "https://a.example/feed" }] }],
    [{ kind: "subreddit", subreddit: "rust" }, { reddit: { subreddits: [{ subreddit: "rust" }] } }],
    [{ kind: "reddit_user", username: "spez" }, { reddit: { users: [{ username: "spez" }] } }],
    [{ kind: "github_repo", owner: "astral-sh", repo: "uv" }, { github: [{ type: "repo_releases", owner: "astral-sh", repo: "uv" }] }],
    [{ kind: "github_user", username: "torvalds" }, { github: [{ type: "user_events", username: "torvalds" }] }],
  ])("writes %j to its list", (source, sources) => {
    expect(addSource({ id: 1 }, source)).toEqual({ data: { id: 1, sources } });
  });

  it("does not mutate the input and keeps other fields and lists", () => {
    const data = {
      id: 1,
      chat_id: "${TELEGRAM_CHAT_ID}",
      sources: { rss: [{ name: "A", url: "https://a.example/feed", enabled: false }], reddit: { subreddits: [{ subreddit: "go" }] } },
    };
    const before = structuredClone(data);
    const result = addSource(data, { kind: "subreddit", subreddit: "rust" });
    expect(data).toEqual(before);
    expect(result).toEqual({
      data: {
        id: 1,
        chat_id: "${TELEGRAM_CHAT_ID}",
        sources: {
          rss: [{ name: "A", url: "https://a.example/feed", enabled: false }],
          reddit: { subreddits: [{ subreddit: "go" }, { subreddit: "rust" }] },
        },
      },
    });
  });

  it("creates the owner's sources block with only the new source", () => {
    const result = addSource({ id: 612722019, chat_id: "${TELEGRAM_CHAT_ID}" }, tg);
    expect(result).toEqual({
      data: {
        id: 612722019,
        chat_id: "${TELEGRAM_CHAT_ID}",
        sources: { telegram: { channels: [{ channel: "durov_news" }] } },
      },
    });
  });

  it("leaves an existing owner's sources block as it is", () => {
    const result = addSource({ id: 612722019, sources: { hackernews: { enabled: true } } }, tg);
    expect(result).toEqual({
      data: { id: 612722019, sources: { hackernews: { enabled: true }, telegram: { channels: [{ channel: "durov_news" }] } } },
    });
  });

  it.each<Source>([
    { kind: "telegram", channel: "Durov_News" },
    { kind: "subreddit", subreddit: "Rust" },
    { kind: "github_repo", owner: "Astral-SH", repo: "UV" },
    { kind: "rss", name: "Другое имя", url: "https://a.example/feed" },
  ])("reports %j as a duplicate regardless of case or name", (source) => {
    const data = {
      id: 1,
      sources: {
        rss: [{ name: "A", url: "https://a.example/feed" }],
        telegram: { channels: [{ channel: "durov_news" }] },
        reddit: { subreddits: [{ subreddit: "rust" }] },
        github: [{ type: "repo_releases", owner: "astral-sh", repo: "uv" }],
      },
    };
    expect(addSource(data, source)).toBe("duplicate");
  });

  it("refuses the 21st source, counting disabled ones", () => {
    const channels = Array.from({ length: 19 }, (_, i) => ({ channel: `channel_${i}`, enabled: false }));
    const data = { id: 1, sources: { telegram: { channels }, github: [{ type: "user_events", username: "torvalds" }] } };
    expect(countSources(data)).toBe(20);
    expect(addSource(data, { kind: "subreddit", subreddit: "rust" })).toBe("limit");
  });

  it("counts only the whitelisted lists", () => {
    expect(countSources({ id: 1 })).toBe(0);
    expect(countSources({ id: 1, sources: { hackernews: { enabled: true }, telegram: { enabled: true } } })).toBe(0);
  });

  it("fails on a malformed sources block instead of overwriting it", () => {
    expect(() => addSource({ id: 1, sources: { telegram: { channels: "x" } } }, tg)).toThrow("not a list");
    expect(() => addSource({ id: 1, sources: [] }, tg)).toThrow("not an object");
  });
});

describe("removeSource", () => {
  it("removes the entry matching the hash and keeps the rest", () => {
    const data = {
      id: 1,
      sources: { telegram: { channels: [{ channel: "durov_news" }, { channel: "other_one" }] }, github: [{ type: "user_events", username: "torvalds" }] },
    };
    const hash = keyHash(sourceKey({ kind: "telegram", channel: "Durov_News" }));
    expect(removeSource(data, hash)).toEqual({
      kind: "telegram",
      data: { id: 1, sources: { telegram: { channels: [{ channel: "other_one" }] }, github: [{ type: "user_events", username: "torvalds" }] } },
    });
    expect(data.sources.telegram.channels).toHaveLength(2);
  });

  it("returns null when nothing matches", () => {
    expect(removeSource({ id: 1 }, "00000000")).toBeNull();
    expect(removeSource({ id: 1, sources: { rss: [] } }, "00000000")).toBeNull();
  });
});

const hashOf = (source: Source) => keyHash(sourceKey(source));

describe("listSources", () => {
  it("lists every whitelisted source in file order with its state and hash", () => {
    const data = {
      id: 1,
      chat_id: "${TELEGRAM_CHAT_ID}",
      sources: {
        github: [
          { type: "user_events", username: "torvalds" },
          { type: "repo_releases", owner: "astral-sh", repo: "uv", enabled: false },
        ],
        reddit: { users: [{ username: "spez" }], subreddits: [{ subreddit: "rust", enabled: true }] },
        telegram: { channels: [{ channel: "durov_news", enabled: false }, { channel: "other_one" }] },
        rss: [{ name: "Блог", url: "https://blog.example/feed" }],
        hackernews: { enabled: true },
      },
    };
    const sources: Source[] = [
      { kind: "rss", name: "Блог", url: "https://blog.example/feed" },
      { kind: "telegram", channel: "durov_news" },
      { kind: "telegram", channel: "other_one" },
      { kind: "subreddit", subreddit: "rust" },
      { kind: "reddit_user", username: "spez" },
      { kind: "github_user", username: "torvalds" },
      { kind: "github_repo", owner: "astral-sh", repo: "uv" },
    ];
    expect(listSources(data)).toEqual(
      sources.map((source, index) => ({ source, enabled: index !== 1 && index !== 6, hash: hashOf(source) })),
    );
  });

  it("is empty without sources", () => {
    expect(listSources({ id: 1 })).toEqual([]);
    expect(listSources({ id: 1, sources: { rss: [], hackernews: { enabled: true } } })).toEqual([]);
  });

  it("skips entries it cannot show", () => {
    const data = {
      id: 1,
      sources: {
        github: [{ type: "org_events", username: "astral-sh" }, { type: "repo_releases", owner: "astral-sh" }, { type: "user_events", username: "torvalds" }],
        rss: [{ url: "https://blog.example/feed" }],
        telegram: { channels: [{ channel: 42 }] },
      },
    };
    expect(listSources(data).map((item) => item.source)).toEqual([{ kind: "github_user", username: "torvalds" }]);
  });
});

describe("sourceLink", () => {
  it.each<[Source, string]>([
    [{ kind: "rss", name: "Блог", url: "https://blog.example/feed" }, "https://blog.example/feed"],
    [{ kind: "telegram", channel: "durov_news" }, "https://t.me/durov_news"],
    [{ kind: "subreddit", subreddit: "rust" }, "https://www.reddit.com/r/rust"],
    [{ kind: "reddit_user", username: "spez" }, "https://www.reddit.com/user/spez"],
    [{ kind: "github_repo", owner: "astral-sh", repo: "uv" }, "https://github.com/astral-sh/uv"],
    [{ kind: "github_user", username: "torvalds" }, "https://github.com/torvalds"],
  ])("links %j to %s", (source, link) => {
    expect(sourceLink(source)).toBe(link);
  });
});

describe("setEnabled", () => {
  const owner = {
    id: 1,
    chat_id: "${TELEGRAM_CHAT_ID}",
    sources: {
      hackernews: { enabled: true },
      rss: [{ name: "Блог", url: "https://blog.example/feed" }],
      reddit: { subreddits: [{ subreddit: "rust", enabled: false }] },
    },
  };
  const rss = hashOf({ kind: "rss", name: "Блог", url: "https://blog.example/feed" });
  const rust = hashOf({ kind: "subreddit", subreddit: "rust" });

  it("turns a source off and keeps everything else", () => {
    expect(setEnabled(owner, rss, false)).toEqual({
      kind: "rss",
      changed: true,
      data: { ...owner, sources: { ...owner.sources, rss: [{ name: "Блог", url: "https://blog.example/feed", enabled: false }] } },
    });
    expect(owner.sources.rss[0]).not.toHaveProperty("enabled");
  });

  it("turns a source on by dropping the flag", () => {
    expect(setEnabled(owner, rust, true)).toEqual({
      kind: "subreddit",
      changed: true,
      data: { ...owner, sources: { ...owner.sources, reddit: { subreddits: [{ subreddit: "rust" }] } } },
    });
  });

  it("reports no change when the source is already in that state", () => {
    expect(setEnabled(owner, rss, true)?.changed).toBe(false);
    expect(setEnabled(owner, rust, false)?.changed).toBe(false);
  });

  it("returns null when nothing matches", () => {
    expect(setEnabled(owner, "00000000", false)).toBeNull();
    expect(setEnabled({ id: 1 }, rss, false)).toBeNull();
  });
});
