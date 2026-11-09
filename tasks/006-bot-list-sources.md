---
id: 006
size: M
status: done
reopened: false
---

# Просмотр, выключение и удаление источников через бота: /list (#11)

## Goal

Одобренный пользователь командой `/list` видит свои источники и в том же сообщении выключает, включает или удаляет любой из них, а изменения попадают в его `data/users/<id>.json` в виде, который проходит `load_user`.

## Context (решения, уже принятые)

- Продолжение 005, цепочка та же: Telegram → Worker `gorizont-bot` → GitHub Contents API → `data/users/<id>.json`.
- Интерфейс в стиле BotFather, всё в одном сообщении (`editMessageText`):
  - **Список**: текст «Ваши источники (N из 20):», под ним по одной кнопке на источник в одну колонку: `✅ <метка>` или `⏸ <метка>`. Метка — как в `sourceLabel`, текст кнопки обрезан до 60 символов. Порядок: RSS, Telegram, Reddit-сабреддиты, Reddit-пользователи, GitHub, внутри типа — как в файле.
  - **Карточка** (нажатие на источник): метка, статус «включён» / «выключен», ссылка (URL фида, `t.me/<канал>`, `reddit.com/r/<x>`, `reddit.com/user/<x>`, `github.com/<owner>/<repo>`, `github.com/<user>`); кнопки `[⏸ Выключить]` или `[▶ Включить]`, `[🗑 Удалить]`, `[← К списку]`.
  - **Подтверждение удаления**: «Удалить <метка>?», кнопки `[Да, удалить] [Нет]`. «Нет» возвращает в карточку.
  - После выключения или включения сообщение показывает обновлённую карточку, после удаления — обновлённый список. Всплывающее уведомление: «Выключено» / «Включено» / «Удалено».
- Пустой список: «Источников пока нет. Как добавить — /help.», без кнопок.
- В файле: выключение — `"enabled": false` в записи; включение — ключ `enabled` удаляется (по умолчанию `true`). Остальные поля записи и файла не меняются, порядок ключей сохраняется, формат как в 005.
- Кнопки задают целевое состояние (`off`/`on`), а не «переключить»: если источник уже в нужном состоянии, коммита нет, показывается актуальная карточка.
- Источник в `callback_data` — тот же `keyHash` ключа, что у «Отменить» в 005; `user id` в `callback_data` не кладётся, действие всегда применяется к файлу `callback_query.from.id`.
- Устаревшая кнопка (источника с таким ключом в файле нажавшего нет) → всплывающее «Источника уже нет», сообщение перерисовывается актуальным списком, коммита нет.
- `/list` показывает и правит только 5 типов, которые добавляет бот (`rss`, `telegram.channels`, `reddit.subreddits`, `reddit.users`, `github`). Прочие блоки `sources` владельца (`hackernews` и т. п.) не показываются и не меняются.
- Коммиты: `chore(users): disable|enable|remove <kind> source for <id> via bot`, автор «Gorizont bot»; запись с `sha` и одним повтором на 409 (`editUser` из 005).
- В `/help` добавляется строка `/list — ваши источники`; в ответ «Добавлено: …» — вторая строка «Все источники — /list». Ожидаемые тексты в `bot/test/bot.test.ts` обновляются вместе с этим (изменение требований, как в 005).
- Меню команд Telegram (`/start`, `/list`, `/help` с описаниями на русском) регистрируется шагом `setMyCommands` в `bot-deploy.yml` рядом с `setWebhook`, с проверкой `ok == true`.
- Python-сторона (`src/`) не меняется: поле `enabled` уже есть во всех `_User*` моделях и учитывается скраперами.

## Acceptance criteria

