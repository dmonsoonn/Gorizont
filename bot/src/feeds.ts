import { isAllowedUrl } from "./sources";

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_CHOICES = 5;
export const MAX_NAME_LENGTH = 100;

const HEAD_BYTES = 256 * 1024;
const FEED_ROOTS = new Set(["rss", "feed", "rdf:rdf"]);
const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml"]);
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export interface Feed {
  url: string;
  title: string;
}

export type Discovery = { feed: Feed } | { choices: Feed[] } | { error: "not_found" };

const NOT_FOUND: Discovery = { error: "not_found" };

export async function discoverFeeds(url: string, fetcher: typeof fetch): Promise<Discovery> {
  const page = await load(url, fetcher);
  if (!page) {
    return NOT_FOUND;
  }
  if (isFeed(page.text)) {
    return { feed: { url: page.url, title: feedTitle(page.text, page.url) } };
  }
  const links = feedLinks(page.text, page.url);
  if (links.length === 1) {
    const feed = await fetchFeed(links[0].url, fetcher);
    return feed ? { feed } : NOT_FOUND;
  }
  return links.length ? { choices: links } : NOT_FOUND;
}

export async function fetchFeed(url: string, fetcher: typeof fetch): Promise<Feed | null> {
  const page = await load(url, fetcher);
  return page && isFeed(page.text) ? { url: page.url, title: feedTitle(page.text, page.url) } : null;
}

async function load(url: string, fetcher: typeof fetch): Promise<{ url: string; text: string } | null> {
  try {
    const response = await fetcher(url, {
      redirect: "follow",
      headers: { "User-Agent": "gorizont-bot" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const finalUrl = new URL(response.url || url);
    if (!response.ok || !response.body || !isAllowedUrl(finalUrl)) {
      return null;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return { url: finalUrl.href, text: text + decoder.decode() };
  } catch {
    return null;
  }
}

function isFeed(text: string): boolean {
  const root = /<(?![?!])([A-Za-z][\w:.-]*)/.exec(text);
  return root !== null && FEED_ROOTS.has(root[1].toLowerCase());
}

function feedTitle(text: string, url: string): string {
  const match = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i.exec(text);
  const raw = match ? match[1].trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1") : "";
  const title = Array.from(decodeEntities(raw).replace(/\s+/g, " ").trim()).slice(0, MAX_NAME_LENGTH).join("").trim();
  return title && !title.includes("${") ? title : new URL(url).hostname;
}

function feedLinks(text: string, base: string): Feed[] {
  const end = text.search(/<\/head\s*>/i);
  const head = end === -1 ? text.slice(0, HEAD_BYTES) : text.slice(0, end);
  const feeds: Feed[] = [];
  for (const [tag] of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(tag);
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    if (!rel.includes("alternate") || !FEED_TYPES.has((attrs.type ?? "").toLowerCase().trim()) || !attrs.href) {
      continue;
    }
    let url: URL;
    try {
      url = new URL(attrs.href, base);
    } catch {
      continue;
    }
    if (!isAllowedUrl(url) || feeds.some((feed) => feed.url === url.href)) {
      continue;
    }
    feeds.push({ url: url.href, title: attrs.title?.trim() || url.href });
    if (feeds.length === MAX_CHOICES) {
      break;
    }
  }
  return feeds;
}

function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
  }
  return attrs;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}
