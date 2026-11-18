import asyncio
import json
import re
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import markdown
import pytest
from bs4 import BeautifulSoup

from src.ai.markdown_utils import clean_app_summary_markdown
from src.ai.summarizer import DailySummarizer
from src.models import (
    ClassificationResult,
    ContentAnalysis,
    ContentArtifact,
    ContentBlock,
    ContentItem,
    ProcessingResult,
    SourceType,
    WebhookConfig,
)
from src.services import webhook


class Digest:
    def __init__(self, contents, profiles=None):
        self.contents = contents
        self.profiles = profiles or ["News"] * len(contents)

    def build_view(self, items, lang):
        groups = []
        for index, (content, profile) in enumerate(zip(self.contents, self.profiles), 1):
            if not groups or groups[-1].profile_id != profile:
                groups.append(SimpleNamespace(profile_id=profile, name=profile, items=[]))
            groups[-1].items.append(
                SimpleNamespace(index=index, title=f"Story {index}", score=8, item=content)
            )
        return SimpleNamespace(groups=groups)

    def generate_detail_item(self, item, **kwargs):
        return item


def notifier():
    return webhook.WebhookNotifier(
        WebhookConfig(
            enabled=True,
            platform="telegram",
            url_env="RICH_LIMIT_TEST_URL",
            request_body={
                "chat_id": 123,
                "rich_message": {"markdown": "#{summary}"},
                "disable_notification": True,
            },
        )
    )


def messages(contents, lang="ru", profiles=None):
    return notifier().build_daily_summary_messages(
        summary="unused",
        important_items=contents,
        all_items_count=len(contents),
        date="2026-11-18",
        lang=lang,
        summarizer=Digest(contents, profiles),
    )


def bodies(parts):
    return re.findall(
        r"<details><summary>.*?</summary>\n\n(.*?)\n\n</details>",
        "\n".join(part["summary"] for part in parts),
        re.S,
    )


def actual_blocks(text):
    details = re.findall(r"<details>.*?</details>", text, re.S)
    remaining = re.sub(r"<details>.*?</details>", "", text, flags=re.S)
    count = len(details)
    documents = [remaining]
    for detail in details:
        documents.append(re.sub(r"^.*?</summary>|</details>$", "", detail, flags=re.S))
    for document in documents:
        tree = BeautifulSoup(markdown.markdown(document), "html.parser")
        count += len(tree.find_all([
            "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
            "blockquote", "pre", "hr", "tr",
        ]))
    return count


def assert_limits(parts):
    assert parts
    for part in parts:
        text = part["summary"]
        assert len(text) <= webhook.TELEGRAM_RICH_MESSAGE_LIMIT
        assert actual_blocks(text) <= 500
        assert text.count("<details>") == text.count("</details>")


def test_many_short_stories_hit_blocks_before_length():
    contents = [f"p{i}\n\nq{i}\n\nr{i}\n\ns{i}" for i in range(110)]
    parts = messages(contents)
    assert sum(len(part["summary"]) for part in parts) < 32000
    assert len(parts) > 1
    assert bodies(parts) == contents
    assert_limits(parts)


@pytest.mark.parametrize(
    "body",
    [
        "Текст🙂 " * 9000,
        "\n\n".join(f"абзац{i}" for i in range(600)),
        "\n".join(f"- пункт{i}" for i in range(600)),
    ],
    ids=["long-text", "paragraphs", "list-items"],
)
def test_one_oversized_story_keeps_all_content(body):
    parts = messages([body])
    assert len(parts) > 1
    assert "".join(bodies(parts)) == body
    assert "продолжение" in " ".join(part["summary"] for part in parts)
    assert_limits(parts)


@pytest.mark.parametrize(
    "lang,part_label,continuation",
    [("ru", "Часть", "продолжение"), ("en", "Part", "continued"), ("zh", "部分", "续")],
)
def test_headers_and_profile_order_with_double_digit_parts(
    monkeypatch, lang, part_label, continuation
):
    monkeypatch.setattr(webhook, "TELEGRAM_RICH_MESSAGE_LIMIT", 600)
    contents = ["Alpha " * 700, "Omega"]
    parts = messages(contents, lang, ["First profile", "Second profile"])
    assert len(parts) >= 10
    assert "".join(bodies(parts)) == "".join(contents)
    assert_limits(parts)
    for number, part in enumerate(parts[1:], 2):
        assert part_label in part["summary"]
        assert str(number) in part["summary"]
        assert str(len(parts)) in part["summary"]
    assert continuation in "".join(part["summary"] for part in parts)
    assert "## Second profile" in parts[-1]["summary"]
    assert "2. Story 2 ⭐️ 8/10" in parts[-1]["summary"]


def test_inline_constructs_at_boundaries(monkeypatch):
    monkeypatch.setattr(webhook, "TELEGRAM_RICH_MESSAGE_LIMIT", 600)
    atoms = [
        r"\*", "&amp;", "[ссылка](https://example.com/path?a=1&amp;b=2)",
        "**метка**", "`#tag`", "🙂",
    ]
    body = " ".join(atoms * 200)
    parts = messages([body])
    assert "".join(bodies(parts)) == body
    assert_limits(parts)
    for fragment in bodies(parts):
        assert not fragment.endswith("\\")
        assert fragment.count("[") == fragment.count("]")
        assert fragment.count("**") % 2 == 0
        assert fragment.count("`") % 2 == 0
        assert not re.search(r"&(?:#?\w*)$", fragment)


def test_unbroken_long_text_does_not_stall(monkeypatch):
    monkeypatch.setattr(webhook, "TELEGRAM_RICH_MESSAGE_LIMIT", 600)
    body = "Ж" * 5000
    parts = messages([body])
    assert "".join(bodies(parts)) == body
    assert_limits(parts)


