---
layout: default
title: Multiple users
---

# Multiple users

One Horizon deployment can serve several people. Each person is identified by their Telegram user ID and gets their own sources, delivery chat and digest frequency on top of the shared `data/config.github.json`.

## User file

Every user has a file `data/users/<telegram_id>.json`:

```json
{
  "id": 111111111,
  "chat_id": "@my_channel",
  "time_window_hours": 6,
  "sources": { "rss": [{ "name": "Simon Willison", "url": "https://simonwillison.net/atom/everything/" }] }
}
```

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Telegram user ID; must match the file name. |
| `chat_id` | `id` | Where the digest goes: the user's private chat with the bot, a channel (`@name`) or a group. The bot must be an admin of a channel to post there. |
| `time_window_hours` | `1` | Collection window and digest frequency. Must divide 24: the user runs at UTC hours divisible by it. |
| `publish_site` | `false` | Publish the digest to GitHub Pages and send email. Only the site owner should set it. |
| `sources` | base sources | Replaces the whole `sources` block of the base config. The base config has no sources, so a user without `sources` gets an empty digest. In the owner's file, missing source types take the model defaults, and Hacker News is on by default: set `"hackernews": {"enabled": false}` to keep it off. Other users are limited as described below. |

`${VAR}` references are expanded from the environment only in the owner's file: the one whose `id` equals the `HORIZON_OWNER_ID` environment variable. Any `${VAR}` in another user's file is a validation error, so a user file cannot read secrets such as AI keys. `users-digest.yml` sets `HORIZON_OWNER_ID` in both jobs; for local runs export it or add it to your dotenv file.

Every other user's `sources` may contain only these fields, at most 20 sources in total; anything else is a validation error:

| Type | Fields |
|---|---|
| `rss` | `name`, `url`, `enabled` |
| `telegram.channels` | `channel`, `enabled` |
| `reddit.subreddits` / `reddit.users` | `subreddit` / `username`, `enabled` |
| `github` | `type` (`repo_releases` with `owner` and `repo`, or `user_events` with `username`), `enabled` |

Hacker News is always off for them, profiles are chosen by the AI (`auto`), and fetch limits and score thresholds use the defaults. RSS feeds of every user are fetched through `safe_request`, which refuses private, loopback and link-local destinations, including redirects to them.

Everything else (AI provider, keys, profiles, thresholds, webhook URL) comes from the base config. Its webhook must be enabled and have a JSON `request_body`; Horizon replaces `request_body.chat_id` with the user's chat.

## Running

```bash
uv run horizon --user 612722019
uv run python -m src.users due --hour 12
```

`--user` loads the base config, applies the user file and uses `time_window_hours` as the collection window unless `--hours` is given. `due` prints the GitHub Actions matrix of users that should run at the given UTC hour (the current hour by default).

## GitHub Actions

`.github/workflows/users-digest.yml` runs hourly. The `plan` job lists due users, and the `digest` job runs them one at a time (`max-parallel: 1`) so they share the AI keys without hitting rate limits. A failed user does not stop the others (`fail-fast: false`) and gets a failure message in their own chat. A user file that fails validation is still scheduled, so its job fails visibly with the error. GitHub Pages is deployed only for users with `publish_site: true`.

`daily-summary.yml` is kept from upstream for manual runs of the base config only; since the base config has no sources, such a run collects nothing.

## Adding a user

1. Ask the person for their Telegram user ID and, if they want a channel, its `@name`.
2. Create `data/users/<id>.json` with at least `id`.
3. Commit and push; the next hourly run picks it up.
