---
id: 004
size: M
status: in-progress
reopened: false
---

# Каркас Telegram-бота на Cloudflare Worker: вебхук, онбординг с одобрением, деплой (#11)

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

## Решения по открытым вопросам (2026-11-08)

1. Окно новых пользователей — 6 ч: файл `{"id": <id>, "time_window_hours": 6}`.
2. `setWebhook` — шаг деплой-workflow после `wrangler deploy` (`url`, `secret_token`, `allowed_updates: ["message", "callback_query"]`).
3. Заявка владельцу: имя (first + last), `@username` (если есть), ID, ссылка `tg://user?id=<id>`.
4. Коммиты бота: `author`/`committer` = `Gorizont bot <bot@users.noreply.github.com>`.
5. Worker `gorizont-bot` на `workers.dev`, без своего домена.
6. `users-digest.yml` не включаем и не меняем; #13 отдельно.
7. Секреты Worker (`TELEGRAM_BOT_TOKEN`, `WEBHOOK_SECRET`, `GITHUB_TOKEN`) — из секретов репо (`TELEGRAM_BOT_TOKEN`, `BOT_WEBHOOK_SECRET`, `BOT_GITHUB_TOKEN`) через `wrangler deploy --secrets-file` (временный файл в `$RUNNER_TEMP`).
8. KV — создаётся владельцем разово (`npx wrangler kv namespace create gorizont-bot`), `id` кладётся в `wrangler.jsonc`.
9. URL Worker для `setWebhook` — переменная репо `vars.BOT_URL`.
10. Коммит-черновик 0f49817 остаётся.

## Acceptance criteria

1. Given незнакомый пользователь When пишет `/start` Then ему ответ «заявка отправлена», владельцу — сообщение (имя, `@username`, ID, ссылка `tg://user?id=`) и кнопки «Одобрить / Отклонить».
2. Given заявка When владелец жмёт «Одобрить» Then в `main` появляется `data/users/<id>.json` = `{"id": <id>, "time_window_hours": 6}` от «Gorizont bot», пользователю — «доступ открыт» и список команд, сообщение владельца меняется на «одобрено»; файл проходит `load_user` на Python-стороне.
3. Given заявка When владелец жмёт «Отклонить» Then пользователю — отказ, в KV запись об отказе; повторные `/start` не беспокоят владельца.
4. Given заявка ожидает решения When тот же человек снова пишет `/start` в течение 24 ч Then владельцу второе уведомление не приходит.
5. Given пользователь уже есть (`data/users/<id>.json` существует) When `/start` Then приветствие и `/help`, без заявки.
6. Given `/help` When отправлен Then список команд (в 004 — только `/start`, `/help`).
7. Given пуш в `bot/**` When `bot-deploy.yml` Then `npm ci`, тесты, `wrangler deploy --secrets-file` и `setWebhook` проходят; `docs/telegram-bot.md` описывает настройку (Cloudflare-токен, KV, секреты и `BOT_URL` в репо, PAT). Реальный прогон зависит от действий владельца (аккаунт, KV id, секреты) — без них AC7 помечается NOT VERIFIED, проверяется `check-jsonschema` (vendor.github-workflows).
8. Given `bot/` When `npm test` и `npx tsc --noEmit` Then зелёные; `uv run pytest` в корне не меняется.

## Negative scenarios

- N1 (доступ): запрос без заголовка `X-Telegram-Bot-Api-Secret-Token` или с неверным → 401, ничего не обрабатывается.
- N2 (чужой ресурс): `callback_query` «Одобрить» не от владельца → отказ, файл не создаётся.
- N3 (валидация ввода): `callback_data` вида `approve:abc`, `approve:../x`, `approve:0` → отказ, файл не создаётся.
- N4: одобрение ID, у которого файл уже есть → файл не перезаписывается (Contents API без `sha` → 422 трактуется как «уже одобрен»).
- N5: апдейт без `message`/`callback_query` или битый JSON → 200 без действий (иначе Telegram будет повторять).
- N6: GitHub API упал → владельцу сообщение об ошибке, заявка остаётся в KV для повтора, Telegram получает 200.

## Scope

- Change: `bot/` (новый: `package.json`, `package-lock.json`, `tsconfig.json`, `wrangler.jsonc`, `worker-configuration.d.ts` (из `wrangler types`), `src/*.ts`, `test/*.test.ts`), `.github/workflows/bot-deploy.yml` (новый), `docs/telegram-bot.md` (новый), `.gitignore` (`bot/node_modules/`, `bot/.wrangler/`).
- Do NOT touch: `src/`, `tests/`, `data/` (кроме того, что пишет бот в рантайме), существующие workflow, `docs/configuration.md`, `README*`.
- Pattern: модели и ограничения файла пользователя — `src/users/__init__.py` (`UserConfig`, `_UserSources`, `MAX_USER_SOURCES`); формат — `docs/multi-user.md`; отправка в Telegram — `src/services/webhook.py`.

## Plan

