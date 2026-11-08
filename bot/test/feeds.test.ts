import { describe, expect, it, vi } from "vitest";
import { discoverFeeds, fetchFeed, FETCH_TIMEOUT_MS, MAX_BODY_BYTES } from "../src/feeds";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet href="/style.xsl"?>
<!-- generated -->
<rss version="2.0"><channel><title> Блог &amp; заметки </title><item><title>Пост</title></item></channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><title type="html"><![CDATA[Simon Willison]]></title></feed>`;

function page(links: string[]): string {
  return `<!doctype html><html><head><title>Сайт</title>${links.join("\n")}</head><body><link rel="alternate" type="application/rss+xml" href="/body.xml"></body></html>`;
}

function served(routes: Record<string, string | Response>) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const route = routes[String(input)];
    if (route === undefined) {
      return new Response("missing", { status: 404 });
    }
    return typeof route === "string" ? new Response(route) : route;
  });
}

function redirected(body: string, url: string): Response {
  const response = new Response(body);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

describe("discoverFeeds", () => {
  it("takes a direct RSS link with its channel title", async () => {
    const fetcher = served({ "https://blog.example/feed": RSS });
    await expect(discoverFeeds("https://blog.example/feed", fetcher)).resolves.toEqual({
      feed: { url: "https://blog.example/feed", title: "Блог & заметки" },
    });
    const [, init] = fetcher.mock.calls[0];
    expect(init?.redirect).toBe("follow");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("reads an Atom title from CDATA", async () => {
    await expect(discoverFeeds("https://simonwillison.net/atom/everything/", served({ "https://simonwillison.net/atom/everything/": ATOM }))).resolves.toEqual({
      feed: { url: "https://simonwillison.net/atom/everything/", title: "Simon Willison" },
    });
  });

  it("stores the URL after redirects", async () => {
    const fetcher = served({ "http://blog.example/feed": redirected(RSS, "https://blog.example/rss.xml") });
    await expect(discoverFeeds("http://blog.example/feed", fetcher)).resolves.toEqual({
      feed: { url: "https://blog.example/rss.xml", title: "Блог & заметки" },
    });
  });

  it.each([
    ["<rss><channel><title>   </title></channel></rss>", "blog.example"],
    ["<rss><channel></channel></rss>", "blog.example"],
    ["<rss><channel><title>${OPENAI_API_KEY}</title></channel></rss>", "blog.example"],
    [`<rss><channel><title>${"я".repeat(150)}</title></channel></rss>`, "я".repeat(100)],
    [`<rss><channel><title>${"😀".repeat(150)}</title></channel></rss>`, "😀".repeat(100)],
    ["<rss><channel><title>A&#x26;B &#8212; C &bogus;</title></channel></rss>", "A&B — C &bogus;"],
  ])("normalizes the title of %j", async (body, title) => {
    const result = await discoverFeeds("https://blog.example/feed", served({ "https://blog.example/feed": body }));
    expect(result).toEqual({ feed: { url: "https://blog.example/feed", title } });
  });

  it("follows the only feed link of a page and resolves a relative href", async () => {
    const fetcher = served({
      "https://blog.example/posts/": page(['<link rel="alternate" type="application/rss+xml" title="Все посты" href="../feed.xml">']),
      "https://blog.example/feed.xml": RSS,
    });
    await expect(discoverFeeds("https://blog.example/posts/", fetcher)).resolves.toEqual({
      feed: { url: "https://blog.example/feed.xml", title: "Блог & заметки" },
    });
  });

  it("offers a choice when the page has several feeds, ignoring duplicates and non-feeds", async () => {
    const links = [
      `<link rel="alternate" type="application/rss+xml" title="Посты" href="/feed.xml">`,
      `<link type='application/atom+xml' rel='Alternate' href='https://blog.example/atom.xml'>`,
      `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`,
      `<link rel="stylesheet" href="/style.css">`,
      `<link rel="alternate" type="text/html" hreflang="en" href="/en/">`,
      `<link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">`,
      `<link rel="alternate" type="application/rss+xml" title="Комментарии &amp; ответы" href=/comments.xml>`,
    ];
    const fetcher = served({ "https://blog.example/": page(links) });
    await expect(discoverFeeds("https://blog.example/", fetcher)).resolves.toEqual({
      choices: [
        { url: "https://blog.example/feed.xml", title: "Посты" },
        { url: "https://blog.example/atom.xml", title: "https://blog.example/atom.xml" },
        { url: "https://blog.example/comments.xml", title: "Комментарии & ответы" },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("offers at most five feeds", async () => {
    const links = Array.from({ length: 7 }, (_, i) => `<link rel="alternate" type="application/rss+xml" href="/feed${i}.xml">`);
    const result = await discoverFeeds("https://blog.example/", served({ "https://blog.example/": page(links) }));
    expect("choices" in result && result.choices.map((c) => c.url)).toEqual([0, 1, 2, 3, 4].map((i) => `https://blog.example/feed${i}.xml`));
  });

  it.each([
    ["a page without feed links", { "https://blog.example/": page([]) }],
    ["a feed link that is not a feed", { "https://blog.example/": page(['<link rel="alternate" type="application/rss+xml" href="/feed.xml">']), "https://blog.example/feed.xml": "<html></html>" }],
    ["a server error", { "https://blog.example/": new Response(RSS, { status: 500 }) }],
    ["a body over the limit", { "https://blog.example/": new Response(`<rss>${"x".repeat(MAX_BODY_BYTES)}</rss>`) }],
    ["a redirect to a forbidden scheme", { "https://blog.example/": redirected(RSS, "ftp://blog.example/feed") }],
  ])("finds nothing on %s", async (_name, routes) => {
    await expect(discoverFeeds("https://blog.example/", served(routes))).resolves.toEqual({ error: "not_found" });
  });

  it("finds nothing when the request fails or times out", async () => {
    const fetcher = vi.fn(async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    await expect(discoverFeeds("https://blog.example/", fetcher)).resolves.toEqual({ error: "not_found" });
  });
});

describe("fetchFeed", () => {
  it("returns the feed or null", async () => {
    const fetcher = served({ "https://blog.example/feed.xml": RSS, "https://blog.example/": page([]) });
    await expect(fetchFeed("https://blog.example/feed.xml", fetcher)).resolves.toEqual({ url: "https://blog.example/feed.xml", title: "Блог & заметки" });
    await expect(fetchFeed("https://blog.example/", fetcher)).resolves.toBeNull();
  });
});
