---
layout: default
title: Telegram bot
---

# Telegram bot

People join Horizon through the same Telegram bot that sends the digests. A person sends `/start`, the owner approves the request with a button, and the bot commits `data/users/<id>.json` to the repository. The next run of `users-digest.yml` picks the new user up (see [Multiple users](multi-user.md)).

## How it works

```
Telegram ──webhook──► Cloudflare Worker (bot/) ──Contents API──► data/users/<id>.json in main
                            │                                              │
                       Workers KV                              users-digest.yml (hourly)
            (pending / rejected requests,                      sends digests with the same bot
                 feed choices)
```

- Telegram delivers every update to the Worker URL with the `X-Telegram-Bot-Api-Secret-Token` header. Requests without the right header get `401`.
- A request from a new person goes to the owner (`OWNER_ID` in `bot/wrangler.jsonc`) with the name, `@username`, ID, profile link and **Approve / Reject** buttons. Only the owner can press them.
- A pending request is stored in KV for 24 hours, so repeated `/start` does not notify the owner again. A rejection is stored without expiry.
- Approval creates `{"id": <id>, "time_window_hours": 6}` as a commit by `Gorizont bot`. An existing file is never overwritten. If GitHub fails, the owner gets an error message and can press the button again.
- The Worker always answers Telegram with `200` after the secret check, otherwise Telegram keeps retrying the update.
- Commands: `/start`, `/help`. The bot ignores groups and channels.

A new user has no sources, so their digest stays empty until they add some. The digest is delivered only while `users-digest.yml` is enabled.

## Adding sources

An approved user sends a link or forwards a post; there is no separate command. Anything that is not a command is read as a source:

| Input | Written to |
|---|---|
| `t.me/<channel>`, `t.me/s/<channel>`, a post link, `@<channel>`, a post forwarded from a public channel | `telegram.channels` |
| `r/<name>`, `reddit.com/r/<name>` / `u/<name>`, `reddit.com/user/<name>` | `reddit.subreddits` / `reddit.users` |
| `github.com/<owner>/<repo>` / `github.com/<user>` | `github`: `repo_releases` / `user_events` |
| any other `http(s)` link | `rss` |

- Telegram, Reddit and GitHub names are checked only against the same patterns as the Python whitelist; the bot does not look them up.
- For a link the bot downloads the page (10 s timeout, at most 1 MB). An RSS or Atom document is added as is, named after its `<title>` (up to 100 characters, the host name if empty). An HTML page is searched for `<link rel="alternate">` feeds: one feed is added directly, several (up to 5) are offered as buttons. The offer is kept in KV (`feeds:<id>`) for 10 minutes.
- Every change is a commit by `Gorizont bot` that edits only the affected list; other fields, including `${VAR}` in the owner's file, stay as they are. When the bot creates the owner's `sources` block, it also writes `"hackernews": {"enabled": false}`, because the owner's file would otherwise get Hacker News by default.
- The reply has an **Undo** button that removes the source with a second commit. It acts on the file of whoever presses it.
- At most 20 sources per user, the owner included; disabled ones count. A source that is already there is reported without a commit. Input containing `${` is refused.
- If the file changed between reading and writing, the bot reads it again and retries once.
- The repository is public, so the bot tells users that their list of sources is public too.

KV is eventually consistent: two `/start` messages a few seconds apart may produce two requests. The second approval is reported as "already connected".

## One-time setup

1. **Cloudflare.** Create an account, then:
   - an API token from the **Edit Cloudflare Workers** template;
   - the Account ID (Workers & Pages overview page);
   - your `workers.dev` subdomain (Workers & Pages → Settings). The Worker URL is `https://gorizont-bot.<subdomain>.workers.dev`.
2. **KV namespace.** Run `cd bot && npm ci && npx wrangler login && npx wrangler kv namespace create gorizont-bot` and put the printed `id` into the `kv_namespaces` entry of `bot/wrangler.jsonc`. The id is not a secret.
3. **GitHub token.** Create a fine-grained personal access token with access to this repository only and the single permission **Contents: Read and write**. Do not grant **Workflows**: user files must not be able to change workflows (see ADR 0002).
4. **Repository secrets** (Settings → Secrets and variables → Actions):

   | Secret | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | token from step 1 |
   | `CLOUDFLARE_ACCOUNT_ID` | account ID from step 1 |
   | `TELEGRAM_BOT_TOKEN` | the bot token (the same bot as in `HORIZON_WEBHOOK_URL`) |
   | `BOT_WEBHOOK_SECRET` | any random string of 1–256 characters `A-Z a-z 0-9 _ -`, e.g. `openssl rand -hex 32` |
   | `BOT_GITHUB_TOKEN` | token from step 3 |

5. **Repository variable** `BOT_URL` = the Worker URL from step 1.
6. Push a change under `bot/` or run **Deploy Telegram Bot** manually.

## Deployment

`.github/workflows/bot-deploy.yml` runs on pushes to `main` that touch `bot/**` and on manual dispatch. It installs the pinned dependencies, runs the tests and the type check, deploys with `wrangler deploy --secrets-file` (the secrets come from the repository secrets above), and registers the webhook with `setWebhook` for `message` and `callback_query` updates.

Check the webhook:

```bash
curl -s "https://api.telegram.org/bot<token>/getWebhookInfo"
```

`url` must be the Worker URL and `last_error_message` must be empty. The bot can have only one webhook, and `getUpdates` stops working while it is set.

## Development

```bash
cd bot
npm ci
npm test
npm run typecheck
npm run types   # after changing wrangler.jsonc
```

Logs of the deployed Worker: `npx wrangler tail`.
