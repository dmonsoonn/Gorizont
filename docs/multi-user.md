---
layout: default
title: Multiple users
---

# Multiple users

One Horizon deployment can serve several people. Each person is identified by their Telegram user ID and gets their own sources, delivery chat and digest frequency on top of the shared base config.

User files live in a separate, usually private repository set by the repository variable `DATA_REPO` ([ADR 0003](decisions/0003-instance-data-repo.md)), as `users/<telegram_id>.json`. The base config is `data/config.github.json` in this repository: the bot's token cannot write it, because a base config controls the AI endpoint and expands `${VAR}`. The workflows copy the user files into `data/users/` and the base config into `data/config.json` before running Horizon.

## User file

Every user has a file `users/<telegram_id>.json` in the data repository (`data/users/<telegram_id>.json` after it is copied):

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
| `chat_id` | `id` | Where the digest goes: the user's private chat with the bot, a channel (`@name` or numeric ID) or a group. The bot must be an admin of a channel to post there. Users change it with `/chat` in the [bot](telegram-bot.md#digest-settings), which writes the numeric channel ID. |
| `time_window_hours` | `1` | Collection window and digest frequency. Must divide 24: the user runs at UTC hours divisible by it. Users choose 3, 6, 12 or 24 with `/window` in the bot. |
| `publish_site` | `false` | Publish the digest to GitHub Pages and send email. Only the site owner should set it. |
| `sources` | base sources | Replaces the whole `sources` block of the base config. The base config has no sources, so a user without `sources` gets an empty digest. In the owner's file, missing source types take the model defaults; Hacker News is off unless the file sets `"hackernews": {"enabled": true}`. Other users are limited as described below. |

`${VAR}` references are expanded from the environment only in the owner's file: the one whose `id` equals the `HORIZON_OWNER_ID` environment variable. Any `${VAR}` in another user's file is a validation error, so a user file cannot read secrets such as AI keys. `users-digest.yml` sets `HORIZON_OWNER_ID` from the repository variable `OWNER_ID` in both jobs; for local runs export it or add it to your dotenv file.

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

Copy the data repository into `data/` first:

```bash
git clone git@github.com:<owner>/<data-repo>.git ../gorizont-data
mkdir -p data/users && cp ../gorizont-data/users/*.json data/users/
uv run horizon --user <telegram_id>
uv run python -m src.users due --hour 12
```

`data/users/` is not tracked in this repository; do not commit it.

`--user` loads the base config, applies the user file and uses `time_window_hours` as the collection window unless `--hours` is given. `due` prints the GitHub Actions matrix of users that should run at the given UTC hour (the current hour by default).

## GitHub Actions

`.github/workflows/users-digest.yml` runs hourly and needs the variables `OWNER_ID` and `DATA_REPO` and the secret `BOT_GITHUB_TOKEN` (the bot's token, see [Telegram bot](telegram-bot.md#one-time-setup)). It checks the data repository out into `instance/` without keeping the token in git config. The `plan` job lists due users, and the `digest` job runs them one at a time (`max-parallel: 1`) so they share the AI keys without hitting rate limits. A failed user does not stop the others (`fail-fast: false`) and gets a failure message in their own chat. A user file that fails validation is still scheduled, so its job fails visibly with the error.

The workflow token is read-only (`contents: read`) everywhere except the `publish` job, which deploys GitHub Pages and does not run Horizon. Only users with `publish_site: true` upload their `docs/` as an artifact; `publish` merges them, points `url` and `baseurl` of `docs/_config.yml` at this repository and deploys to `gh-pages`. Runs never overlap: a new one waits for the current one (`concurrency`). A manual run with **dry_run** only prints the matrix of due users and sends nothing.

`daily-summary.yml` is kept from upstream for manual runs of the base config only; since the base config has no sources, such a run collects nothing.

## Adding a user

1. Ask the person for their Telegram user ID and, if they want a channel, its `@name`.
2. Create `users/<id>.json` with at least `id` in the data repository.
3. Commit and push there; the next hourly run picks it up.
