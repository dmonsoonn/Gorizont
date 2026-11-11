#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
WORKER_NAME="gorizont-bot"
PROBE_SHA="0000000000000000000000000000000000000000"
SAFE_SECRET='^[A-Za-z0-9_.:-]+$'

usage() {
  cat <<'EOF'
Использование: ./scripts/setup.sh

Настраивает ваш форк Горизонта: репозиторий данных, секреты и переменные
GitHub Actions, деплой Telegram-бота. Запускайте в клоне своего форка.

Нужно установить: gh (выполнен gh auth login), jq, curl, openssl, git.

Подготовьте заранее:
  1. Бота у @BotFather и его токен.
  2. Токен Cloudflare по шаблону «Edit Cloudflare Workers» и поддомен
     workers.dev (Workers & Pages → Settings).
  3. Ключ Groq (console.groq.com/keys), можно до трёх.
  Fine-grained PAT скрипт попросит создать, когда появится репозиторий данных.

Что скрипт делает сам:
  - проверяет каждый токен перед записью;
  - узнаёт ваш Telegram ID через бота, Account ID и адрес Worker через Cloudflare;
  - создаёт приватный репозиторий данных с файлом владельца;
  - генерирует BOT_WEBHOOK_SECRET;
  - записывает секреты и переменные, включает Actions, деплоит бота;
  - спрашивает, включить ли ежечасную рассылку (по умолчанию нет), и, если
    она включена, запускает пробный прогон (dry run).

Повторный запуск безопасен: для уже заданных значений скрипт спрашивает,
заменить ли их.
EOF
}

say() { printf '%s\n' "$*"; }
die() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }

ask() {
  local prompt=$1 default=${2:-} answer
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$prompt" "$default" >&2
  else
    printf '%s: ' "$prompt" >&2
  fi
  IFS= read -r answer || die "ввод закончился"
  REPLY=${answer:-$default}
}

ask_secret() {
  local answer
  printf '%s: ' "$1" >&2
  if [ -t 0 ]; then
    IFS= read -rs answer || die "ввод закончился"
    printf '\n' >&2
  else
    IFS= read -r answer || die "ввод закончился"
  fi
  REPLY=$answer
}

confirm() {
  local prompt=$1 default=$2
  if [ "$default" = y ]; then ask "$prompt [Y/n]"; else ask "$prompt [y/N]"; fi
  case "${REPLY:-$default}" in
    y|Y|yes|д|Д|да) return 0 ;;
    *) return 1 ;;
  esac
}

