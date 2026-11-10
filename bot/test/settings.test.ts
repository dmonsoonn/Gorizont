import { describe, expect, it } from "vitest";
import { chatTarget, parseChannel, resetChat, setChat, setWindow, windowOf } from "../src/settings";

describe("parseChannel", () => {
  it.each([
    ["a public channel", { type: "channel", chat: { id: -1001, username: "my_chan" } }, -1001],
    ["a private channel", { type: "channel", chat: { id: -1002 } }, -1002],
    ["a user", { type: "user", chat: { id: 5 } }, null],
    ["a group", { type: "chat", chat: { id: -1003, username: "group" } }, null],
    ["a channel without an id", { type: "channel", chat: { username: "my_chan" } }, null],
  ])("reads a forward from %s", (_name, origin, expected) => {
    expect(parseChannel("", origin)).toBe(expected);
  });

  it.each(["@my_chan", "t.me/my_chan", "https://t.me/my_chan", "https://t.me/s/my_chan/42", " @my_chan "])("reads %s as @my_chan", (value) => {
    expect(parseChannel(value)).toBe("@my_chan");
  });

  it.each(["", "привет", "https://blog.example/", "@abc", `@${"a".repeat(40)}`, "${TELEGRAM_CHAT_ID}", "@my_chan ${X}", "t.me/joinchat", "r/python"])(
    "rejects %s",
    (value) => {
      expect(parseChannel(value)).toBeNull();
    },
  );
});

describe("settings edits", () => {
  const file = () => ({ id: 1, chat_id: "${TELEGRAM_CHAT_ID}", time_window_hours: 1, sources: { rss: [] } });

  it("changes only the window and keeps the key order", () => {
    const original = file();
    const updated = setWindow(original, 24);
    expect(JSON.stringify(updated.data)).toBe(JSON.stringify({ ...file(), time_window_hours: 24 }));
    expect(updated.changed).toBe(true);
    expect(original).toEqual(file());
    expect(setWindow(updated.data, 24).changed).toBe(false);
  });

  it("sets and resets the chat", () => {
    const channel = setChat(file(), -1001);
    expect(JSON.stringify(channel.data)).toBe(JSON.stringify({ ...file(), chat_id: -1001 }));
    expect(setChat(channel.data, -1001).changed).toBe(false);
    const reset = resetChat(channel.data);
    expect(reset).toEqual({ data: { id: 1, time_window_hours: 1, sources: { rss: [] } }, changed: true });
    expect(resetChat(reset.data).changed).toBe(false);
  });

  it.each([
    [{ id: 1 }, "private"],
    [{ id: 1, chat_id: 1 }, "private"],
    [{ id: 1, chat_id: "${TELEGRAM_CHAT_ID}" }, "config"],
    [{ id: 1, chat_id: -1001 }, -1001],
    [{ id: 1, chat_id: "@my_chan" }, "@my_chan"],
  ])("reads the chat target of %j", (data, expected) => {
    expect(chatTarget(data)).toBe(expected);
  });

  it("defaults the window to 1 hour", () => {
    expect(windowOf({ id: 1 })).toBe(1);
    expect(windowOf({ id: 1, time_window_hours: 6 })).toBe(6);
  });
});