Утверждён 2026-11-08 (полная версия — `~/.claude/plans/dreamy-weaving-rabbit.md`). Доп. решения: на прочий текст — подсказка `/help`, не-личные чаты игнорируются; `id` KV владелец пришлёт по ходу.

1. `bot/` каркас: `package.json` (точные dev-версии), `tsconfig.json`, `wrangler.jsonc`, `wrangler types` → `worker-configuration.d.ts`, `src/env.d.ts` (секреты) → verify: `npm run typecheck`.
2. `src/telegram.ts`, `src/github.ts` (GET/PUT Contents API, 422 → exists, committer Gorizont bot) + `test/github.test.ts`.
3. `src/bot.ts` (сценарии AC1–6, N2–N4, N6; KV `pending:<id>` TTL 24 ч, `rejected:<id>`) + `test/bot.test.ts`.
4. `src/index.ts` (secret-заголовок → 401, битый JSON → 200, всё в try/catch → 200) + `test/index.test.ts`.
5. `.github/workflows/bot-deploy.yml` (тесты, `wrangler deploy --secrets-file`, `setWebhook`) → verify: check-jsonschema.
6. `docs/telegram-bot.md`, `.gitignore`.
7. Проверка: `npm test`, `typecheck`, `wrangler deploy --dry-run`, `load_user` на файле бота, `uv run pytest`; затем `/verify`, `/review-diff`.

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| AC1 | `bot/test/bot.test.ts` › «/start from a new user» › sends the request…, escapes HTML… (`npx vitest run --reporter=verbose`, 2026-11-08) | PASS (логика, фейковые Telegram/GitHub/KV) |
| AC2 | `bot.test.ts` › approve creates the user file…; `github.test.ts` › commits the user file as the bot without a sha (PUT, без `sha`, author/committer «Gorizont bot», content = `{"id":123,"time_window_hours":6}`); файл из `userFile()` → `load_user` в scratchpad: `id=123456789 chat_id=None time_window_hours=6 publish_site=False sources=None` | PASS (логика + Python-валидация) |
| AC3 | `bot.test.ts` › reject remembers the user and notifies them (`rejected:<id>` без TTL, повторный `/start` → владельцу 0 новых сообщений) | PASS |
| AC4 | `bot.test.ts` › does not notify the owner twice while the request is pending; TTL `pending` = 86400 в «sends the request…» | PASS |
| AC5 | `bot.test.ts` › greets an existing user without a request | PASS |
| AC6 | `bot.test.ts` › answers /help, /help@gorizont_bot, /help extra; points to /help on unknown text; ignores messages outside private chats | PASS |
| AC7 | `uvx check-jsonschema --builtin-schema vendor.github-workflows .github/workflows/bot-deploy.yml` → ok; `npx wrangler deploy --dry-run --outdir …` → бандл 10.03 KiB, биндинги KV/OWNER_ID/GITHUB_REPO; `wrangler deploy --help` содержит `--secrets-file`; `docs/telegram-bot.md` написан. KV id `eabf6e95…` прописан, `wrangler kv namespace list` подтверждает namespace `gorizont-bot` в аккаунте, dry-run видит `env.KV (eabf6e95…)`. Реальный прогон workflow не делался: секреты/`BOT_URL` не заданы, пуш не разрешён | NOT VERIFIED |
| AC8 | `npm test` → 42 passed; `npm run typecheck` → exit 0; `uv run pytest` → 1051 passed | PASS |
| N1 | `index.test.ts` › rejects secret null/""/wrong with 401 (fetch не вызывается); rejects non-POST (405); rejects everything when the Worker secret is unset (пустой секрет + пустой/нет заголовка → 401, добавлено по ревью). Мутации «убрать проверку секрета» и «убрать проверку пустого секрета» → тесты падают. `npm test` → 42 passed | PASS |
| N2 | `bot.test.ts` › refuses decisions from anyone but the owner. Мутация «убрать проверку владельца» → тест падает | PASS |
| N3 | `bot.test.ts` › refuses malformed callback data (abc, ../x, 0, пусто, «1 2», -5, delete:123, 17 цифр) | PASS |
| N4 | `github.test.ts` › 422 + файл есть → exists, 422 + файла нет → ошибка; `bot.test.ts` › does not overwrite or re-greet an existing user | PASS |
| N5 | `index.test.ts` › acknowledges `{not json`, `{}`, `null`, `{"edited_message":{}}` → 200 без вызовов fetch | PASS |
| N6 | `bot.test.ts` › keeps the request and tells the owner when GitHub fails; `index.test.ts` › acknowledges the update even when Telegram fails (200 + console.error) | PASS |
| review | reviewer (раунд 2; раунд 1 — BLOCK: пустой `WEBHOOK_SECRET`, исправлено) | PASS |
| E2E | Реальный сценарий `/start` → кнопка → коммит в `main` в Telegram | NOT VERIFIED (нужен деплой) |

## Knowledge

- Dead ends: none
- Decisions: ADR 0001 (оверлей), ADR 0002 (граница доверия: владелец только через workflow)
- Known issues: none
