---
id: 001
size: M
status: done
reopened: false
---

# Конфиги по пользователям и прогон пайплайна на каждого

## Goal

Дать нескольким пользователям (ключ — Telegram user ID) свои источники, свой чат доставки и свою частоту дайджеста поверх общего `data/config.github.json`. Это фундамент для бота из задачи 002 (issues #10, #11).

## Context (решения из уточнения)

- Хостинг — GitHub Actions; пользователи прогоняются matrix-джобой последовательно (`max-parallel: 1`) на общих ключах Groq.
- Хранение — `data/users/<telegram_id>.json` в публичном репо (ID и источники видны всем, секретов в файлах нет).
- Модель — «база + оверлей»: общие `ai`, `processing`, `digest`, `webhook` и ключи из базы; у пользователя свои:
  - `sources` — **полностью заменяют** базовые; если ключа нет, берутся базовые;
  - `chat_id` — куда слать дайджест (канал/чат на выбор; по умолчанию — личка, т.е. сам `id`); поддерживает `${VAR}`;
  - `time_window_hours` — окно сбора и одновременно частота дайджеста (по умолчанию 1);
  - `publish_site` — публиковать ли в GitHub Pages и email (по умолчанию `false`).
- Владелец (вы) — первый пользователь: ваши текущие источники переезжают в ваш файл, `"chat_id": "${TELEGRAM_CHAT_ID}"`, `"publish_site": true`.
- Allowlist и команды бота — в задаче 002, здесь список пользователей = файлы в `data/users/`.

## Acceptance criteria

1. Given `data/users/111.json` с `id: 111`, своим `sources` и `chat_id: "@chan"` When `horizon --user 111` Then пайплайн собирает только источники пользователя 111, а `webhook.request_body.chat_id` равен `@chan`.
2. Given файл пользователя без `chat_id` When применяется оверлей Then дайджест уходит в `chat_id = 111` (личка с ботом).
3. Given файл пользователя без `sources` When применяется оверлей Then используются источники из базового конфига.
4. Given `"chat_id": "${TELEGRAM_CHAT_ID}"` и env `TELEGRAM_CHAT_ID=@owner` When применяется оверлей Then `chat_id` разворачивается в `@owner`.
5. Given `time_window_hours: 6` When `horizon --user 111` без `--hours` Then окно сбора 6 часов; Given явный `--hours 2` Then он имеет приоритет.
6. Given пользователи с окнами 1, 6 и 24 When `python -m src.users due` в час UTC 0 Then в matrix попадают все трое; в час 12 — окна 1 и 6; в час 13 — только окно 1.
7. Given `publish_site: false` (или не задан) When прогон пользователя Then в `docs/_posts` ничего не пишется и email не отправляется; Given `publish_site: true` Then поведение как сейчас.
8. Given `horizon` без `--user` When запуск Then поведение не меняется (все существующие тесты зелёные).
9. Given новый workflow `users-digest.yml` When срабатывает cron раз в час Then джоба `plan` строит matrix из «due»-пользователей, `digest` прогоняет их по одному с `fail-fast: false`, деплой в Pages выполняется только для пользователей с `publish_site: true`; почасовой cron в `daily-summary.yml` отключён (остаётся `workflow_dispatch`), чтобы владелец не получал дубли.
10. Given текущие источники из `data/config.github.json` When миграция Then они лежат в `data/users/<owner_id>.json`, и ручной `workflow_dispatch` нового workflow доставляет дайджест в ваш канал.

## Negative scenarios

- N1 (валидация ввода): Given `--user ../config` или `--user abc` When запуск Then ошибка «invalid user id», exit 1, ни один файл вне `data/users/` не читается.
- N2: Given `--user 999` и файла нет When запуск Then понятная ошибка и exit 1.
- N3 (валидация ввода): Given в файле пользователя неизвестный ключ (например `ai`) или невалидный источник When загрузка Then `ConfigError` с путём файла; в matrix падает только джоба этого пользователя.
- N4 (чужой ресурс): Given файл `data/users/111.json` содержит `id: 222` When загрузка Then ошибка несовпадения id; конфиг не применяется.
- N5 (чужой ресурс): Given пользователи A и B When прогон A Then ни источники B, ни chat_id B не используются, уведомление о сбое A уходит только в чат A.
- N6: Given `time_window_hours: 5` (не делит 24) или ≤ 0 When загрузка Then ошибка валидации.
- N7: Given прогон пользователя A упал When matrix продолжается Then пользователь B получает свой дайджест.

## Scope

- Change:
  - `src/users/` — новый модуль: модель `UserConfig` (pydantic, `extra="forbid"`), загрузка и валидация id/файла, `apply_overlay(base, user) -> Config`, `due_users(hour)`, `__main__` для `python -m src.users due`.
  - `src/main.py` — хирургически: флаг `--user`, применение оверлея, окно по умолчанию, передача `publish_site`.
  - `src/orchestrator.py` — хирургически: параметр `publish_site: bool = True`, при `False` пропускать копию в `docs/_posts` и email.
  - `.github/workflows/users-digest.yml` — новый.
  - `.github/workflows/daily-summary.yml` — убрать только блок `schedule`.
  - `data/users/<owner_id>.json` — новый (миграция ваших источников).
  - `tests/test_users.py` — новые тесты.
  - `docs/multi-user.md` — документация форка отдельным файлом.
  - `.gitignore` — строка `.claude/state/` (требование скилла `/task`).
  - `docs/decisions/0001-user-config-overlay.md` — ADR по решениям задачи (добавлено при `/done` по вашему решению).
- Do NOT touch: `src/models.py` (без новых полей в `Config`), `src/services/webhook.py`, `src/storage/manager.py` (только переиспользовать), `docs/configuration.md`, `README*.md`, `pyproject.toml`, существующие тесты, Jekyll-сайт.
- Pattern:
  - загрузка и раскрытие `${VAR}` — `StorageManager.load_config` и `_expand_env_vars` (`src/storage/manager.py`);
  - pydantic-модели конфига — `src/models.py` (`Config` с `extra="forbid"`);
  - CLI-аргументы — `src/_cli.py`, `src/main.py`;
  - fork-flow: новый код в новых модулях, в upstream-файлах только точки подключения.

## Plan

Владелец: Telegram ID `612722019`. Битый файл пользователя всё равно попадает в matrix, чтобы его джоба упала с понятной ошибкой.

1. `src/users/__init__.py`: `UserConfig` (`id`, `chat_id`, `time_window_hours` делит 24, `publish_site`, `sources: SourcesConfig | None`), `user_path` (id `^[1-9]\d*$` + `safe_output_path`), `load_user` (`_expand_env_vars`, проверка id), `apply_overlay` (sources, окно, `webhook.request_body.chat_id`, `email=None` без `publish_site`), `due_users(hour)`.
2. `src/users/__main__.py`: `python -m src.users due [--data-dir] [--hour]` → JSON matrix `{"include": [...]}`.
3. `src/main.py`: `--user`, оверлей, `force_hours = args.hours or user.time_window_hours`, `publish_site` в оркестратор.
4. `src/orchestrator.py`: kwarg `publish_site=True`, при `False` пропуск копии в `docs/_posts`.
5. `.github/workflows/users-digest.yml`: `plan` → `digest` (matrix, `max-parallel: 1`, `fail-fast: false`, Pages только при `publish_site`); из `daily-summary.yml` убрать `schedule`.
6. `data/users/612722019.json`: источники из `config.github.json`, `${TELEGRAM_CHAT_ID}`, `publish_site: true`.
7. `tests/test_users.py`: AC 1–7, N1–N6.
8. `docs/multi-user.md`.

Базовая линия до правок: `uv run pytest` → 974 passed, 1 failed (`test_3xx_redirect_prints_warning`, известная проблема #4, зависит от DNS).

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| 1 | `tests/test_users.py::test_overlay_uses_user_sources_and_chat`, `::test_main_runs_single_user` | PASS |
| 2 | `::test_overlay_defaults_chat_to_user_id` | PASS |
| 3 | `::test_overlay_without_sources_keeps_base_sources` | PASS |
| 4 | `::test_load_user_expands_env_vars` | PASS |
| 5 | `::test_main_runs_single_user` (force_hours=6), `::test_main_explicit_hours_override_user_window` | PASS |
| 6 | `::test_due_users_follows_time_windows`, `::test_due_command_prints_matrix`; `uv run python -m src.users due --hour 0/12/13` на реальной `data/` | PASS |
| 7 | `::test_orchestrator_skips_site_when_not_publishing`, `::test_orchestrator_publishes_site_by_default`, `::test_overlay_drops_email_unless_user_publishes_site`, `::test_main_without_user_is_unchanged` | PASS |
| 8 | `uv run pytest` → 1009 passed (после фикса #4 в `cabbe3d`); `::test_main_without_user_is_unchanged` | PASS |
| 9 | `uvx check-jsonschema --builtin-schema vendor.github-workflows` → ok; run 42379714135 (`workflow_dispatch`): `plan` → matrix `[{612722019, true}]` → `digest` → Deploy to GitHub Pages, success; cron только в `users-digest.yml` | PASS |
| 10 | Run 42379714135: ваш файл загружен, окно 1 ч, за час 0 элементов. Затем локально `uv run horizon --config data/config.github.json --user 612722019 --hours 24` → 32 fetched, 11 selected, `Sending RU webhook notification... Webhook sent successfully (status=200)`, exit 0; chat_id из `${TELEGRAM_CHAT_ID}` | PASS |
| N1 | `::test_load_user_rejects_invalid_ids` (6 случаев), `::test_main_rejects_bad_user`; `uv run horizon --user abc` / `../config` → exit 1 | PASS |
| N2 | `::test_load_user_reports_missing_file`; `uv run horizon --user 999` → exit 1 | PASS |
| N3 | `::test_load_user_rejects_invalid_files` (неизвестный ключ, источник без url, битый JSON), `::test_due_users_keeps_broken_files_so_their_job_fails` | PASS |
| N4 | `::test_load_user_rejects_foreign_id` | PASS |
| N5 | `::test_users_do_not_share_sources_or_chat` (источники и chat_id уведомлений только пользователя A) | PASS |
| N6 | `::test_time_window_must_divide_day` (5, 0, -1, 25) | PASS |
| N7 | Run 42412369718 на временной ветке с битым `data/users/1.json` (`ai` — лишний ключ): `digest (1)` упал в 20:43:18 с `Invalid user config data/users/1.json … extra_forbidden`, exit 1; затем `digest (612722019)` стартовал в 20:43:21 и завершился success. Ветка удалена, workflow снова выключен | PASS |
| Review r1 FINDING 8 (пустой/неразвёрнутый `chat_id`) | `::test_load_user_rejects_empty_chat_id`, `::test_overlay_rejects_unexpanded_chat_id` (падали до фикса), `::test_due_users_does_not_need_chat_env` (джоба `plan` без секретов не ломает `publish_site`); `uv run horizon --data-dir <tmp> --user 111` с `${HZ_NO_SUCH_CHAT_VAR}` → `chat_id … is not expanded`, exit 1; `uv run pytest` → 1012 passed | PASS |

| review r1 (2026-11-08, диапазон 2fd734a..HEAD) | reviewer | BLOCK: FINDING 8 (исправлен), FINDING 1/5 по `cabbe3d` — принят вами как отдельный фикс #4, concurrency вынесен в #13 |
| review r2 (2026-11-08, незакоммиченный diff) | reviewer | BLOCK: только ADR вне Scope — внесён в Scope |
| review r3 (2026-11-08, незакоммиченный diff) | reviewer | PASS |

Линтера в проекте нет (`ruff` не установлен), отдельного typecheck тоже.

## Knowledge

- Dead ends: none
- Decisions: [ADR 0001](../docs/decisions/0001-user-config-overlay.md) — оверлей вне `Config`, `sources` заменяют базовые, окно делит 24.
- Known issues: все workflow в репо выключены вручную (`disabled_manually`), почасовой дайджест сейчас не ходит; для проверки N7 `users-digest.yml` включался на время прогона и снова выключен. Вынесено в issues: #13 (concurrency в `users-digest.yml`), #14 (раскрытие любых `${VAR}` в файлах пользователей — блокер для #11).
