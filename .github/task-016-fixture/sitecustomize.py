import json
from datetime import datetime, timezone

from src.ai.client import OpenAIClient
from src.models import ContentItem, SourceType
from src.scrapers.base import FetchResult
from src.scrapers.rss import RSSScraper
from src.services.webhook import WebhookNotifier


async def fixture_feed(self, source, since):
    item = ContentItem(
        id="rss:fixture:016",
        source_type=SourceType.RSS,
        title="Task 016 fixture story",
        url="https://example.invalid/story",
        content="A deterministic content item for the workflow check.",
        published_at=datetime.now(timezone.utc),
        profile="tech-news",
        metadata={"rss_source": source.name},
    )
    return FetchResult(items=[item], successful=1)


async def fixture_completion(self, system, user, **kwargs):
    if '"tool_requests"' in system:
        return json.dumps({"tool_requests": []})
    if '"score"' in system:
        return json.dumps({"score": 9, "reason": "Fixture", "summary": "Task 016 fixture story", "tags": ["CI"]})
    if '"blocks"' in system:
        return json.dumps({
            "title": "Task 016 fixture story",
            "blocks": [
                {"id": "summary", "title": "Summary", "content": "Task 016 fixture digest content."},
                {"id": "background", "title": "Background", "content": "Run on an isolated fixture."},
            ],
        })
    raise AssertionError(f"Unexpected fixture completion: {system[:120]}")


async def fixture_delivery(self, summary, *args, **kwargs):
    assert "Task 016 fixture digest content." in summary
    print("Fixture delivery intercepted; no external request")


RSSScraper._fetch_feed = fixture_feed
OpenAIClient.complete = fixture_completion
WebhookNotifier.send_daily_summary = fixture_delivery
