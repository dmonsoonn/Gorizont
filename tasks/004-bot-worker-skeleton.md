---
id: 004
size: M
status: in-progress
reopened: false
---

# Каркас Telegram-бота на Cloudflare Worker: вебхук, онбординг с одобрением, деплой (#11)

> Черновик. Перед кодом: задать «Открытые вопросы» через AskUserQuestion, обновить AC/Scope по ответам, получить «ок», записать путь в `.claude/state/active-task`, выполнить `kit-log.sh task_created`.

## Goal

Новый человек пишет боту `/start`, владелец одобряет заявку кнопкой, и у человека появляется `data/users/<id>.json` — без ручных коммитов.

## Context (решения, уже принятые)

- Цепочка: Telegram → webhook → Cloudflare Worker (TS, каталог `bot/`) → коммит `data/users/<id>.json` через GitHub Contents API → `users-digest.yml` раз в час собирает и шлёт дайджест тем же ботом в личку.
- Тот же бот, что шлёт дайджесты (токен сейчас внутри секрета `HORIZON_WEBHOOK_URL`). У бота не должно быть другого webhook.
- Зависимости в `bot/package.json` — только dev: `wrangler`, `typescript`, `vitest`. Bot API и GitHub API — чистым `fetch`, без фреймворков. Версии пинить точные, опубликованные не позже чем за 2 недели (на 2026-11-08 свежайшие: wrangler 4.158.0 от 11-05, typescript 7.0.2 от 11-08, vitest 5.1.0 от 11-02 — брать более ранние).
- Тесты — обычный `vitest` на чистых модулях с внедрённым `fetch` и фейковым KV; `@cloudflare/vitest-plugin` не согласован (по Context7 его API менялся: `SELF` → `exports` из `cloudflare:workers`).
- Доступ: заявка → владельцу сообщение с кнопками «Одобрить / Отклонить» (`callback_data`); повторная заявка не чаще раза в 24 ч (Workers KV, TTL); отклонённые запоминаются навсегда.
- При одобрении создаётся файл `{"id": <id>}`: `chat_id` по умолчанию = личка, `publish_site` = false, `sources` нет → базовые (их нет) → пустой дайджест, пока человек не добавит источники (это задача 005).
- Запись в репо — fine-grained PAT только на `dmonsoonn/Gorizont`, право `Contents: Read and write` (без `Workflows`: иначе ломается граница доверия из ADR 0002). Хранится секретом Worker.
- Вебхук защищён `secret_token` (заголовок `X-Telegram-Bot-Api-Secret-Token`).
- Владелец: `OWNER_ID = 612722019` (переменная Worker).
- Деплой: GitHub Actions при пуше в `bot/**` (+ `workflow_dispatch`), `wrangler deploy`; в репо нужны секреты `CLOUDFLARE_API_TOKEN` (шаблон «Edit Cloudflare Workers») и `CLOUDFLARE_ACCOUNT_ID`. Аккаунт Cloudflare у владельца есть.
- Python-сторона готова: `${VAR}` только у владельца (002, ADR 0002), белый список полей источников, лимит 20, HN выключен, RSS через `safe_request` (003). Worker должен писать файлы, которые проходят эти проверки.
- Сообщения бота — на русском.
- Важно: все workflow в репо сейчас выключены вручную (`disabled_manually`) — без включения `users-digest.yml` дайджесты не придут никому.

## Открытые вопросы (задать до кода)

1. Окно по умолчанию для новых пользователей: писать в файл `time_window_hours` (например 24) или оставить дефолт 1 ч (каждый пользователь — прогон каждый час на общих ключах Groq, см. #13)?
2. `setWebhook`: шаг в деплой-workflow или разовая команда из документации?
3. Что показывать владельцу в заявке: имя, `@username`, ссылка на профиль, ID?
4. От чьего имени коммиты бота (PAT владельца → автор владелец; можно задать `committer` в Contents API, например «Gorizont bot»)?
5. Имя Worker и URL (`<name>.<account>.workers.dev`) — ок или свой домен?
6. Включать ли `users-digest.yml` в рамках задачи (и лимит #13 — `concurrency`)?

## Acceptance criteria (черновик)

1. Given незнакомый пользователь When пишет `/start` Then ему ответ «заявка отправлена», владельцу — сообщение с данными заявителя и кнопками «Одобрить / Отклонить».
2. Given заявка When владелец жмёт «Одобрить» Then в `main` появляется `data/users/<id>.json` (`{"id": <id>}` + решения по вопросам), пользователю — «доступ открыт» и список команд, сообщение владельца меняется на «одобрено»; файл проходит `load_user` на Python-стороне.
3. Given заявка When владелец жмёт «Отклонить» Then пользователю — отказ, в KV запись об отказе; повторные `/start` не беспокоят владельца.
4. Given заявка ожидает решения When тот же человек снова пишет `/start` в течение 24 ч Then владельцу второе уведомление не приходит.
5. Given пользователь уже есть (`data/users/<id>.json` существует) When `/start` Then приветствие и `/help`, без заявки.
6. Given `/help` When отправлен Then список команд (в 004 — только `/start`, `/help`).
7. Given пуш в `bot/**` When workflow Then `wrangler deploy` проходит; `docs/telegram-bot.md` описывает настройку (аккаунт, токены, секреты, KV, вебхук).
8. Given `bot/` When `npm test` и `npx tsc --noEmit` Then зелёные; `uv run pytest` в корне не меняется.

## Negative scenarios (черновик)

- N1 (доступ): запрос без заголовка `X-Telegram-Bot-Api-Secret-Token` или с неверным → 401, ничего не обрабатывается.
- N2 (чужой ресурс): `callback_query` «Одобрить» не от владельца → отказ, файл не создаётся.
- N3 (валидация ввода): `callback_data` вида `approve:abc`, `approve:../x`, `approve:0` → отказ, файл не создаётся.
- N4: одобрение ID, у которого файл уже есть → файл не перезаписывается (Contents API без `sha` → 422 трактуется как «уже одобрен»).
- N5: апдейт без `message`/`callback_query` или битый JSON → 200 без действий (иначе Telegram будет повторять).
- N6: GitHub API упал → владельцу сообщение об ошибке, заявка остаётся в KV для повтора, Telegram получает 200.

## Scope (черновик)

- Change: `bot/` (новый: `package.json`, `package-lock.json`, `tsconfig.json`, `wrangler.jsonc`, `src/*.ts`, `test/*.test.ts`), `.github/workflows/bot-deploy.yml` (новый), `docs/telegram-bot.md` (новый), `.gitignore` (`bot/node_modules/`, `bot/.wrangler/`).
- Do NOT touch: `src/`, `tests/`, `data/` (кроме того, что пишет бот в рантайме), существующие workflow (если вопрос 6 не решён иначе), `docs/configuration.md`, `README*`.
- Pattern: модели и ограничения файла пользователя — `src/users/__init__.py` (`UserConfig`, `_UserSources`, `MAX_USER_SOURCES`); формат — `docs/multi-user.md`; отправка в Telegram — `src/services/webhook.py`.

## Plan

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|

## Knowledge

- Dead ends: none
- Decisions: ADR 0001 (оверлей), ADR 0002 (граница доверия: владелец только через workflow)
- Known issues: none
