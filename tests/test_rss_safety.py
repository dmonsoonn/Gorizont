from __future__ import annotations

import asyncio
import ipaddress
from datetime import datetime, timezone

import httpx
import pytest

from src.models import RSSSourceConfig
from src.scrapers.rss import RSSScraper

_SINCE = datetime(2026, 4, 24, 0, 0, tzinfo=timezone.utc)
_FEED = """<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title>
<item><title>Story</title><link>https://public.example/story</link>
<pubDate>Fri, 24 Apr 2026 12:00:00 GMT</pubDate></item>
</channel></rss>
"""
_HOSTS = {"public.example": "93.184.216.34", "private.example": "10.0.0.5"}


@pytest.fixture(autouse=True)
def _fake_dns(monkeypatch):
    async def resolve(hostname: str, port: int) -> set[str]:
        try:
            return {str(ipaddress.ip_address(hostname))}
        except ValueError:
            return {_HOSTS[hostname]}

    monkeypatch.setattr("src.url_security._resolve_hostname", resolve)


def _fetch(sources: list[RSSSourceConfig], requests: list[httpx.Request]):
    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/redirect":
            return httpx.Response(302, headers={"location": "http://private.example/feed"})
        return httpx.Response(200, text=_FEED)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            return await RSSScraper(sources, client).fetch(_SINCE)

    return asyncio.run(run())


def test_rss_never_requests_private_destinations():
    requests: list[httpx.Request] = []
    sources = [
        RSSSourceConfig(name="Loopback", url="http://127.0.0.1/feed"),
        RSSSourceConfig(name="Metadata", url="http://169.254.169.254/latest/meta-data"),
        RSSSourceConfig(name="Private DNS", url="http://private.example/feed"),
        RSSSourceConfig(name="Redirect", url="https://public.example/redirect"),
        RSSSourceConfig(name="Public", url="https://public.example/feed"),
    ]

    result = _fetch(sources, requests)

    assert {request.url.host for request in requests} == {"public.example"}
    assert set(result.failures) == {"Loopback", "Metadata", "Private DNS", "Redirect"}
    assert all(failure.startswith("UnsafeURLError") for failure in result.failures.values())
    assert [item.title for item in result.items] == ["Story"]


def test_rss_still_expands_env_vars_in_feed_url(monkeypatch):
    monkeypatch.setenv("FEED_KEY", "secret-key")
    requests: list[httpx.Request] = []

    result = _fetch([RSSSourceConfig(name="Keyed", url="https://public.example/feed?key=${FEED_KEY}")], requests)

    assert [request.url.params["key"] for request in requests] == ["secret-key"]
    assert [item.title for item in result.items] == ["Story"]
