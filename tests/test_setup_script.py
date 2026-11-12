import json
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/setup.sh"

BOT = "123456:SECRETbotTOKEN"
CF = "cfSECRETtoken"
PAT = "github_pat_SECRETgood"
PAT_EVERYWHERE = "github_pat_SECRETeverywhere"
PAT_NOWHERE = "github_pat_SECRETnowhere"
GROQ = "gsk_SECRETone"
GROQ_2 = "gsk_SECRETtwo"
GROQ_3 = "gsk_SECRETthree"
HOOK = "ab" * 32
SECRET_VALUES = [BOT, CF, PAT, PAT_EVERYWHERE, PAT_NOWHERE, GROQ, GROQ_2, GROQ_3, HOOK]

FRESH = [BOT, "", "", CF, "", PAT, GROQ, "", ""]

FAKE = r'''
import base64, json, os, re, sys
from pathlib import Path

STATE = Path(os.environ["SETUP_FAKE_STATE"])
LOG = Path(os.environ["SETUP_FAKE_LOG"])
WITH_VALUE = {"-X", "-q", "-f", "-F", "-R", "--json", "-L", "--workflow", "--event", "--body", "--description", "-K", "-w", "-H", "--data"}


def log(cmd, argv, stdin):
    with LOG.open("a") as f:
        f.write(json.dumps({"cmd": cmd, "argv": argv, "stdin": stdin}) + "\n")


def opt(argv, name):
    return argv[argv.index(name) + 1] if name in argv else None


def opts(argv, name):
    return [argv[i + 1] for i, a in enumerate(argv) if a == name]


def positionals(argv):
    result, i = [], 0
    while i < len(argv):
        if argv[i] in WITH_VALUE:
            i += 2
        elif argv[i].startswith("-"):
            i += 1
        else:
            result.append(argv[i])
            i += 1
    return result


def fail(message="HTTP 404"):
    print(message, file=sys.stderr)
    return 1


def gh_api(s, argv):
    method = opt(argv, "-X") or "GET"
    path = positionals(argv)[1]
    query = opt(argv, "-q")
    if path in s.get("api_errors", {}):
        return fail(s["api_errors"][path])
    if path == "user":
        print(s["login"])
        return 0
    m = re.match(r"repos/([^/]+/[^/]+)(?:/(.*))?$", path)
    repo, rest = m.group(1), m.group(2) or ""
    if rest == "":
        if query == ".permissions.admin":
            print("true" if repo == s["code_repo"] and s["admin"] else "false")
            return 0
        if repo not in s["repos"]:
            return fail()
        print("true" if s["repos"][repo]["private"] else "false")
        return 0
    if rest.startswith("contents/"):
        name = rest[len("contents/"):]
        files = s["repos"].get(repo, {}).get("files", {})
        if method == "GET":
            return 0 if name in files else fail()
        fields = dict(f.split("=", 1) for f in opts(argv, "-f"))
        files[name] = base64.b64decode(fields["content"]).decode()
        return 0
    if rest == "actions/permissions":
        if method == "GET":
            print("true" if s["actions_enabled"] else "false")
            return 0
        if s["actions_put_failures"] > 0:
            s["actions_put_failures"] -= 1
            return fail("HTTP 403")
        s["actions_enabled"] = True
        return 0
    if rest.startswith("actions/workflows/"):
        print(s["workflows"][rest.rsplit("/", 1)[1]])
        return 0
    return fail("unexpected api " + path)


def gh(s, argv):
    stdin = sys.stdin.read() if argv[:2] == ["secret", "set"] else None
    log("gh", argv, stdin)
    pos = positionals(argv)
    head = pos[:2]
    if head == ["auth", "status"]:
        return 0 if s["auth"] else 1
    if pos[0] == "api":
        return gh_api(s, argv)
    if head == ["secret", "list"]:
        if s["secrets"]:
            print("\n".join(s["secrets"]))
        return 0
    if head == ["variable", "list"]:
        print(json.dumps([{"name": k, "value": v} for k, v in s["vars"].items()]))
        return 0
    if head == ["secret", "set"]:
        s["secrets"][pos[2]] = stdin
        return 0
    if head == ["variable", "set"]:
        s["vars"][pos[2]] = opt(argv, "--body")
        return 0
    if head == ["repo", "create"]:
        if pos[2] in s["repos"]:
            return fail("already exists")
        s["repos"][pos[2]] = {"private": "--private" in argv, "files": {"README.md": ""}}
        return 0
    if head == ["workflow", "enable"]:
        if not s["actions_enabled"]:
            return fail("HTTP 403")
        s["workflows"][pos[2]] = "active"
        return 0
    if head == ["workflow", "disable"]:
        s["workflows"][pos[2]] = "disabled_manually"
        return 0
    if head == ["workflow", "run"]:
        workflow = pos[2]
        if s["workflows"][workflow] != "active":
            return fail("workflow is disabled")
        s["runs"].append({
            "id": 100 + len(s["runs"]),
            "workflow": workflow,
            "fields": opts(argv, "-f"),
            "conclusion": s["conclusions"].get(workflow, "success"),
        })
        return 0
    if head == ["run", "list"]:
        if s.get("run_list_fails"):
            return fail("HTTP 502")
        ids = [r["id"] for r in s["runs"] if r["workflow"] == opt(argv, "--workflow")]
        print(ids[-1] if ids else 0)
        return 0
    if head == ["run", "watch"]:
        run = next(r for r in s["runs"] if r["id"] == int(pos[2]))
        if run["conclusion"] != "success":
            return 1
        if run["workflow"] == "bot-deploy.yml":
            s["webhook_url"] = s["vars"]["BOT_URL"]
        return 0
    if head == ["run", "view"]:
        if "--log" in argv:
            print("plan\tList users due this hour\t2026-11-11T12:00:00Z " + json.dumps(s["matrix"]))
        else:
            print(f"https://github.com/{s['code_repo']}/actions/runs/{pos[2]}")
        return 0
    return fail("unexpected gh " + " ".join(argv))


def respond(status, body):
    sys.stdout.write(json.dumps(body) + "\n" + str(status))
    return 0


def curl(s, argv):
    config = sys.stdin.read() if "-K" in argv else ""
    log("curl", argv, config)
    url = re.search(r'^url = "(.*)"$', config, re.M).group(1)
    auth = re.search(r'^header = "Authorization: Bearer (.*)"$', config, re.M)
    token = auth.group(1) if auth else None
    method = opt(argv, "-X")
    m = re.match(r"https://api\.telegram\.org/bot([^/]+)/(\w+)$", url)
    if m:
        if m.group(1) not in s["bot_tokens"]:
            return respond(401, {"ok": False, "description": "Unauthorized"})
        call = m.group(2)
        if call == "getMe":
            return respond(200, {"ok": True, "result": {"username": "gorizont_test_bot"}})
        if call == "getUpdates":
            if s["webhook_url"]:
                return respond(409, {"ok": False, "description": "Conflict: webhook is active"})
            return respond(200, {"ok": True, "result": s["updates"]})
        if call == "getWebhookInfo":
            info = {"url": s["webhook_url"]}
            if s["webhook_error"]:
                info["last_error_message"] = s["webhook_error"]
            return respond(200, {"ok": True, "result": info})
    if url == "https://api.cloudflare.com/client/v4/accounts":
        if token not in s["cf_tokens"]:
            return respond(403, {"success": False, "result": None})
        return respond(200, {"success": True, "result": s["cf_accounts"]})
    m = re.match(r"https://api\.cloudflare\.com/client/v4/accounts/([^/]+)/workers/subdomain$", url)
    if m:
        s["subdomain_account"] = m.group(1)
        if not s["cf_subdomain"]:
            return respond(404, {"success": False, "result": None})
        return respond(200, {"success": True, "result": {"subdomain": s["cf_subdomain"]}})
    m = re.match(r"https://api\.github\.com/repos/([^/]+/[^/]+)/contents/(.+)$", url)
    if m and method == "PUT":
        if token not in s["pats"]:
            return respond(401, {"message": "Bad credentials"})
        repo, name = m.group(1), m.group(2)
        if repo == s["code_repo"] and s.get("code_probe"):
            return respond(s["code_probe"][0], {"message": s["code_probe"][1]})
        if repo in s["pats"][token] and name in s["repos"].get(repo, {}).get("files", {}):
            return respond(409, {"message": f"{name} does not match"})
        return respond(403, {"message": "Resource not accessible by personal access token"})
    if url == "https://api.groq.com/openai/v1/models":
        if token not in s["groq_keys"]:
            return respond(401, {"error": {"message": "Invalid API Key"}})
        return respond(200, {"data": []})
    return respond(500, {"unexpected": url})


def main():
    name = Path(sys.argv[0]).name
    argv = sys.argv[1:]
    if name == "sleep":
        return 0
    if name == "openssl":
        log("openssl", argv, None)
        print("ab" * 32)
        return 0
    s = json.loads(STATE.read_text())
    code = gh(s, argv) if name == "gh" else curl(s, argv)
    STATE.write_text(json.dumps(s))
    return code


sys.exit(main())
'''

