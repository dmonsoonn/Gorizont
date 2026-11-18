import asyncio
import json
from io import StringIO
from unittest.mock import AsyncMock

import httpx
import pytest
from rich.console import Console

from src.ai.summarizer import DailySummarizer
from src.models import WebhookConfig
from src.services import webhook


BOT_TOKEN = "123456:example-test-token"
WEBHOOK_URL = f"https://api.telegram.org/bot{BOT_TOKEN}/sendRichMessage"


@pytest.fixture
def delivery(monkeypatch):
    request = AsyncMock()
    monkeypatch.setattr(webhook, "safe_request", request)

    def make_notifier(response, *, platform="telegram", url=WEBHOOK_URL):
        monkeypatch.setenv("TEST_TELEGRAM_WEBHOOK_URL", url)
        request.return_value = response
        output = StringIO()
        notifier = webhook.WebhookNotifier(
            WebhookConfig(
                enabled=True,
                platform=platform,
                url_env="TEST_TELEGRAM_WEBHOOK_URL",
                request_body={"chat_id": 123, "rich_message": {"markdown": "#{summary}"}},
            ),
            console=Console(file=output, width=200),
        )
        return notifier, output, request

    return make_notifier


def test_daily_summary_reports_telegram_description_without_retargeting(delivery, caplog):
    description = "Bad Request: chat not found"
    notifier, output, request = delivery(httpx.Response(400, json={
        "ok": False,
        "description": description,
        "parameters": {"migrate_to_chat_id": 456},
    }))

    asyncio.run(notifier.send_daily_summary("Summary", [], 0, "2026-11-18", "en", DailySummarizer()))

    assert f"Webhook client error (status=400): {description}" in output.getvalue()
    assert f"status=400: {description}" in caplog.text
    assert BOT_TOKEN not in caplog.text
    request.assert_awaited_once()
    assert request.await_args.args[1:] == ("POST", WEBHOOK_URL)
    assert json.loads(request.await_args.kwargs["content"])["chat_id"] == 123


@pytest.mark.parametrize(("base_url", "bot_prefix"), [
    ("https://api.telegram.org", "bot"),
    ("https://proxy.example/bot-api", "bot"),
    ("https://proxy.example", "%62ot"),
])
def test_telegram_description_is_literal_and_redacted(delivery, caplog, base_url, bot_prefix):
    encoded_token = BOT_TOKEN.replace(":e", "%3a%65")
    url = f"{base_url}/{bot_prefix}{BOT_TOKEN}/sendRichMessage"
    response = httpx.Response(429, json={"description": (
        f"[bold]Rejected[/bold]\n{url}\r{BOT_TOKEN}\x1b {encoded_token}"
    )})
    notifier, output, _ = delivery(response, url=url)

    result = asyncio.run(notifier.notify({"summary": "Summary"}))

    expected = (
        f"[bold]Rejected[/bold] {base_url}/{bot_prefix}<redacted>/sendRichMessage"
        " <redacted>  <redacted>"
    )
    assert result.status == webhook.WebhookDeliveryStatus.HTTP_FAILURE
    assert result.status_code == 429
    assert result.sent is False
    assert result.detail == expected
    assert expected in output.getvalue()
    assert expected in caplog.text
    for destination in (output.getvalue(), caplog.text, result.detail):
        assert BOT_TOKEN not in destination
        assert encoded_token not in destination
        assert "\r" not in destination
        assert "\x1b" not in destination


@pytest.mark.parametrize("body", [
    b"raw response",
    b'["raw response"]',
    b'{"other": "raw response"}',
    b'{"description": null}',
    b'{"description": 123}',
    b'{"description": ""}',
    b'{"description": " \\n\\u001b"}',
])
def test_telegram_error_falls_back_to_status(delivery, caplog, body):
    notifier, output, _ = delivery(httpx.Response(400, content=body))

    result = asyncio.run(notifier.notify({"summary": "Summary"}))

    assert output.getvalue() == "Webhook client error (status=400)\n"
    assert caplog.records[-1].getMessage().endswith("status=400")
    assert result.status == webhook.WebhookDeliveryStatus.HTTP_FAILURE
    assert result.status_code == 400
    assert result.detail is None


@pytest.mark.parametrize(("platform", "status", "message"), [
    ("generic", 400, "Webhook client error"),
    ("telegram", 503, "Webhook server error"),
])
def test_other_error_responses_keep_existing_diagnostics(delivery, caplog, platform, status, message):
    response = httpx.Response(status, json={"description": "raw response"})
    notifier, output, _ = delivery(response, platform=platform)

    result = asyncio.run(notifier.notify({"summary": "Summary"}))

    assert output.getvalue() == f"{message} (status={status})\n"
    assert caplog.records[-1].getMessage().endswith(f"status={status}")
    assert result.status == webhook.WebhookDeliveryStatus.HTTP_FAILURE
    assert result.detail == response.text
