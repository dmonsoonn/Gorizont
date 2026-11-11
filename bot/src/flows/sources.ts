import { discoverFeeds, fetchFeed, type Feed } from "../feeds";
import { answerQuery, clip, editMessage, editUser, markDecision, reply, send, type Change } from "../replies";
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
  type ForwardOrigin,
  type Listed,
  type Source,
  type UserData,
} from "../sources";
import {
  added,
  BACK_BUTTON,
  CHOICE_EXPIRED,
  CHOOSE_FEED,
  chosen,
  CONFIRM_DELETE_BUTTON,
  confirmDelete,
  DELETE_BUTTON,
  DISABLE_BUTTON,
  DISABLED,
  duplicate,
  ENABLE_BUTTON,
  ENABLED,
  FEED_NOT_FOUND,
  KEEP_BUTTON,
  LIMIT,
  listItem,
  NEED_START,
  NO_SOURCES,
  PRIVATE_FORWARD,
  READ_FAILED,
  REMOVED,
  SAVE_FAILED,
  SOURCE_GONE,
  sourceStatus,
  sourcesTitle,
  STALE_BUTTON,
  UNDO_BUTTON,
  UNDONE_MARK,
  UNKNOWN,
} from "../texts";
import { FEEDS_TTL_SECONDS, feedsKey, type CallbackQuery, type Deps, type View } from "../types";

export type Action = "ls" | "src" | "off" | "on" | "del" | "rm";

type Saved = "added" | "duplicate" | "limit" | "missing" | "failed";

interface Managed {
  view: View;
  toast?: string;
}

function saveSource(userId: number, source: Source, deps: Deps): Promise<Saved> {
  return editUser<Saved>(userId, deps, (data) => {
    const result = addSource(data, source);
    if (typeof result === "string") {
      return { outcome: result };
    }
    return { outcome: "added", write: { data: result.data, message: `chore(users): add ${source.kind} source for ${userId} via bot` } };
  });
}

async function announce(userId: number, source: Source, saved: Saved, deps: Deps): Promise<void> {
  const label = sourceLabel(source);
  if (saved === "added") {
    await send(
      userId,
      {
        text: added(label),
        reply_markup: { inline_keyboard: [[{ text: UNDO_BUTTON, callback_data: `undo:${keyHash(sourceKey(source))}` }]] },
      },
      deps,
    );
    return;
  }
  const texts = { duplicate: duplicate(label), limit: LIMIT, missing: NEED_START, failed: SAVE_FAILED };
  await reply(userId, texts[saved], deps);
}

export async function addFromMessage(userId: number, text: string, origin: ForwardOrigin | undefined, deps: Deps): Promise<void> {
  const parsed = parseInput(text, origin);
  if ("error" in parsed) {
    return reply(userId, parsed.error === "private_forward" ? PRIVATE_FORWARD : UNKNOWN, deps);
  }
  if (!(await deps.github.userExists(userId))) {
    return reply(userId, NEED_START, deps);
  }
  if ("source" in parsed) {
    return announce(userId, parsed.source, await saveSource(userId, parsed.source, deps), deps);
  }
  const found = await discoverFeeds(parsed.feedUrl, deps.fetcher);
  if ("error" in found) {
    return reply(userId, FEED_NOT_FOUND, deps);
  }
  if ("choices" in found) {
    return offerFeeds(userId, keyHash(parsed.feedUrl), found.choices, deps);
  }
  const source: Source = { kind: "rss", name: found.feed.title, url: found.feed.url };
  await announce(userId, source, await saveSource(userId, source, deps), deps);
}

async function offerFeeds(userId: number, nonce: string, choices: Feed[], deps: Deps): Promise<void> {
  await deps.kv.put(feedsKey(userId), JSON.stringify({ nonce, choices }), { expirationTtl: FEEDS_TTL_SECONDS });
  await send(
    userId,
    {
      text: CHOOSE_FEED,
      reply_markup: {
        inline_keyboard: choices.map((feed, index) => [{ text: clip(feed.title), callback_data: `feed:${nonce}:${index}` }]),
      },
    },
    deps,
  );
}

export async function chooseFeed(query: CallbackQuery, nonce: string, index: number, deps: Deps): Promise<void> {
  const userId = query.from.id;
  const stored = await deps.kv.get(feedsKey(userId));
  const offer: { nonce: string; choices: Feed[] } | null = stored ? JSON.parse(stored) : null;
  const choice = offer?.nonce === nonce ? offer.choices[index] : undefined;
  if (!choice) {
    return answerQuery(query, deps, CHOICE_EXPIRED);
  }
  await answerQuery(query, deps);
  const feed = await fetchFeed(choice.url, deps.fetcher);
  if (!feed) {
    return reply(userId, FEED_NOT_FOUND, deps);
  }
  const source: Source = { kind: "rss", name: feed.title, url: feed.url };
  const saved = await saveSource(userId, source, deps);
  if (saved !== "failed") {
    await deps.kv.delete(feedsKey(userId));
    await markDecision(query, chosen(choice.title), deps);
  }
  await announce(userId, source, saved, deps);
}

