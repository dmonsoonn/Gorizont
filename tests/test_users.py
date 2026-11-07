import asyncio
import json
from datetime import datetime, timezone

import pytest

from src import main as main_module
from src import orchestrator as orchestrator_module
from src.models import (
    ClassificationResult,
    Config,
    ContentAnalysis,
    ContentItem,
    ProcessingResult,
    SourceType,
)
from src.orchestrator import HorizonOrchestrator
from src.storage.manager import ConfigError, StorageManager
from src.users import UserConfig, apply_overlay, due_users, load_user
from src.users.__main__ import main as users_main

BASE_CONFIG = {
    "ai": {"provider": "openai", "model": "test", "api_key_env": "TEST_API_KEY", "languages": ["en"]},
    "sources": {"rss": [{"name": "Base", "url": "https://base.example.com/feed"}]},
    "collection": {"time_window_hours": 24},
    "email": {
        "imap_server": "imap.example.com",
        "smtp_server": "smtp.example.com",
        "email_address": "me@example.com",
    },
    "webhook": {
        "enabled": True,
        "url_env": "HORIZON_WEBHOOK_URL",
        "platform": "telegram",
        "request_body": {"chat_id": "${TELEGRAM_CHAT_ID}", "rich_message": {"markdown": "#{summary}"}},
    },
}

MY_SOURCES = {"rss": [{"name": "Mine", "url": "https://mine.example.com/feed"}]}
OTHER_SOURCES = {"rss": [{"name": "Other", "url": "https://other.example.com/feed"}]}


def base_config() -> Config:
    return Config.model_validate(BASE_CONFIG)


def write_user(data_dir, name, payload) -> None:
    users_dir = data_dir / "users"
    users_dir.mkdir(parents=True, exist_ok=True)
    content = payload if isinstance(payload, str) else json.dumps(payload)
    (users_dir / f"{name}.json").write_text(content, encoding="utf-8")


def rss_names(config: Config) -> list[str]:
    return [feed.name for feed in config.sources.rss]


def test_overlay_uses_user_sources_and_chat():
    user = UserConfig.model_validate({"id": 111, "chat_id": "@chan", "sources": MY_SOURCES})

    config = apply_overlay(base_config(), user)

    assert rss_names(config) == ["Mine"]
    assert config.webhook.request_body["chat_id"] == "@chan"
    assert config.webhook.request_body["rich_message"] == {"markdown": "#{summary}"}


def test_overlay_defaults_chat_to_user_id():
    config = apply_overlay(base_config(), UserConfig(id=111))

    assert config.webhook.request_body["chat_id"] == 111


def test_overlay_without_sources_keeps_base_sources():
    config = apply_overlay(base_config(), UserConfig(id=111))

    assert rss_names(config) == ["Base"]


def test_load_user_expands_env_vars(tmp_path, monkeypatch):
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "@owner")
    write_user(tmp_path, "111", {"id": 111, "chat_id": "${TELEGRAM_CHAT_ID}"})

    config = apply_overlay(base_config(), load_user(tmp_path, "111"))

    assert config.webhook.request_body["chat_id"] == "@owner"


def test_overlay_drops_email_unless_user_publishes_site():
    assert apply_overlay(base_config(), UserConfig(id=111)).email is None
    assert apply_overlay(base_config(), UserConfig(id=111, publish_site=True)).email is not None


def test_overlay_requires_json_webhook():
    data = dict(BASE_CONFIG, webhook=None)

    with pytest.raises(ConfigError, match="webhook"):
        apply_overlay(Config.model_validate(data), UserConfig(id=111))


@pytest.mark.parametrize("user_id", ["abc", "../config", "0", "-1", "12/34", ""])
def test_load_user_rejects_invalid_ids(tmp_path, user_id):
    with pytest.raises(ConfigError, match="Invalid user id"):
        load_user(tmp_path, user_id)


def test_load_user_reports_missing_file(tmp_path):
    with pytest.raises(ConfigError, match="not found"):
        load_user(tmp_path, "999")