def test_recipient_and_spacing_are_preserved(monkeypatch):
    monkeypatch.setenv("RICH_LIMIT_TEST_URL", "https://example.com/sendRichMessage")
    monkeypatch.setattr(webhook, "TELEGRAM_RICH_MESSAGE_LIMIT", 600)
    sent = []

    async def fake_request(client, method, url, **kwargs):
        sent.append(json.loads(kwargs["content"]))
        return SimpleNamespace(
            status_code=200, text='{"ok":true}', json=lambda: {"ok": True}
        )

    sleep = AsyncMock()
    monkeypatch.setattr(webhook, "safe_request", fake_request)
    monkeypatch.setattr(webhook.asyncio, "sleep", sleep)
    body = "chat_id=999 " * 300
    asyncio.run(notifier().send_daily_summary(
        "", [body], 1, "2026-11-18", "ru", Digest([body])
    ))
    assert len(sent) > 1
    assert all(request["chat_id"] == 123 and request["disable_notification"] for request in sent)
    assert sleep.await_count == len(sent) - 1
    assert all(call.args == (3.0,) for call in sleep.await_args_list)


def test_short_and_empty_digests_remain_single_messages():
    assert len(messages(["short"])) == 1
    assert bodies(messages(["short"])) == ["short"]
    assert len(messages([])) == 1
    assert "<details>" not in messages([])[0]["summary"]


def test_actual_summarizer_preserves_escaped_content(monkeypatch):
    monkeypatch.setattr(webhook, "TELEGRAM_RICH_MESSAGE_LIMIT", 1200)
    item = ContentItem(
        id="test:long",
        source_type=SourceType.GITHUB,
        title="Long & safe",
        url="https://example.com/article",
        content="source",
        published_at=datetime(2026, 11, 18, tzinfo=timezone.utc),
        fetched_at=datetime(2026, 11, 18, tzinfo=timezone.utc),
        processing=ProcessingResult(
            classification=ClassificationResult(profile="tech-news", method="source_override"),
            analysis=ContentAnalysis(
                score=8,
                reason="test",
                summary="Текст🙂 & <safe> *literal*\n\n" * 300,
                tags=["test"],
            ),
        ),
    )
    summarizer = DailySummarizer()
    view_item = summarizer.build_view([item], "ru").groups[0].items[0]
    expected = clean_app_summary_markdown(summarizer.generate_detail_item(
        item, language="ru", index=view_item.index, title=view_item.title, score=view_item.score
    ))
    parts = notifier().build_daily_summary_messages("", [item], 1, "2026-11-18", "ru", summarizer)
    assert len(parts) > 1
    assert "".join(bodies(parts)) == expected
    assert_limits(parts)


def test_indivisible_oversized_link_is_rejected_before_sending(monkeypatch):
    monkeypatch.setattr(webhook, "TELEGRAM_RICH_MESSAGE_LIMIT", 600)
    sender = notifier()
    sender.notify = AsyncMock()
    body = "[link](https://example.com/" + "x" * 1000 + ")"
    with pytest.raises(ValueError, match="indivisible text fragment"):
        asyncio.run(sender.send_daily_summary("", [body], 1, "2026-11-18", "ru", Digest([body])))
    sender.notify.assert_not_awaited()


def test_whitespace_at_a_split_boundary_is_not_lost(monkeypatch):
    monkeypatch.setattr(webhook, "TELEGRAM_RICH_MESSAGE_LIMIT", 600)
    body = "word" + " " * 1000 + "word" + "\n" * 1000 + "end"
    parts = messages([body])
    assert "".join(bodies(parts)) == body
    assert_limits(parts)


@pytest.mark.parametrize("kind,delimiter", [("block-title", "**"), ("tag", "`")])
def test_actual_summarizer_splits_long_formatted_text(monkeypatch, kind, delimiter):
    monkeypatch.setattr(webhook, "TELEGRAM_RICH_MESSAGE_LIMIT", 600)
    marker = "Z" * 3000
    processing = ProcessingResult(
        classification=ClassificationResult(profile="tech-news", method="source_override"),
        analysis=ContentAnalysis(score=8, reason="test", summary="short", tags=[]),
    )
    if kind == "tag":
        processing.analysis.tags = [marker]
    else:
        processing.artifacts["ru"] = ContentArtifact(
            language="ru",
            title="Story",
            blocks=[ContentBlock(id="extra", title=marker, content="body")],
        )
    item = ContentItem(
        id="test:formatted",
        source_type=SourceType.GITHUB,
        title="Story",
        url="https://example.com/article",
        content="source",
        published_at=datetime(2026, 11, 18, tzinfo=timezone.utc),
        fetched_at=datetime(2026, 11, 18, tzinfo=timezone.utc),
        processing=processing,
    )
    summarizer = DailySummarizer()
    view_item = summarizer.build_view([item], "ru").groups[0].items[0]
    expected = clean_app_summary_markdown(summarizer.generate_detail_item(
        item, language="ru", index=view_item.index, title=view_item.title, score=view_item.score
    ))
    parts = notifier().build_daily_summary_messages(
        "", [item], 1, "2026-11-18", "ru", summarizer
    )
    fragments = bodies(parts)
    assert len(parts) > 2
    assert sum(fragment.count("Z") for fragment in fragments) == len(marker)
    assert all(fragment.count(delimiter) % 2 == 0 for fragment in fragments)
    assert "".join(fragments).replace(delimiter, "") == expected.replace(delimiter, "")
    assert_limits(parts)