REAL_TOOLS = ["bash", "jq", "git", "grep", "cat", "dirname"]
FAKE_TOOLS = ["gh", "curl", "openssl", "sleep"]


def _bashes():
    found = {}
    for candidate in ["/bin/bash", shutil.which("bash")]:
        if candidate and Path(candidate).exists():
            version = subprocess.run(
                [candidate, "-c", "echo $BASH_VERSION"], capture_output=True, text=True, check=True,
            ).stdout.strip()
            found.setdefault(version, candidate)
    return list(found.items())


BASHES = _bashes()


def fresh_state():
    return {
        "login": "alice",
        "auth": True,
        "admin": True,
        "code_repo": "alice/Gorizont",
        "secrets": {},
        "vars": {},
        "repos": {"alice/Gorizont": {"private": False, "files": {"README.md": "# Horizon\n"}}},
        "actions_enabled": False,
        "actions_put_failures": 0,
        "workflows": {"bot-deploy.yml": "disabled_fork", "ci.yml": "disabled_fork", "users-digest.yml": "disabled_fork"},
        "runs": [],
        "conclusions": {},
        "matrix": {"include": [{"user": "4242", "publish_site": False}]},
        "bot_tokens": [BOT],
        "updates": [{"update_id": 1, "message": {"chat": {"id": 4242, "type": "private"}, "from": {"id": 4242}, "text": "/start"}}],
        "webhook_url": "",
        "webhook_error": "",
        "cf_tokens": [CF],
        "cf_accounts": [{"id": "acc1", "name": "Alice"}],
        "cf_subdomain": "alice",
        "pats": {PAT: ["alice/gorizont-data"], PAT_EVERYWHERE: ["alice/gorizont-data", "alice/Gorizont"], PAT_NOWHERE: []},
        "groq_keys": [GROQ, GROQ_2, GROQ_3],
    }


