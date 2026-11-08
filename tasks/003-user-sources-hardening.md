---
id: 003
size: M
status: done
reopened: false
---

# Защита Python-стороны перед ботом: белый список источников, безопасный RSS, токен GitHub (#15)

## Goal

Сделать так, чтобы файл обычного пользователя (его будет писать бот из задач 004–005) не мог ни вытащить секреты, ни заставить раннер скачать внутренний адрес, ни включить источники сверх разрешённых.

## Context (решения из уточнения)

- Бот (004–006): Cloudflare Worker на TS, тот же бот, что шлёт дайджесты; новые пользователи по одобрению владельца; источники добавляются ссылкой или пересланным постом; удаление и пауза кнопками в `/list`; лимит 20 источников; новый пользователь стартует без источников.
- Пользователям бота разрешены только четыре типа источников:
  - RSS: `name`, `url`, `enabled`;
  - Telegram: `channels[].channel`, `channels[].enabled`;
  - Reddit: `subreddits[].subreddit`, `subreddits[].enabled`, `users[].username`, `users[].enabled`;
  - GitHub: `type` ∈ {`repo_releases`, `user_events`}, `owner`+`repo` или `username`, `enabled`.
  Всё остальное (Twitter, OpenBB, OSS Insight, GDELT, Google News, `profile`, `category`, `content_extractor`, `fetch_limit`, `min_score`, `sort`, `time_filter`, `fetch_comments`, `*_env`, пути к cookies) — только у владельца.