@pytest.mark.parametrize(
    "payload",
    [
        {"id": 111, "ai": {}},
        {"id": 111, "sources": {"rss": [{"name": "No url"}]}},
        "{not json",
    ],
)
def test_load_user_rejects_invalid_files(tmp_path, payload):
    write_user(tmp_path, "111", payload)

    with pytest.raises(ConfigError) as excinfo:
        load_user(tmp_path, "111")

    assert "111.json" in str(excinfo.value)


def test_load_user_rejects_foreign_id(tmp_path):
    write_user(tmp_path, "111", {"id": 222})

    with pytest.raises(ConfigError, match="does not match"):
        load_user(tmp_path, "111")


@pytest.mark.parametrize("hours", [5, 0, -1, 25])
def test_time_window_must_divide_day(tmp_path, hours):
    write_user(tmp_path, "111", {"id": 111, "time_window_hours": hours})

    with pytest.raises(ConfigError, match="time_window_hours"):
        load_user(tmp_path, "111")


def test_users_do_not_share_sources_or_chat(tmp_path):
    write_user(tmp_path, "111", {"id": 111, "chat_id": "@a", "sources": MY_SOURCES})
    write_user(tmp_path, "222", {"id": 222, "chat_id": "@b", "sources": OTHER_SOURCES})

    config = apply_overlay(base_config(), load_user(tmp_path, "111"))
    orchestrator = HorizonOrchestrator(config, StorageManager(str(tmp_path)))

    assert rss_names(config) == ["Mine"]
    assert orchestrator.webhook_notifier.config.request_body["chat_id"] == "@a"


def test_due_users_follows_time_windows(tmp_path):
    write_user(tmp_path, "1", {"id": 1})
    write_user(tmp_path, "6", {"id": 6, "time_window_hours": 6, "publish_site": True})
    write_user(tmp_path, "24", {"id": 24, "time_window_hours": 24})

    assert [entry["user"] for entry in due_users(tmp_path, 0)] == ["1", "24", "6"]
    assert [entry["user"] for entry in due_users(tmp_path, 12)] == ["1", "6"]
    assert due_users(tmp_path, 13) == [{"user": "1", "publish_site": False}]


def test_due_users_keeps_broken_files_so_their_job_fails(tmp_path):
    write_user(tmp_path, "111", "{not json")
    write_user(tmp_path, "abc", {"id": 1})

    assert due_users(tmp_path, 13) == [
        {"user": "111", "publish_site": False},
        {"user": "abc", "publish_site": False},
    ]


def test_due_users_without_users_dir(tmp_path):
    assert due_users(tmp_path, 0) == []


def test_due_command_prints_matrix(tmp_path, monkeypatch, capsys):
    write_user(tmp_path, "6", {"id": 6, "time_window_hours": 6, "publish_site": True})
    monkeypatch.setattr("sys.argv", ["users", "due", "--data-dir", str(tmp_path), "--hour", "12"])

    users_main()

    assert json.loads(capsys.readouterr().out) == {"include": [{"user": "6", "publish_site": True}]}


class RecordingOrchestrator:
    calls: list[dict] = []

    def __init__(self, config, storage, console=None, publish_site=True):
        self.call = {"config": config, "publish_site": publish_site}
        RecordingOrchestrator.calls.append(self.call)

    async def run(self, force_hours=None):
        self.call["force_hours"] = force_hours


def run_main(monkeypatch, tmp_path, *args):
    (tmp_path / "config.json").write_text(json.dumps(BASE_CONFIG), encoding="utf-8")
    RecordingOrchestrator.calls = []
    monkeypatch.setattr(main_module, "HorizonOrchestrator", RecordingOrchestrator)
    monkeypatch.setattr(main_module, "load_dotenv", lambda: None)
    monkeypatch.setattr(main_module, "configure_logging", lambda console, level=None: None)
    monkeypatch.setattr(main_module.console, "print", lambda *a, **k: None)
    monkeypatch.setattr("sys.argv", ["horizon", "--data-dir", str(tmp_path), *args])
    main_module.main()
    return RecordingOrchestrator.calls[0]