request() {
  local method=$1 url=$2 token=$3 body=${4:-} out
  local args=(-sS -X "$method" -K - -w '\n%{http_code}' -H 'Accept: application/json')
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  out=$(
    {
      printf 'url = "%s"\n' "$url"
      if [ -n "$token" ]; then
        printf 'header = "Authorization: Bearer %s"\n' "$token"
      fi
    } | curl "${args[@]}"
  ) || out=$'\n000'
  HTTP_STATUS=${out##*$'\n'}
  HTTP_BODY=${out%$'\n'*}
}

telegram() {
  request GET "https://api.telegram.org/bot$1/$2" ""
}

read_valid() {
  local label=$1 check=$2 secret=${3:-} default=${4:-} attempt
  for attempt in 1 2 3; do
    if [ -n "$secret" ]; then ask_secret "$label"; else ask "$label" "$default"; fi
    if [ -n "$secret" ] && ! [[ $REPLY =~ $SAFE_SECRET ]]; then
      say "Значение содержит недопустимые символы."
    elif "$check" "$REPLY"; then
      return 0
    fi
  done
  die "$label: три неудачные попытки"
}

has_secret() { grep -qx "$1" <<<"$EXISTING_SECRETS"; }
var_value() { jq -r --arg n "$1" '.[] | select(.name == $n) | .value' <<<"$EXISTING_VARS"; }

SECRET_NAMES=()
SECRET_VALUES=()
put_secret() {
  SECRET_NAMES+=("$1")
  SECRET_VALUES+=("$2")
}

keep_group() {
  local name
  for name in "$@"; do
    case $name in
      vars.*) [ -n "$(var_value "${name#vars.}")" ] || return 1 ;;
      *) has_secret "$name" || return 1 ;;
    esac
  done
  ! confirm "Уже заданы: $*. Заменить?" n
}

preflight() {
  local tool url
  for tool in gh jq curl openssl git; do
    command -v "$tool" >/dev/null 2>&1 || die "не найдена утилита $tool"
  done
  gh auth status >/dev/null 2>&1 || die "gh не авторизован: выполните gh auth login"
  url=$(git -C "$PROJECT_DIR" remote get-url origin 2>/dev/null) || die "у репозитория нет remote origin"
  case $url in
    https://github.com/*) CODE_REPO=${url#https://github.com/} ;;
    git@github.com:*) CODE_REPO=${url#git@github.com:} ;;
    ssh://git@github.com/*) CODE_REPO=${url#ssh://git@github.com/} ;;
    *) die "origin не на GitHub: $url" ;;
  esac
  CODE_REPO=${CODE_REPO%/}
  CODE_REPO=${CODE_REPO%.git}
  [[ $CODE_REPO =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "не удалось разобрать origin: $url"
  LOGIN=$(gh api user -q .login)
  [ "$(gh api "repos/$CODE_REPO" -q .permissions.admin 2>/dev/null)" = true ] \
    || die "у $LOGIN нет прав администратора в $CODE_REPO: запускайте скрипт в клоне своего форка"
  EXISTING_SECRETS=$(gh secret list -R "$CODE_REPO" --json name -q '.[].name')
  EXISTING_VARS=$(gh variable list -R "$CODE_REPO" --json name,value)
  say "Репозиторий: $CODE_REPO"
}

check_bot_token() {
  [[ $1 =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || { say "Токен бота выглядит как 123456:ABC-def…"; return 1; }
  telegram "$1" getMe
  if [ "$HTTP_STATUS" != 200 ] || [ "$(jq -r '.ok' <<<"$HTTP_BODY" 2>/dev/null)" != true ]; then
    say "Telegram не принял токен."
    return 1
  fi
  say "Бот: @$(jq -r '.result.username' <<<"$HTTP_BODY")"
}

step_telegram() {
  BOT_TOKEN=""
  say ""
  say "== Telegram-бот"
  if keep_group TELEGRAM_BOT_TOKEN HORIZON_WEBHOOK_URL; then return; fi
  read_valid "Токен бота от @BotFather" check_bot_token secret
  BOT_TOKEN=$REPLY
  put_secret TELEGRAM_BOT_TOKEN "$BOT_TOKEN"
  put_secret HORIZON_WEBHOOK_URL "https://api.telegram.org/bot$BOT_TOKEN/sendRichMessage"
}

check_owner_id() {
  [[ $1 =~ ^[1-9][0-9]*$ ]] || { say "ID — положительное целое число."; return 1; }
}

step_owner() {
  local current found=""
  say ""
  say "== Владелец"
  current=$(var_value OWNER_ID)
  if [ -z "$current" ] && [ -n "$BOT_TOKEN" ]; then
    ask "Отправьте боту /start в Telegram и нажмите Enter"
    telegram "$BOT_TOKEN" getUpdates
    if [ "$HTTP_STATUS" = 200 ]; then
      found=$(jq -r '[.result[].message | select(. != null and .chat.type == "private") | .from.id] | last // empty' <<<"$HTTP_BODY")
    fi
    [ -n "$found" ] || say "Сообщение не найдено, введите ID вручную (его показывает @userinfobot)."
  fi
  read_valid "Ваш Telegram ID (OWNER_ID)" check_owner_id "" "${current:-$found}"
  OWNER_ID=$REPLY
  if [ "$OWNER_ID" != "$current" ] || ! has_secret TELEGRAM_CHAT_ID; then
    put_secret TELEGRAM_CHAT_ID "$OWNER_ID"
  fi
}

check_cloudflare_token() {
  local count
  request GET "https://api.cloudflare.com/client/v4/accounts" "$1"
  count=$(jq -r 'if .success == true then (.result | length) else 0 end' <<<"$HTTP_BODY" 2>/dev/null || echo 0)
  if [ "$HTTP_STATUS" != 200 ] || [ "$count" = 0 ]; then
    say "Cloudflare не вернул ни одного аккаунта для этого токена."
    return 1
  fi
}

step_cloudflare() {
  local token count index subdomain
  say ""
  say "== Cloudflare"
  if keep_group CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID vars.BOT_URL; then
    BOT_URL=$(var_value BOT_URL)
    return
  fi
  read_valid "Токен Cloudflare (шаблон «Edit Cloudflare Workers»)" check_cloudflare_token secret
  token=$REPLY
  count=$(jq -r '.result | length' <<<"$HTTP_BODY")
  index=0
  if [ "$count" -gt 1 ]; then
    jq -r '.result | to_entries[] | "\(.key + 1)) \(.value.name) (\(.value.id))"' <<<"$HTTP_BODY"
    ask "Номер аккаунта" 1
    [[ $REPLY =~ ^[0-9]+$ ]] && [ "$REPLY" -ge 1 ] && [ "$REPLY" -le "$count" ] || die "нет аккаунта с номером $REPLY"
    index=$((REPLY - 1))
  fi
  ACCOUNT_ID=$(jq -r ".result[$index].id" <<<"$HTTP_BODY")
  request GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/subdomain" "$token"
  subdomain=$(jq -r '.result.subdomain // empty' <<<"$HTTP_BODY" 2>/dev/null || true)
  [ "$HTTP_STATUS" = 200 ] && [ -n "$subdomain" ] \
    || die "у аккаунта нет поддомена workers.dev: откройте Workers & Pages в Cloudflare, задайте его и запустите скрипт снова"
  BOT_URL="https://$WORKER_NAME.$subdomain.workers.dev"
  say "Адрес бота: $BOT_URL"
  put_secret CLOUDFLARE_API_TOKEN "$token"
  put_secret CLOUDFLARE_ACCOUNT_ID "$ACCOUNT_ID"
}

step_webhook_secret() {
  say ""
  say "== Секрет webhook"
  if keep_group BOT_WEBHOOK_SECRET; then return; fi
  put_secret BOT_WEBHOOK_SECRET "$(openssl rand -hex 32)"
  say "BOT_WEBHOOK_SECRET сгенерирован."
}

check_repo_name() {
  [[ $1 =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { say "Нужен формат owner/name."; return 1; }
}

step_data_repo() {
  local private found content
  say ""
  say "== Репозиторий данных"
  DATA_REPO=$(var_value DATA_REPO)
  read_valid "Репозиторий данных (DATA_REPO)" check_repo_name "" "${DATA_REPO:-$LOGIN/gorizont-data}"
  DATA_REPO=$REPLY
  if private=$(gh api "repos/$DATA_REPO" -q .private 2>&1); then
    if [ "$private" != true ]; then
      confirm "$DATA_REPO публичный: ID и источники пользователей будут видны всем. Продолжить?" n \
        || die "сделайте $DATA_REPO приватным или укажите другой репозиторий"
    fi
    say "$DATA_REPO уже есть."
  elif [[ $private == *"HTTP 404"* ]]; then
    gh repo create "$DATA_REPO" --private --add-readme --description "Gorizont instance data" >/dev/null \
      || die "не удалось создать $DATA_REPO"
    say "Создан приватный $DATA_REPO."
  else
    die "не удалось проверить $DATA_REPO: $private"
  fi
  if found=$(gh api "repos/$DATA_REPO/contents/users/$OWNER_ID.json" --silent 2>&1); then
    say "Файл владельца users/$OWNER_ID.json уже есть."
  elif [[ $found != *"HTTP 404"* ]]; then
    die "не удалось проверить users/$OWNER_ID.json в $DATA_REPO: $found"
  else
    content=$(jq -n --argjson id "$OWNER_ID" '{id: $id, time_window_hours: 6}' | jq -Rrs @base64)
    gh api -X PUT "repos/$DATA_REPO/contents/users/$OWNER_ID.json" \
      -f message="chore(users): add user $OWNER_ID via setup" -f content="$content" --silent \
      || die "не удалось записать users/$OWNER_ID.json в $DATA_REPO"
    say "Записан users/$OWNER_ID.json."
  fi
}

probe_write() {
  request PUT "https://api.github.com/repos/$1/contents/$2" "$3" \
    "{\"message\":\"setup probe\",\"content\":\"eA==\",\"sha\":\"$PROBE_SHA\"}"
}

check_pat() {
  probe_write "$DATA_REPO" "users/$OWNER_ID.json" "$1"
  case $HTTP_STATUS in
    409) ;;
    401) say "GitHub не принял токен."; return 1 ;;
    *) say "У токена нет записи в $DATA_REPO: выдайте ему доступ к $DATA_REPO, Contents: Read and write."; return 1 ;;
  esac
  probe_write "$CODE_REPO" README.md "$1"
  case $HTTP_STATUS in
    404) ;;
    403) [[ $HTTP_BODY == *"not accessible"* ]] \
      || die "не удалось проверить доступ токена к $CODE_REPO (HTTP 403): $(jq -r '.message // empty' <<<"$HTTP_BODY" 2>/dev/null)" ;;
    409) die "токен может писать в $CODE_REPO. Создайте fine-grained PAT только на $DATA_REPO (Only select repositories): утёкший токен не должен менять код (docs/decisions/0003-instance-data-repo.md)" ;;
    *) die "не удалось проверить доступ токена к $CODE_REPO (HTTP $HTTP_STATUS)" ;;
  esac
}