def installed_state():
    s = fresh_state()
    s["secrets"] = {name: "old" for name in [
        "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "TELEGRAM_BOT_TOKEN", "BOT_WEBHOOK_SECRET",
        "BOT_GITHUB_TOKEN", "GROQ_API_KEY", "HORIZON_WEBHOOK_URL", "TELEGRAM_CHAT_ID",
    ]}
    s["vars"] = {"OWNER_ID": "4242", "DATA_REPO": "alice/gorizont-data", "BOT_URL": "https://gorizont-bot.alice.workers.dev"}
    s["repos"]["alice/gorizont-data"] = {"private": True, "files": {"README.md": "", "users/4242.json": "{}"}}
    s["actions_enabled"] = True
    s["workflows"] = {"bot-deploy.yml": "active", "ci.yml": "active", "users-digest.yml": "disabled_manually"}
    s["webhook_url"] = s["vars"]["BOT_URL"]
    s["updates"] = []
    return s


class Sandbox:
    def __init__(self, tmp_path):
        self.repo = tmp_path / "repo"
        (self.repo / "scripts").mkdir(parents=True)
        shutil.copy(SCRIPT, self.repo / "scripts/setup.sh")
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        self.set_origin("https://github.com/alice/Gorizont.git")
        self.fakes = tmp_path / "fakes"
        self.fakes.mkdir()
        fake = self.fakes / "fake.py"
        fake.write_text(f"#!{sys.executable}\n{FAKE}")
        fake.chmod(0o755)
        for name in FAKE_TOOLS:
            (self.fakes / name).symlink_to(fake)
        self.tools = tmp_path / "tools"
        self.tools.mkdir()
        for name in REAL_TOOLS:
            (self.tools / name).symlink_to(shutil.which(name))
        self.state_file = tmp_path / "state.json"
        self.log_file = tmp_path / "calls.jsonl"
        self.log_file.touch()
        self.state = fresh_state()

    def set_origin(self, url):
        subprocess.run(["git", "-C", str(self.repo), "remote", "remove", "origin"], capture_output=True)
        subprocess.run(["git", "-C", str(self.repo), "remote", "add", "origin", url], check=True)

    def remove_tool(self, name):
        for folder in (self.fakes, self.tools):
            if (folder / name).exists():
                (folder / name).unlink()

    def run(self, answers=(), *args, bash=None):
        self.state_file.write_text(json.dumps(self.state))
        env = {
            "PATH": f"{self.fakes}:{self.tools}",
            "HOME": str(self.repo),
            "SETUP_FAKE_STATE": str(self.state_file),
            "SETUP_FAKE_LOG": str(self.log_file),
        }
        result = subprocess.run(
            [bash or BASHES[0][1], str(self.repo / "scripts/setup.sh"), *args],
            input="".join(f"{a}\n" for a in answers),
            capture_output=True, text=True, env=env, cwd=self.repo, timeout=60,
        )
        self.state = json.loads(self.state_file.read_text())
        return result

    def calls(self, cmd=None):
        entries = [json.loads(line) for line in self.log_file.read_text().splitlines()]
        return [e for e in entries if cmd is None or e["cmd"] == cmd]

    def gh(self, *prefix):
        return [c["argv"] for c in self.calls("gh") if c["argv"][:len(prefix)] == list(prefix)]

    def writes(self):
        return (
            self.gh("secret", "set") + self.gh("variable", "set") + self.gh("repo", "create")
            + [a for a in self.gh("api", "-X", "PUT") if "/contents/" in a[3]]
        )


