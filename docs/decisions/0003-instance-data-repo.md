# 0003. Keep instance data in a separate repository

- Status: accepted
- Date: 2026-11-11

## Context
For the self-host release (#17) a person forks the repository, keeps it up to date with Sync fork and runs their own bot. Until now the installation lived in `main`: user files in `data/users/`, the owner ID in `users-digest.yml`, the repository and KV id in `bot/wrangler.jsonc`. Sync fork would conflict with such files, and every bot action was a commit to the code branch.

The bot writes user files with a fine-grained PAT that has `Contents: read and write`. Such a token cannot be limited to a branch or a path. If it leaks (Cloudflare account, Worker bug), whoever holds it can push code to `main`, and that code runs in `users-digest.yml` with the Groq keys and the bot token.

## Options
- A: Branch `data` in the code repository. Plus: one repository, fewer setup steps. Minus: the PAT still reaches `main`, so a leaked token can change code.
- B: Separate repository `DATA_REPO` (private by default). Plus: the PAT is granted only on it, so a leaked token can change user files but not code, workflows or the base config; user IDs and sources are not public. Minus: one more repository to create; workflows check out two repositories and need a token to read a private one.
- C: Both, with the branch as default. Plus: flexible. Minus: two code paths to test and document, and the default is the weaker one.

## Decision
We will use option B. The data repository holds only `users/<telegram_id>.json`. The base config stays in the code repository as `data/config.github.json`: `load_config` expands `${VAR}` everywhere in it and it sets `ai.base_url` and the key variables, so a base config the PAT could write would let a leaked token send the Groq keys or the bot token to any server. The Worker gets the repository as `GITHUB_REPO` from `vars.DATA_REPO` and the owner as `OWNER_ID` from `vars.OWNER_ID` via `wrangler deploy --var`. `users-digest.yml` checks the data repository out with the same PAT (`secrets.BOT_GITHUB_TOKEN`) into `instance/` with `persist-credentials: false` and copies the files into `data/`. The KV namespace has no id in `wrangler.jsonc` and is provisioned by `wrangler deploy`.

## Consequences
- `main` holds no installation values, so Sync fork does not conflict with user data.
- The owner ID moves from the workflow file to a repository variable; ADR 0002 is updated accordingly.
- Setup needs a second repository, a PAT on it, and the variables `OWNER_ID` and `DATA_REPO`.
- Local runs need a clone of the data repository copied into `data/`.
- The base config is edited in the fork; a change to `data/config.github.json` upstream shows up as a Sync fork conflict.
- The history of user files before the move stays in the code repository.
- The owner's file is in the data repository and its `${VAR}` are still expanded (ADR 0002), so a leaked PAT can still reach the job's secrets through it. Closing that needs user files without any `${VAR}` (#22).