step_pat() {
  local readme
  say ""
  say "== Токен GitHub для бота"
  if [ "$DATA_REPO" = "$(var_value DATA_REPO)" ] && keep_group BOT_GITHUB_TOKEN; then return; fi
  readme=$(gh api "repos/$CODE_REPO/contents/README.md" --silent 2>&1) \
    || die "не удалось найти README.md в $CODE_REPO, по нему проверяется, что токен не может писать в код: $readme"
  say "Создайте fine-grained token: https://github.com/settings/personal-access-tokens/new"
  say "  Repository access: Only select repositories → $DATA_REPO"
  say "  Permissions: Contents → Read and write. Больше ничего."
  read_valid "Токен (github_pat_…)" check_pat secret
  put_secret BOT_GITHUB_TOKEN "$REPLY"
}

check_groq_key() {
  request GET "https://api.groq.com/openai/v1/models" "$1"
  [ "$HTTP_STATUS" = 200 ] || { say "Groq не принял ключ (HTTP $HTTP_STATUS)."; return 1; }
}

step_groq() {
  local name
  say ""
  say "== Groq"
  if keep_group GROQ_API_KEY; then return; fi
  read_valid "Ключ Groq (gsk_…)" check_groq_key secret
  put_secret GROQ_API_KEY "$REPLY"
  for name in GROQ_API_KEY_2 GROQ_API_KEY_3; do
    ask_secret "Дополнительный ключ $name, Enter — пропустить"
    [ -n "$REPLY" ] || break
    [[ $REPLY =~ $SAFE_SECRET ]] && check_groq_key "$REPLY" || die "ключ $name не принят"
    put_secret "$name" "$REPLY"
  done
}

