---
id: 011
size: M
status: in-progress
reopened: false
---

# `.github/README.md` и `docs/self-host.md`

## Goal

Человек, открывший форк Горизонта на GitHub, видит русский README про Горизонт и по `docs/self-host.md` поднимает свой экземпляр (скриптом или вручную), включает рассылку, получает первый дайджест и знает, как обслуживать установку (#17, п. «`.github/README.md` и `docs/self-host.md`»; аудит, пп. 9, 12, 13).

## Context (решения, уже принятые)

- Оба файла на русском. Остальные `docs/*.md` остаются на английском.
- `.github/README.md` — полный README, но про Горизонт: сценарий бота и Telegram в основе, возможности Horizon — кратким разделом со ссылками. Без спонсоров, бейджей Trendshift/HelloGitHub и QQ-группы апстрима. `README.md` и `README_*.md` апстрима не трогаем: GitHub показывает `.github/README.md` вместо корневого.
- Скриншотов нет: вместо них текстовый пример диалога с ботом. Скриншоты — отдельный issue после установки с нуля.
- `self-host.md` — сквозной гайд. Ручные шаги не дублируются: ссылка на `telegram-bot.md#one-time-setup`.
- Рассылка: описать только как включить расписание `users-digest.yml` (без упоминания открытых issue).
- Разбан и отключение пользователей: основной путь — веб-интерфейсы Cloudflare и GitHub, каждый шаг продублирован командой (`wrangler`, `gh`).
- Дополнительные разделы `self-host.md`: обновление через Sync fork, лимиты и стоимость, диагностика, удаление установки.
- Факты о внешних сервисах (поведение cron в форках и при неактивности, бесплатные лимиты, команды `wrangler`/`gh`/Telegram API) сверяются с официальной документацией; несверенное не пишется.
- `docs/` публикуется на GitHub Pages (Jekyll, kramdown): у `self-host.md` front matter как у соседних страниц. Якоря на русские заголовки у GitHub и kramdown разные, поэтому ссылок на якоря внутри русских документов избегаем.

## Acceptance criteria

1. Given изменения запушены When `gh api repos/dmonsoonn/Gorizont/readme -q .path` Then `.github/README.md`; `git diff --stat ba8927c -- README.md 'README_*.md'` пуст (файлы апстрима не изменены).
2. Given `.github/README.md` When читаем Then он на русском и содержит: что такое Горизонт и чем отличается от Horizon (ссылка на апстрим); как это работает (схема Telegram → Worker → `DATA_REPO` → `users-digest.yml` → Telegram); что умеет бот для пользователя (`/start`, добавление источников, `/list`, `/window`, `/chat`, `/help`) с текстовым примером диалога; «Поднять свой» — кратко и ссылка на `docs/self-host.md`; поддерживаемые источники; возможности Horizon кратко со ссылками на `docs/`; таблицу документации; статус проекта; лицензию и благодарность апстриму. Спонсорских блоков, бейджей Trendshift/HelloGitHub и ссылок на QQ-группу нет.
3. Given `docs/self-host.md` When читаем Then он на русском, с front matter `layout: default` и `title`, и содержит разделы: что понадобится (аккаунты и утилиты); установка скриптом (что подготовить, запуск, что скрипт делает сам, повторный запуск); ручная установка — одна ссылка на `telegram-bot.md#one-time-setup` без повторения шагов; включение рассылки; первый дайджест (как проверить, что всё работает); пользователи (одобрение, разбан, отключение); обновление; лимиты и стоимость; диагностика; удаление установки.
4. Given раздел про рассылку When читаем Then сказано, что в форке расписания workflow по умолчанию выключены, как включить `users-digest.yml` (вкладка Actions и `gh workflow enable`), как сделать пробный прогон (**dry_run**) и ручной запуск, и при каком условии GitHub сам отключает расписание и как его вернуть; формулировки и сроки совпадают с документацией GitHub, ссылка на неё есть в тексте, источник записан в Plan.
5. Given раздел «Пользователи» When читаем Then: разбан отклонённого — удалить ключ `rejected:<id>` из KV (путь в дашборде Cloudflare и команда `wrangler`), после чего человек снова шлёт `/start`; отключение одобренного — удалить `users/<id>.json` в `DATA_REPO` (веб GitHub и команда `gh`), а чтобы он не мог подать заявку снова — записать `rejected:<id>`; сказано, что команд для этого в боте пока нет. Поведение сверено с `bot/src/flows/access.ts`, команды — с документацией.
6. Given раздел «Обновление» When читаем Then описан Sync fork; когда после него нужен деплой бота (изменения в `bot/` при пуше деплоятся сами, Sync fork — проверить запуск `bot-deploy.yml`); что личных данных в `main` нет и конфликтов не будет, пока человек не правил файлы кода. Утверждение о том, запускает ли Sync fork workflow по `push`, сверено с документацией GitHub или помечено как непроверенное и не пишется.
7. Given раздел «Лимиты и стоимость» When читаем Then перечислены Groq (free tier, до трёх ключей), Cloudflare Workers и KV (free), GitHub Actions для публичного и приватного репозитория; каждая цифра взята с официальной страницы, ссылка в тексте, дата сверки записана в Plan.
8. Given раздел «Диагностика» When читаем Then есть «бот не отвечает» (`getWebhookInfo`, `last_error_message`, 401 из-за секрета, 500 из-за конфига Worker, `npx wrangler tail`) и «дайджест не пришёл» (расписание выключено, лог run, час UTC и `time_window_hours`, пустые источники, dry_run).
9. Given раздел «Удаление» When читаем Then: `deleteWebhook`, удаление Worker и KV namespace (дашборд и `wrangler`), удаление репозитория данных, отзыв PAT, удаление секретов и переменных или форка целиком. Команды сверены с документацией.
10. Given оба файла When скрипт проверки ссылок (в scratchpad) разбирает все относительные ссылки и картинки Then каждая указывает на существующий файл, а якорь — на существующий заголовок английского документа; ссылки из `.github/README.md` относительны к `.github/` (`../docs/…`).
11. Given оба файла When сверяем с кодом Then имена секретов и переменных, файлы workflow, команды бота, ключи KV, шаги и флаги `scripts/setup.sh`, имя Worker `gorizont-bot` совпадают с кодом (таблица сверки в Evidence).
12. Given `docs/telegram-bot.md` When читаем «One-time setup» Then добавлено одно предложение со ссылкой на `self-host.md`; остальной текст не изменён.
13. Given задача When смотрим issue форка Then заведён issue про скриншоты бота и дайджеста для README.
14. Given изменения When `uv run pytest` локально и CI (`ci.yml`, `deploy-docs.yml`) после пуша Then зелёные.

## Negative scenarios

- N1 (личные данные): Given новые файлы When `grep` по реальному `OWNER_ID`, `1043052224`, токенам, KV id, `dmonsoonn/gorizont-data` Then совпадений нет; в примерах только заглушки (`<id>`, `<you>/gorizont-data`). Ссылки на `dmonsoonn/Gorizont` как на дом проекта допустимы.
- N2 (доступ к чужому ресурсу): Given раздел про PAT When читаем Then прямо сказано: доступ только к репозиторию данных, Contents: Read and write, никакого доступа к репозиторию с кодом и классического PAT; объяснено почему (ADR 0003) и что `setup.sh` такой токен отклоняет.
- N3 (ввод): Given в файл временно вставлена битая ссылка и битый якорь When скрипт проверки ссылок Then он падает и называет обе; после отката — проходит.
- N4: Given утверждение о внешнем сервисе (срок, лимит, команда), которое не удалось сверить с документацией When пишем текст Then его нет в файлах, а в Knowledge записано, что не сверено.

## Scope

- Change: `.github/README.md` (новый), `docs/self-host.md` (новый), `docs/telegram-bot.md` (одно предложение), `tasks/011-readme-self-host.md`.
- Do NOT touch: `README.md`, `README_*.md`, остальные `docs/*.md`, `docs/_config.yml`, `docs/index.md`, `scripts/`, `bot/`, `src/`, `.github/workflows/*`, ADR, тесты.
- Pattern: `docs/telegram-bot.md` (front matter, короткие пункты, таблицы, тон); структура разделов `README.md` апстрима; терминология `README_ru.md`; текст `--help` в `scripts/setup.sh`.

## Plan

Сверено по документации (2026-11-12):
- GitHub, [Disabling and enabling a workflow](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows): «When a public repository is forked, scheduled workflows are disabled by default»; «In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days»; включение — Actions → workflow → **Enable workflow** или `gh workflow enable WORKFLOW`.
- GitHub, [Events that trigger workflows → schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows): расписание только на ветке по умолчанию; задержки под нагрузкой, особенно в начале часа, часть задач может быть отброшена. Вывод для гайда: коммиты бота идут в `DATA_REPO`, а не в форк, поэтому сам форк может «простаивать» 60 дней.
- GitHub, [Syncing a fork](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork): **Sync fork** → **Update branch**, `gh repo sync owner/fork -b main`; при конфликтах веб предлагает PR, CLI отказывает. Запускает ли sync workflow по `push` — в документации не сказано → в гайде не утверждаем, советуем проверить вкладку Actions и при необходимости запустить **Deploy Telegram Bot** вручную.
- GitHub, [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions): стандартные раннеры в публичных репозиториях бесплатны; для GitHub Free включено $12 в месяц на приватные (денежная сумма, не минуты), 500 MB артефактов. Форк публичного репозитория публичен.
- Cloudflare, [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): Free — 100 000 запросов в сутки (сброс в полночь UTC), 10 ms CPU на запрос. [KV limits](https://developers.cloudflare.com/kv/platform/limits/): Free — 100 000 чтений и 1 000 записей в разные ключи в сутки, 1 GB.
- Cloudflare, [KV commands](https://developers.cloudflare.com/kv/reference/kv-commands/): `wrangler kv namespace list`, `kv namespace delete --namespace-id`, `kv key put/delete <KEY> --namespace-id … --remote`. Wrangler 4 по умолчанию работает с локальным хранилищем (CHANGELOG 4.0.0, `isLocal` default `true`) → `--remote` обязателен. KV в `wrangler.jsonc` без `id` (создаётся при деплое) → в командах `--namespace-id`, а не `--binding`.
- `wrangler delete` удаляет только Worker; KV-пространство, привязанное к нему, не удаляется (`packages/wrangler/src/delete.ts`) → в «Удалении» отдельный шаг.
- Groq, [Rate limits](https://console.groq.com/docs/rate-limits): «Rate limits apply at the organization level, not individual users»; цифры бесплатного плана на странице не выведены, точные — на странице Limits в консоли. Вывод: запасные ключи `GROQ_API_KEY_2`/`_3` дают прибавку, только если они из других организаций. Цифр Groq в гайд не пишем.
- Telegram, [Bot API](https://core.telegram.org/bots/api): `deleteWebhook` (`drop_pending_updates`), `getWebhookInfo` (`url`, `last_error_message`, `pending_update_count`).

Сверено по коду:
- `bot/src/flows/access.ts`: `/start` → файл есть — «уже подключены»; `rejected:<id>` — «отклонил»; `pending:<id>` — «ждёт»; иначе заявка владельцу. Одобрение удаляет `pending:` и `rejected:`. → разбан = удалить `rejected:<id>`; отключение = удалить `users/<id>.json` и записать `rejected:<id>` (иначе человек снова подаст заявку).
- `users-digest.yml`: ручной запуск обрабатывает только тех, кто должен получить дайджест в текущий час UTC; `dry_run` только печатает матрицу.

Шаги:
1. `docs/self-host.md` (русский, front matter как у `telegram-bot.md`).
2. `.github/README.md` (русский, ссылки `../docs/…`, `../LICENSE`).
3. Одно предложение в `docs/telegram-bot.md`.
4. Скрипт проверки ссылок в scratchpad + мутация (N3); grep личных данных (N1); таблица сверки с кодом (AC11).
5. Issue про скриншоты (AC13), `uv run pytest`, коммит, пуш, CI.

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| 1 | `git diff ba8927c -- README.md 'README_*.md' \| wc -l` → 0. `gh api …/readme` — только после пуша | NOT VERIFIED (нет пуша) |
| 2 | grep разделов и ключевых строк `.github/README.md`: все 18 на месте, `/help` есть после правки; trendshift/hellogithub/QQ/спонсоры — 0 совпадений | PASS |
| 3 | `head -4` (front matter `layout: default`, `title: Свой Горизонт`), `grep '^## \|^### '`: 9 разделов + «Токен GitHub для бота», «Вручную» | PASS |
| 4 | grep: `gh workflow enable users-digest.yml`, **Enable workflow**, **dry_run**, **Run workflow**, «60 дней», ссылка `disable-and-enable-workflows`; источник в Plan | PASS |
| 5 | grep: `rejected:<id>`, `kv key delete … --remote`, `gh api -X DELETE`, `kv key put "rejected:<id>"`, «команд … пока нет»; поведение сверено с `bot/src/flows/access.ts` (Plan) | PASS |
| 6 | grep: **Sync fork**, `gh repo sync`, **Deploy Telegram Bot**, «В `main` нет личных данных», «Конфликтов»; запуск workflow при sync не утверждается | PASS |
| 7 | grep ссылок на 4 официальные страницы лимитов, `GROQ_API_KEY_2`; цифры совпадают с Plan (сверка 2026-11-12) | PASS |
| 8 | grep: `getWebhookInfo`, `last_error_message`, `` `401` ``, `` `500` ``, `npx wrangler tail`, `dry_run`, `/window` | PASS |
| 9 | grep: `deleteWebhook`, `npx wrangler delete`, `kv namespace delete`, «Отзовите токен», `gh repo delete`, «секреты и переменные» | PASS |
| 10 | `python3 -I scratchpad/check_links.py .github/README.md docs/self-host.md docs/telegram-bot.md` → `checked 3 files, 0 errors` | PASS |
| 11 | Каждое из 13 имён секретов/переменных из текста найдено в `.github/workflows/*.yml` / `scripts/setup.sh`; `Users Horizon Digest`, `Deploy Telegram Bot`, `gorizont-bot` (`bot/wrangler.jsonc`), `gorizont-data`/`workers.dev`/`sendRichMessage` (`setup.sh`), `pending:`/`rejected:` (`types.ts`), 20 источников, 24 ч, окно 6 ч, `WINDOWS = [3, 6, 12, 24]`, кнопка `✓ 6 ч` (`texts.ts:81`), пустой дайджест не отправляется (`orchestrator.py:281`), `/start` скрипт просит сам (`setup.sh:186`) | PASS |
| 12 | `git diff --word-diff=plain docs/telegram-bot.md` → только `{+The full walkthrough … [Self-hosting](self-host.md) (in Russian).+}` | PASS |
| 13 | `gh issue create` → https://github.com/dmonsoonn/Gorizont/issues/26 | PASS |
| 14 | `uv run pytest` → `1126 passed in 62.41s` (после последней правки). CI `ci.yml` / `deploy-docs.yml` — после пуша | NOT VERIFIED (нет пуша) |
| N1 | grep по `vars.OWNER_ID`, `1043052224`, `vars.DATA_REPO`, хосту `vars.BOT_URL`, `ghp_`, `github_pat_`, `gsk_`, 32-hex → 0 совпадений в обоих файлах | PASS |
| N2 | grep `self-host.md`: «только репозиторий данных», «Contents: Read and write», «classic token», «ADR 0003», «отказывается записывать токен» | PASS |
| N3 | мутация: дописаны `[x](missing.md)` и `[y](telegram-bot.md#no-such-section)` → `2 errors`, exit 1, обе названы; после отката → `0 errors`, exit 0 | PASS |
| N4 | Несверенное не написано: запуск workflow при Sync fork, цифры Groq free, путь до KV в дашборде дан без точных пунктов меню; записано в Knowledge | PASS |
| review | reviewer | PASS |

## Knowledge

- Dead ends: none
- Decisions: в «Вручную» добавлена таблица секретов рассылки (`GROQ_API_KEY*`, `HORIZON_WEBHOOK_URL`, `TELEGRAM_CHAT_ID`): ручные шаги `telegram-bot.md` их не упоминают, без них рассылка не работает. Это дополнение, а не повтор шагов. Пример RSS в README — прямой фид `simonwillison.net/atom/everything/` (заголовок `Simon Willison's Weblog` проверен `curl`), а не адрес сайта: на сайте может быть несколько фидов, и бот предложит выбор.
- Not verified externally: запускает ли Sync fork workflow по `push`; точные цифры Groq free (на странице rate limits их нет); точные пункты меню дашборда Cloudflare для KV и удаления Worker; формат имени KV-пространства, которое создаёт `wrangler deploy` (поэтому в командах `kv namespace list` + `--namespace-id`).
- Known issues: в ручных шагах `docs/telegram-bot.md` нет секретов рассылки (закрыто таблицей в `self-host.md`, сам `telegram-bot.md` не правился).
