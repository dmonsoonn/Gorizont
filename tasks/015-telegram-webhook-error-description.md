---
id: 015
size: S
status: done
reopened: false
---

# Описание ошибки Telegram при отправке дайджеста через CLI

## Goal

Показывать причину ошибки отправки дайджеста в консоли и журнале CLI, когда Telegram возвращает HTTP 4xx с полем `description`. [Issue #5](https://github.com/dmonsoonn/Gorizont/issues/5)

## Cause

Ветка 4xx в `WebhookNotifier._handle_response_status` пишет HTTP-код в консоль и журнал, а первые 500 символов тела передаёт в `WebhookDeliveryResult.detail` без разбора `description`.

## Acceptance criteria

1. Given `platform: telegram` и ответ HTTP 400 с JSON `{"ok": false, "description": "Bad Request: chat not found"}`, When CLI отправляет дайджест, Then консоль и журнал показывают HTTP-код и описание, а результат доставки сохраняет `HTTP_FAILURE`, `status_code=400` и `sent=false`.
2. Given ответ Telegram 4xx с JSON-телом, When обработчик разбирает ответ, Then он использует только непустое строковое поле `description` из объекта верхнего уровня. Диагностика выводится одной строкой, а разметка Rich и управляющие символы из ответа не интерпретируются.
3. Given Telegram отклоняет отправку и возвращает `description` с токеном настроенного бота, в том числе в составе URL, When CLI пишет диагностику ошибки доставки, Then открытый токен отсутствует в сообщении Horizon в консоли, записи `src.services.webhook` и `WebhookDeliveryResult.detail`, а безопасная часть описания сохраняется.
4. Given ответ другой webhook-платформы или ответ Telegram за пределами 4xx, When обработчик получает такой ответ, Then для него сохраняются существующие сообщения и результат доставки.

## Negative scenarios

- N1. Given ответ Telegram 4xx с невалидным JSON, JSON-массивом, отсутствующим, пустым или нестроковым `description` либо описанием, которое нельзя безопасно показать, When CLI обрабатывает ответ, Then консоль и журнал показывают существующую ошибку с HTTP-кодом, сырой ответ не выводится и результат остаётся `HTTP_FAILURE`.
- N2. Given настроенная отправка в один чат и отказ Telegram, связанный с недоступным чатом, When ответ содержит ID или ссылку на другой чат, Then обработчик использует ответ только как диагностику и не выполняет запросов к этому чату, не меняет адресата и не повторяет отправку на основании ответа.

## Scope

- Change — обработка ответа Telegram 4xx в `src/services/webhook.py` и новый файл `tests/test_telegram_webhook_errors.py`. Для Telegram 4xx в `WebhookDeliveryResult.detail` передаётся только безопасное описание либо `None`, чтобы сырой ответ не попал в структурированную диагностику.
- Do NOT touch — существующие тесты, Worker в `bot/`, выбор чата и URL, конфигурацию, форматирование и разбиение дайджеста, правила доступа, код MCP и обработку ошибок других платформ и статусов.
- Pattern — ветка с диагностикой ошибки платформы в `WebhookNotifier._handle_response_status` для вывода в консоль и журнал, `redact_url` в том же модуле для маскирования токена в URL, тесты HTTP-ошибок через `notify` в `tests/test_webhook.py` для проверки результата доставки.

## Plan

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| 1 | `test_daily_summary_reports_telegram_description_without_retargeting`, `test_telegram_description_is_literal_and_redacted` и `test_telegram_error_falls_back_to_status` в `tests/test_telegram_webhook_errors.py` | PASS |
| 2 | `test_telegram_description_is_literal_and_redacted` и `test_telegram_error_falls_back_to_status` | PASS |
| 3 | `test_telegram_description_is_literal_and_redacted`, обычный URL, прокси `/bot-api`, закодированный префикс и частично закодированный токен | PASS |
| 4 | `test_other_error_responses_keep_existing_diagnostics` и полный прогон существующих webhook-тестов | PASS |
| N1 | `test_telegram_error_falls_back_to_status`, 7 вариантов непригодного ответа | PASS |
| N2 | `test_daily_summary_reports_telegram_description_without_retargeting`, один запрос с исходным `chat_id` при `migrate_to_chat_id` в ответе | PASS |
| Python | `.venv/bin/python -m pytest --tb=short` с доступом к DNS и локальным сокетам → 1204 passed | PASS |
| review | Независимое read-only ревью текущего diff, 0 замечаний | PASS |
| Done | `.venv/bin/python -m pytest tests/test_telegram_webhook_errors.py tests/test_webhook.py tests/test_webhook_cli.py tests/test_telegram_rich_limits.py --tb=short` → 152 passed | PASS |

## Knowledge

- Dead ends: none
- Decisions: диагностический текст добавляется только для Telegram 4xx. Если безопасного описания нет, выводится существующее сообщение с кодом.
- Known issues: при `--log-level INFO` или `DEBUG` собственный журнал HTTPX пишет полный URL запроса, включая токен в пути. Подтверждено через `httpx.MockTransport` с подставным токеном. Эта задача относится к диагностике ответа Horizon.