apply() {
  local i name value
  say ""
  say "== Запись в $CODE_REPO"
  i=0
  while [ "$i" -lt "${#SECRET_NAMES[@]}" ]; do
    printf '%s' "${SECRET_VALUES[$i]}" | gh secret set "${SECRET_NAMES[$i]}" -R "$CODE_REPO" >/dev/null
    say "Секрет ${SECRET_NAMES[$i]} записан."
    i=$((i + 1))
  done
  for name in OWNER_ID DATA_REPO BOT_URL; do
    value=${!name}
    if [ "$value" != "$(var_value "$name")" ]; then
      gh variable set "$name" -R "$CODE_REPO" --body "$value" >/dev/null
      say "Переменная $name = $value"
    fi
  done
}

enable_core_workflows() {
  local enabled
  enabled=$(gh api "repos/$CODE_REPO/actions/permissions" -q .enabled 2>&1) || { ACTIONS_ERROR=$enabled; return 1; }
  if [ "$enabled" != true ]; then
    ACTIONS_ERROR=$(gh api -X PUT "repos/$CODE_REPO/actions/permissions" -F enabled=true --silent 2>&1) || return 1
  fi
  ACTIONS_ERROR=$(gh workflow enable bot-deploy.yml -R "$CODE_REPO" 2>&1) || return 1
  ACTIONS_ERROR=$(gh workflow enable ci.yml -R "$CODE_REPO" 2>&1) || return 1
}