1. Given одобренный пользователь с источниками разных типов When отправляет `/list` Then бот отвечает «Ваши источники (N из 20):» и по кнопке на каждый источник 5 типов со статусом ✅/⏸, где N совпадает с `countSources`.
2. Given одобренный пользователь без источников (нет `sources` или все списки пусты) When отправляет `/list` Then «Источников пока нет. Как добавить — /help.», без кнопок.
3. Given список When пользователь нажимает на источник Then сообщение меняется на карточку с меткой, статусом, ссылкой и кнопками «Выключить»/«Включить», «Удалить», «К списку»; «К списку» возвращает список. Коммитов нет.
4. Given включённый источник When пользователь жмёт «Выключить» Then в записи появляется `"enabled": false` (одним коммитом `disable`), остальные поля файла не изменились, карточка показывает «выключен» и кнопку «Включить».
5. Given выключенный источник When пользователь жмёт «Включить» Then ключ `enabled` удаляется из записи (коммит `enable`), карточка показывает «включён».
6. Given карточка When пользователь жмёт «Удалить» Then появляется подтверждение без коммита; «Нет» возвращает карточку без коммита; «Да, удалить» удаляет запись (коммит `remove`) и показывает обновлённый список.
7. Given файл владельца с `chat_id: "${TELEGRAM_CHAT_ID}"`, `hackernews` и другими полями When владелец выключает, включает и удаляет источник через `/list` Then меняется только эта запись; `/list` не показывает `hackernews`.
8. Given файлы, записанные в сценариях AC4–AC7 When их прогоняют через `load_user` на Python-стороне Then ошибок нет; выключенный источник не попадает в выборку скрапера (`enabled` = `false`).
9. Given `/help` и ответ «Добавлено: …» When бот отвечает Then в `/help` есть `/list`, в «Добавлено» — строка «Все источники — /list»; после деплоя меню «/» в Telegram показывает `/start`, `/list`, `/help`.
10. Given `bot/` When `npm test`, `npm run typecheck`, `npx wrangler deploy --dry-run` Then зелёные; `uv run pytest` не меняется; после пуша `bot-deploy.yml` зелёный (включая шаг `setMyCommands`), в живом боте от владельца проходят `/list`, выключение, включение и удаление.

## Negative scenarios

- N1 (доступ): пользователь без файла в `data/users/` отправляет `/list` или жмёт кнопку списка → «Сначала подключитесь к Горизонту: /start.», в GitHub ничего не пишется.
- N2 (чужой ресурс): кнопка из списка, нажатая не тем, кому адресовано сообщение, читает и меняет только файл нажавшего; если такого источника у него нет → «Источника уже нет» и его собственный актуальный список, коммита нет.
- N3 (валидация ввода): `callback_data` не по формату (не 8 hex-символов, неизвестное действие, лишние символы) → «Некорректная кнопка.», в GitHub ничего не пишется.
- N4 (устаревшая кнопка): источник удалён через «Отменить» или другой `/list` → «Источника уже нет», актуальный список, коммита нет.
- N5 (идемпотентность): повторное «Выключить» на уже выключенном источнике (или «Включить» на включённом) → коммита нет, ошибки «message is not modified» от Telegram не роняют обработку.
- N6: два конфликта записи подряд (409) или ошибка GitHub → всплывающее «Не удалось сохранить, попробуйте ещё раз», сообщение и файл не испорчены.

## Scope

- Change: `bot/src/sources.ts` (перечисление записей, метки и ссылки по записи, `setEnabled`), `bot/src/bot.ts` (`/list`, карточка, подтверждение, обработчики кнопок, тексты `/help` и «Добавлено»), при необходимости `bot/src/telegram.ts` (терпимость к «message is not modified»), `bot/test/`, `.github/workflows/bot-deploy.yml` (шаг `setMyCommands`), `docs/telegram-bot.md`.
- Do NOT touch: `src/`, `tests/`, `data/` (кроме того, что пишет бот в рантайме), остальные workflow, `docs/multi-user.md`, `README*`, онбординг из 004, добавление и «Отменить» из 005 (кроме строки «Все источники — /list»).
- Pattern: `undoSource` + `editUser` + `removeSource`/`keyHash` в `bot/src/bot.ts` и `bot/src/sources.ts`; фейковые Telegram/GitHub/KV в `bot/test/bot.test.ts`; шаг `Set Telegram webhook` в `bot-deploy.yml`.

## Plan

Утверждён 2026-11-10 (полная версия — `~/.claude/plans/tingly-shimmying-seal.md`). После «ок»: ожидаемые тексты `/help` и «Добавлено» в `test/bot.test.ts` обновляются; живая проверка AC10 — от владельца.

