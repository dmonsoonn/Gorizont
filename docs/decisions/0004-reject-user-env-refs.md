# 0004. Reject environment references in every user file

- Status: accepted
- Date: 2026-11-16

## Context

ADR 0003 isolates user files in DATA_REPO, but the bot's PAT can still change the owner's file. ADR 0002 allowed that file to expand `${VAR}` from the digest job's environment. A leaked PAT could insert an RSS URL containing `${GROQ_API_KEY}` and send the expanded secret to an external server (#22).

## Options

- A: Keep the owner's exception. Existing configs keep working, but the leaked PAT retains this path to secrets.
- B: Reject environment references in every user file. Removes this expansion path with one common validation rule; owners must migrate existing references.
- C: Move the owner's file to the code repository. Gives it a different trust boundary, but splits user storage and complicates bot writes.

## Decision

Use option B, superseding ADR 0002. Before owner-specific source validation, `load_user` rejects `${NAME}` matching the existing environment-name pattern anywhere in the parsed JSON, including nested keys and values. It never expands variables from user files. Errors name the variables and file, without their secret values. Plain `$name` is unchanged.

The base config stays in the code repository and retains environment expansion. HORIZON_OWNER_ID still selects the owner's source permissions and Hacker News defaults; workflows and bot behavior are unchanged.

## Consequences

- A PAT holder cannot extract secrets through `${VAR}` expansion in any user file.
- Replace user `chat_id` references with explicit numeric IDs or channel names, or omit the field to deliver to the user's ID. A base webhook chat ID is overwritten by the user overlay.
- Move secret-bearing sources to the base config and omit user `sources` to inherit them. User `sources` replaces the whole base block; it is not merged.
- Invalid files remain in the due matrix with `publish_site=false`, so their jobs fail visibly instead of disappearing.
- Owner source fields that refer to secrets or files by name, such as `apify_token_env` and `cookie_dir`, retain their existing behavior. This decision closes the interpolation path, not every possible misuse of owner source permissions; those fields need a separate trust review.