- Hacker News у пользователей всегда выключен: в `SourcesConfig` он по умолчанию включён, поэтому без принудительного выключения первый же источник пользователя включал бы HN.
- Профиль источников пользователей — `auto` (AI выбирает сам). Чтобы `ai-creator` не пропускал всё без фильтра (`src/orchestrator.py:920`), в базовом конфиге ему порог 7.0 (один пункт из #16).
- RSS скачивается через существующий `safe_request` (`src/url_security.py:86`): проверка DNS и каждого редиректа на публичный адрес. Касается всех, включая владельца.
- `GITHUB_TOKEN` (встроенный токен Actions) передаётся в джобу `digest`; скрейпер шлёт его только на `api.github.com` (`src/scrapers/github.py:23`).
- Владелец (`HORIZON_OWNER_ID`) ограничений белого списка не имеет — как сейчас.

## Acceptance criteria

1. Given файл не-владельца с RSS, Telegram-каналом, сабреддитом, Reddit-пользователем и GitHub-репо в разрешённых полях When `load_user` + `apply_overlay` Then все источники в конфиге, `hackernews.enabled` = `false`.
2. Given файл не-владельца с `sources: {"rss": [...]}` (без `hackernews`) When загрузка Then Hacker News выключен.
3. Given файл владельца с любыми полями `SourcesConfig` (Twitter, `profile`, `content_extractor`, HN) When загрузка Then загружается как до задачи.
4. Given RSS-источник с публичным URL When сбор Then лента скачивается через `safe_request` (заголовок `User-Agent` как раньше), элементы те же; существующие тесты RSS зелёные.
5. Given `data/config.github.json` When загрузка Then у `ai-creator` порог 7.0; локальный `data/config.json` — копия `config.github.json`.
6. Given `users-digest.yml` When открыть шаг «Run Horizon for user» Then в env есть `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}`; схема workflow валидна.
7. Given `docs/multi-user.md` When читать раздел о файле пользователя Then описаны разрешённые для пользователей поля, лимит 20 и выключенный HN.
8. Given `uv run pytest` When запуск Then всё зелёное.

## Negative scenarios

- N1 (чужой ресурс / секреты): Given файл не-владельца с `sources.twitter` (в т.ч. `apify_token_env`, `cookie_dir`) When загрузка Then `ConfigError` с путём файла, в matrix этот пользователь падает отдельно.
- N2 (валидация ввода): Given файл не-владельца с `profile`, `category`, `content_extractor`, `fetch_limit` или `min_score` у источника When загрузка Then `ConfigError`.
- N3 (валидация ввода): Given файл не-владельца с `hackernews: {"enabled": true}`, `google_news`, `gdelt`, `openbb` или `ossinsight` When загрузка Then `ConfigError`.
- N4 (валидация ввода): Given GitHub-источник не-владельца с `type` не из {`repo_releases`, `user_events`} When загрузка Then `ConfigError`.
- N5 (лимит): Given файл не-владельца с 21 источником (в сумме по всем типам) When загрузка Then `ConfigError` с упоминанием лимита 20; с 20 — загружается.
- N6 (чужой ресурс / SSRF): Given RSS-источник `http://127.0.0.1/feed`, `http://169.254.169.254/…` или домен, который резолвится в частный адрес, или публичный URL с редиректом на частный адрес When сбор Then запрос не выполняется (`UnsafeURLError`), источник в отчёте о сбоях, остальные источники собираются.
- N7: Given RSS-источник владельца с `${VAR}` в URL When сбор Then работает как раньше (раскрытие в `rss.py` не ломается от `safe_request`).

## Scope

- Change:
  - `src/users/__init__.py` — модели белого списка для не-владельцев (pydantic, `extra="forbid"`), лимит 20, принудительно выключенный HN.
  - `src/scrapers/rss.py` — хирургически: `self.client.get(...)` → `safe_request(self.client, "GET", ...)`, без `follow_redirects=True` (редиректы проверяет `safe_request`).
  - `tests/test_users.py` — новые тесты на AC/N.
  - `tests/test_rss.py`, `tests/test_rss_request_headers.py`, `tests/test_extractors_firecrawl.py`, `tests/test_extractors_outcrawl.py`, `tests/test_fetch_reporting.py` — **существующие тесты** (три последних согласованы вами при утверждении плана): только заглушка DNS (`src.url_security._resolve_hostname` → публичный адрес, как в `tests/test_webhook.py:1622`), assert'ы не меняются; ваше «ок» дано при уточнении («правка моков в тестах»). Новые тесты N6/N7 — в отдельном файле или в конце `tests/test_rss.py`.
  - `tests/conftest.py` — общая не-autouse фикстура `public_dns`, файлы выше подключают её через `pytestmark` (вместо пяти копий фикстуры; добавлено по ходу).
  - `data/config.github.json` — `profile_settings.ai-creator.threshold: 7.0`; `data/config.json` (локальный, в `.gitignore`) — копия.
  - `.github/workflows/users-digest.yml` — `GITHUB_TOKEN` в env шага «Run Horizon for user».
  - `docs/multi-user.md` — разрешённые поля, лимит, HN.
- Do NOT touch: `src/models.py`, `src/url_security.py` (только переиспользовать), `src/orchestrator.py`, `src/main.py`, остальные скрейперы, `data/config.example.json`, `data/users/612722019.json`, `daily-summary.yml`, остальные существующие тесты.
- Pattern: `UserConfig` с `extra="forbid"` и `load_user` (`src/users/__init__.py`); `safe_request` в `src/extractors/trafilatura.py`; заглушка DNS — `tests/test_webhook.py:1622`; тесты пользователей — `write_user` + `monkeypatch.setenv("HORIZON_OWNER_ID", …)`.

## Plan

1. `tests/test_users.py`: тесты AC 1–3, N1–N5 (сначала красные).
2. `src/users/__init__.py`: приватные модели `_UserRSS`, `_UserTelegram(Channel)`, `_UserReddit(Subreddit/User)`, `_UserGitHub` (`type: Literal[...]`, проверка `owner`+`repo` / `username`), `_UserSources` — все `extra="forbid"`. В `load_user` для не-владельца: `sources` валидируются этими моделями, считается сумма источников (> 20 → `ConfigError`), в итоговый dict добавляется `"hackernews": {"enabled": false}`; дальше `UserConfig.model_validate` как сейчас. Владелец — без изменений.
3. `src/scrapers/rss.py`: импорт `safe_request`, вызов `safe_request(self.client, "GET", feed_url, headers=...)` вместо `self.client.get(..., follow_redirects=True, ...)`.
4. Заглушка DNS (autouse-фикстура: IP-литералы — как есть, имена — публичный адрес) в `tests/test_rss.py`, `tests/test_rss_request_headers.py` (+ ещё три файла, если согласуете). Новый `tests/test_rss_safety.py`: N6 (литералы, частный DNS, редирект на частный адрес через `httpx.MockTransport`), N7 (`${VAR}` в URL владельца), AC 4.
5. `data/config.github.json`: `ai-creator.threshold: 7.0`; `cp` в `data/config.json`.
6. `users-digest.yml`: `GITHUB_TOKEN` в env шага «Run Horizon for user»; `check-jsonschema`.
7. `docs/multi-user.md`: разрешённые поля, лимит, HN.
8. `uv run pytest`, `/verify`, `/review-diff`.

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| 1 | `tests/test_users.py::test_non_owner_allowed_sources_load_without_hackernews` (RSS, канал, сабреддит, Reddit-пользователь, оба типа GitHub; HN выключен) | PASS |
| 2 | `::test_non_owner_sources_keep_hackernews_off`; пример из `docs/multi-user.md` через `load_user` → `['Simon Willison'] hn False` | PASS |
| 3 | `::test_owner_sources_are_not_restricted` (Twitter, `profile`, `content_extractor`, HN у владельца) | PASS |
| 4 | `tests/test_rss_safety.py` (публичный источник собирается), существующие `tests/test_rss.py`, `tests/test_rss_request_headers.py` (в т.ч. `User-Agent`) зелёные; они же с отключённым DNS (`-p no_dns`) → 183 passed | PASS |
| 5 | `Config.model_validate(config.github.json)` → `ai-creator threshold: 7.0`; `cmp data/config.json data/config.github.json` → совпадают | PASS |
| 6 | `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` в шаге «Run Horizon for user»; `uvx check-jsonschema --builtin-schema vendor.github-workflows` → ok | PASS |
| 7 | `docs/multi-user.md`: таблица разрешённых полей, лимит 20, HN выключен, `safe_request` | PASS |
| 8 | `uv run pytest` → 1043 passed | PASS |
| N1 | `::test_non_owner_sources_reject_fields_outside_allowlist[twitter apify_token_env / cookie_dir]`; CLI `uv run horizon --data-dir <tmp> --user 111` с `twitter.apify_token_env` → `Invalid user config …/111.json`, exit 1; в matrix битый файл падает отдельно (`::test_due_users_keeps_broken_files_so_their_job_fails`) | PASS |
| N2 | `::test_non_owner_sources_reject_fields_outside_allowlist` — `profile`, `category`, `content_extractor`, `fetch_limit`, `min_score`, `fetch_comments` | PASS |
| N3 | то же — `hackernews` (true и false), `google_news`, `gdelt`, `openbb`, `ossinsight` | PASS |
| N4 | то же — `org_events`, `repo_releases` без `repo`, `user_events` без `username` | PASS |
| N5 | `::test_non_owner_source_limit` (20 — грузится, 21 — `ConfigError` с «20») | PASS |
| N6 | `tests/test_rss_safety.py::test_rss_never_requests_private_destinations`: `127.0.0.1`, `169.254.169.254`, домен с частным IP, редирект на частный адрес — запросов к ним нет, в `failures` `UnsafeURLError`, публичный источник собран; до правки `rss.py` тест падал | PASS |
| N7 | `::test_rss_still_expands_env_vars_in_feed_url` | PASS |
| review r1 (2026-11-08) | reviewer | BLOCK: имена (`channel`, `subreddit`, `username`, `owner`, `repo`) без проверки формата подставлялись в URL (`github.py:78`, `:173`, `telegram.py:54`, `reddit.py:86`) — исправлено `pattern` в моделях; `conftest.py` внесён в Scope |
| Review r1 FINDING (формат имён) | `::test_non_owner_source_names_must_be_plain_identifiers` (8 случаев: `../`, `?`, `#`, `..`, пустые; падали до правки); `uv run pytest` → 1051 passed | PASS |
| review r2 (2026-11-08) | reviewer | PASS |

## Knowledge

- Dead ends: none
- Decisions: none — задача реализует последствие из [ADR 0002](../docs/decisions/0002-owner-only-env-expansion.md) (поля, читающие секреты и файлы по имени, ограничиваются отдельно); новых архитектурных решений нет.
- Known issues: пользователь без ключа `sources` наследует источники базового конфига как есть (без белого списка и без принудительного выключения HN). Сейчас база без источников и с выключенным HN, поэтому это безопасно; если в базу вернуть источники, они достанутся всем таким пользователям.