1. `src/sources.ts`: `listSources`, `sourceLink`, `setEnabled` (записи, которые не собираются в `Source`, пропускаются) + `test/sources.test.ts`.
2. `src/bot.ts`: `/list`, кнопки `ls`/`src`/`off`/`on`/`del`/`rm` над файлом `from.id`, `editUser` с исходом, несущим данные, рендер списка/карточки/подтверждения, проглатывание «message is not modified»; разбор `CALLBACK_PATTERN` до проверки владельца (N3); тексты `/help` и «Добавлено» + тесты.
3. `bot-deploy.yml`: шаг `setMyCommands`.
4. `docs/telegram-bot.md`.
5. Проверка: `npm test`, `typecheck`, `wrangler deploy --dry-run`, `load_user` на записанных файлах, `uv run pytest`; затем `/verify`, `/review-diff`; пуш по разрешению, CI, живой бот.

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| AC1 | `bot/test/bot.test.ts` «lists the sources with their state» (3 типа, ✅/⏸, «3 из 20»); `test/sources.test.ts` «lists every whitelisted source in file order with its state and hash» | PASS |
| AC2 | `bot.test.ts` «says there are no sources in %j» (нет `sources`; пустые списки) | PASS |
| AC3 | `bot.test.ts` «opens a card and goes back to the list without commits» (карточка RSS и выключенного Telegram, «К списку», `link_preview_options`, 0 коммитов); `sources.test.ts` «links %j to %s» (6 видов) | PASS |
| AC4 | `bot.test.ts` «turns a source off and on again» (`enabled: false`, коммит `disable rss`, карточка «выключен» + «Включить»); `sources.test.ts` «turns a source off and keeps everything else» | PASS |
| AC5 | `bot.test.ts` «turns a source off and on again» (ключ удалён, коммиты `enable rss`/`enable telegram`); `sources.test.ts` «turns a source on by dropping the flag» | PASS |
| AC6 | `bot.test.ts` «asks before deleting and deletes on confirmation» (подтверждение и «Нет» без коммитов, «Да» → коммит `remove`, список «2 из 20»), «shows an empty list after deleting the last source» | PASS |
| AC7 | `bot.test.ts` «touches only the chosen entry in the owner's file» (`chat_id`, `hackernews`, `time_window_hours`, пустой `rss` сохранены; HN не в списке; off → on возвращает исходный файл) | PASS |
| AC8 | scratchpad `ac8/gen.mts` (`addSource` ×6 → `setEnabled` off/on → `removeSource`, обычный пользователь и владелец с `${TELEGRAM_CHAT_ID}` и `hackernews: true`) → `HORIZON_OWNER_ID=612722019 TELEGRAM_CHAT_ID=-100123 uv run python -c 'load_user…; due_users(d, 6)'`: оба файла ok, выключенные записи `enabled=False` (скраперы их пропускают: `src/scrapers/telegram.py:43`, `reddit.py:62,66`, `rss.py:56`, `github.py:52`), у владельца `chat -100123`, `hn True` сохранён, `due` включает обоих | PASS |
| AC9 | `bot.test.ts` «answers /help with the command list» (строка `/list`), «adds a Telegram channel with an undo button» и др. («Все источники — /list»); шаг `Set Telegram commands`: YAML разобран (`uv run --with pyyaml`), `jq -n …` выдаёт валидный payload. CI run 42711674316: шаг `Set Telegram commands` ✓; меню «/» в живом Telegram подтвердил пользователь | PASS |
| AC10 | `npm test` → 221 passed; `npm run typecheck` → ok; `npx wrangler deploy --dry-run` → ok; `uv run pytest` → 1052 passed. CI `bot-deploy.yml` run 42711674316 — все шаги ✓. Живой бот от владельца 612722019: `/list` и кнопки подтвердил пользователь; коммиты бота (автор «Gorizont bot») `91fb31e` remove, `07624de` disable, `df4b84c` enable; итоговый `data/users/612722019.json` проходит `load_user` (`ecotopor`, `naebnet` включены) | PASS |
| N1 | `bot.test.ts` «asks a stranger to /start first» (`/list`, `ls`, `off`: `NEED_START`, без записи и правок сообщения) | PASS |
| N2 | `bot.test.ts` «applies %s only to the presser's own file» (off/on/rm/src/del от 456: читается только файл 456, файл 123 не тронут, «Источника уже нет», список 456) | PASS |
| N3 | `bot.test.ts` «refuses malformed button data %s from anyone» (8 вводов от не-владельца → «Некорректная кнопка.», `readUser` не вызван); мутация (проверка владельца перед разбором) → 8 тестов падают | PASS |
| N4 | `bot.test.ts` «refreshes the list on a stale button» (после «Отменить»: off/del/rm → «Источника уже нет», актуальный пустой список, без коммитов) | PASS |
| N5 | `bot.test.ts` «does not commit %s when the source is already there» (Telegram бросает «message is not modified» → обработка не падает), «lets other Telegram errors through»; мутация (не проглатывать) → 2 теста падают | PASS |
| N6 | `bot.test.ts` «reports a failed save after two conflicts», «…after a GitHub error» (off и rm: «Не удалось сохранить…», файл и сообщение не тронуты), «reports a failed read» | PASS |
| review | reviewer, раунд 1: FINDING нет; замечания (каст `as Action` из regex; N в заголовке по `countSources` при повреждённых записях — по AC1) не блокируют | PASS |

## Knowledge

- Dead ends: none
- Decisions: none
- Known issues: none
