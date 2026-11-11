---
id: 010
size: M
status: in-progress
reopened: false
---

# Скрипт установки `scripts/setup.sh`

## Goal

Человек, который форкнул Gorizont, одним интерактивным скриптом из клона своего форка создаёт репозиторий данных, проверяет и записывает все секреты и переменные, включает Actions и деплоит бота, не повторяя вручную шаги «One-time setup» из `docs/telegram-bot.md` (#17, п. «Setup-скрипт»).

## Context (решения, уже принятые)

- Запуск локально в клоне форка: `./scripts/setup.sh`. Нужны `gh` (залогинен), `jq`, `curl`, `openssl`. Репозиторий с кодом берётся из `origin`. macOS (`/bin/bash` 3.2) и Linux; Windows — только WSL. Без новых зависимостей.
- Вручную человек создаёт только то, что нельзя создать через API: бота у BotFather, токен Cloudflare (шаблон «Edit Cloudflare Workers»), fine-grained PAT, ключи Groq. Скрипт подсказывает, где их взять.
- Скрипт сам: генерирует `BOT_WEBHOOK_SECRET` (`openssl rand -hex 32`); выводит `CLOUDFLARE_ACCOUNT_ID` и поддомен `workers.dev` из API Cloudflare (`BOT_URL = https://gorizont-bot.<subdomain>.workers.dev`); `HORIZON_WEBHOOK_URL = https://api.telegram.org/bot<token>/sendRichMessage`; `OWNER_ID` через `getUpdates` после `/start` боту (иначе текущее значение переменной или ручной ввод); `TELEGRAM_CHAT_ID = OWNER_ID`.
- Репозиторий данных: по умолчанию приватный `<login>/gorizont-data`, создаётся через `gh` пользователя, если его нет; первый коммит `users/<OWNER_ID>.json` = `{"id": <id>, "time_window_hours": 6}` (как бот при одобрении). Существующий репозиторий и существующий файл переиспользуются и не перезаписываются. Создаётся до ввода PAT, потому что fine-grained PAT выдаётся на существующий репозиторий.
- Проверка ввода до записи: `getMe` для токена бота, `GET accounts` и `GET accounts/{id}/workers/subdomain` для Cloudflare (они же дают Account ID и поддомен, отдельный `tokens/verify` не нужен), `GET /models` у Groq, PAT имеет право записи в репозиторий данных и **не** имеет его в репозитории с кодом (ADR 0003). Если у PAT есть право записи в код — отказ и остановка, секрет не записывается.
- Право записи PAT проверяется пробой без записи: `PUT contents/<существующий файл>` с `sha` из нулей. 409 «does not match» — запись разрешена, коммита нет; 403/404 — нет. Проверено 2026-11-11 токеном `gh` владельца на `Gorizont/README.md`: 409, `origin/main` не изменился. Поле `permissions.push` в `GET repos` не используется: по документации оно описывает роль пользователя, а не права токена.
- Секреты и токены не попадают в argv дочерних процессов и в вывод: `gh secret set` получает значение через stdin, `curl` — URL и заголовки с токенами через `-K -` (config из stdin). Ввод секретов без эха, если stdin — терминал.
- Повторный запуск: для уже заданного секрета — «уже задан, заменить? [y/N]»; при «нет» секрет не вводится и не проверяется. Переменные показываются текущим значением как default.
- Actions: `PUT repos/<repo>/actions/permissions` (`enabled=true`) и `gh workflow enable` для `bot-deploy.yml` и `ci.yml`; если не вышло — ссылка на вкладку Actions и ожидание Enter. `users-digest.yml`: вопрос «включить расписание? [y/N]», по умолчанию нет (пока открыты #6 и #8).
- Финал: `gh workflow run bot-deploy.yml`, ожидание результата, `getWebhookInfo` (`url == BOT_URL`, `last_error_message` пуст); затем, только если расписание `users-digest.yml` включено, запуск с `dry_run=true` и вывод матрицы. Выключенное расписание скрипт не включает даже на время dry-run (ревью, раунд 1): иначе при падении прогона или срабатывании cron в эту минуту рассылка пошла бы без согласия владельца.
- Сообщения скрипта, подсказки и `--help` — на русском. Код и имена — на английском, без комментариев.
- Тесты: pytest запускает скрипт с фейковыми `gh`/`curl`/`openssl` в `PATH`, которые пишут argv и stdin в лог и отдают заранее заданные ответы. Новых зависимостей нет, идут в существующем CI-job `python`.
- Документация: в этой задаче только абзац в `docs/telegram-bot.md` («One-time setup»: можно запустить `scripts/setup.sh`, что подготовить заранее). Полное описание — в задаче про `docs/self-host.md`.
- Живая проверка — повторный запуск на текущей установке Gorizont с ответом «нет» на все замены. Установка с нуля на тестовом форке — следующий пункт #17.

## Acceptance criteria

1. Given любой каталог When `./scripts/setup.sh --help` Then печатается справка на русском (что нужно заранее, шаги), exit 0, ни одного вызова `gh`/`curl`.
2. Given нет одной из утилит `gh`, `jq`, `curl`, `openssl`, или `gh auth status` неуспешен, или `origin` не указывает на GitHub When запуск Then сообщение называет, чего не хватает, exit ≠ 0, вызовов `gh secret`/`gh variable`/`gh repo create` нет.
3. Given чистая установка (секретов и переменных нет, репозитория данных нет) и корректный ввод When запуск Then заданы секреты `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TELEGRAM_BOT_TOKEN`, `BOT_WEBHOOK_SECRET` (64 hex), `BOT_GITHUB_TOKEN`, `GROQ_API_KEY`, `HORIZON_WEBHOOK_URL` (`…/bot<token>/sendRichMessage`), `TELEGRAM_CHAT_ID` (= `OWNER_ID`) и переменные `OWNER_ID`, `DATA_REPO`, `BOT_URL` (`https://gorizont-bot.<subdomain>.workers.dev`) — ровно этот набор, с ожидаемыми значениями; `GROQ_API_KEY_2`/`_3` — только если введены.
4. Given чистая установка When скрипт создаёт репозиторий данных Then он создан `gh repo create --private --add-readme` (`<login>/gorizont-data` по умолчанию), затем вторым коммитом через Contents API — `users/<OWNER_ID>.json` с `{"id": <OWNER_ID>, "time_window_hours": 6}`; создание идёт до запроса PAT.
5. Given любой прогон When смотрим argv всех вызовов фейковых `gh`/`curl` и stdout/stderr скрипта Then ни одно значение секрета (токен бота, PAT, токен Cloudflare, ключи Groq, webhook-секрет) там не встречается.
6. Given новый бот без webhook и `getUpdates` с личным сообщением `/start` When шаг `OWNER_ID` Then берётся `from.id`, человек подтверждает его; если сообщений нет или webhook уже стоит — предлагается текущее `vars.OWNER_ID` или ручной ввод.
7. Given Cloudflare-токен с одним аккаунтом When шаг Cloudflare Then `CLOUDFLARE_ACCOUNT_ID` и поддомен берутся из API без вопросов; при нескольких аккаунтах — выбор по номеру.
8. Given всё уже настроено (секреты и переменные есть, репозиторий данных и файл владельца есть) When повторный запуск с ответом «нет» на все «заменить?» Then ни одного `gh secret set`, `gh variable set` с новым значением, `gh repo create` или записи файла в репозиторий данных; деплой и проверки webhook выполняются.
9. Given Actions выключены в форке When шаг Actions Then вызываются `PUT actions/permissions` и `gh workflow enable` для `bot-deploy.yml` и `ci.yml`; если вызов упал — печатается ссылка на вкладку Actions и скрипт ждёт Enter.
10. Given вопрос про расписание `users-digest.yml` When ответ по умолчанию (Enter) Then `gh workflow enable users-digest.yml` не вызывается; при «y» — вызывается.
11. Given все секреты записаны When финальный шаг Then запускается `bot-deploy.yml`, скрипт ждёт завершения; при успехе, если токен бота введён в этом запуске, проверяет `getWebhookInfo` (`url` = `BOT_URL`, `last_error_message` пуст), иначе печатает команду для ручной проверки; затем, если расписание `users-digest.yml` включено, запускает его с `dry_run=true`, ждёт и печатает строку матрицы из лога, а если выключено — печатает «Пропущен» и команду для ручного dry-run; при провале деплоя печатает ссылку на run и выходит с ≠ 0.
12. Given `docs/telegram-bot.md` When читаем «One-time setup» Then есть абзац про `scripts/setup.sh`: что подготовить заранее и что скрипт делает сам; остальной текст не изменён.
13. Given изменения When `uv run pytest` локально (тесты скрипта и под `/bin/bash` 3.2, и под bash 5) и CI `ci.yml` после пуша Then зелёные; `bash -n scripts/setup.sh` чисто.
14. Given текущая установка Gorizont When владелец запускает скрипт и отвечает «нет» на все замены Then скрипт находит существующие секреты, переменные и `gorizont-data`, `bot-deploy.yml` зелёный, напечатанная команда `getWebhookInfo` (выполненная вручную) — без ошибки, dry-run пропущен (расписание выключено) и `users-digest.yml` остался `disabled_manually`; `gh secret list` и `gh variable list` после прогона совпадают с до (даты обновления секретов не изменились; `BOT_WEBHOOK_SECRET` не перегенерирован).

## Negative scenarios

- N1 (ввод): токен бота, на который `getMe` отвечает `ok: false` → понятная ошибка, повторный ввод (до 3 попыток), затем выход ≠ 0; ни одного `gh secret set` / `gh variable set`.
- N2 (ввод): `OWNER_ID` не положительное целое (`abc`, `-100123`, пусто) → отказ и повторный ввод.
- N3 (ввод): токен Cloudflare не даёт списка аккаунтов (`GET accounts` не `success` или пуст), ключ Groq получает 401, или у аккаунта нет поддомена `workers.dev` → ошибка с подсказкой, что сделать; секреты не записаны.
- N4 (доступ): PAT не видит репозиторий данных или не имеет на нём права записи → ошибка «выдайте PAT доступ к <DATA_REPO>, Contents: Read and write», `BOT_GITHUB_TOKEN` не записан.
- N5 (чужой ресурс / ADR 0003): PAT имеет право записи в репозиторий с кодом (классический PAT или «All repositories») → отказ, объяснение, секрет не записан, выход ≠ 0.
- N6 (чужой ресурс): `origin` — репозиторий, где у залогиненного пользователя `gh` нет прав admin (клон апстрима или чужого форка) → отказ «запускайте в клоне своего форка», ничего не записано.
- N7 (ввод): `DATA_REPO` не в формате `owner/name`, или существующий репозиторий данных публичный → отказ / предупреждение с подтверждением соответственно.
- N8 (деплой): `bot-deploy.yml` упал или `getWebhookInfo` вернул `last_error_message` → сообщение со ссылкой на run / текстом ошибки, выход ≠ 0, «готово» не печатается.

## Scope

- Change: `scripts/setup.sh` (новый), `tests/test_setup_script.py` (новый), `docs/telegram-bot.md` (один абзац в «One-time setup»).
- Do NOT touch: `.github/workflows/*`, `bot/`, `src/`, существующие тесты, `README*`, `.github/README.md`, `docs/self-host.md`, ADR, `data/config.github.json`.
- Pattern: `scripts/daily-run.sh` (`set -euo pipefail`, `SCRIPT_DIR`/`PROJECT_DIR`, функции); проверка переменных циклом с `${!name}` и `jq -n` для JSON из `bot-deploy.yml`; запуск скрипта через `subprocess.run` в `tmp_path` из `tests/test_horizon_skill.py`.

## Plan

Сверено по документации (2026-11-11):
- Cloudflare: `GET /client/v4/accounts/{id}/workers/subdomain` → `result.subdomain`, нужен `Workers Scripts Read|Write` (есть в шаблоне «Edit Cloudflare Workers»).
- GitHub: в документации Contents API не сказано, работает ли `PUT` на пустом репозитории → репозиторий создаётся с `--add-readme`, файл владельца пишется вторым коммитом.
- GitHub: `PUT actions/permissions` (`enabled`) → 204; про баннер форков в документации ничего нет → после него `gh workflow enable`, при ошибке ссылка и Enter (как и договорились).
- `gh workflow run` не обещает вернуть id запуска → id ищется через `gh run list --workflow … --event workflow_dispatch --json databaseId,createdAt` с отметкой времени до запуска, затем `gh run watch --exit-status`.

Устройство скрипта (`scripts/setup.sh`, bash 3.2: без ассоциативных массивов, `${x,,}`, `mapfile`):
1. `--help`; проверка `gh jq curl openssl git`, `gh auth status`, `origin` → `CODE_REPO`, `permissions.admin` у пользователя `gh` (N6).
2. Чтение имён существующих секретов (`gh secret list --json name`) и переменных со значениями.
3. Группы ввода, каждая спрашивает «заменить?» только если все её значения уже есть:
   - Telegram: `TELEGRAM_BOT_TOKEN` → `getMe`; при вводе пишется и `HORIZON_WEBHOOK_URL`.
   - Владелец: `OWNER_ID` (getUpdates → var → ручной ввод); `TELEGRAM_CHAT_ID = OWNER_ID`, если секрета нет или `OWNER_ID` изменился.
   - Cloudflare: токен → `accounts` (выбор при нескольких) → `subdomain`; пишутся `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `BOT_URL`.
   - `BOT_WEBHOOK_SECRET`: генерируется, если нет; при наличии — «заменить?».
   - Репозиторий данных: `DATA_REPO` (формат, приватность, создание, файл владельца).
   - PAT: инструкция и ссылка на создание токена, проба записи в `users/<OWNER_ID>.json` репозитория данных (ждём 409) и в `README.md` репозитория с кодом (ждём 403/404).
   - Groq: `GROQ_API_KEY` → `/models`; `_2`, `_3` необязательны.
4. Запись: секреты через stdin `gh secret set NAME`, переменные `gh variable set`. Все HTTP-запросы с токенами — одна функция `api`, передающая URL и заголовки в `curl -K -`.
5. Actions, вопрос про `users-digest.yml`, деплой, `getWebhookInfo`, dry-run.

Тесты (`tests/test_setup_script.py`): `tmp_path` с git-репозиторием (`origin` = `https://github.com/alice/Gorizont.git`) и копией скрипта; `PATH` = каталог фейков (`gh`, `curl`, `openssl`, `sleep` — Python-скрипты с общим состоянием в JSON и логом argv/stdin) + каталог симлинков на нужные системные утилиты (чтобы тест AC2 мог «убрать» утилиту). Ответы пользователя — через stdin. Параметризация по `bash` (`/bin/bash` и `bash` из PATH, если версии различаются).

Шаги и коммиты:
1. Тестовый каркас и тесты AC1–2, N6 → скрипт: preflight. `uv run pytest tests/test_setup_script.py`.
2. Тесты AC3–7, N1–N5, N7 → группы ввода и запись. Затем AC8 (повтор), AC5 (нет секретов в argv/выводе).
3. Тесты AC9–11, N8 → Actions, деплой, dry-run.
4. Абзац в `docs/telegram-bot.md` (AC12).
5. Полный `uv run pytest`, `bash -n`, `/verify`, `/review-diff`. Коммиты `feat(scripts): add interactive setup script [#17]`, `docs(bot): mention the setup script [#17]`; пуш по согласию, CI.
6. AC14: живой прогон у владельца.

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| AC1 | `tests/test_setup_script.py::test_help_prints_usage_without_calls` (exit 0, справка, лог вызовов пуст) | PASS |
| AC2 | `test_missing_tool_stops_before_anything[gh,jq,curl,openssl,git]`, `test_gh_must_be_logged_in`, `test_origin_must_be_on_github` — exit ≠ 0, имя причины, `writes() == []` | PASS |
| AC3 | `test_fresh_install_writes_everything[3.2.57, 5.3.20]` — точный набор секретов и переменных со значениями; `_2`/`_3` только при вводе — `test_secrets_never_reach_argv_or_output` | PASS |
| AC4 | `test_fresh_install_creates_a_private_data_repo_before_asking_for_the_pat` — `repo create … --private --add-readme`, `users/4242.json` = `{"id": 4242, "time_window_hours": 6}`, создание раньше пробы PAT и раньше подсказки о PAT | PASS |
| AC5 | `test_secrets_never_reach_argv_or_output` (9 значений, включая webhook-секрет, нет в argv всех фейков и в stdout/stderr), `test_secret_set_reads_the_value_from_stdin`; мутация «`gh secret set --body`» роняет оба теста | PASS |
| AC6 | `test_fresh_install_writes_everything` (`from.id` 4242 из `getUpdates`, Enter принимает), `test_owner_id_falls_back_to_manual_input[no_messages, webhook_set]`, повторный запуск берёт `vars.OWNER_ID` — `test_rerun_keeps_everything_when_told_so` | PASS |
| AC7 | `test_fresh_install_writes_everything` (один аккаунт, без вопроса), `test_picks_the_cloudflare_account_by_number` (`acc2`, поддомен запрошен для `acc2`) | PASS |
| AC8 | `test_rerun_keeps_everything_when_told_so[3.2.57, 5.3.20]` — `writes() == []`, секреты/переменные/файл владельца без изменений, деплой и dry-run запущены | PASS |
| AC9 | `test_enables_actions_and_core_workflows`, `test_asks_to_enable_actions_by_hand_when_the_api_fails` (в выводе причина `HTTP 403`), `test_stops_when_actions_stay_disabled` | PASS |
| AC10 | `test_digest_schedule_stays_off_by_default` (ни одного `gh workflow enable users-digest.yml`, состояние не изменилось), `test_rerun_keeps_everything_when_told_so` (то же), `test_digest_schedule_is_enabled_on_yes_and_dry_run_follows` (`active`, без `disable`) | PASS |
| AC11 | `test_deploy_checks_the_webhook`, `test_digest_schedule_is_enabled_on_yes_and_dry_run_follows` и `test_dry_run_runs_when_the_schedule_is_already_on` (dry-run с `dry_run=true`, матрица в выводе), `test_digest_schedule_stays_off_by_default` («Пропущен», запусков нет), `test_rerun_keeps_everything_when_told_so` (без токена — команда `getWebhookInfo`), `test_failed_deploy_stops_with_the_run_link` | PASS |
| AC12 | `git diff -U0 docs/telegram-bot.md` — добавлен один абзац в «One-time setup» (+2 строки), удалений нет | PASS |
| AC13 | `uv run pytest` → 1126 passed (1079 + 47); тесты скрипта под `/bin/bash` 3.2.57 и bash 5.3.20; `bash -n` под обоими чисто. CI после пуша — не запускался (пуша не было) | NOT VERIFIED (CI) |
| AC14 | Живой прогон владельцем на Gorizont не делался | NOT VERIFIED |
| N1 | `test_bad_bot_token_is_asked_again` (кавычка → «недопустимые символы», неверный → «Telegram не принял»), `test_three_bad_bot_tokens_write_nothing` | PASS |
| N2 | `test_owner_id_must_be_a_positive_integer` (`abc`, `-100123` отклонены), `test_three_bad_owner_ids_write_nothing` (с пустым) | PASS |
| N3 | `test_rejected_service_tokens_write_no_secrets[cloudflare, no_subdomain, groq]` — ни `secret set`, ни `variable set` | PASS |
| N4 | `test_pat_without_access_to_the_data_repo_is_refused` | PASS |
| N5 | `test_pat_that_can_write_code_stops_the_setup` (остановка на первом же токене); мутация «409 не останавливает» роняет тест | PASS |
| N6 | `test_refuses_a_repository_the_user_does_not_admin` (origin `Thysrael/Horizon`) | PASS |
| N7 | `test_data_repo_name_is_validated`, `test_public_data_repo_needs_confirmation[Enter → отказ без записей, y → продолжение]` | PASS |
| N8 | `test_failed_deploy_stops_with_the_run_link`, `test_webhook_error_fails_the_setup` («Готово» не печатается) | PASS |
| ревью р.1 | Ошибка проверки репозитория данных или файла владельца, кроме 404, останавливает скрипт без `repo create`/записи: `test_data_repo_check_error_does_not_create_a_repo`, `test_owner_file_check_error_does_not_write_the_file`. Шесть новых и изменённых проверок падают на версии до правок | PASS |
| ревью р.2 | Проба PAT в коде: 404 — нет доступа (`test_private_code_repo_answering_404_counts_as_no_access`), 403 без «not accessible» (rate limit) — остановка (`test_other_403_on_the_code_repo_is_not_taken_as_no_access`), нет `README.md` в коде — остановка до запроса PAT (`test_pat_check_needs_readme_in_the_code_repo`); сбой `gh run list` — сообщение (`test_failing_run_list_is_reported`); удалена неиспользуемая `check_optional_groq_key`; справка и абзац в `docs/telegram-bot.md` описывают dry-run только при включённом расписании. Три новых теста падают на версии раунда 1 | PASS |
| review | reviewer | PASS |

Оговорка: поведение `gh`, Telegram, Cloudflare, GitHub и Groq в тестах — фейки по документации и пробе `409`. Реальные ответы проверяет только AC14.

## Knowledge

- Dead ends: none
- Decisions: none
- Known issues: none
