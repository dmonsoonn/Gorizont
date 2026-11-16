import json

import pytest

from src.storage.manager import ConfigError, StorageManager
from src.users import apply_overlay, load_user


@pytest.mark.parametrize("user_id", ["111", "222"])
@pytest.mark.parametrize("owner_id", ["111", None, "invalid"])
@pytest.mark.parametrize("env_present", [True, False])
@pytest.mark.parametrize("field", ["url", "name", "chat_id", "key"])
def test_all_user_files_reject_nested_env_refs(tmp_path, monkeypatch, user_id, owner_id, env_present, field):
    if owner_id is None:
        monkeypatch.delenv("HORIZON_OWNER_ID", raising=False)
    else:
        monkeypatch.setenv("HORIZON_OWNER_ID", owner_id)
    if env_present:
        monkeypatch.setenv("GROQ_API_KEY", "synthetic-secret-value")
    else:
        monkeypatch.delenv("GROQ_API_KEY", raising=False)

    def refuse_network(*args, **kwargs):
        pytest.fail("Loading a user file must not make network requests")

    monkeypatch.setattr("httpx.Client.send", refuse_network)
    monkeypatch.setattr("httpx.AsyncClient.send", refuse_network)
    feed = {"name": "Feed", "url": "https://evil.example/feed?k="}
    payload = {"id": int(user_id), "sources": {"rss": [feed]}}
    if field == "key":
        feed["${GROQ_API_KEY}"] = "value"
    elif field == "chat_id":
        payload["chat_id"] = "${GROQ_API_KEY}"
    else:
        feed[field] += "${GROQ_API_KEY}"
    (tmp_path / "users").mkdir()
    (tmp_path / "users" / f"{user_id}.json").write_text(json.dumps(payload))

    with pytest.raises(ConfigError) as excinfo:
        load_user(tmp_path, user_id)

    assert f"{user_id}.json" in str(excinfo.value)
    assert "GROQ_API_KEY" in str(excinfo.value)
    assert "synthetic-secret-value" not in str(excinfo.value)


def test_owner_without_sources_uses_base_config_env(tmp_path, monkeypatch):
    monkeypatch.setenv("HORIZON_OWNER_ID", "111")
    monkeypatch.setenv("BASE_FEED", "https://base.example.com/private-feed")
    config_data = {
        "ai": {"provider": "openai", "model": "test", "api_key_env": "TEST_API_KEY"},
        "sources": {"rss": [{"name": "Base", "url": "${BASE_FEED}"}]},
        "webhook": {
            "enabled": True,
            "url_env": "HORIZON_WEBHOOK_URL",
            "platform": "telegram",
            "request_body": {"chat_id": 111, "rich_message": {"markdown": "#{summary}"}},
        },
    }
    (tmp_path / "config.json").write_text(json.dumps(config_data))
    (tmp_path / "users").mkdir()
    (tmp_path / "users" / "111.json").write_text(json.dumps({"id": 111}))

    config = apply_overlay(StorageManager(tmp_path).load_config(), load_user(tmp_path, "111"))

    assert str(config.sources.rss[0].url) == "https://base.example.com/private-feed"
    assert config.webhook.request_body["chat_id"] == 111
