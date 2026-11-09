export const MAX_SOURCES = 20;
export const MAX_URL_LENGTH = 2048;

const CHANNEL = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/;
const REDDIT_USER = /^[A-Za-z0-9_-]{3,20}$/;
const GITHUB_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GITHUB_REPO = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;

const TELEGRAM_HOSTS = new Set(["t.me", "telegram.me", "telegram.dog"]);
const TELEGRAM_RESERVED = new Set(["s", "c", "joinchat", "addstickers", "addemoji", "addlist", "share", "proxy", "socks", "iv", "boost"]);
const REDDIT_HOSTS = new Set(["reddit.com", "old.reddit.com", "new.reddit.com"]);
const GITHUB_RESERVED = new Set([
  "about", "apps", "collections", "enterprise", "events", "explore", "features", "login", "marketplace",
  "notifications", "orgs", "pricing", "search", "settings", "sponsors", "topics", "trending",
]);

export type Source =
  | { kind: "rss"; name: string; url: string }
  | { kind: "telegram"; channel: string }
  | { kind: "subreddit"; subreddit: string }
  | { kind: "reddit_user"; username: string }
  | { kind: "github_repo"; owner: string; repo: string }
  | { kind: "github_user"; username: string };

export interface ForwardOrigin {
  type: string;
  chat?: { username?: string };
}

export type Parsed = { source: Source } | { feedUrl: string } | { error: "unknown" | "private_forward" };

export type UserData = Record<string, unknown>;

type Entry = Record<string, unknown>;

interface List {
  path: [string] | [string, string];
  key(entry: Entry): string;
  source(entry: Entry): Source | null;
}

export interface Listed {
  source: Source;
  enabled: boolean;
  hash: string;
}

const lower = (value: unknown) => String(value).toLowerCase();
const isText = (value: unknown): value is string => typeof value === "string";

const LISTS: List[] = [
  {
    path: ["rss"],
    key: (e) => `rss:${e.url}`,
    source: (e) => (isText(e.name) && isText(e.url) ? { kind: "rss", name: e.name, url: e.url } : null),
  },
  {
    path: ["telegram", "channels"],
    key: (e) => `telegram:${lower(e.channel)}`,
    source: (e) => (isText(e.channel) ? { kind: "telegram", channel: e.channel } : null),
  },
  {
    path: ["reddit", "subreddits"],
    key: (e) => `subreddit:${lower(e.subreddit)}`,
    source: (e) => (isText(e.subreddit) ? { kind: "subreddit", subreddit: e.subreddit } : null),
  },
  {
    path: ["reddit", "users"],
    key: (e) => `reddit_user:${lower(e.username)}`,
    source: (e) => (isText(e.username) ? { kind: "reddit_user", username: e.username } : null),
  },
  {
    path: ["github"],
    key: (e) => (e.type === "repo_releases" ? `github_repo:${lower(e.owner)}/${lower(e.repo)}` : `github_user:${lower(e.username)}`),
    source: (e) => {
      if (e.type === "repo_releases" && isText(e.owner) && isText(e.repo)) {
        return { kind: "github_repo", owner: e.owner, repo: e.repo };
      }
      return e.type === "user_events" && isText(e.username) ? { kind: "github_user", username: e.username } : null;
    },
  },
];

const UNKNOWN: Parsed = { error: "unknown" };

