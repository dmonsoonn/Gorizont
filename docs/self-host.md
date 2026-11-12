---
layout: default
title: Свой Горизонт
---

# Свой Горизонт

Это руководство о том, как поднять собственный экземпляр Горизонта: свой Telegram-бот, который собирает новости из ваших источников и присылает дайджест вам и людям, которых вы одобрите. Сервер не нужен:

- **GitHub Actions** в вашем форке собирает источники и рассылает дайджесты (`users-digest.yml`);
- **Cloudflare Workers** держит бота: принимает команды и записывает настройки пользователей ([устройство бота](telegram-bot.md));
- **Groq** анализирует и пересказывает новости;
- **приватный репозиторий данных** хранит файлы пользователей `users/<id>.json` ([формат](multi-user.md)).

Все сервисы используются на бесплатных тарифах, ограничения описаны в разделе «Лимиты и стоимость».

## Что понадобится

- Аккаунты GitHub, Telegram, [Cloudflare](https://dash.cloudflare.com/sign-up) и [Groq](https://console.groq.com).
- Для скрипта установки: macOS или Linux (на Windows — WSL), установленные `git`, [`gh`](https://cli.github.com) (после `gh auth login`), `jq`, `curl` и `openssl`.

## Установка

1. Сделайте форк репозитория (**Fork** на странице GitHub) и склонируйте его:

   ```bash
   gh repo clone <you>/Gorizont
   cd Gorizont
   ```

2. Подготовьте то, что нельзя создать через API:
   - бота у [@BotFather](https://t.me/BotFather) (`/newbot`) и его токен;
   - токен Cloudflare по шаблону **Edit Cloudflare Workers** (My Profile → API Tokens) и поддомен `workers.dev` (Workers & Pages → Settings);
   - ключ Groq на [console.groq.com/keys](https://console.groq.com/keys), можно до трёх.
3. Запустите скрипт и отвечайте на вопросы. По ходу он попросит написать вашему боту `/start`, чтобы узнать ваш Telegram ID:

   ```bash
   ./scripts/setup.sh
   ```

Что скрипт делает сам:

- проверяет каждый токен перед записью: токен бота через `getMe`, токен Cloudflare через список аккаунтов, ключи Groq через список моделей;
- узнаёт ваш Telegram ID из сообщения `/start`, Account ID и адрес Worker (`https://gorizont-bot.<subdomain>.workers.dev`) из Cloudflare;
- создаёт приватный репозиторий данных `<you>/gorizont-data` с вашим файлом `users/<id>.json`;
- просит создать токен GitHub для бота (см. ниже) и проверяет его права;
- генерирует `BOT_WEBHOOK_SECRET`, записывает секреты и переменные Actions;
- включает Actions в форке, деплоит бота и проверяет webhook;
- спрашивает, включить ли ежечасную рассылку. По умолчанию нет, её можно включить позже (раздел «Рассылка»).

Справка: `./scripts/setup.sh --help`. Повторный запуск безопасен: для уже заданных значений скрипт спрашивает, заменить ли их, и ничего не перезаписывает без вашего согласия.

### Токен GitHub для бота

Бот записывает файлы пользователей через fine-grained personal access token. Скрипт покажет ссылку на страницу создания токена, когда репозиторий данных уже будет создан. Настройки токена:

- **Repository access:** Only select repositories → **только репозиторий данных**;
- **Permissions:** Repository permissions → **Contents: Read and write**, больше ничего.

Не давайте токену доступ к форку с кодом и не используйте classic token. Токен хранится в Cloudflare. Если он утечёт, с доступом только к репозиторию данных им можно испортить файлы пользователей, но нельзя изменить код и workflow, которые запускаются с вашими ключами ([ADR 0003](decisions/0003-instance-data-repo.md)). Скрипт проверяет это сам и отказывается записывать токен, у которого есть право записи в форк.

### Вручную

Без скрипта: выполните шаги из [One-time setup](telegram-bot.md#one-time-setup) и добавьте секреты для рассылки (Settings → Secrets and variables → Actions):

| Секрет | Значение |
|---|---|
| `GROQ_API_KEY` | ключ Groq |
| `GROQ_API_KEY_2`, `GROQ_API_KEY_3` | необязательные запасные ключи |
| `HORIZON_WEBHOOK_URL` | `https://api.telegram.org/bot<токен бота>/sendRichMessage` |
| `TELEGRAM_CHAT_ID` | ваш Telegram ID, как в `OWNER_ID` |

## Рассылка

Дайджесты рассылает workflow **Users Horizon Digest** (`users-digest.yml`). Он запускается каждый час и обрабатывает тех пользователей, у которых в этот час UTC подошло время: при `time_window_hours: 6` это 0, 6, 12 и 18 часов UTC.

В форке расписание выключено: GitHub [отключает scheduled workflows в форках публичных репозиториев](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows), а скрипт включает его, только если вы ответили «да». Включить:

- в браузере: Actions → **Users Horizon Digest** → **Enable workflow**;
- или командой: `gh workflow enable users-digest.yml`.

Проверить без отправки: Actions → **Users Horizon Digest** → **Run workflow** с галочкой **dry_run**. Прогон напечатает, кто должен получить дайджест в текущий час, и ничего не отправит. Тот же запуск без галочки отправляет дайджесты тем, у кого подошло время.

**Расписание отключается через 60 дней.** В публичном репозитории GitHub [выключает расписание, если в репозитории 60 дней не было активности](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows). Бот пишет коммиты в репозиторий данных, а не в форк, поэтому форк может «простаивать», даже когда дайджесты исправно приходят. Если рассылка прекратилась, проверьте вкладку Actions и включите workflow снова так же, как в первый раз.

Ещё о расписании: GitHub запускает его только на ветке по умолчанию и под нагрузкой (особенно в начале часа) [может задержать или пропустить запуск](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Первый дайджест

1. Напишите боту `/list`: бот отвечает, значит webhook работает.
2. Добавьте источник: пришлите ссылку `t.me/<канал>`, `r/<сабреддит>`, `github.com/<владелец>/<репозиторий>` или адрес сайта с RSS. Бот ответит «Добавлено: …». Все способы описаны в [документации бота](telegram-bot.md).
3. Включите рассылку (раздел «Рассылка») и дождитесь ближайшего часа UTC, кратного вашему окну (`/window` показывает окно). Или в такой час запустите **Users Horizon Digest** вручную без **dry_run**.
4. Дайджест придёт в личный чат с ботом. Если что-то пошло не так, смотрите раздел «Диагностика».

## Пользователи

Чтобы пригласить человека, дайте ему ссылку на бота. Он пишет `/start`, вам приходит заявка с кнопками **Одобрить** и **Отклонить**. Одобрение создаёт `users/<id>.json` в репозитории данных, дайджест пойдёт со следующего подходящего часа, когда у человека появятся источники. Заявку без ответа бот помнит 24 часа, отказ — бессрочно.

Команд для разбана и отключения в боте пока нет, это делается вручную.

**Разбанить отклонённого.** Отказ хранится в Workers KV как ключ `rejected:<id>`. Удалите его, и человек сможет снова отправить `/start`:

- в дашборде Cloudflare: Workers KV → пространство, привязанное к Worker `gorizont-bot` → ключ `rejected:<id>` → удалить;
- или командой из каталога `bot/` (нужны `npm ci` и `npx wrangler login`):

  ```bash
  npx wrangler kv namespace list
  npx wrangler kv key delete "rejected:<id>" --namespace-id <namespace_id> --remote
  ```

  `--remote` обязателен: без него wrangler 4 работает с локальной копией KV, а не с той, что использует бот.

**Отключить одобренного.** Удалите его файл из репозитория данных, и дайджесты ему больше не придут:

- в браузере: `<you>/gorizont-data` → `users/<id>.json` → **Delete file**;
- или командой:

  ```bash
  sha=$(gh api repos/<you>/gorizont-data/contents/users/<id>.json -q .sha)
  gh api -X DELETE repos/<you>/gorizont-data/contents/users/<id>.json -f message="Remove user <id>" -f sha="$sha"
  ```

Без файла человек снова может подать заявку. Чтобы этого не было, запишите отказ:

```bash
npx wrangler kv key put "rejected:<id>" 1 --namespace-id <namespace_id> --remote
```

## Обновление

В `main` нет личных данных: файлы пользователей лежат в репозитории данных, ID и адреса — в переменных Actions. Поэтому обновление — это синхронизация форка:

- в браузере: **Sync fork** → **Update branch** на странице форка;
- или командой: `gh repo sync <you>/Gorizont -b main`.

[Конфликтов](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/working-with-forks/syncing-a-fork) не будет, пока вы не меняли файлы в форке. Если меняли, GitHub предложит pull request.

После синхронизации откройте Actions и проверьте, что **Deploy Telegram Bot** прошёл с новыми изменениями `bot/`. Если запуска нет, нажмите **Run workflow** в **Deploy Telegram Bot** вручную. Новый код рассылки применяется сам со следующего запуска `users-digest.yml`.

## Лимиты и стоимость

| Сервис | Бесплатно | Что важно |
|---|---|---|
| [GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions) | стандартные раннеры в публичных репозиториях | Форк публичного репозитория публичный, поэтому сбор и рассылка ничего не стоят. |
| [Cloudflare Workers](https://developers.cloudflare.com/workers/platform/limits/) | 100 000 запросов в сутки | Один запрос — одно сообщение или нажатие кнопки, бот укладывается с большим запасом. |
| [Workers KV](https://developers.cloudflare.com/kv/platform/limits/) | 100 000 чтений и 1 000 записей в сутки | В KV хранятся заявки, отказы и незавершённые диалоги. |
| [Groq](https://console.groq.com/docs/rate-limits) | лимиты бесплатного плана на запросы и токены в минуту и в сутки | Лимиты считаются на организацию Groq, а не на ключ. Запасные ключи `GROQ_API_KEY_2` и `GROQ_API_KEY_3` помогают, только если созданы в других организациях. Свои лимиты смотрите на странице Limits в консоли Groq. |

Чем больше пользователей и источников, тем больше токенов Groq уходит на каждый запуск. Пользователи обрабатываются по очереди и делят одни ключи.

## Диагностика

**Бот не отвечает.**

1. Проверьте webhook:

   ```bash
   curl -s "https://api.telegram.org/bot<токен бота>/getWebhookInfo"
   ```

   `url` должен быть адресом Worker, `last_error_message` — пустым. Большой `pending_update_count` означает, что Telegram не может доставить сообщения.
2. `401` в `last_error_message`: секрет webhook не совпадает с `BOT_WEBHOOK_SECRET`. Перезапустите **Deploy Telegram Bot**: он заново регистрирует webhook с текущим секретом.
3. `500`: Worker не нашёл свою конфигурацию (`OWNER_ID`, `DATA_REPO`, токены). Проверьте секреты и переменные (можно повторно запустить `./scripts/setup.sh`) и перезапустите деплой.
4. Логи Worker в реальном времени: `npx wrangler tail` из каталога `bot/`.
5. Последний запуск **Deploy Telegram Bot** должен быть зелёным.

**Дайджест не пришёл.**

1. Workflow **Users Horizon Digest** включён (раздел «Рассылка»), в том числе после 60 дней простоя.
2. Запуск в нужный час был: Actions → **Users Horizon Digest**. Время считается в UTC, а час должен делиться на ваше окно (`/window`).
3. Ручной запуск с **dry_run** показывает, есть ли вы в списке на текущий час. Пустой список вне вашего часа — это нормально.
4. У вас есть включённые источники (`/list`). Если за окно в источниках не появилось ничего нового, дайджест не отправляется.
5. Если обработка упала, бот присылает сообщение об ошибке в ваш чат, а подробности есть в логе job `digest`.

## Удаление установки

1. Снимите webhook, чтобы Telegram перестал слать сообщения в Worker:

   ```bash
   curl -s "https://api.telegram.org/bot<токен бота>/deleteWebhook?drop_pending_updates=true"
   ```

   Самого бота можно удалить у @BotFather командой `/deletebot`.
2. Удалите Worker: в дашборде Cloudflare Workers & Pages → `gorizont-bot` → Settings → Delete, или `npx wrangler delete` из каталога `bot/`.
3. Удалите KV-пространство бота: `wrangler delete` его не удаляет. В дашборде Workers KV или командами:

   ```bash
   npx wrangler kv namespace list
   npx wrangler kv namespace delete --namespace-id <namespace_id>
   ```

4. Отзовите токен бота на GitHub (Settings → Developer settings → Personal access tokens) и токен Cloudflare (My Profile → API Tokens).
5. Удалите репозиторий данных (Settings → Delete this repository) или `gh repo delete <you>/gorizont-data`. Вместе с ним удаляются файлы и источники всех пользователей.
6. Удалите форк целиком или только секреты и переменные Actions в его настройках.
