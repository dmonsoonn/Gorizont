---
id: 009
size: M
status: done
reopened: false
---

# Рефакторинг бота и src/users по итогам аудита

## Goal

Разнести `bot/src/bot.ts` (733 строки) по модулям, убрать дублирующиеся хелперы и цепочку регэкспов в роутинге кнопок, проверять форму ответов Telegram вместо `as` (#19) и мелко причесать `src/users`, не меняя поведение бота и пайплайна.

## Context (решения, уже принятые)

- Основание: аудит в #17 (комментарий 2026-11-11), пп. 14, 15 и #19. Пункт 7 (проверка env Worker) уже сделан в 008. Пункт 8 (бот молчит при исключении) вынесен в #25: это изменение поведения, а не рефакторинг.
- Рефакторим только свой код. Файлы апстрима (`src/` кроме `src/users/`), наши вставки в `webhook.py` и `orchestrator.py` не трогаем, чтобы не было конфликтов при синхронизации (memory: fork low-conflict flow, аудит п. 16).
- Существующие тесты (`bot/test/*.test.ts`, `tests/test_users.py`) не меняются ни на байт: это доказательство, что поведение сохранилось. Для #19 добавляются только новые тесты.
- `bot.ts` сохраняет все экспорты, которые импортируют тесты: `handleUpdate`, `pendingKey`, `rejectedKey`, `feedsKey`, `channelKey`, `PENDING_TTL_SECONDS`, `FEEDS_TTL_SECONDS`, `CHANNEL_TTL_SECONDS`, типы `Store`, `Update` (определены в `types.ts`, ре-экспорт из `bot.ts`).
- Структура (выбрана пользователем):
  - `bot.ts` — `handleUpdate`, разбор сообщения на команды, таблица маршрутов кнопок, ре-экспорт;
  - `types.ts` — `Update`, `Message`, `CallbackQuery`, `User`, `Store`, `Deps`, `View`, ключи KV и TTL;
  - `texts.ts` — все тексты для пользователя, включая шаблоны (`Добавлено: …`) как функции;
  - `replies.ts` — отправка сообщения, ответ на нажатие кнопки, `editMessage`, `markDecision`, `editUser`, `clip`;
  - `flows/access.ts` — `/start`, заявка, одобрить/отклонить;
  - `flows/sources.ts` — добавление источника, выбор фида, undo, `/list` и карточки;
  - `flows/settings.ts` — `/window`, `/chat`, выбор канала;
  - `telegram.ts` — плюс type guards для ответов `getChat`, `getMe`, `getChatMember`.
  - `sources.ts`, `settings.ts`, `feeds.ts`, `github.ts`, `index.ts` не меняются.
- #19, поведение при ответе неожиданной формы (ошибка пишется в лог с именем метода):
  - `getChat` при выборе канала → «Канал не найден…» (как сейчас, этого требует существующий тест `refuses a chat without a numeric id`);
  - `getMe` или `getChatMember` при выборе канала → «Не удалось проверить канал, попробуйте ещё раз.», ожидание канала сохраняется, коммита нет;
  - `getChat` в `/chat` → подпись `в канал <id>` (как сейчас при ошибке запроса).
- `src/users`: `UserConfig` наследует `_Strict` вместо повтора `model_config`; аннотация `due_users` в стиле модуля (`List`/`Dict`). Импорт приватных `_ENV_VAR_PATTERN` и `_expand_env_vars` из `storage/manager.py` апстрима остаётся (см. Knowledge).
- Пуш в `bot/**` запускает `bot-deploy.yml`, поэтому после пуша нужна живая проверка бота.

## Acceptance criteria

1. Given рефакторинг закончен When `git diff --stat <base> -- bot/test tests` Then существующие тестовые файлы не изменены (в списке только новые файлы), `npm test` проходит: 301 старый тест плюс новые, `uv run pytest` — 1079 passed.
2. Given новая структура When `wc -l bot/src/*.ts bot/src/flows/*.ts` Then есть `types.ts`, `texts.ts`, `replies.ts`, `flows/access.ts`, `flows/sources.ts`, `flows/settings.ts`; `bot.ts` не длиннее 120 строк, каждый файл в `flows/` не длиннее 300 строк; `git diff <base> -- bot/src/index.ts bot/src/sources.ts bot/src/settings.ts bot/src/feeds.ts bot/src/github.ts` пуст.
3. Given новый код When `grep -rn "answerCallbackQuery\|const reply =\|const answer =" bot/src` Then `answerCallbackQuery` встречается только в `replies.ts`, локальных `reply`/`answer` в функциях нет.
4. Given роутинг кнопок When читаем `bot.ts` Then `callback_data` разбирается одной таблицей маршрутов (массив «регэксп → обработчик» и один цикл), без цепочки `exec` и без `as Action`/`as ChatAction`.
5. Given тексты When `grep -lP "[А-Яа-яЁё]" bot/src/*.ts bot/src/flows/*.ts` Then кириллица есть только в `texts.ts` и `sources.ts` (последний не трогаем).
6. Given #19 When `grep -nE " as [A-Za-z{(]" bot/src --include=*.ts -r` Then приведений ответов Telegram (`request(...) as`) нет; остаются только `as` в `sources.ts` (не трогаем).
7. Given режим ожидания канала и `getMe`, отвечающий `{}` When пользователь присылает `@chan` Then ответ «Не удалось проверить канал, попробуйте ещё раз.», в лог пишется ошибка с `getMe`, коммита нет, ключ `chat:<id>` остаётся (новый тест).
8. Given режим ожидания канала и `getChatMember`, отвечающий без строкового `status` When пользователь присылает `@chan` Then ответ «Не удалось проверить канал…», ошибка в логе, коммита нет (новый тест).
9. Given пользователь с `chat_id` канала и `getChat`, отвечающий без числового `id` When он отправляет `/chat` Then бот показывает «Дайджест приходит: в канал <id>», ошибка в логе (новый тест).
10. Given `src/users` When `git diff <base> -- src/users` Then `UserConfig(_Strict)` без собственного `model_config`, у `due_users` аннотация `List[Dict[str, Any]]`; других изменений нет, `tests/test_users.py` не изменён.
11. Given изменения When `npm run typecheck`, `npx wrangler deploy --dry-run`, CI `ci.yml` после пуша Then всё зелёное.
12. Given задеплоенный бот (`bot-deploy.yml` после пуша) When владелец в Telegram делает `/help`, `/list`, нажимает источник и «← К списку», `/window` и нажимает текущее значение, `/chat` → «В канал» → «Отмена» Then ответы те же, что до рефакторинга, новых коммитов в `gorizont-data` нет.

## Negative scenarios

- N1: Given ответ `getMe` неожиданной формы When выбор канала Then «Не удалось проверить канал…», без `undefined` в запросе `getChatMember` (AC7).
- N2: Given неизвестная или испорченная `callback_data` (`foo`, `win:5`, `feed:zz:0`, `approve:0`) When нажатие Then «Некорректная кнопка.» (существующие тесты, проверяют таблицу маршрутов).
- N3 (чужой ресурс): Given пользователь нажимает «Одобрить» When он не владелец Then «Решать заявки может только владелец.»; кнопки источников и настроек меняют только файл `callback_query.from.id` (существующие тесты `changes only the presser's file`).

## Scope

- Change: `bot/src/bot.ts`, `bot/src/telegram.ts`, новые `bot/src/{types,texts,replies}.ts`, `bot/src/flows/{access,sources,settings}.ts`, новый файл тестов для #19 в `bot/test/`, `src/users/__init__.py`.
- Do NOT touch: существующие `bot/test/*.test.ts`, `tests/test_users.py`, `bot/src/{index,sources,settings,feeds,github}.ts`, все файлы апстрима в `src/`, workflow, документацию.
- Pattern: чистая логика без I/O — как в `bot/src/settings.ts` и `bot/src/sources.ts` (функции над `UserData`, возвращают новое значение); фабрика зависимостей — `createTelegram`/`createGitHub`; результат записи — существующий `editUser` с `Change<T>`.

## Plan

База: `9e2a4ed`. Три атомарных коммита, после каждого `npm test` + `npm run typecheck` (или `uv run pytest`).

1. Структура без изменения поведения (AC2–5): вынести типы и ключи KV в `types.ts`, тексты в `texts.ts`, общие хелперы в `replies.ts`, обработчики в `flows/{access,sources,settings}.ts`; `bot.ts` — `handleUpdate`, роутинг команд, таблица маршрутов кнопок, ре-экспорт. Проверка: 301 старый тест зелёный, `git diff 9e2a4ed -- bot/test` пуст. Коммит `refactor(bot): split bot.ts into flows [#17]`.
2. #19 (AC6–9): сначала новый `bot/test/telegram-shape.test.ts` с ответами неожиданной формы, убедиться, что AC7–9 падают на шаге 1; затем guards в `telegram.ts` и их использование в `flows/settings.ts`, тесты зелёные. Коммит `fix(bot): check the shape of Telegram responses [#19]`.
3. `src/users` (AC10): `UserConfig(_Strict)`, аннотация `due_users`. `uv run pytest`. Коммит `refactor(users): reuse the strict base model [#17]`.
4. `/verify`, `/review-diff`, пуш по согласию, CI и деплой, живая проверка AC12 у владельца.

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| AC1 | `git diff --name-status 9e2a4ed -- bot/test tests` → только `A bot/test/telegram-shape.test.ts`; `npm test` → 7 files, 308 passed (301 + 7); `uv run pytest` → 1079 passed | PASS |
| AC2 | `wc -l`: `bot.ts` 91, `flows/access.ts` 80, `flows/settings.ts` 212, `flows/sources.ts` 262; `types.ts`, `texts.ts`, `replies.ts` есть; `git diff --stat 9e2a4ed -- bot/src/{index,sources,settings,feeds,github}.ts` пуст | PASS |
| AC3 | `grep -rn "answerCallbackQuery\|const reply =\|const answer =" bot/src` → одна строка, `replies.ts:21` | PASS |
| AC4 | `bot.ts`: `ROUTES` (стр. 24) и один цикл `for … of ROUTES` с `pattern.exec` (стр. 84–85); `as Action`/`as ChatAction` нет | PASS |
| AC5 | `grep -lP "[А-Яа-яЁё]" bot/src/*.ts bot/src/flows/*.ts` → `texts.ts`, `sources.ts` | PASS |
| AC6 | `grep -rnE ' as [A-Za-z{(]' bot/src` (без `as const`) → только `sources.ts:282,292`; ответы `request` идут через `shaped`/`isChat` (`flows/settings.ts:91,151,176`) | PASS |
| AC7 | `bot/test/telegram-shape.test.ts` «asks to retry the channel check on getMe without an id / not an object»: ответ `CHECK_FAILED`, лог `Telegram getMe returned an unexpected response`, коммитов нет, `chat:123` остаётся, `getChatMember` без `undefined`. До фикса тест падал (прогон на `82eb6b3`) | PASS |
| AC8 | тот же файл, «bot membership / user membership without a status» | PASS |
| AC9 | тот же файл, «shows the channel id in /chat when getChat answers without an id» → `Дайджест приходит: в канал -100777` + лог | PASS |
| AC10 | `git diff 9e2a4ed -- src/users`: `UserConfig(_Strict)`, `List[Dict[str, Any]]`, импорт `Dict`; 3+/5−; `tests/test_users.py` не изменён; pytest 1079 passed | PASS |
| AC11 | `npm run typecheck` exit 0; `npx wrangler deploy --dry-run` → `--dry-run: exiting now.`; CI run 43093236129 на `4137116` success: bot 7 files / 308 passed, dry-run ok, python 1079 passed; `bot-deploy.yml` run 43093236169 success, version `0da41b8e` | PASS |
| AC12 | Владелец прошёл сценарий на версии `0da41b8e` (`/help`, `/list` → источник → «← К списку», `/window` → текущее значение, `/chat` → «В канал» → «Отмена»), ответы как прежде — со слов владельца; `gh api repos/dmonsoonn/gorizont-data/commits` в 20:09Z → последний коммит 13:37:51Z, новых нет; в Gorizont коммитов бота нет | PASS |
| N1 | = AC7 (`getChatMember` вызывается только с числовым `user_id`) | PASS |
| N2 | `bot.test.ts`: «refuses malformed callback data» (`approve:0`, `approve:abc`, `delete:123`, …), `win:5`/`chat:foo` (стр. 1059), «refuses malformed button data» для источников — зелёные без изменений тестов | PASS |
| review | reviewer, раунд 1 BLOCK (только AC11/AC12 до пуша), раунд 2 | PASS |
| N3 | `bot.test.ts`: «refuses decisions from anyone but the owner», «applies off/on/rm/src/del only to the presser's own file», «changes only the presser's file» — зелёные | PASS |

## Knowledge

- Dead ends: none
- Decisions: none
- Known issues: `src/users` импортирует приватные `_ENV_VAR_PATTERN` и `_expand_env_vars` из `src/storage/manager.py` апстрима. Если апстрим их переименует, импорт сломается при синхронизации; это поймают тесты и пробное слияние (#12). Не чиним: решение требует правки файла апстрима или копирования его кода.