export function parseInput(text: string, origin?: ForwardOrigin): Parsed {
  if (origin) {
    const username = origin.type === "channel" ? origin.chat?.username : undefined;
    return username && CHANNEL.test(username) ? { source: { kind: "telegram", channel: username } } : { error: "private_forward" };
  }
  const token = text.trim().split(/\s+/, 1)[0];
  if (!token || token.length > MAX_URL_LENGTH || text.includes("${")) {
    return UNKNOWN;
  }
  if (token.startsWith("@")) {
    return telegram(token.slice(1));
  }
  const short = /^\/?([ru])\/([^/]+)\/?$/i.exec(token);
  if (short) {
    return short[1].toLowerCase() === "r" ? subreddit(short[2]) : redditUser(short[2]);
  }
  const url = toUrl(token);
  if (!url) {
    return UNKNOWN;
  }
  const host = url.hostname.replace(/^www\./, "");
  const segments = url.pathname.split("/").filter(Boolean);
  if (TELEGRAM_HOSTS.has(host)) {
    return telegramPath(segments);
  }
  if (REDDIT_HOSTS.has(host)) {
    return redditPath(segments);
  }
  if (host === "github.com") {
    return githubPath(segments);
  }
  return { feedUrl: url.href };
}

export function isAllowedUrl(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    !url.username &&
    !url.password &&
    url.href.length <= MAX_URL_LENGTH &&
    !url.href.includes("${")
  );
}

function toUrl(token: string): URL | null {
  let value = token;
  if (!/^https?:\/\//i.test(value)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) || !/^[^/:]+\.[^/:]+(\/|$)/.test(value)) {
      return null;
    }
    value = `https://${value}`;
  }
  try {
    const url = new URL(value);
    return isAllowedUrl(url) ? url : null;
  } catch {
    return null;
  }
}

function telegram(name: string | undefined): Parsed {
  return name && CHANNEL.test(name) && !TELEGRAM_RESERVED.has(name.toLowerCase())
    ? { source: { kind: "telegram", channel: name } }
    : UNKNOWN;
}

function subreddit(name: string): Parsed {
  return SUBREDDIT.test(name) ? { source: { kind: "subreddit", subreddit: name } } : UNKNOWN;
}

function redditUser(name: string): Parsed {
  return REDDIT_USER.test(name) ? { source: { kind: "reddit_user", username: name } } : UNKNOWN;
}

function telegramPath(segments: string[]): Parsed {
  const rest = segments[0] === "s" ? segments.slice(1) : segments;
  if (rest.length === 0 || rest.length > 2 || (rest.length === 2 && !/^\d+$/.test(rest[1]))) {
    return UNKNOWN;
  }
  return telegram(rest[0]);
}

function redditPath(segments: string[]): Parsed {
  const [type, name] = segments;
  if (!name) {
    return UNKNOWN;
  }
  if (type === "r") {
    return subreddit(name);
  }
  return type === "u" || type === "user" ? redditUser(name) : UNKNOWN;
}

function githubPath(segments: string[]): Parsed {
  const [owner, repo] = segments;
  if (!owner || !GITHUB_OWNER.test(owner) || GITHUB_RESERVED.has(owner.toLowerCase())) {
    return UNKNOWN;
  }
  if (!repo) {
    return { source: { kind: "github_user", username: owner } };
  }
  const name = repo.replace(/\.git$/, "");
  return GITHUB_REPO.test(name) ? { source: { kind: "github_repo", owner, repo: name } } : UNKNOWN;
}

function place(source: Source): { list: List; entry: Entry } {
  switch (source.kind) {
    case "rss":
      return { list: LISTS[0], entry: { name: source.name, url: source.url } };
    case "telegram":
      return { list: LISTS[1], entry: { channel: source.channel } };
    case "subreddit":
      return { list: LISTS[2], entry: { subreddit: source.subreddit } };
    case "reddit_user":
      return { list: LISTS[3], entry: { username: source.username } };
    case "github_repo":
      return { list: LISTS[4], entry: { type: "repo_releases", owner: source.owner, repo: source.repo } };
    case "github_user":
      return { list: LISTS[4], entry: { type: "user_events", username: source.username } };
  }
}

export function sourceKey(source: Source): string {
  const { list, entry } = place(source);
  return list.key(entry);
}

export function sourceLink(source: Source): string {
  switch (source.kind) {
    case "rss":
      return source.url;
    case "telegram":
      return `https://t.me/${source.channel}`;
    case "subreddit":
      return `https://www.reddit.com/r/${source.subreddit}`;
    case "reddit_user":
      return `https://www.reddit.com/user/${source.username}`;
    case "github_repo":
      return `https://github.com/${source.owner}/${source.repo}`;
    case "github_user":
      return `https://github.com/${source.username}`;
  }
}

