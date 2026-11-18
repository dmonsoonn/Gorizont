---
id: 016
size: M
status: done
reopened: false
---

# Migrate Python setup actions to Node 24 and verify Ubuntu 26

## Goal

Обновить четыре пары Python setup-actions и подтвердить работу CI и обоих workflow дайджеста на Ubuntu 26.04. [#23](https://github.com/dmonsoonn/Gorizont/issues/23), [#24](https://github.com/dmonsoonn/Gorizont/issues/24).

## Acceptance criteria

1. Given три workflow с четырьмя парами setup-actions. When сверены changelog, требования раннера и `action.yml` выбранных релизов. Then все четыре пары ссылаются на релизы с `runs.using: node24` (`setup-python` v7.1.0 и `setup-uv` v10.3.3), Python остаётся 3.12, uv — 0.11.26, а `runs-on` — `ubuntu-latest`. В задаче зафиксирован вывод о влиянии изменений defaults `setup-uv`.
2. Given CI на коммите с обновлением. When обе джобы прошли на GitHub Actions. Then лог `Set up job` подтверждает Ubuntu 26.04, Python-джоба проходит `uv sync --extra dev --locked` и pytest, бот проходит тесты, typecheck и `wrangler deploy --dry-run`, а аннотации не содержат предупреждений о Node 20 для обновлённых actions.
3. Given изолированный инстанс с тестовыми данными и пользователем, которому положен дайджест в час запуска. When выполняется `users-digest.yml` с `dry_run: true`. Then job `plan` проходит на Ubuntu 26.04 и строит матрицу с тестовым пользователем, `digest` и `publish` имеют статус `skipped`, а у setup-actions нет аннотаций о Node 20.
4. Given изолированное окружение с тестовыми данными без доступа к рабочим получателям и рабочему Pages. When в GitHub Actions выполняется генерация через job `digest` в `users-digest.yml` и через `daily-summary.yml`. Then для обоих путей лог показывает Ubuntu 26.04, `uv sync` и `uv run horizon` завершаются успешно, результат содержит дайджест на тестовых данных, а setup-actions не дают аннотаций о Node 20.

## Negative scenarios

- N1. Given `dry_run: true` и тестовый пользователь с включённой публикацией в матрице. When завершается `plan`. Then `digest` и `publish` пропущены, отправки и записи в Pages отсутствуют.
- N2. Given лог показывает Ubuntu 24.04 либо на Ubuntu 26.04 шаг падает. When оценивается совместимость. Then проверка Ubuntu 26.04 остаётся открытой до подтверждённого успешного прогона. Если нужен переход на закреплённый образ, он согласуется отдельно.

## Scope

- Change: `.github/workflows/ci.yml`, `.github/workflows/daily-summary.yml`, `.github/workflows/users-digest.yml`. Изменения ограничены настройкой Python setup-actions. Изолированный прогон использует тестовые данные и отдельное от рабочего инстанса окружение.
- Do NOT touch: код приложения, тесты, lockfile, боевые настройки и секреты, расписание и логику рассылки, `bot-deploy.yml` и `deploy-docs.yml`. Проверка бота проходит через CI dry-run. Боевой деплой, рассылка и публикация в Pages вне объёма задачи.
- Pattern: порядок Checkout → Setup Python → Setup uv → `uv sync` совпадает в трёх существующих workflow. Для CI сохраняется `--locked`, для бота используется текущий `wrangler deploy --dry-run`, для планировщика — существующий вход `users-digest.yml` `dry_run` и проверка `if` в `digest` и `publish`.

## Plan

1. Сверить метаданные релизов, минимальную версию раннера и изменения настроек кэша; сохранить используемые версии Python и uv.
2. Заменить ссылки на setup-actions в четырёх парах. Проверить YAML, состав diff, Python-тесты и проверки Worker из CI.
3. После разрешения на публикацию проверить CI на точном коммите, затем запустить планировщик и оба пути генерации в изолированном GitHub Actions окружении. Записать ссылки на прогоны и фактический образ по `Set up job`.

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| 1 | `git diff --check`; разбор трёх YAML через Ruby `YAML.safe_load` и сравнение с `git show HEAD:<path>` с учётом только разрешённых изменений → четыре пары, прежние версии Python и uv, `ubuntu-latest`. Метаданные обоих релизов объявляют `node24`. | PASS |
| 2 | [CI на `1c0f333`](https://github.com/dmonsoonn/Gorizont/actions/runs/44335643677): обе джобы на `ubuntu-26.04`, runner `2.338.2`, образ `20261111.196.1`. `uv sync --extra dev --locked` прошёл, pytest → 1202 passed. Бот → 320 passed, typecheck и Worker dry-run прошли. API check annotations вернул только уведомления о миграции `ubuntu-latest`. | PASS |
| 3 | [Изолированный `planner-dry-run / plan`](https://github.com/dmonsoonn/Gorizont/actions/runs/44336276093/job/134913770900) на `ubuntu-26.04` вернул `{"include": [{"user": "4242", "publish_site": true}]}`. `digest` и `publish` пропущены, аннотации о Node 20 отсутствуют. | PASS |
| 4 | [Daily Summary](https://github.com/dmonsoonn/Gorizont/actions/runs/44336276093/job/134913770101) и [Users Digest](https://github.com/dmonsoonn/Gorizont/actions/runs/44336276093/job/134914311767) на `ubuntu-26.04`: `uv sync` и оба штатных вызова `uv run horizon` прошли. Проверка нашла текст тестовой статьи в обоих Markdown-дайджестах, доставка перехвачена, аннотации о Node 20 отсутствуют. | PASS |
| N1 | В [изолированном прогоне](https://github.com/dmonsoonn/Gorizont/actions/runs/44336276093) `gh run view --json jobs` подтвердил `skipped` у `planner-dry-run / digest` и `planner-dry-run / publish` при `publish_site: true`, поэтому обе джобы не выполняли действий. | PASS |
| N2 | При проверке сохранённых логов и статусов локальный предикат принял только `ubuntu-26.04` с `success`. Контрольные входы `ubuntu-24.04` с `success` и `ubuntu-26.04` с `failure` отклонены. Фактические успешные джобы в обоих прогонах подтвердили `ubuntu-26.04`. | PASS |
| review | Независимое ревью, второй раунд. Открытых замечаний нет. | PASS |
| done | `git diff --check`; workflow совпадают с `1c0f333`; изменения в тестах отсутствуют; `pytest -q tests/test_setup_script.py` → 47 тестов; `npm test` → 320 passed; `npm run typecheck` → exit 0. | PASS |

## Knowledge

- Dead ends: none
- Cause: закреплённые ранее `setup-python@v5` и `setup-uv@v6` объявляли `node20`, хотя GitHub-hosted раннеры уже исполняли JavaScript actions на Node 24. Параллельная миграция `ubuntu-latest` требовала подтверждения работы на фактическом образе.
- Decisions: сохранить `ubuntu-latest`; подтверждать фактический образ по `Set up job`; проверять два пути генерации изолированно, бот — сборкой CI.
- Isolation: штатные `daily-summary.yml` и `users-digest.yml` отключены в настройках репозитория, ручной dispatch вернул HTTP 422. Проверка идёт на отдельных копиях workflow в `verify/task-016-digest`, коммит `13677d3`. Сравнение YAML подтвердило совпадение `runs-on`, setup-шагов, команд CLI и обоих условий `dry_run`. Боевые переменные и секреты заменены тестовыми данными, webhook перехватывается, публикация Pages отключена. RSS и ответы AI подменены детерминированными данными, чтобы проверить генерацию без внешних сервисов.
- Publication: [черновой PR #27](https://github.com/dmonsoonn/Gorizont/pull/27) содержит только правки трёх workflow. Файлы изолированного прогона хранятся в отдельной ветке.
- Compatibility: переход `setup-python` на Node 24 требует runner v2.327.1 или новее. `setup-uv` v9 меняет `prune-cache` с `true` на `false`, поэтому во всех четырёх блоках указан `prune-cache: true`. Изменения `auto` в v10 касаются событий вне трёх изменённых workflow и не требуют отдельных настроек.
- Download: `setup-uv` v10.3.3 по умолчанию использует зеркало Astral для манифеста версий, с GitHub в качестве резервного источника. Существующая фиксация uv на 0.11.26 сохраняется. Доступность загрузки на раннере проверяется в AC2–4. [Release notes](https://github.com/astral-sh/setup-uv/releases/tag/v10.3.3), [action metadata](https://github.com/astral-sh/setup-uv/blob/v10.3.3/action.yml).
- Local checks: `.venv/bin/python -m pytest --tb=short` с доступом к DNS и локальным сокетам → 1204 passed; `uv sync --extra dev --locked --offline --check` с временным кэшем → `Would make no changes`; `npm test` → 320 passed; `npm run typecheck` → exit 0; `wrangler deploy --dry-run` → exit 0, 57.71 KiB.
- Sources: [setup-python v7.1.0](https://github.com/actions/setup-python/releases/tag/v7.1.0), [setup-uv v10.3.3](https://github.com/astral-sh/setup-uv/releases/tag/v10.3.3), [переход ubuntu-latest на Ubuntu 26.04](https://github.blog/changelog/2026-09-17-ubuntu-26-generally-available-and-latest-migration/).
- Known issues: `users-digest.yml` в режиме `dry_run` проверяет только планировщик. У `daily-summary.yml` ручной запуск включает отправку и публикацию при рабочей конфигурации.