@pytest.fixture
def box(tmp_path):
    return Sandbox(tmp_path)


def test_help_prints_usage_without_calls(box):
    result = box.run((), "--help")
    assert result.returncode == 0
    assert "Использование: ./scripts/setup.sh" in result.stdout
    assert "@BotFather" in result.stdout
    assert box.calls() == []


@pytest.mark.parametrize("tool", ["gh", "jq", "curl", "openssl", "git"])
def test_missing_tool_stops_before_anything(box, tool):
    box.remove_tool(tool)
    result = box.run(FRESH)
    assert result.returncode != 0
    assert f"не найдена утилита {tool}" in result.stderr
    assert box.writes() == []


def test_gh_must_be_logged_in(box):
    box.state["auth"] = False
    result = box.run(FRESH)
    assert result.returncode != 0
    assert "gh auth login" in result.stderr
    assert box.writes() == []


def test_origin_must_be_on_github(box):
    box.set_origin("https://gitlab.com/alice/Gorizont.git")
    result = box.run(FRESH)
    assert result.returncode != 0
    assert "origin не на GitHub" in result.stderr
    assert box.writes() == []


def test_refuses_a_repository_the_user_does_not_admin(box):
    box.state["admin"] = False
    box.set_origin("git@github.com:Thysrael/Horizon.git")
    result = box.run(FRESH)
    assert result.returncode != 0
    assert "в клоне своего форка" in result.stderr
    assert box.writes() == []


@pytest.mark.parametrize("bash", [b for _, b in BASHES], ids=[v for v, _ in BASHES])
def test_fresh_install_writes_everything(box, bash):
    result = box.run(FRESH, bash=bash)
    assert result.returncode == 0, result.stderr
    assert box.state["secrets"] == {
        "TELEGRAM_BOT_TOKEN": BOT,
        "HORIZON_WEBHOOK_URL": f"https://api.telegram.org/bot{BOT}/sendRichMessage",
        "TELEGRAM_CHAT_ID": "4242",
        "CLOUDFLARE_API_TOKEN": CF,
        "CLOUDFLARE_ACCOUNT_ID": "acc1",
        "BOT_WEBHOOK_SECRET": HOOK,
        "BOT_GITHUB_TOKEN": PAT,
        "GROQ_API_KEY": GROQ,
    }
    assert box.state["vars"] == {
        "OWNER_ID": "4242",
        "DATA_REPO": "alice/gorizont-data",
        "BOT_URL": "https://gorizont-bot.alice.workers.dev",
    }
    assert "Готово" in result.stdout
    assert "Ничего не изменилось." not in result.stdout


