---
id: 014
size: S
status: done
reopened: false
---

# Сообщение при необработанном исключении Telegram-бота

## Goal

Сообщать пользователю, что действие не удалось, если обработчик Telegram-бота выбросил исключение, и сохранять исходную ошибку в журнале Worker. [Issue #25](https://github.com/dmonsoonn/Gorizont/issues/25)

## Cause

Исключение из `handleUpdate` доходило до `catch` в `bot/src/index.ts`. Worker логировал ошибку и подтверждал вебхук, но не отправлял сообщение в чат и не отвечал на нажатие кнопки.

## Acceptance criteria

1. Given корректный вебхук с `/start` из личного чата, When GitHub возвращает 5xx при проверке пользователя, Then бот отправляет в этот чат «Что-то пошло не так, попробуйте позже», Worker логирует исходную ошибку и возвращает Telegram HTTP 200 с `ok`.
2. Given корректный вебхук с поддерживаемой ссылкой на источник в личном чате, When GitHub возвращает 5xx при проверке пользователя перед добавлением, Then бот отправляет в этот чат тот же текст, Worker логирует исходную ошибку и возвращает HTTP 200 с `ok`.
3. Given корректный вебхук с нажатием известной кнопки, When обработчик выбрасывает необработанное исключение до подтверждения нажатия, Then бот передаёт тот же текст в `answerCallbackQuery` по ID этого нажатия, Worker логирует исходное исключение и возвращает HTTP 200 с `ok`.
4. Given нажатие кнопки списка источников `ls`, When чтение файла пользователя в GitHub возвращает 5xx, Then бот показывает существующий текст `READ_FAILED` через `answerCallbackQuery`, Worker логирует исходную ошибку и возвращает HTTP 200 с `ok`.
5. Given корректное действие бота, When обработчик успешно завершает его, Then пользователь получает предусмотренный ответ без общего сообщения об ошибке.

## Negative scenarios

- N1. Given обработчик выбросил исключение, When Telegram также отклоняет отправку сообщения об ошибке или `answerCallbackQuery` (включая случай уже подтверждённого нажатия), Then Worker логирует исходное исключение и сбой доставки отдельно, возвращает HTTP 200 с `ok` и завершает обработку без повторных попыток или сообщения в личный чат после сбоя `answerCallbackQuery`.
- N2. Given неверный секрет вебхука, невалидный JSON или апдейт без поддерживаемого события, When Worker получает запрос, Then при неверном секрете возвращает 401, в остальных случаях — HTTP 200 с `ok`, без вызовов GitHub и Telegram.
- N3. Given пользователь, который не является владельцем, When он нажимает кнопку одобрения заявки другого пользователя, Then бот отвечает `NOT_OWNER` на это нажатие, без чтения или записи чужого файла в GitHub и без сообщения в чужой чат.

## Scope

- Change — `bot/src/bot.ts`, `bot/src/texts.ts`, новый файл `bot/test/update-errors.test.ts` и один согласованный тест в `bot/test/bot.test.ts` на необработанную ошибку редактирования.
- Do NOT touch — обработчики в `bot/src/flows/`, правила доступа, клиенты GitHub и Telegram, настройки Worker, остальные существующие тесты и issue #5.
- Pattern — `reply` и `answerQuery` в `bot/src/replies.ts` для доставки, константы в `bot/src/texts.ts` для пользовательского текста, `bot/test/index.test.ts` для проверок вебхука с подменой `fetch`.

## Plan

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| 1 | `bot/test/update-errors.test.ts`, GitHub 503 на `/start` | PASS |
| 2 | `bot/test/update-errors.test.ts`, GitHub 503 на добавлении `@example_channel` | PASS |
| 3 | `bot/test/update-errors.test.ts`, GitHub 503 на `chat:channel` | PASS |
| 4 | `bot/test/update-errors.test.ts`, GitHub 503 на `ls` | PASS |
| 5 | `bot/test/update-errors.test.ts`, обычный ответ на `/help` | PASS |
| N1 | `bot/test/update-errors.test.ts`, сбой отправки, сбой всплывающего ответа до и после подтверждения кнопки | PASS |
| N2 | `bot/test/index.test.ts` и `bot/test/update-errors.test.ts`, неверные секреты и неподдерживаемые апдейты | PASS |
| N3 | `bot/test/update-errors.test.ts`, `approve:456` от пользователя 123 | PASS |
| Worker | `npm test` → 320 passed, `npm run typecheck` → exit 0, `npx --no-install wrangler deploy --dry-run` → exit 0 | PASS |
| Python | `uv run --locked pytest --tb=short` с доступом к локальным сокетам и DNS → 1191 passed | PASS |
| review | Независимый read-only reviewer, 0 замечаний | PASS |
| Done | `npm run typecheck` → exit 0, `npm test -- test/update-errors.test.ts test/index.test.ts test/bot.test.ts` → 168 passed | PASS |

## Knowledge

- Dead ends: none
- Decisions: общий ответ только на необработанные исключения. При сбое всплывающего ответа достаточно журнала Worker.
- Known issues: none
