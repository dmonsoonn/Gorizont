---
id: 007
size: M
status: in-progress
reopened: false
---

# Частота выпусков и чат доставки через бота: /window и /chat

## Goal

Одобренный пользователь сам выбирает в боте, как часто приходит дайджест (`/window`) и куда он приходит — в личный чат или в свой канал (`/chat`), а изменения попадают в его `data/users/<id>.json` в виде, который проходит `load_user`.

## Context (решения, уже принятые)

- Продолжение 005–006, цепочка та же: Telegram → Worker `gorizont-bot` → GitHub Contents API → `data/users/<id>.json`; запись через `editUser` (с `sha`, один повтор на 409). Python-сторона (`src/`) не меняется: `time_window_hours` и `chat_id` уже есть в `UserConfig`.
- Строгость (#16) — отдельная задача 008. Выбор времени суток выпуска не делается: расписание как сейчас, UTC-часы, кратные `time_window_hours`.
- **`/window`**: одно сообщение «Дайджест приходит раз в N ч.» и кнопки `3 ч`, `6 ч`, `12 ч`, `24 ч`; текущее значение отмечено `✓`. Нажатие пишет `time_window_hours` и перерисовывает сообщение (`editMessageText`), всплывающее «Сохранено». Кнопка с текущим значением коммита не делает. Значение вне списка (у владельца `1`, или ключа нет — по умолчанию `1`) показывается как есть, без `✓`.
- **`/chat`**: сообщение «Дайджест приходит: в личный чат» / «в канал <название или @имя>» / «задан в конфиге» (для `${VAR}`) и кнопки `[В канал]`, `[В личный чат]`.
  - «В личный чат» удаляет ключ `chat_id` (по умолчанию `chat_id` = `id`); если ключа нет — коммита нет.
  - «В канал» включает режим ожидания: KV `chat:<id>` на 10 минут, сообщение «Перешлите пост из канала или пришлите @имя / ссылку t.me/имя. Бот должен быть администратором канала с правом публикации.» с кнопкой `[Отмена]`.
  - В режиме ожидания следующее сообщение читается как канал, а не как источник: пересылка из канала (публичного или приватного), `@имя`, `t.me/имя`. Не канал (ссылка на сайт, текст, пересылка от человека или из группы) → «Это не канал…», ожидание продолжается. Любая команда (`/list`, `/help`, …) сбрасывает ожидание и выполняется как обычно. «Отмена» сбрасывает ожидание.
  - Канал резолвится через `getChat` (id, тип, название), id бота — через `getMe`. Проверка прав через `getChatMember`: бот — `administrator` с `can_post_messages`, пользователь — `creator` или `administrator`. Если нет — понятная причина («Бот не администратор канала…», «Вы не администратор этого канала», «Канал не найден»), коммита нет, ожидание продолжается.
  - Запись: всегда числовой id канала (`-100…`), и для публичного, и для приватного канала — смена username не ломает доставку. `/chat` показывает название канала через `getChat`, при ошибке — id. После записи ожидание снимается, ответ «Дайджест будет приходить в <канал>.». В канал ничего не публикуется.
- Владелец — как все: его `"${TELEGRAM_CHAT_ID}"` и `1 ч` показываются как есть и перезаписываются кнопками; вернуть их можно только правкой файла.
- Остальные поля файла (включая `${VAR}` у владельца в других полях и `sources`) не меняются, порядок ключей сохраняется.
- Коммиты: `chore(users): set window <N>h for <id> via bot`, `chore(users): set chat for <id> via bot`, `chore(users): reset chat for <id> via bot`, автор «Gorizont bot».
- `user id` в `callback_data` не кладётся: действие всегда над файлом `callback_query.from.id`.
- В `/help` добавляются `/window` и `/chat`; меню команд (`setMyCommands` в `bot-deploy.yml`) — тоже. Ожидаемый текст `/help` в тестах обновляется (изменение требований, как в 005–006).
- Документация: раздел в `docs/telegram-bot.md`; в `docs/multi-user.md` — что `chat_id` и `time_window_hours` меняются через бота.

## Acceptance criteria

1. Given одобренный пользователь с `time_window_hours: 6` When отправляет `/window` Then бот отвечает «Дайджест приходит раз в 6 ч.» с кнопками `3 ч`, `✓ 6 ч`, `12 ч`, `24 ч`.
2. Given сообщение `/window` When пользователь жмёт `12 ч` Then в файле `time_window_hours: 12` (один коммит `set window 12h`), остальные поля не изменились, сообщение показывает `✓ 12 ч`; повторное нажатие `12 ч` коммита не делает.
3. Given файл владельца (`time_window_hours: 1`, `chat_id: "${TELEGRAM_CHAT_ID}"`, `hackernews`, источники) When владелец отправляет `/window` и `/chat` Then видит «раз в 1 ч» без `✓` и «задан в конфиге»; When жмёт `24 ч` Then меняется только `time_window_hours`, `chat_id` и `sources` байт-в-байт прежние.
4. Given пользователь без `chat_id` When отправляет `/chat` Then «Дайджест приходит: в личный чат» и кнопки «В канал», «В личный чат»; «В личный чат» коммита не делает.
5. Given режим ожидания (после «В канал») When пользователь пересылает пост из публичного канала `@chan`, где бот — админ с правом публикации, а пользователь — создатель или админ Then в файле `"chat_id"` — числовой id канала (коммит `set chat`), ожидание снято, ответ «Дайджест будет приходить в канал «<название>».», в канал ничего не отправлено.
6. Given режим ожидания When пользователь пересылает пост из приватного канала (без username) с теми же правами Then в файле `chat_id` — числовой id канала.
7. Given режим ожидания When пользователь присылает `@chan` или `t.me/chan` Then результат как в AC5 (тот же `getChatMember`).
8. Given `chat_id` канала When пользователь жмёт «В личный чат» Then ключ `chat_id` удалён (коммит `reset chat`), сообщение показывает «в личный чат».
9. Given файлы, записанные в сценариях AC2, AC3, AC5, AC6, AC8 When их прогоняют через `load_user` и `apply_overlay` на Python-стороне Then ошибок нет, `request_body.chat_id` и `time_window_hours` — записанные значения; `due_users` ставит пользователя на часы, кратные новому окну.
10. Given `/help` When бот отвечает Then там есть `/window` и `/chat`; после деплоя меню «/» показывает `/start`, `/list`, `/window`, `/chat`, `/help`.
11. Given `bot/` When `npm test`, `npm run typecheck`, `npx wrangler deploy --dry-run` Then зелёные; `uv run pytest` не меняется; после пуша `bot-deploy.yml` зелёный, в живом боте от владельца проходят `/window` и `/chat` (канал и возврат в личный чат).

## Negative scenarios

- N1 (доступ): пользователь без файла в `data/users/` отправляет `/window`, `/chat` или жмёт их кнопки → «Сначала подключитесь к Горизонту: /start.», в GitHub ничего не пишется, режим ожидания не включается.
- N2 (чужой ресурс, канал): пользователь указывает канал, где он не создатель и не админ (даже если бот там админ) → «Вы не администратор этого канала», коммита нет.
- N3 (права бота): бот не в канале, не админ или админ без `can_post_messages` → «Бот не администратор канала…», коммита нет; канал не существует / `getChatMember` вернул ошибку → «Канал не найден…», коммита нет.
- N4 (чужой ресурс, кнопки): кнопка `/window` или `/chat`, нажатая не тем, кому адресовано сообщение, меняет только файл нажавшего.
- N5 (валидация ввода): `callback_data` не по формату (окно не из 3/6/12/24, неизвестное действие, лишние символы) → «Некорректная кнопка.», в GitHub ничего не пишется. Ввод канала с `${`, невалидным именем или длиннее лимита → «Это не канал…», без вызовов GitHub.
- N6 (ожидание): в режиме ожидания ссылка на сайт или текст не добавляются как источник, а получают «Это не канал…»; команда сбрасывает ожидание и выполняется; после «Отмена» или истечения 10 минут пересылка снова добавляет источник, как в 005.
- N7: два конфликта записи подряд (409) или ошибка GitHub → «Не удалось сохранить, попробуйте ещё раз», файл не испорчен.

## Scope

- Change: `bot/src/bot.ts` (`/window`, `/chat`, режим ожидания, обработчики кнопок, `/help`), `bot/src/sources.ts` или новый модуль `bot/src/settings.ts` (разбор канала, правка `time_window_hours`/`chat_id`), `bot/src/telegram.ts` (возврат результата вызова для `getChatMember`), `bot/src/index.ts` (id бота, если понадобится), `bot/test/`, `.github/workflows/bot-deploy.yml` (меню команд), `docs/telegram-bot.md`, `docs/multi-user.md`.
- Do NOT touch: `src/`, `tests/`, `data/` (кроме того, что пишет бот в рантайме), остальные workflow, `README*`, онбординг из 004 (текст «Доступ открыт…» остаётся), добавление источников из 005 и `/list` из 006 (кроме перехвата сообщения в режиме ожидания).
- Pattern: `/list` и `manageSource`/`applyAction`/`editMessage` в `bot/src/bot.ts` (кнопки над файлом `from.id`, рендер в одном сообщении, проглатывание «message is not modified»); `feedsKey` + `FEEDS_TTL_SECONDS` (KV-состояние с TTL); `parseInput` с `ForwardOrigin` и `CHANNEL` в `bot/src/sources.ts`; фейковые Telegram/GitHub/KV в `bot/test/bot.test.ts`; шаг `Set Telegram commands` в `bot-deploy.yml`.

## Plan

1. `bot/src/telegram.ts`: `call` возвращает `result.result` (`Promise<unknown>`).
2. `bot/src/sources.ts`: `ForwardOrigin.chat` получает `id?`, `title?`.
3. `bot/src/settings.ts` (новый, чистые функции): `WINDOWS`, `windowOf`, `setWindow`, `setChat`, `resetChat`, `chatTarget`, `parseChannel` (текст разбирается существующим `parseInput`).
4. `bot/src/bot.ts`: `/window`, `/chat`, колбэки `win:N` и `chat:channel|private|cancel`, режим ожидания `chat:<id>` (10 мин) в `handleMessage`, `pickChannel` → `verifyChannel` (`getChat` → `getMe` → `getChatMember` бота и пользователя) → `editUser(setChat)`; `/help`.
5. Тесты: фейковые `getMe`/`getChat`/`getChatMember` в `setup()`, сценарии AC1–AC8 и N1–N7 в `bot/test/bot.test.ts`, `bot/test/settings.test.ts`.
6. `bot-deploy.yml` (меню команд), `docs/telegram-bot.md`, `docs/multi-user.md`.
7. Проверка: `npm test`, `npm run typecheck`, `npx wrangler deploy --dry-run`, `uv run pytest`, AC9 — скрипт `load_user`/`apply_overlay`/`due_users` на файлах в scratchpad.

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| 1 | `bot/test/bot.test.ts` › digest settings › /window › shows the current window with a check mark; `npm test` | PASS |
| 2 | `bot/test/bot.test.ts` › digest settings › /window › saves a new window once and redraws the message (один коммит `set window 12h`, второй клик без коммита, `✓ 12 ч`) | PASS |
| 3 | `bot/test/bot.test.ts` › digest settings › owner's file › shows the window and the chat as they are and changes only the window (сравнение `JSON.stringify` — байты и порядок ключей) | PASS |
| 4 | `bot/test/bot.test.ts` › digest settings › /chat › shows the private chat and does not commit when it is already there | PASS |
| 5 | `bot/test/bot.test.ts` › digest settings › /chat › saves the numeric id of a public channel forward (KV TTL 600, подсказка с «Отмена», `chat_id` = id, ключ снят, в канал ничего не отправлено) | PASS |
| 6 | `bot/test/bot.test.ts` › digest settings › /chat › saves the numeric id of a private channel forward | PASS |
| 7 | `bot/test/bot.test.ts` › digest settings › /chat › saves the numeric id of @name / t.me/name / a t.me link; `bot/test/settings.test.ts` › parseChannel | PASS |
| 8 | `bot/test/bot.test.ts` › digest settings › /chat › shows the channel title and switches back to the private chat; shows the id when the channel title is unavailable | PASS |
| 9 | `uv run python <scratchpad>/ac9.py`: файлы как пишет бот → `load_user` + `apply_overlay` + `due_users`: окна 12/24/6, `request_body.chat_id` = -100… / id / `${TELEGRAM_CHAT_ID}`→555; час 6 и 18 — только окно 6, час 12 — без окна 24 (перепрогнано 2026-11-10, exit 0) | PASS |
| 10 | `/help` — тест messages › answers /help…; меню — `bot-deploy.yml` (YAML валиден, `ruby -ryaml`, добавлены `window` и `chat`). Меню в живом боте после деплоя не проверено | PASS (help) / NOT VERIFIED (меню после деплоя) |
| 11 | `npm test` 294 passed, `npm run typecheck` exit 0, `npx wrangler deploy --dry-run` ок, `uv run pytest` 1052 passed (перепрогнано 2026-11-10). Пуш, `bot-deploy.yml` и живой бот — не сделаны (ждут пуша и проверки владельцем) | PASS (локально) / NOT VERIFIED (CI, живой бот) |
| N1 | `bot/test/bot.test.ts` › digest settings › refusals › asks a stranger to /start first (ни записи, ни KV) | PASS |
| N2 | `bot/test/bot.test.ts` › digest settings › refusals › refuses the channel when the user is not an admin | PASS |
| N3 | `bot/test/bot.test.ts` › digest settings › refusals › refuses the channel when the bot is a member / cannot post / is not in the channel; refuses an unknown channel and a group | PASS |
| N4 | `bot/test/bot.test.ts` › digest settings › refusals › changes only the presser's file | PASS |
| N5 | `bot/test/bot.test.ts` › digest settings › refusals › refuses malformed button data (8 вариантов); answers … with 'not a channel' without network calls (6 вариантов); `settings.test.ts` › parseChannel › rejects | PASS |
| N6 | `bot/test/bot.test.ts` › digest settings › refusals › 'not a channel' для сайта и текста, forward from a user / a group, drops the waiting state on a command, adds sources again after cancel. Истечение 10 мин = отсутствие ключа (TTL 600 проверен в AC5), путь тот же, что после «Отмены» | PASS |
| N7 | `bot/test/bot.test.ts` › digest settings › refusals › reports a failed save after two conflicts / a GitHub error (файл не изменён, ожидание остаётся) | PASS |
| review | reviewer | PASS |

## Knowledge

- Dead ends: none
- Decisions: none
- Known issues: права в канале проверяются только при выборе; если бота позже разжалуют, выпуск упадёт при отправке (сообщение об ошибке — #5).