def test_fresh_install_creates_a_private_data_repo_before_asking_for_the_pat(box):
    result = box.run(FRESH)
    assert result.returncode == 0, result.stderr
    data = box.state["repos"]["alice/gorizont-data"]
    assert data["private"] is True
    assert json.loads(data["files"]["users/4242.json"]) == {"id": 4242, "time_window_hours": 6}
    assert box.gh("repo", "create") == [["repo", "create", "alice/gorizont-data", "--private", "--add-readme", "--description", "Gorizont instance data"]]
    order = [c for c in box.calls() if c["argv"][:2] == ["repo", "create"] or "api.github.com" in (c["stdin"] or "")]
    assert order[0]["argv"][:2] == ["repo", "create"]
    assert result.stderr.index("Репозиторий данных") < result.stderr.index("Токен (github_pat_")


def test_secrets_never_reach_argv_or_output(box):
    result = box.run([BOT, "", "", CF, "", PAT, GROQ, GROQ_2, GROQ_3, ""])
    assert result.returncode == 0, result.stderr
    assert box.state["secrets"]["GROQ_API_KEY_2"] == GROQ_2
    assert box.state["secrets"]["GROQ_API_KEY_3"] == GROQ_3
    argv = "\n".join(" ".join(c["argv"]) for c in box.calls())
    for value in SECRET_VALUES:
        assert value not in argv
        assert value not in result.stdout
        assert value not in result.stderr


def test_secret_set_reads_the_value_from_stdin(box):
    box.run(FRESH)
    assert ["secret", "set", "BOT_GITHUB_TOKEN", "-R", "alice/Gorizont"] in box.gh("secret", "set")


@pytest.mark.parametrize("updates_case", ["no_messages", "webhook_set"])
def test_owner_id_falls_back_to_manual_input(box, updates_case):
    if updates_case == "no_messages":
        box.state["updates"] = []
    else:
        box.state["webhook_url"] = "https://elsewhere.example"
    result = box.run([BOT, "", "777", CF, "", PAT, GROQ, "", ""])
    assert result.returncode == 0, result.stderr
    assert "введите ID вручную" in result.stdout
    assert box.state["vars"]["OWNER_ID"] == "777"
    assert box.state["secrets"]["TELEGRAM_CHAT_ID"] == "777"


def test_owner_id_must_be_a_positive_integer(box):
    box.state["updates"] = []
    result = box.run([BOT, "", "abc", "-100123", "555", CF, "", PAT, GROQ, "", ""])
    assert result.returncode == 0, result.stderr
    assert result.stdout.count("положительное целое") == 2
    assert box.state["vars"]["OWNER_ID"] == "555"


def test_three_bad_owner_ids_write_nothing(box):
    box.state["updates"] = []
    result = box.run([BOT, "", "abc", "-1", ""])
    assert result.returncode != 0
    assert "три неудачные попытки" in result.stderr
    assert box.writes() == []


def test_picks_the_cloudflare_account_by_number(box):
    box.state["cf_accounts"] = [{"id": "acc1", "name": "Alice"}, {"id": "acc2", "name": "Work"}]
    result = box.run([BOT, "", "", CF, "2", "", PAT, GROQ, "", ""])
    assert result.returncode == 0, result.stderr
    assert "2) Work (acc2)" in result.stdout
    assert box.state["secrets"]["CLOUDFLARE_ACCOUNT_ID"] == "acc2"
    assert box.state["subdomain_account"] == "acc2"


def test_bad_bot_token_is_asked_again(box):
    result = box.run(['12:ab"cd', "123:wrong", BOT, "", "", CF, "", PAT, GROQ, "", ""])
    assert result.returncode == 0, result.stderr
    assert "недопустимые символы" in result.stdout
    assert "Telegram не принял токен" in result.stdout


def test_three_bad_bot_tokens_write_nothing(box):
    result = box.run(["123:wrong", "123:wrong", "123:wrong"])
    assert result.returncode != 0
    assert "три неудачные попытки" in result.stderr
    assert box.writes() == []


@pytest.mark.parametrize("answers, setup, message", [
    ([BOT, "", "", "cf_bad", "cf_bad", "cf_bad"], None, "три неудачные попытки"),
    ([BOT, "", "", CF], "no_subdomain", "нет поддомена workers.dev"),
    ([BOT, "", "", CF, "", PAT, "gsk_bad", "gsk_bad", "gsk_bad"], None, "три неудачные попытки"),
])
def test_rejected_service_tokens_write_no_secrets(box, answers, setup, message):
    if setup == "no_subdomain":
        box.state["cf_subdomain"] = ""
    result = box.run(answers)
    assert result.returncode != 0
    assert message in result.stderr
    assert box.gh("secret", "set") == []
    assert box.gh("variable", "set") == []