export async function undoSource(query: CallbackQuery, hash: string, deps: Deps): Promise<void> {
  const userId = query.from.id;
  const outcome = await editUser<"removed" | "stale">(userId, deps, (data) => {
    const removed = removeSource(data, hash);
    if (!removed) {
      return { outcome: "stale" };
    }
    return { outcome: "removed", write: { data: removed.data, message: `chore(users): remove ${removed.kind} source for ${userId} via bot` } };
  });
  if (outcome !== "removed") {
    return answerQuery(query, deps, outcome === "failed" ? SAVE_FAILED : STALE_BUTTON);
  }
  await answerQuery(query, deps);
  await markDecision(query, UNDONE_MARK, deps);
}

export async function showList(userId: number, deps: Deps): Promise<void> {
  let view: View;
  try {
    const file = await deps.github.readUser(userId);
    view = file ? listView(file.data) : { text: NEED_START };
  } catch (error) {
    console.error(error);
    view = { text: READ_FAILED };
  }
  await send(userId, view, deps);
}

export async function manageSource(query: CallbackQuery, action: Action, hash: string, deps: Deps): Promise<void> {
  const userId = query.from.id;
  const result = await editUser<Managed>(userId, deps, (data) => applyAction(data, action, hash, userId));
  if (result === "missing") {
    return answerQuery(query, deps, NEED_START);
  }
  if (result === "failed") {
    return answerQuery(query, deps, action === "off" || action === "on" || action === "rm" ? SAVE_FAILED : READ_FAILED);
  }
  await answerQuery(query, deps, result.toast);
  await editMessage(query, result.view, deps);
}

function applyAction(data: UserData, action: Action, hash: string, userId: number): Change<Managed> {
  const stale: Change<Managed> = { outcome: { view: listView(data), toast: SOURCE_GONE } };
  if (action === "rm") {
    const removed = removeSource(data, hash);
    if (!removed) {
      return stale;
    }
    return {
      outcome: { view: listView(removed.data), toast: REMOVED },
      write: { data: removed.data, message: `chore(users): remove ${removed.kind} source for ${userId} via bot` },
    };
  }
  if (action === "off" || action === "on") {
    const enabled = action === "on";
    const updated = setEnabled(data, hash, enabled);
    const item = updated && listSources(updated.data).find((listed) => listed.hash === hash);
    if (!updated || !item) {
      return stale;
    }
    const outcome = { view: cardView(item), toast: enabled ? ENABLED : DISABLED };
    if (!updated.changed) {
      return { outcome };
    }
    const verb = enabled ? "enable" : "disable";
    return { outcome, write: { data: updated.data, message: `chore(users): ${verb} ${updated.kind} source for ${userId} via bot` } };
  }
  if (action === "ls") {
    return { outcome: { view: listView(data) } };
  }
  const item = listSources(data).find((listed) => listed.hash === hash);
  if (!item) {
    return stale;
  }
  return { outcome: { view: action === "src" ? cardView(item) : confirmView(item) } };
}

function listView(data: UserData): View {
  const items = listSources(data);
  if (items.length === 0) {
    return { text: NO_SOURCES };
  }
  return {
    text: sourcesTitle(countSources(data)),
    reply_markup: {
      inline_keyboard: items.map((item) => [{ text: clip(listItem(item.enabled, sourceLabel(item.source))), callback_data: `src:${item.hash}` }]),
    },
  };
}

function cardView(item: Listed): View {
  const toggle = item.enabled
    ? { text: DISABLE_BUTTON, callback_data: `off:${item.hash}` }
    : { text: ENABLE_BUTTON, callback_data: `on:${item.hash}` };
  return {
    text: [sourceLabel(item.source), sourceStatus(item.enabled), sourceLink(item.source)].join("\n"),
    reply_markup: {
      inline_keyboard: [[toggle, { text: DELETE_BUTTON, callback_data: `del:${item.hash}` }], [{ text: BACK_BUTTON, callback_data: "ls" }]],
    },
    link_preview_options: { is_disabled: true },
  };
}

function confirmView(item: Listed): View {
  return {
    text: confirmDelete(sourceLabel(item.source)),
    reply_markup: {
      inline_keyboard: [
        [
          { text: CONFIRM_DELETE_BUTTON, callback_data: `rm:${item.hash}` },
          { text: KEEP_BUTTON, callback_data: `src:${item.hash}` },
        ],
      ],
    },
  };
}
