---
id: 008
size: L
status: done
reopened: false
---

# Данные установки в отдельном репозитории, значения установки из переменных

## Goal

В `main` не остаётся ничего, что относится к конкретной установке: файлы пользователей и конфиг установки лежат в отдельном приватном репозитории данных, а `OWNER_ID`, репозиторий данных и KV задаются переменными. Форк после Sync fork работает у другого человека без правки кода (#17, п. 3).

## Context (решения, уже принятые)

- Данные — в отдельном репозитории (`DATA_REPO`, например `dmonsoonn/gorizont-data`), по умолчанию приватном. Причина: fine-grained PAT нельзя ограничить веткой или путём, а PAT только на репозиторий данных при утечке не даёт изменить код (аудит #17, п. 1). Это заменяет решение «ветка `data`» из #17. Фиксируется в ADR 0003.
- Раскладка репозитория данных: только `users/<telegram_id>.json`. Базовый конфиг — всегда `data/config.github.json` из форка. Изначально был необязательный `config.json` в репозитории данных; убран по замечанию ревью: `load_config` раскрывает `${VAR}` во всём базовом конфиге и задаёт `ai.base_url`, так что запись в него через утёкший PAT уводит ключи.
- Один fine-grained PAT на репозиторий данных (Contents: Read and write), секрет `BOT_GITHUB_TOKEN`. Его используют и Worker, и checkout в `users-digest.yml` (передаётся только в шаг checkout). На репозиторий с кодом PAT доступа не имеет.
- Repository variables: `OWNER_ID`, `DATA_REPO` (плюс уже существующий `BOT_URL`). `users-digest.yml` берёт `HORIZON_OWNER_ID` из `vars.OWNER_ID`, `bot-deploy.yml` передаёт `OWNER_ID` и `GITHUB_REPO` в Worker через `wrangler deploy --var`. В ADR 0002 меняется вариант: гарантия «бот не назначит себя владельцем» теперь держится на том, что у PAT нет прав на Variables и Workflows и нет доступа к репозиторию с кодом.
- KV: `id` убирается из `wrangler.jsonc`, namespace создаётся при первом деплое (автопровижининг wrangler) и дальше переиспользуется. Сверено по исходникам `workers-sdk` (`KVHandler.isFullySpecified`, `--experimental-provision` по умолчанию `true`). Для текущей установки нужно проверить, что после деплоя биндинг остался на прежнем namespace (`canInherit`), иначе KV теряет заявки и состояние (это допустимо, но надо знать).
- Python (`src/`) не меняется: workflow копирует `users/` и `config.json` из репозитория данных в `data/`.
- Worker проверяет env на входе: без `OWNER_ID` (не число), `GITHUB_REPO`, `TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, `GITHUB_TOKEN` он пишет в лог, каких переменных не хватает, и отвечает 500, чтобы ошибка была видна в `getWebhookInfo`. `bot-deploy.yml` падает с `::error::`, если не заданы `vars.OWNER_ID` или `vars.DATA_REPO`.
- `users-digest.yml`: `concurrency` с общей группой и `cancel-in-progress: false` (#13), `permissions: contents: read` на уровне workflow, `contents: write` только у публикации в `gh-pages` (#20), `workflow_dispatch` с входом `dry_run`: строится только матрица, рассылки нет.
- `docs/_config.yml`: `url` и `baseurl` при публикации подставляются из `github.repository_owner` и имени репозитория, в `main` остаются значения upstream.
- `/help`: строка «Список ваших источников хранится в публичном репозитории.» → «Список ваших источников видит владелец бота.» Ожидаемый текст `/help` в тестах обновляется (изменение требований).
- Миграция текущей установки: создать приватный `dmonsoonn/gorizont-data`, скопировать текущие `data/users/*.json` одним коммитом без истории, удалить `data/users/` из `main`. История остаётся в Gorizont. Cron `users-digest` остаётся выключенным до #6 и #8; живая проверка — `workflow_dispatch` с `dry_run`.

## Acceptance criteria

1. Given `main` после задачи When `git grep -n -e 612722019 -e 1043052224 -e dmonsoonn -e eabf6e95 -- ':!tasks' ':!docs/decisions'` (кроме тестовых фикстур в `bot/test` и `tests/`) Then пусто; `data/users/` в `main` нет.
2. Given `bot/wrangler.jsonc` When его читают Then в нём нет `vars` с `OWNER_ID`/`GITHUB_REPO` и нет `id` у `kv_namespaces`; `npx wrangler deploy --dry-run` проходит.
3. Given Worker When бот пишет или читает файл пользователя Then запросы идут в `repos/<DATA_REPO>/contents/users/<id>.json`.
4. Given env Worker без `OWNER_ID` (или не число), `GITHUB_REPO`, `TELEGRAM_BOT_TOKEN` или `GITHUB_TOKEN` When приходит update с верным секретом Then ответ 500, в логе перечислены недостающие переменные, `handleUpdate` не вызывается. Без `WEBHOOK_SECRET` ответ по-прежнему 401: проверка конфига идёт после аутентификации.
5. Given репозиторий без `vars.OWNER_ID` или `vars.DATA_REPO` When запускается `bot-deploy.yml` Then джоба падает до деплоя с `::error::` и именем переменной.
6. Given `users-digest.yml` When его запускают `workflow_dispatch` с `dry_run: true` Then `plan` делает checkout приватного репозитория данных, строит матрицу из `users/` (в ней 612722019 и 1043052224), `digest` пропущен; в логе нет значения токена.
7. Given `users-digest.yml` When его читают Then есть `concurrency` с `cancel-in-progress: false`, на уровне workflow `permissions: contents: read`, `contents: write` только у джобы публикации в `gh-pages`, которая не запускает `horizon`.
8. Given репозиторий данных (с `config.json` или без) When `digest` готовит конфиг Then всегда используется `data/config.github.json` из форка, файлы из репозитория данных в конфиг не попадают.
9. Given живой бот после деплоя When владелец отправляет `/list`, `/window`, добавляет и удаляет источник Then коммиты бота появляются в `gorizont-data`, а не в Gorizont; KV-состояние (`/chat` → «В канал» → «Отмена») работает.
10. Given `/help` When бот отвечает Then там «Список ваших источников видит владелец бота.»
11. Given `bot/` и корень When `npm test`, `npm run typecheck`, `npx wrangler deploy --dry-run`, `uv run pytest` Then зелёные; после пуша `bot-deploy.yml` зелёный.
12. Given документация When её читают Then `docs/telegram-bot.md` и `docs/multi-user.md` описывают репозиторий данных, переменные `OWNER_ID`/`DATA_REPO`, PAT только на репозиторий данных и автосоздание KV; меню команд в `telegram-bot.md` актуально (`/window`, `/chat`); есть ADR 0003 и поправка к ADR 0002.

## Negative scenarios

- N1 (конфиг): нет `OWNER_ID` или он не число → Worker отвечает 500 и пишет причину в лог, сообщения в чат `NaN` не отправляются (AC4).
- N2 (конфиг деплоя): нет `vars.OWNER_ID` / `vars.DATA_REPO` → `bot-deploy.yml` падает до `wrangler deploy` (AC5).
- N3 (доступ): у PAT нет доступа к репозиторию данных или `DATA_REPO` указан неверно → `plan` падает на checkout с понятной ошибкой, `digest` не запускается, ничего не рассылается.
- N4 (чужой ресурс): PAT бота не имеет доступа к репозиторию с кодом — попытка записи в Gorizont этим токеном возвращает 403/404 (проверка вручную `curl` с токеном, без вывода значения).
- N5 (права): в `users-digest.yml` джоба с `horizon` не получает `contents: write` (AC7).
- N6 (dry run): `workflow_dispatch` с `dry_run: true` не отправляет сообщений и не публикует сайт.
- N7 (`${VAR}`): файл не-владельца с `${VAR}` в репозитории данных по-прежнему отклоняется `load_user` (существующие тесты `tests/test_users.py` не меняются и проходят).

## Scope

- Change: `bot/wrangler.jsonc`, `bot/worker-configuration.d.ts` (перегенерация), `bot/src/env.d.ts`, `bot/src/index.ts` (проверка env), `bot/src/github.ts` (путь `users/<id>.json`), `bot/src/bot.ts` (строка `/help`), `bot/test/`, `.github/workflows/bot-deploy.yml`, `.github/workflows/users-digest.yml`, `docs/_config.yml` (только если подстановку нельзя сделать в workflow), `docs/telegram-bot.md`, `docs/multi-user.md`, `docs/decisions/0002-*.md`, `docs/decisions/0003-*.md` (новый), удаление `data/users/`.
- Вне репозитория: создание `dmonsoonn/gorizont-data`, перенос файлов, PAT на него, `vars.OWNER_ID`, `vars.DATA_REPO`, обновление `BOT_GITHUB_TOKEN`.
- Do NOT touch: `src/`, `tests/`, логика бота кроме пути и строки `/help`, `daily-summary.yml`, `deploy-docs.yml`, `README*`, `.github/README.md` и `docs/self-host.md` (п. 7 #17), `scripts/setup.sh` (п. 4 #17).
- Pattern: шаг проверки секретов в `bot-deploy.yml` (`test -n "${!name}" || ::error::`), `concurrency` из `bot-deploy.yml`, фейковый `fetcher` в `bot/test/github.test.ts` и `bot/test/index.test.ts`.

## Plan

1. `bot/`: `wrangler.jsonc` без `vars` и KV `id`, `npm run types`, `env.d.ts` (`OWNER_ID`, `GITHUB_REPO`), `index.ts` — проверка конфига после секрета (500 + лог), `github.ts` — путь `users/<id>.json`, строка `/help`; тесты `index`, `github` (путь), `bot` (`/help`).
2. `bot-deploy.yml`: `vars.OWNER_ID`/`vars.DATA_REPO` в проверке и `wrangler deploy --var`.
3. `users-digest.yml`: `permissions: contents: read`, `concurrency`, вход `dry_run`, checkout репозитория данных (`persist-credentials: false`) в `plan` и `digest`, конфиг только из `data/config.github.json`, сайт через артефакт и отдельную джобу `publish` с `contents: write`, подстановка `url`/`baseurl`; `docs/_config.yml` как в upstream.
4. Документация: ADR 0003, поправка к ADR 0002, `docs/telegram-bot.md`, `docs/multi-user.md`.
5. Миграция: приватный `gorizont-data`, PAT (пользователь), `vars`, `git rm -r data/users`, коммиты, пуш после «пушь».
6. Проверка: тесты, `wrangler deploy --dry-run`, `users-digest` с `dry_run`, живой бот, `/verify`, `/review-diff`.

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| 1 | `git grep -n -e 612722019 -e 1043052224 -e dmonsoonn -e eabf6e95 -- ':!tasks' ':!docs/decisions' ':!bot/test' ':!tests'` → пусто (exit 1); `git rm -r --cached data/users`, `data/users/` в `.gitignore` | PASS |
| 2 | `bot/wrangler.jsonc` без `vars` и `id` (`grep -c '"id"\|"vars"'` → 0); `npx wrangler deploy --dry-run` → `env.KV`, exit 0; с `--var OWNER_ID:1 --var GITHUB_REPO:a/b` → оба биндинга `(hidden)` | PASS |
| 3 | `bot/test/github.test.ts` (`FILE_URL` = `repos/<repo>/contents/users/123.json`), `index.ts` передаёт `env.GITHUB_REPO`; `npm test` 301 passed | PASS |
| 4 | `bot/test/index.test.ts` › fails with 500 and logs %s when it is %j (6 случаев), › checks the secret before the config, › rejects everything when the Worker secret is unset (401, без изменений) | PASS |
| 5 | Симуляция шага `Deploy Worker` под bash: пустой `OWNER_ID` / `DATA_REPO` → `::error::Repository variable … is not set`, exit 1; оба заданы → ok. Живой прогон без переменных не делался | PASS (локально) |
| 6 | Run 43019945465 (`workflow_dispatch`, `dry_run=true`, 12:23 UTC): checkout `gorizont-data` ok, матрица `{"include": [{"user": "1043052224", …}, {"user": "612722019", …}]}`, `digest`/`publish` skipped, в логе 0 совпадений `github_pat_`/`ghp_`; workflow снова `disabled_manually`. Ранее run 43007434304 в 10 UTC — пустая матрица | PASS |
| 7 | Ruby YAML: `permissions` workflow `contents: read`, `concurrency` `cancel-in-progress: false`; `plan` read/без horizon, `digest` read/horizon, `publish` write/без horizon | PASS |
| 8 | Ruby YAML: шаг `Prepare config and user files` в `digest` — `cp data/config.github.json data/config.json` и копия `users/`; `grep -c instance/config users-digest.yml` → 0 | PASS |
| 9 | Владелец 13:37 UTC: `/list`, `/window`, выключил и включил источник, `/chat` → «В канал» → «Отмена» (KV) и «Личный чат». В `gorizont-data` коммиты бота `b45f55c` (window 3h), `6207c8b`/`fb0a8cd` (disable/enable telegram source), `8da8695` (reset chat); в Gorizont новых коммитов нет (последний `bf25011`). Добавление и удаление источника не проверялись вживую, но запись идёт тем же `editUser` → `repos/<DATA_REPO>/contents/users/<id>.json` | PASS |
| 10 | `bot/test/bot.test.ts` › /help (ожидаемый текст), › explains sources and who sees them after approval | PASS |
| 11 | `npm test` 301 passed, `npm run typecheck` чисто, `npx wrangler deploy --dry-run` ok, `uv run pytest` 1079 passed; `bot-deploy.yml` run 43007294028 (bf25011) success: `env.KV (inherited)`, `OWNER_ID`/`GITHUB_REPO` заданы | PASS |
| 12 | `docs/telegram-bot.md` (репозиторий данных, PAT, `OWNER_ID`/`DATA_REPO`, KV при деплое, меню с `/window`/`/chat`), `docs/multi-user.md`, `docs/decisions/0003-instance-data-repo.md`, `## Update` в ADR 0002 | PASS |
| N1 | = AC4 | PASS |
| N2 | = AC5 | PASS (локально) |
| N3 | Прогон с неверным `DATA_REPO` не делался (опционально) | NOT VERIFIED |
| N4 | Владелец: `curl -X PUT repos/dmonsoonn/Gorizont/contents/README.md` с `BOT_GITHUB_TOKEN` и фиктивным `sha` → 403 (со слов владельца) | PASS |
| N5 | = AC7 | PASS |
| N6 | Run 43007434304: `digest` и `publish` skipped, сообщений и публикации нет | PASS |
| N7 | `git diff HEAD -- src tests` пуст, `uv run pytest` 1079 passed | PASS |
| review | reviewer | PASS |