def test_pat_without_access_to_the_data_repo_is_refused(box):
    result = box.run([BOT, "", "", CF, "", PAT_NOWHERE, PAT_NOWHERE, PAT_NOWHERE])
    assert result.returncode != 0
    assert "Contents: Read and write" in result.stdout
    assert box.gh("secret", "set") == []


def test_pat_that_can_write_code_stops_the_setup(box):
    result = box.run([BOT, "", "", CF, "", PAT_EVERYWHERE, PAT, GROQ, "", ""])
    assert result.returncode != 0
    assert "может писать в alice/Gorizont" in result.stderr
    assert box.gh("secret", "set") == []
    assert box.gh("variable", "set") == []


def test_private_code_repo_answering_404_counts_as_no_access(box):
    box.state["code_probe"] = [404, "Not Found"]
    result = box.run(FRESH)
    assert result.returncode == 0, result.stderr
    assert box.state["secrets"]["BOT_GITHUB_TOKEN"] == PAT


def test_other_403_on_the_code_repo_is_not_taken_as_no_access(box):
    box.state["code_probe"] = [403, "API rate limit exceeded"]
    result = box.run(FRESH)
    assert result.returncode != 0
    assert "не удалось проверить доступ токена к alice/Gorizont (HTTP 403): API rate limit exceeded" in result.stderr
    assert box.gh("secret", "set") == []


def test_pat_check_needs_readme_in_the_code_repo(box):
    box.state["repos"]["alice/Gorizont"]["files"] = {}
    result = box.run(FRESH)
    assert result.returncode != 0
    assert "не удалось найти README.md в alice/Gorizont" in result.stderr
    assert "Токен (github_pat_" not in result.stderr
    assert box.gh("secret", "set") == []


def test_failing_run_list_is_reported(box):
    box.state["run_list_fails"] = True
    result = box.run(FRESH)
    assert result.returncode != 0
    assert "не удалось получить список запусков bot-deploy.yml" in result.stderr


def test_data_repo_name_is_validated(box):
    result = box.run([BOT, "", "", CF, "not-a-repo", "", PAT, GROQ, "", ""])
    assert result.returncode == 0, result.stderr
    assert "Нужен формат owner/name" in result.stdout
    assert box.state["vars"]["DATA_REPO"] == "alice/gorizont-data"


@pytest.mark.parametrize("answer, ok", [("", False), ("y", True)])
def test_public_data_repo_needs_confirmation(box, answer, ok):
    box.state["repos"]["alice/gorizont-data"] = {"private": False, "files": {"README.md": ""}}
    result = box.run([BOT, "", "", CF, "", answer, PAT, GROQ, "", ""])
    assert (result.returncode == 0) is ok, result.stderr
    if not ok:
        assert "сделайте alice/gorizont-data приватным" in result.stderr
        assert box.writes() == []


def test_data_repo_check_error_does_not_create_a_repo(box):
    box.state["api_errors"] = {"repos/alice/gorizont-data": "HTTP 502"}
    result = box.run(FRESH)
    assert result.returncode != 0
    assert "не удалось проверить alice/gorizont-data: HTTP 502" in result.stderr
    assert box.writes() == []


def test_owner_file_check_error_does_not_write_the_file(box):
    box.state["repos"]["alice/gorizont-data"] = {"private": True, "files": {"README.md": ""}}
    box.state["api_errors"] = {"repos/alice/gorizont-data/contents/users/4242.json": "HTTP 502"}
    result = box.run(FRESH)
    assert result.returncode != 0
    assert "не удалось проверить users/4242.json в alice/gorizont-data: HTTP 502" in result.stderr
    assert box.writes() == []


@pytest.mark.parametrize("bash", [b for _, b in BASHES], ids=[v for v, _ in BASHES])
def test_rerun_keeps_everything_when_told_so(box, bash):
    box.state = installed_state()
    before = json.loads(json.dumps(box.state["secrets"])), dict(box.state["vars"])
    result = box.run(["n", "", "n", "n", "", "n", "n", ""], bash=bash)
    assert result.returncode == 0, result.stderr
    assert box.writes() == []
    assert (box.state["secrets"], box.state["vars"]) == before
    assert box.state["repos"]["alice/gorizont-data"]["files"]["users/4242.json"] == "{}"
    assert "Проверить webhook: curl" in result.stdout
    assert "Ничего не изменилось." in result.stdout
    assert [r["workflow"] for r in box.state["runs"]] == ["bot-deploy.yml"]
    assert box.gh("workflow", "enable", "users-digest.yml") == []


