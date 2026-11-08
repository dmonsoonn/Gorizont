---
id: 005
size: M
status: in-progress
reopened: false
---

# Добавление источников через бота: ссылка, @канал, пересылка, автопоиск RSS (#11)

## Goal

Одобренный пользователь присылает боту ссылку, `@канал` или пересылает пост из канала, и источник попадает в его `data/users/<id>.json` в виде, который проходит `load_user`, без ручных коммитов.

## Context (решения, уже принятые)

- Продолжение 004. Цепочка та же: Telegram → Worker `gorizont-bot` → GitHub Contents API → `data/users/<id>.json`.
- Работа по источникам разбита на две задачи: 005 — добавление (эта), 006 — `/list` с кнопками «Удалить» и «Вкл/выкл». `/window`, `/chat`, строгость (#16) сдвигаются в 007.
- Ввод без команды: любое сообщение одобренного пользователя, кроме команд, разбирается как источник. `/add` не вводим.
- Типы и формы ввода:
  - Telegram-канал: `t.me/<name>`, `t.me/<name>/<post>`, `t.me/s/<name>`, `telegram.me/…`, `@<name>`, пересылка из публичного канала (`forward_origin.type == "channel"` с `chat.username`) → `telegram.channels[].channel`.
  - Reddit: `reddit.com/r/<x>`, `r/<x>` → `reddit.subreddits[].subreddit`; `reddit.com/u/<x>`, `reddit.com/user/<x>`, `u/<x>` → `reddit.users[].username`.
  - GitHub: `github.com/<owner>/<repo>` → `{"type": "repo_releases", "owner", "repo"}`; `github.com/<user>` → `{"type": "user_events", "username"}`.
  - Любой другой `http(s)` URL → RSS.
- Проверка: Telegram, Reddit и GitHub только по формату (те же regex, что в `_UserSources`), без сетевых запросов. RSS по сети: если по ссылке RSS/Atom, берём её; иначе ищем `<link rel="alternate" type="application/rss+xml|atom+xml">` на странице. Один фид добавляется сразу. Если фидов несколько, бот показывает до 5 кнопок выбора, кандидаты лежат в KV `feeds:<userId>` 10 минут. Имя RSS — `<title>` фида без пробелов по краям, до 100 символов; если `<title>` пустой, берём hostname.
- Сеть для RSS: только `http`/`https`, таймаут 10 с, ответ до 1 МБ. Разбор регулярками, без DOM и `HTMLRewriter`, чтобы модули тестировались в обычном vitest.
- После добавления — ответ «Добавлено: …» и кнопка «Отменить», которая удаляет этот источник вторым коммитом. Кнопка ищет источник по его ключу, а не по индексу, и `user id` в `callback_data` не кладёт: действие всегда применяется к файлу `callback_query.from.id`.
- Лимит — 20 источников для всех, включая владельца; выключенные (`enabled: false`) тоже считаются, как в `_UserSources.count()`.
- Дубликат (тот же ключ: URL для RSS, имя канала/сабреддита/юзера без учёта регистра, `owner/repo` или `username` для GitHub) → «уже есть», без коммита.
- Файл правится точечно: бот меняет только нужный список, остальные поля и `${VAR}` (у владельца) остаются как были, порядок ключей сохраняется, формат — `JSON.stringify(…, null, 2)` + `\n`.
- Если блока `sources` нет, бот создаёт его с одним этим источником. В файле владельца в новый блок `sources` дополнительно пишется `"hackernews": {"enabled": false}`: без этого `SourcesConfig` включит HN по умолчанию (см. `docs/multi-user.md`).
- Запись — `PUT` с `sha`; на 409 бот один раз перечитывает файл и повторяет запись, при повторном конфликте сообщает об ошибке.
- Коммиты: `chore(users): add <type> source for <id> via bot` / `chore(users): remove <type> source for <id> via bot`, автор — «Gorizont bot», как в 004.
- Репо публичный: в приветствии после одобрения и в `/help` одна строка о том, что список источников хранится в публичном репозитории.
- Python-сторона (`src/`) не меняется.

## Acceptance criteria

1. Given одобренный пользователь When присылает `t.me/<name>`, `t.me/s/<name>`, `t.me/<name>/123`, `@<name>` или пересылает пост из публичного канала Then в файле появляется `{"channel": "<name>"}` в `sources.telegram.channels`, пользователю — «Добавлено: Telegram @<name>» и кнопка «Отменить».
2. Given одобренный пользователь When присылает `reddit.com/r/<x>`, `r/<x>`, `reddit.com/user/<x>` или `u/<x>` Then добавляется `{"subreddit": "<x>"}` или `{"username": "<x>"}` в соответствующий список.
3. Given одобренный пользователь When присылает `github.com/<owner>/<repo>` или `github.com/<user>` Then добавляется `repo_releases` с `owner`/`repo` или `user_events` с `username`.
4. Given URL, по которому отдаётся RSS или Atom When пользователь его присылает Then добавляется `{"name": <title>, "url": <url>}`, имя обрезано до 100 символов, при пустом `<title>` — hostname.
5. Given URL HTML-страницы с одним `<link rel="alternate">` на фид When пользователь её присылает Then добавляется этот фид (относительный `href` разрешается от URL страницы); Given фидов больше одного Then бот показывает кнопки (не больше 5), по нажатию добавляется выбранный.
6. Given источник только что добавлен When пользователь жмёт «Отменить» Then источник удаляется вторым коммитом, сообщение меняется на «Отменено».
7. Given у пользователя уже 20 источников (включая выключенные) When он присылает новый Then отказ «лимит 20», коммита нет.
8. Given такой источник уже есть When пользователь присылает его ещё раз (в том числе в другом регистре или другой формой ссылки) Then «уже есть», коммита нет.
9. Given файл владельца с `chat_id: "${TELEGRAM_CHAT_ID}"` и без `sources` When владелец добавляет источник Then `chat_id` и прочие поля не изменились, в `sources` есть новый источник и `"hackernews": {"enabled": false}`.
10. Given файлы, которые бот записал в сценариях AC1–AC5 и AC9 When их прогоняют через `load_user` на Python-стороне Then ошибок нет, `due` их включает.
11. Given `/help` или одобрение заявки When бот отвечает Then текст объясняет, как добавить источник, и предупреждает, что список хранится в публичном репозитории.
12. Given `bot/` When `npm test`, `npm run typecheck`, `wrangler deploy --dry-run` Then зелёные; `uv run pytest` не меняется; после пуша `bot-deploy.yml` зелёный, в живом боте добавление и отмена проходят от второго аккаунта.

## Negative scenarios

- N1 (доступ): пользователь без файла в `data/users/` присылает ссылку → «сначала /start», в GitHub ничего не пишется.
- N2 (чужой ресурс): «Отменить» или кнопка выбора фида, нажатая не тем, кому было адресовано сообщение (например, переслали сообщение с кнопкой), меняет только файл нажавшего; если у нажавшего такого источника или кандидатов нет — «кнопка устарела», коммита нет.
- N3 (валидация ввода): `t.me/+invite`, `t.me/joinchat/…`, `t.me/c/…`, канал короче 5 символов, `ftp://…`, `javascript:…`, URL длиннее 2048 символов, текст без ссылки → «Не понимаю. Список команд — /help.» (формы ввода — в `/help`), коммита нет.
- N4 (секреты): ввод, содержащий `${`, отклоняется: иначе `_reject_env_refs` сломает весь файл не-владельца.
- N5: пересылка от человека, из группы или из канала без `username` → объяснение, что подходят только публичные каналы.
- N6: RSS: таймаут, не-2xx, ответ больше 1 МБ, не фид и нет `<link rel="alternate">` → «фид не найден», коммита нет.
- N7: кнопка выбора фида после истечения 10 минут (KV пуст) → «выбор устарел, пришлите ссылку снова».
- N8: два конфликта записи подряд (409) → «не удалось сохранить, попробуйте ещё раз», файл не испорчен.

## Scope

- Change: `bot/src/` (новые модули разбора ввода и поиска фидов, правка файла пользователя; `bot.ts`, `github.ts` — чтение/запись с `sha`), `bot/test/`, `docs/telegram-bot.md` (команды и формы ввода).
- Do NOT touch: `src/`, `tests/`, `data/` (кроме того, что пишет бот в рантайме), workflow, `docs/multi-user.md`, `README*`, онбординг из 004 (кроме текстов `/help` и одобрения).
- Pattern: модули с внедрённым `fetch` и фейковым KV, как `bot/src/github.ts`, `bot/test/bot.test.ts`; ограничения полей — `_UserSources` в `src/users/__init__.py`.

## Plan

Утверждён 2026-11-08 (полная версия — `~/.claude/plans/purrfect-roaming-reddy.md`). Доп. решения: на нераспознанный ввод остаётся прежний ответ «Не понимаю. Список команд — /help.», формы ввода — в `/help`; ожидаемый текст `/help` в `test/bot.test.ts` обновляется вместе с AC11 (согласовано), фейковый GitHub в `setup()` дополняется `readUser`/`writeUser`.

1. `src/sources.ts`: разбор ввода, ключи, `addSource`/`removeSource`, `keyHash` + `test/sources.test.ts`.
2. `src/feeds.ts`: загрузка (10 с, 1 МБ), распознавание фида, `<link rel="alternate">`, до 5 кандидатов + `test/feeds.test.ts`.
3. `src/github.ts`: `readUser`/`writeUser` (sha, UTF-8 base64, 409 → conflict) + тесты.
4. `src/bot.ts`: добавление, «Отменить», выбор фида (KV `feeds:<id>`, 10 мин), `editUser` с одним повтором, тексты `/help` и одобрения + тесты.
5. `docs/telegram-bot.md`.
6. Проверка: `npm test`, `typecheck`, `wrangler deploy --dry-run`, `load_user`/`due_users` на файлах, записанных `addSource`, `uv run pytest`; затем `/verify`, `/review-diff`; пуш по разрешению, CI, живой E2E.

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| AC1 | `bot/test/bot.test.ts` «adds a Telegram channel with an undo button» (ссылка, `t.me/s/…/42`, `@`, пересылка, пересылка с `caption`), «treats a forwarded post starting with %s as its channel» (находка ревью, раунд 1); `test/sources.test.ts` «reads %s as a Telegram channel» | PASS |
| AC2 | `bot.test.ts` «adds r/rust», «adds /r/rust», «adds …reddit.com/user/spez»; `sources.test.ts` «reads %s» (7 форм Reddit) | PASS |
| AC3 | `bot.test.ts` «adds https://github.com/astral-sh/uv», «adds github.com/torvalds»; `sources.test.ts` (`.git`, хвост пути) | PASS |
| AC4 | `bot.test.ts` «adds a direct RSS feed with its title»; `test/feeds.test.ts` «takes a direct RSS link…», «reads an Atom title from CDATA», «normalizes the title…» (пусто → hostname, 100 символов, эмодзи, сущности) | PASS |
| AC5 | `bot.test.ts` «finds the only feed of a site», «offers a choice of feeds and adds the chosen one»; `feeds.test.ts` «follows the only feed link… relative href», «offers a choice…», «offers at most five feeds» | PASS |
| AC6 | `bot.test.ts` «undo removes the source with a second commit» | PASS |
| AC7 | `bot.test.ts` «refuses the 21st source»; `sources.test.ts` «refuses the 21st source, counting disabled ones» (в том числе владелец) | PASS |
| AC8 | `bot.test.ts` «reports a duplicate without a commit»; `sources.test.ts` «reports %j as a duplicate regardless of case or name» | PASS |
| AC9 | `bot.test.ts` «keeps the owner's fields and turns Hacker News off»; `sources.test.ts` «turns Hacker News off…», «leaves an existing owner's sources block…» | PASS |
| AC10 | scratchpad `ac10/gen.mts` (`addSource` для всех 6 типов, файл владельца с `${TELEGRAM_CHAT_ID}`, новый пользователь) → `HORIZON_OWNER_ID=612722019 uv run python -c 'load_user…; due_users(d, 6)'`: все 3 файла ok, у владельца `hn False`, `chat -100123`, `due` включает всех | PASS |
| AC11 | `bot.test.ts` «answers /help with the command list» (новый текст), «explains sources and the public repository after approval» | PASS |
| AC12 | `npm test` → 179 passed; `npm run typecheck` → ok; `npx wrangler deploy --dry-run` → ok (33.56 KiB); `uv run pytest` → 1051 passed. CI `bot-deploy.yml` и живой E2E — не выполнялись: нужен пуш, ждёт разрешения | NOT VERIFIED (CI, живой бот) |
| N1 | `bot.test.ts` «asks a stranger to /start first without touching GitHub files or the network» | PASS |
| N2 | `bot.test.ts` «undo by someone without that source changes nothing», «undo twice reports a stale button», «refuses an expired, foreign or replaced feed choice» | PASS |
| N3 | `bot.test.ts` «does not understand %s» (6 вводов); `sources.test.ts` «rejects %j» (21 ввод, в том числе `t.me/c/…`, короткий канал, URL > 2048) | PASS |
| N4 | `bot.test.ts` «does not understand https://example.com/${OPENAI_API_KEY}»; `sources.test.ts` (`${SECRET}`, `@durov_news ${X}`); `feeds.test.ts` (`${…}` в `<title>` → hostname) | PASS |
| N5 | `bot.test.ts` «refuses a forward from %j» (user, hidden_user, chat, channel без username) | PASS |
| N6 | `bot.test.ts` «reports a missing feed»; `feeds.test.ts` «finds nothing on %s» (нет ссылок, не фид, 500, > 1 МБ, редирект на ftp), «…fails or times out» | PASS |
| N7 | `bot.test.ts` «refuses an expired, foreign or replaced feed choice» | PASS |
| N8 | `bot.test.ts` «reports a failed save after two conflicts», «…after a GitHub error», «retries once on a write conflict»; `github.test.ts` «reports a stale sha as a conflict» | PASS |
| review | reviewer: раунд 1 BLOCK (пересылка с текстом на `/` уходила в команды) → исправлено; раунд 2 | PASS |

## Knowledge

- Dead ends: none
- Decisions: none
- Known issues: none