export function sourceLabel(source: Source): string {
  switch (source.kind) {
    case "rss":
      return `RSS «${source.name}»`;
    case "telegram":
      return `Telegram @${source.channel}`;
    case "subreddit":
      return `Reddit r/${source.subreddit}`;
    case "reddit_user":
      return `Reddit u/${source.username}`;
    case "github_repo":
      return `GitHub ${source.owner}/${source.repo} (релизы)`;
    case "github_user":
      return `GitHub ${source.username} (активность)`;
  }
}

export function keyHash(key: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(key)) {
    hash = Math.imul(hash ^ byte, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function container(parent: Record<string, unknown>, key: string, create: boolean): Record<string, unknown> | undefined {
  if (parent[key] === undefined && create) {
    parent[key] = {};
  }
  const value = parent[key];
  if (value !== undefined && !isObject(value)) {
    throw new Error(`${key} is not an object`);
  }
  return value;
}

function entries(sources: Record<string, unknown>, list: List, create = false): Entry[] {
  const [first, second] = list.path;
  const parent = second === undefined ? sources : container(sources, first, create);
  const key = second ?? first;
  if (parent && parent[key] === undefined && create) {
    parent[key] = [];
  }
  const value = parent?.[key] ?? [];
  if (!Array.isArray(value)) {
    throw new Error(`sources.${list.path.join(".")} is not a list`);
  }
  return value as Entry[];
}

export function countSources(data: UserData): number {
  const sources = container(data, "sources", false);
  return sources ? LISTS.reduce((total, list) => total + entries(sources, list).length, 0) : 0;
}

export function addSource(data: UserData, source: Source): { data: UserData } | "duplicate" | "limit" {
  const next = structuredClone(data);
  const sources = container(next, "sources", true) as Record<string, unknown>;
  const { list, entry } = place(source);
  const key = list.key(entry);
  if (entries(sources, list).some((existing) => list.key(existing) === key)) {
    return "duplicate";
  }
  if (countSources(data) >= MAX_SOURCES) {
    return "limit";
  }
  entries(sources, list, true).push(entry);
  return { data: next };
}

export function listSources(data: UserData): Listed[] {
  const sources = container(data, "sources", false);
  if (!sources) {
    return [];
  }
  return LISTS.flatMap((list) =>
    entries(sources, list).flatMap((entry) => {
      const source = list.source(entry);
      return source ? [{ source, enabled: entry.enabled !== false, hash: keyHash(list.key(entry)) }] : [];
    }),
  );
}

function locate(data: UserData, hash: string): { items: Entry[]; index: number; kind: string } | null {
  const sources = container(data, "sources", false);
  if (!sources) {
    return null;
  }
  for (const list of LISTS) {
    const items = entries(sources, list);
    const index = items.findIndex((entry) => keyHash(list.key(entry)) === hash);
    if (index !== -1) {
      return { items, index, kind: list.key(items[index]).split(":", 1)[0] };
    }
  }
  return null;
}

export function removeSource(data: UserData, hash: string): { data: UserData; kind: string } | null {
  const next = structuredClone(data);
  const found = locate(next, hash);
  if (!found) {
    return null;
  }
  found.items.splice(found.index, 1);
  return { data: next, kind: found.kind };
}

export function setEnabled(data: UserData, hash: string, enabled: boolean): { data: UserData; kind: string; changed: boolean } | null {
  const next = structuredClone(data);
  const found = locate(next, hash);
  if (!found) {
    return null;
  }
  const entry = found.items[found.index];
  const changed = (entry.enabled !== false) !== enabled;
  if (enabled) {
    delete entry.enabled;
  } else {
    entry.enabled = false;
  }
  return { data: next, kind: found.kind, changed };
}