def test_main_runs_single_user(monkeypatch, tmp_path):
    write_user(tmp_path, "111", {"id": 111, "chat_id": "@chan", "time_window_hours": 6, "sources": MY_SOURCES})

    call = run_main(monkeypatch, tmp_path, "--user", "111")

    assert rss_names(call["config"]) == ["Mine"]
    assert call["config"].webhook.request_body["chat_id"] == "@chan"
    assert call["force_hours"] == 6
    assert call["publish_site"] is False


def test_main_explicit_hours_override_user_window(monkeypatch, tmp_path):
    write_user(tmp_path, "111", {"id": 111, "time_window_hours": 6})

    call = run_main(monkeypatch, tmp_path, "--user", "111", "--hours", "2")

    assert call["force_hours"] == 2


def test_main_without_user_is_unchanged(monkeypatch, tmp_path):
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "@base")

    call = run_main(monkeypatch, tmp_path)

    assert rss_names(call["config"]) == ["Base"]
    assert call["config"].webhook.request_body["chat_id"] == "@base"
    assert call["force_hours"] is None
    assert call["publish_site"] is True


@pytest.mark.parametrize("user_id", ["../config", "abc", "999"])
def test_main_rejects_bad_user(monkeypatch, tmp_path, user_id):
    with pytest.raises(SystemExit) as excinfo:
        run_main(monkeypatch, tmp_path, "--user", user_id)

    assert excinfo.value.code == 1
    assert RecordingOrchestrator.calls == []


class FakeSummarizer:
    def __init__(self, **kwargs):
        pass

    async def generate_summary(self, items, date, total, language="en"):
        return "# Title\nbody"


def make_item() -> ContentItem:
    return ContentItem(
        id="rss:test:1",
        source_type=SourceType.RSS,
        title="item",
        url="https://example.com/item",
        published_at=datetime.now(timezone.utc),
        profile="tech-news",
        processing=ProcessingResult(
            classification=ClassificationResult(profile="tech-news", method="source_override"),
            analysis=ContentAnalysis(score=9.0, reason="test", summary="item"),
        ),
    )


def run_orchestrator(monkeypatch, tmp_path, publish_site: bool) -> None:
    config = Config.model_validate(dict(BASE_CONFIG, email=None, webhook=None))
    orchestrator = HorizonOrchestrator(
        config, StorageManager(str(tmp_path / "data")), publish_site=publish_site
    )

    async def passthrough(items, **kwargs):
        return items

    async def fetch_all_sources(since):
        return [make_item()]

    async def nothing(items):
        return None

    monkeypatch.setattr(orchestrator_module, "DailySummarizer", FakeSummarizer)
    monkeypatch.setattr(orchestrator, "fetch_all_sources", fetch_all_sources)
    monkeypatch.setattr(orchestrator, "analyze_items", passthrough)
    monkeypatch.setattr(orchestrator, "merge_topic_duplicates", passthrough)
    monkeypatch.setattr(orchestrator, "_expand_twitter_discussion", nothing)
    monkeypatch.setattr(orchestrator, "enrich_items", nothing)
    monkeypatch.chdir(tmp_path)

    asyncio.run(orchestrator.run())


def test_orchestrator_skips_site_when_not_publishing(monkeypatch, tmp_path):
    run_orchestrator(monkeypatch, tmp_path, publish_site=False)

    assert not (tmp_path / "docs" / "_posts").exists()
    assert list((tmp_path / "data" / "summaries").glob("*.md"))


def test_orchestrator_publishes_site_by_default(monkeypatch, tmp_path):
    run_orchestrator(monkeypatch, tmp_path, publish_site=True)

    assert list((tmp_path / "docs" / "_posts").glob("*-summary-en.md"))