step_actions() {
  say ""
  say "== GitHub Actions"
  if ! enable_core_workflows; then
    say "Не удалось включить Actions: $ACTIONS_ERROR"
    say "Откройте https://github.com/$CODE_REPO/actions и включите workflows."
    ask "Нажмите Enter, когда включите"
    enable_core_workflows || die "Actions в $CODE_REPO всё ещё выключены: $ACTIONS_ERROR"
  fi
  say "Deploy Telegram Bot и CI включены."
  DIGEST_STATE=$(gh api "repos/$CODE_REPO/actions/workflows/users-digest.yml" -q .state) \
    || die "не удалось узнать состояние users-digest.yml в $CODE_REPO"
  if [ "$DIGEST_STATE" = active ]; then
    say "Ежечасная рассылка (users-digest.yml) уже включена."
  elif confirm "Включить ежечасную рассылку дайджестов (users-digest.yml)?" n; then
    gh workflow enable users-digest.yml -R "$CODE_REPO" >/dev/null
    DIGEST_STATE=active
    say "Рассылка включена."
  else
    say "Рассылка выключена. Включить позже: gh workflow enable users-digest.yml -R $CODE_REPO"
  fi
}

latest_run() {
  gh run list -R "$CODE_REPO" --workflow "$1" --event workflow_dispatch -L 1 --json databaseId -q '.[0].databaseId // 0'
}

dispatch() {
  local workflow=$1 before attempt=0
  shift
  before=$(latest_run "$workflow") || die "не удалось получить список запусков $workflow"
  gh workflow run "$workflow" -R "$CODE_REPO" "$@" >/dev/null || die "не удалось запустить $workflow"
  while [ "$attempt" -lt 30 ]; do
    RUN_ID=$(latest_run "$workflow") || die "не удалось получить список запусков $workflow"
    [ "$RUN_ID" -gt "$before" ] && return 0
    attempt=$((attempt + 1))
    sleep 2
  done
  die "запуск $workflow не появился за минуту"
}

watch_run() {
  gh run watch "$RUN_ID" -R "$CODE_REPO" --exit-status >/dev/null 2>&1 \
    || die "$1 завершился с ошибкой: $(gh run view "$RUN_ID" -R "$CODE_REPO" --json url -q .url)"
}

step_deploy() {
  local url error
  say ""
  say "== Деплой бота"
  dispatch bot-deploy.yml
  say "Запущен Deploy Telegram Bot, жду завершения…"
  watch_run "Deploy Telegram Bot"
  say "Бот задеплоен."
  if [ -n "$BOT_TOKEN" ]; then
    telegram "$BOT_TOKEN" getWebhookInfo
    url=$(jq -r '.result.url // empty' <<<"$HTTP_BODY")
    error=$(jq -r '.result.last_error_message // empty' <<<"$HTTP_BODY")
    [ "$url" = "$BOT_URL" ] || die "webhook бота указывает на '$url', ожидался $BOT_URL"
    [ -z "$error" ] || die "Telegram сообщает об ошибке webhook: $error"
    say "Webhook в порядке: $url"
  else
    say "Проверить webhook: curl -s \"https://api.telegram.org/bot<токен>/getWebhookInfo\""
  fi
}

step_dry_run() {
  local matrix
  say ""
  say "== Пробный прогон рассылки"
  if [ "$DIGEST_STATE" != active ]; then
    say "Пропущен: расписание выключено. После включения: gh workflow run users-digest.yml -R $CODE_REPO -f dry_run=true"
    return
  fi
  dispatch users-digest.yml -f dry_run=true
  watch_run "Пробный прогон users-digest.yml"
  matrix=$(gh run view "$RUN_ID" -R "$CODE_REPO" --log 2>/dev/null | grep -m1 -o '{"include".*' || true)
  say "Пользователи этого часа: ${matrix:-не найдены в логе}"
}

main() {
  case ${1:-} in
    -h|--help) usage; exit 0 ;;
    "") ;;
    *) usage >&2; exit 2 ;;
  esac
  preflight
  step_telegram
  step_owner
  step_cloudflare
  step_webhook_secret
  step_data_repo
  step_pat
  step_groq
  apply
  step_actions
  step_deploy
  step_dry_run
  say ""
  say "Готово. Напишите боту /start или /help."
}

main "$@"