def test_rerun_with_a_new_data_repo_asks_for_a_new_pat(box):
    box.state = installed_state()
    box.state["pats"][PAT] = ["alice/other-data"]
    result = box.run(["n", "", "n", "n", "alice/other-data", PAT, "n", ""])
    assert result.returncode == 0, result.stderr
    assert box.state["vars"]["DATA_REPO"] == "alice/other-data"
    assert box.state["secrets"]["BOT_GITHUB_TOKEN"] == PAT
    assert box.state["repos"]["alice/other-data"]["private"] is True


def test_enables_actions_and_core_workflows(box):
    result = box.run(FRESH)
    assert result.returncode == 0, result.stderr
    assert box.gh("api", "-X", "PUT", "repos/alice/Gorizont/actions/permissions")
    assert box.state["workflows"]["bot-deploy.yml"] == "active"
    assert box.state["workflows"]["ci.yml"] == "active"


def test_asks_to_enable_actions_by_hand_when_the_api_fails(box):
    box.state["actions_put_failures"] = 1
    result = box.run([BOT, "", "", CF, "", PAT, GROQ, "", "", ""])
    assert result.returncode == 0, result.stderr
    assert "Не удалось включить Actions: HTTP 403" in result.stdout
    assert "https://github.com/alice/Gorizont/actions" in result.stdout


def test_stops_when_actions_stay_disabled(box):
    box.state["actions_put_failures"] = 2
    result = box.run([BOT, "", "", CF, "", PAT, GROQ, "", ""])
    assert result.returncode != 0
    assert "Actions в alice/Gorizont всё ещё выключены" in result.stderr


def test_digest_schedule_stays_off_by_default(box):
    result = box.run(FRESH)
    assert result.returncode == 0, result.stderr
    assert box.state["workflows"]["users-digest.yml"] == "disabled_fork"
    assert box.gh("workflow", "enable", "users-digest.yml") == []
    assert [r for r in box.state["runs"] if r["workflow"] == "users-digest.yml"] == []
    assert "Пропущен: расписание выключено" in result.stdout


def test_digest_schedule_is_enabled_on_yes_and_dry_run_follows(box):
    result = box.run([BOT, "", "", CF, "", PAT, GROQ, "", "y"])
    assert result.returncode == 0, result.stderr
    assert box.state["workflows"]["users-digest.yml"] == "active"
    assert box.gh("workflow", "disable") == []
    dry = [r for r in box.state["runs"] if r["workflow"] == "users-digest.yml"]
    assert [r["fields"] for r in dry] == [["dry_run=true"]]
    assert '{"include": [{"user": "4242"' in result.stdout


def test_dry_run_runs_when_the_schedule_is_already_on(box):
    box.state = installed_state()
    box.state["workflows"]["users-digest.yml"] = "active"
    result = box.run(["n", "", "n", "n", "", "n", "n"])
    assert result.returncode == 0, result.stderr
    assert "уже включена" in result.stdout
    assert [r["workflow"] for r in box.state["runs"]] == ["bot-deploy.yml", "users-digest.yml"]


def test_deploy_checks_the_webhook(box):
    result = box.run(FRESH)
    assert result.returncode == 0, result.stderr
    assert "Webhook в порядке: https://gorizont-bot.alice.workers.dev" in result.stdout
    assert box.state["runs"][0]["workflow"] == "bot-deploy.yml"


def test_failed_deploy_stops_with_the_run_link(box):
    box.state["conclusions"]["bot-deploy.yml"] = "failure"
    result = box.run(FRESH)
    assert result.returncode != 0
    assert "https://github.com/alice/Gorizont/actions/runs/100" in result.stderr
    assert "Готово" not in result.stdout


def test_webhook_error_fails_the_setup(box):
    box.state["webhook_error"] = "Wrong response from the webhook: 500"
    result = box.run(FRESH)
    assert result.returncode != 0
    assert "Wrong response from the webhook: 500" in result.stderr
    assert "Готово" not in result.stdout
