"""Webhook notification service for Horizon."""

import asyncio
import html
import json
import logging
import os
import re
from rich.console import Console
from rich.text import Text
from dataclasses import asdict, dataclass
from enum import Enum
from urllib.parse import unquote, urlsplit, urlunsplit
from datetime import datetime, timezone
from typing import Any, List, Optional, Union, cast
import httpx

from ..ai.markdown_utils import clean_app_summary_markdown
from ..console_icons import get_icons
from ..models import ContentItem, WebhookConfig
from ..ai.summarizer import LABELS, DailySummarizer
from ..url_security import UnsafeURLError, safe_request, validate_http_url

logger = logging.getLogger(__name__)

TELEGRAM_RICH_MESSAGE_LIMIT = 32000
TELEGRAM_RICH_BLOCK_LIMIT = 500
TELEGRAM_SEND_INTERVAL = 3.0
_TELEGRAM_BOT_PATH_RE = re.compile(r"/bot[^/]+")
_TELEGRAM_TOKEN_PATH_RE = re.compile(r"/bot([0-9]+:[A-Za-z0-9_-]+)(?=/|$)")
_TELEGRAM_EXPAND_HINT = {
    "zh": "点击条目即可展开详情。",
    "ru": "Нажмите на материал, чтобы раскрыть подробности.",
    "en": "Tap an item to expand the details.",
}
_TELEGRAM_PART_LABEL = {
    "zh": "第 {part}/{total} 部分",
    "ru": "Часть {part} из {total}",
    "en": "Part {part}/{total}",
}
_TELEGRAM_CONTINUED_LABEL = {"zh": "续", "ru": "продолжение", "en": "continued"}
_TELEGRAM_INLINE_RE = re.compile(
    r"\[(?:\\.|[^\]\\\n])*\]\([^\s()]*\)"
    r"|\*\*(?:\\.|[^*\n]|\*(?!\*))*\*\*"
    r"|`(?:\\.|[^`\n])*`"
    r"|&(?:\#\d+|\#x[0-9a-fA-F]+|[a-zA-Z]+);|\\.|.",
    re.DOTALL,
)


class WebhookDeliveryStatus(str, Enum):
    DISABLED = "disabled"
    SKIPPED = "skipped"
    SUCCESS = "success"
    HTTP_FAILURE = "http_failure"
    PLATFORM_FAILURE = "platform_failure"
    NETWORK_FAILURE = "network_failure"
    INTERNAL_FAILURE = "internal_failure"


@dataclass(frozen=True)
class WebhookDeliveryResult:
    status: WebhookDeliveryStatus
    status_code: int | None = None
    detail: str | None = None
    error_type: str | None = None

    @property
    def sent(self) -> bool:
        return self.status == WebhookDeliveryStatus.SUCCESS

    def to_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["status"] = self.status.value
        result["sent"] = self.sent
        return result


# Pattern: #{key} or #{key?param1=val1&param2=val2}
_PLACEHOLDER_RE = re.compile(r"#\{(\w+)(\?\w+=[^}]+)?\}")
_SENSITIVE_HEADER_RE = re.compile(
    r"(authorization|token|secret|signature|key|password)", re.IGNORECASE
)


def _truncate(value: str, limit: int, split: str) -> str:
    """Truncate a string to at most *limit* characters by splitting on *split*.

    Segments are accumulated in order until adding the next one would
    exceed *limit* characters.  Remaining segments are dropped.

    Args:
        value: The full text to truncate
        limit: Maximum number of characters allowed
        split: Delimiter to split value into segments

    Returns:
        Truncated text
    """
    segments = value.split(split)
    kept: list[str] = []
    current_chars = 0

    for seg in segments:
        # +len(split) for the delimiter that will be re-joined
        seg_chars = len(seg) + (len(split) if kept else 0)
        if kept and current_chars + seg_chars > limit:
            break
        kept.append(seg)
        current_chars += seg_chars

    return split.join(kept)


def _render(
    template: Union[str, dict, list], variables: dict
) -> Union[str, dict, list]:
    """Replace #{key} and #{key?params} placeholders in a template.

    Supports strings, dicts, and lists.  For dicts/lists, walks all
    string values recursively and replaces placeholders.

    Parameterized syntax: #{key?limit=N&split=DELIM}
      - limit: maximum number of output characters
      - split: delimiter to split the value into segments before
               accumulating up to *limit* characters

    Args:
        template: Template with #{key} placeholders — str, dict, or list
        variables: Dict mapping placeholder keys to replacement values

    Returns:
        Same type as template, with placeholders replaced
    """
    if isinstance(template, dict):
        return {k: _render(v, variables) for k, v in template.items()}
    if isinstance(template, list):
        return [_render(item, variables) for item in template]
    if isinstance(template, str):

        def _replace(match: re.Match) -> str:
            key = match.group(1)
            params_str = match.group(2)  # e.g. "?limit=500&split=---"

            value = variables.get(key)
            if value is None:
                return match.group(0)  # leave placeholder unchanged

            if not params_str:
                return str(value)

            # Parse params: ?limit=500&split=---
            raw_params = params_str.lstrip("?")
            params: dict[str, str] = {}
            for pair in raw_params.split("&"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    params[k] = v

            limit = int(params.get("limit", "0")) if "limit" in params else 0
            split_delim = params.get("split", "---")

            if limit and split_delim:
                return _truncate(str(value), limit, split_delim)

            return str(value)

        return _PLACEHOLDER_RE.sub(_replace, template)
    # int, float, bool, None — return as-is
    return template


def _format_markdown_for_webhook(value: str) -> str:
    """Flatten HTML constructs that chat/webhook Markdown often cannot render."""
    return clean_app_summary_markdown(value)


def _telegram_details(title: str, content: str, *, preserve_whitespace: bool = False) -> str:
    if not preserve_whitespace:
        content = content.strip()
    return (
        f"<details><summary>{html.escape(title, quote=False)}</summary>\n\n"
        f"{content}\n\n</details>"
    )


def _telegram_block_budget(value: str) -> int:
    return 3 * sum(bool(line.strip()) for line in value.splitlines())


def _telegram_fits(value: str) -> bool:
    return (
        len(value) <= TELEGRAM_RICH_MESSAGE_LIMIT
        and _telegram_block_budget(value) <= TELEGRAM_RICH_BLOCK_LIMIT
    )


def _telegram_take_content(content: str, envelope: str) -> tuple[str, str]:
    chars_left = TELEGRAM_RICH_MESSAGE_LIMIT - len(envelope)
    lines_left = (TELEGRAM_RICH_BLOCK_LIMIT - _telegram_block_budget(envelope)) // 3 - 1
    end = 0
    for match in _TELEGRAM_INLINE_RE.finditer(content):
        token = match.group()
        if len(token) > chars_left or token.count("\n") > lines_left:
            if not end:
                for delimiter in ("**", "`"):
                    if token.startswith(delimiter) and token.endswith(delimiter):
                        inner = token[len(delimiter):-len(delimiter)]
                        fragment, remaining = _telegram_take_content(
                            inner, envelope + delimiter * 2
                        )
                        tail = delimiter + remaining + delimiter if remaining else ""
                        return (
                            delimiter + fragment + delimiter,
                            tail + content[match.end():],
                        )
            break
        chars_left -= len(token)
        lines_left -= token.count("\n")
        end = match.end()
    if not end:
        raise ValueError("Telegram rich message cannot fit an indivisible text fragment")
    return content[:end], content[end:]


def _prepare_variables_for_body(
    raw_body: Union[str, dict, list, None], variables: dict, platform: str = "generic"
) -> dict:
    """Apply webhook-safe variable formatting before body rendering."""
    if raw_body is None or "summary" not in variables or platform == "telegram":
        return variables

    prepared = dict(variables)
    prepared["summary"] = _format_markdown_for_webhook(str(variables["summary"]))
    return prepared


def _isjson(s: str) -> bool:
    """Return True if the string starts with a JSON open brace."""
    s = s.strip()
    return s.startswith("{") or s.startswith("[")


def _is_feishu_platform(platform: str) -> bool:
    """Return whether platform should use Feishu/Lark card rendering."""
    return platform.lower() in {"feishu", "lark"}


def _text(value: str) -> dict[str, str]:
    """Build a Feishu plain text object."""
    return {"tag": "plain_text", "content": value}


def _markdown(content: str) -> dict[str, str]:
    """Build a Feishu Markdown component."""
    return {"tag": "markdown", "content": content}


def _collapsible_panel(title: str, content: str) -> dict[str, Any]:
    """Build a Feishu Card JSON 2.0 collapsible panel."""
    return {
        "tag": "collapsible_panel",
        "expanded": False,
        "header": {
            "title": _text(title),
            "icon": {
                "tag": "standard_icon",
                "token": "down-small-ccm_outlined",
                "size": "16px 16px",
            },
            "icon_position": "right",
            "icon_expanded_angle": -180,
        },
        "border": {"color": "grey", "corner_radius": "5px"},
        "elements": [_markdown(content)],
    }


def _extract_headers(headers_str: Optional[str]) -> dict:
    """Parse custom headers from a multi-line "Key: Value" string.

    Args:
        headers_str: Multi-line string, each line "Key: Value"

    Returns:
        dict: Parsed headers as key-value pairs
    """
    if not headers_str:
        return {}

    headers = {}
    for line in headers_str.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(":", 1)
        if len(parts) != 2:
            logger.warning("Invalid webhook header line: %s", line)
            continue
        k, v = parts[0].strip(), parts[1].strip()
        headers[k] = v

    return headers


def redact_url(url: str) -> str:
    """Return a log-safe URL without query strings or fragments."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return "<invalid-url>"
    if not parts.scheme or not parts.netloc:
        return "<redacted-url>"
    path = _TELEGRAM_BOT_PATH_RE.sub("/bot<redacted>", parts.path)
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def redact_headers(headers: dict[str, str]) -> dict[str, str]:
    """Mask sensitive header values for logs and dry-run output."""
    return {
        key: "<redacted>" if _SENSITIVE_HEADER_RE.search(key) else value
        for key, value in headers.items()
    }


def _telegram_token_pattern(request_url: str) -> re.Pattern[str] | None:
    tokens = _TELEGRAM_TOKEN_PATH_RE.findall(unquote(urlsplit(request_url).path))
    if not tokens:
        return None
    patterns = [
        "".join(f"(?:{re.escape(char)}|(?i:%{ord(char):02x}))" for char in token)
        for token in sorted(tokens, key=len, reverse=True)
    ]
    return re.compile("|".join(patterns))


def _telegram_error_description(
    response: httpx.Response, token_pattern: re.Pattern[str] | None
) -> str | None:
    try:
        data = response.json()
    except (ValueError, RecursionError):
        return None

    description = data.get("description") if isinstance(data, dict) else None
    if not isinstance(description, str):
        return None

    if token_pattern:
        description = token_pattern.sub("<redacted>", description)

    description = "".join(char if char.isprintable() else " " for char in description)
    return description.strip()[:500].rstrip() or None


class WebhookNotifier:
    """Sends webhook notifications after pipeline completion or failure."""

    def __init__(self, config: WebhookConfig, console=None, icons=None):
        self.config = config
        self.console = console if console is not None else Console(stderr=True)
        self.icons = icons if icons is not None else get_icons()
        self.url = None
        self._validate_config()  # sets self.url or raises ValueError

    def _validate_url(self, url: str) -> str:
        """Validate webhook URL has a valid scheme (http/https) and hostname.
        Raises:
            ValueError: If the URL is empty, has wrong scheme, no hostname,
                        or is structurally invalid
        """
        url = url.strip()
        # Remove shell escape artifacts: \? \= \& \% before query chars
        url = re.sub(r"\\([?=&%])", r"\1", url)
        if not url:
            raise ValueError(
                f"Webhook URL is empty (env var '{self.config.url_env}' is set but empty)"
            )
        try:
            validate_http_url(url)
            httpx.URL(url)
        except (httpx.InvalidURL, UnsafeURLError) as e:
            raise ValueError(
                f"Webhook URL is structurally invalid: '{url}' — {e} "
                f"(env var '{self.config.url_env}')"
            ) from e
        return url

    def _validate_config(self) -> None:
        """Validate webhook URL configuration and print warnings for skip scenarios.

        Raises ValueError when URL is present but invalid.
        Sets self.url to the validated URL, or leaves it None for skip scenarios.
        """
        if not self.config.url_env:
            # url_env not configured at all
            logger.warning("Webhook enabled but url_env is not configured, skipping notification.")
            self.console.print(
                "[yellow]Webhook enabled but 'url_env' is not set in config. "
                "No notification URL available, skipping.[/yellow]"
            )
            return

        raw_url = os.getenv(self.config.url_env)
        if raw_url is None:
            # env var name configured, but the env var itself doesn't exist
            logger.warning(
                "Webhook enabled but env var '%s' is not set, skipping notification.",
                self.config.url_env,
            )
            self.console.print(
                f"[yellow]Webhook enabled but env var '{self.config.url_env}' is not set "
                f"in your environment. Skipping notification.[/yellow]"
            )
            return

        # env var exists — validate the URL value (strip + scheme + hostname + httpx check)
        self.url = self._validate_url(raw_url)

    def _render_request_components(
        self, variables: dict
    ) -> tuple[str, str | None, dict[str, str]]:
        """Render the final request URL, body, and headers for the given variables."""
        request_url = cast(str, _render(self.url or "", variables))

        content_type = "application/x-www-form-urlencoded"
        body_content = None
        raw_body = variables.get("_request_body_override", self.config.request_body)
        body_variables = _prepare_variables_for_body(
            raw_body, variables, (self.config.platform or "generic").lower()
        )

        if raw_body:
            if isinstance(raw_body, (dict, list)):
                rendered_obj = _render(raw_body, body_variables)
                body_content = json.dumps(rendered_obj, ensure_ascii=False)
                content_type = "application/json"
            elif isinstance(raw_body, str) and raw_body.strip():
                rendered = cast(str, _render(raw_body, body_variables))
                body_content = rendered
                if _isjson(rendered):
                    try:
                        json.loads(rendered)
                        content_type = "application/json"
                    except json.JSONDecodeError:
                        pass

        headers = _extract_headers(self.config.headers)
        headers["Content-Type"] = content_type
        return request_url, body_content, headers

    def _can_use_feishu_collapsible(self) -> bool:
        """Return whether this notifier should render Feishu collapsible cards."""
        platform = getattr(self.config, "platform", "generic")
        layout = getattr(self.config, "layout", "markdown")
        return _is_feishu_platform(platform) and layout == "collapsible"

    def _build_feishu_collapsible_overview(
        self,
        item_count: int,
        all_items_count: int,
        date: str,
        lang: str,
    ) -> str:
        """Build a non-redundant overview for a card that already lists item panels."""
        if lang == "zh":
            if item_count == 0:
                return (
                    f"# Horizon 每日速递 - {date}\n\n"
                    f"> 已分析 {all_items_count} 条内容，暂无达到重要性阈值的资讯。"
                )
            return (
                f"# Horizon 每日速递 - {date}\n\n"
                f"> 从 {all_items_count} 条内容中筛选出 {item_count} 条重要资讯。\n\n"
                "点击下方新闻面板即可在飞书内展开阅读全文。"
            )

        if lang == "ru":
            if item_count == 0:
                return (
                    f"# Horizon: дайджест дня - {date}\n\n"
                    f"> Проанализировано материалов: {all_items_count}. "
                    "Ни один не прошёл порог важности."
                )
            return (
                f"# Horizon: дайджест дня - {date}\n\n"
                f"> Отобрано важных материалов: {item_count} из {all_items_count}.\n\n"
                "Разверните карточки ниже, чтобы прочитать материалы прямо в Feishu/Lark."
            )

        if item_count == 0:
            return (
                f"# Horizon Daily - {date}\n\n"
                f"> Analyzed {all_items_count} items, but none met the importance threshold."
            )

        return (
            f"# Horizon Daily - {date}\n\n"
            f"> Selected {item_count} important items from {all_items_count} fetched items.\n\n"
            "Expand the panels below to read the full briefing inside Feishu/Lark."
        )

    def _build_feishu_collapsible_body(
        self,
        important_items: List[ContentItem],
        all_items_count: int,
        date: str,
        lang: str,
        summarizer: DailySummarizer,
    ) -> dict[str, Any]:
        """Build a single Feishu Card JSON 2.0 message with collapsed item details."""
        overview = self._build_feishu_collapsible_overview(
            item_count=len(important_items),
            all_items_count=all_items_count,
            date=date,
            lang=lang,
        )
        elements: list[dict[str, Any]] = [_markdown(overview)]

        view = summarizer.build_view(important_items, lang)
        for group in view.groups:
            elements.append(_markdown(f"## {group.name}"))
            for view_item in group.items:
                score_suffix = (
                    f" ⭐️ {view_item.score}/10"
                    if view_item.score != "?"
                    else ""
                )
                panel_title = f"{view_item.index}. {view_item.title}{score_suffix}"
                item_content = summarizer.generate_webhook_item(
                    view_item.item,
                    language=lang,
                    index=view_item.index,
                    total=view_item.group_count,
                    title=view_item.title,
                    score=view_item.score,
                )
                elements.append(
                    _collapsible_panel(
                        panel_title,
                        _format_markdown_for_webhook(item_content),
                    )
                )

        return {
            "msg_type": "interactive",
            "card": {
                "schema": "2.0",
                "config": {
                    "wide_screen_mode": True,
                    "update_multi": True,
                },
                "header": {
                    "title": {
                        "tag": "plain_text",
                        "content": (
                            f"Horizon {date} 折叠日报"
                            if lang == "zh"
                            else f"Horizon {date}: дайджест дня"
                            if lang == "ru"
                            else f"Horizon {date} Collapsible Daily"
                        ),
                    },
                    "template": "blue",
                },
                "body": {
                    "elements": elements,
                },
            },
        }

    def _build_telegram_rich_parts(
        self,
        important_items: List[ContentItem],
        all_items_count: int,
        date: str,
        lang: str,
        summarizer: DailySummarizer,
    ) -> List[str]:
        labels = LABELS.get(lang, LABELS["en"])
        header = f"# {labels['header']} - {date}\n\n"
        if not important_items:
            return [
                header
                + f"> {labels['empty_analyzed'].format(total=all_items_count)}\n\n"
                + labels["empty_body"]
            ]

        overview = (
            header
            + f"> {labels['selected_items'].format(total=all_items_count, selected=len(important_items))}\n\n"
            + _TELEGRAM_EXPAND_HINT.get(lang, _TELEGRAM_EXPAND_HINT["en"])
        )
        entries = []
        for group in summarizer.build_view(important_items, lang).groups:
            for view_item in group.items:
                score_suffix = (
                    f" ⭐️ {view_item.score}/10" if view_item.score != "?" else ""
                )
                entries.append(
                    (
                        group.profile_id,
                        group.name,
                        f"{view_item.index}. {view_item.title}{score_suffix}",
                        clean_app_summary_markdown(
                            summarizer.generate_detail_item(
                                view_item.item,
                                language=lang,
                                index=view_item.index,
                                title=view_item.title,
                                score=view_item.score,
                            )
                        ),
                    )
                )
        part_label = _TELEGRAM_PART_LABEL.get(lang, _TELEGRAM_PART_LABEL["en"])
        continued = _TELEGRAM_CONTINUED_LABEL.get(lang, _TELEGRAM_CONTINUED_LABEL["en"])

        def prefix(number: int, total: int) -> str:
            return (
                f"**{labels['header']} - {date}** · "
                f"{part_label.format(part=number, total=total)}\n\n"
            )

        total = 1
        while True:
            parts = [overview]
            part_group = None
            for profile_id, name, title, content in entries:
                heading = f"## {name}\n\n"
                block = _telegram_details(title, content)
                addition = block if part_group == profile_id else heading + block
                candidate = parts[-1] + "\n\n" + addition
                if _telegram_fits(candidate):
                    parts[-1] = candidate
                    part_group = profile_id
                    continue
                start = prefix(len(parts) + 1, total) + heading
                if _telegram_fits(start + block):
                    parts.append(start + block)
                else:
                    remaining = content
                    fragment_title = title
                    if not remaining:
                        raise ValueError("Telegram rich message cannot fit an item heading")
                    while remaining:
                        start = prefix(len(parts) + 1, total) + heading
                        envelope = start + _telegram_details(fragment_title, "")
                        fragment, remaining = _telegram_take_content(remaining, envelope)
                        parts.append(
                            start + _telegram_details(
                                fragment_title, fragment, preserve_whitespace=True
                            )
                        )
                        fragment_title = f"{title} ({continued})"
                part_group = profile_id
            if len(parts) == total:
                return parts
            total = len(parts)

    def build_preview(self, variables: dict) -> dict[str, Any]:
        """Build the fully rendered request for dry-run preview."""
        request_url, body_content, headers = self._render_request_components(variables)
        return {
            "url": redact_url(request_url),
            "body": body_content,
            "headers": redact_headers(headers),
        }

    def build_daily_summary_messages(
        self,
        summary: str,
        important_items: List[ContentItem],
        all_items_count: int,
        date: str,
        lang: str,
        summarizer: DailySummarizer,
    ) -> List[dict[str, Any]]:
        """Build the variables for all webhook messages for one language."""
        webhook_languages = getattr(self.config, "languages", None)
        if webhook_languages and lang not in webhook_languages:
            return []

        base_vars = {
            "date": date,
            "language": lang,
            "important_items": len(important_items),
            "all_items": all_items_count,
            "result": "success",
            "timestamp": str(int(datetime.now(timezone.utc).timestamp())),
        }

        if self._can_use_feishu_collapsible():
            return [
                {
                    **base_vars,
                    "message_title": (
                        f"Horizon {date} 折叠日报"
                        if lang == "zh"
                        else f"Horizon {date}: дайджест дня"
                        if lang == "ru"
                        else f"Horizon {date} Collapsible Daily"
                    ),
                    "message_kind": "collapsible",
                    "summary": self._build_feishu_collapsible_overview(
                        item_count=len(important_items),
                        all_items_count=all_items_count,
                        date=date,
                        lang=lang,
                    ),
                    "_request_body_override": self._build_feishu_collapsible_body(
                        important_items=important_items,
                        all_items_count=all_items_count,
                        date=date,
                        lang=lang,
                        summarizer=summarizer,
                    ),
                }
            ]

        if (self.config.platform or "").lower() == "telegram":
            parts = self._build_telegram_rich_parts(
                important_items, all_items_count, date, lang, summarizer
            )
            return [
                {
                    **base_vars,
                    "message_title": (
                        f"Horizon {date} 日报"
                        if lang == "zh"
                        else f"Horizon {date}: дайджест дня"
                        if lang == "ru"
                        else f"Horizon {date} Daily"
                    ),
                    "message_kind": "summary",
                    "summary": part,
                }
                for part in parts
            ]

        delivery = getattr(self.config, "delivery", "summary")
        if delivery == "summary_and_items":
            item_messages: List[dict[str, Any]] = []
            overview = summarizer.generate_webhook_overview(
                important_items,
                date,
                all_items_count,
                language=lang,
            )
            overview_message = {
                **base_vars,
                "message_title": (
                    f"Horizon {date} 总览"
                    if lang == "zh"
                    else f"Horizon {date}: обзор"
                    if lang == "ru"
                    else f"Horizon {date} Overview"
                ),
                "message_kind": "overview",
                "summary": overview,
            }
            view = summarizer.build_view(important_items, lang)
            for group in view.groups:
                for view_item in group.items:
                    item_summary = summarizer.generate_webhook_item(
                        view_item.item,
                        language=lang,
                        index=view_item.index,
                        total=view_item.group_count,
                        title=view_item.title,
                        score=view_item.score,
                    )
                    item_messages.append(
                        {
                            **base_vars,
                            "message_title": (
                                f"{group.name} {view_item.index}/"
                                f"{view_item.group_count} {view_item.title}"
                            ),
                            "message_kind": "item",
                            "item_index": view_item.global_index,
                            "item_count": view.item_count,
                            "profile_item_index": view_item.index,
                            "profile_item_count": view_item.group_count,
                            "item_profile": group.profile_id,
                            "item_profile_name": group.name,
                            "item_title": view_item.title,
                            "item_url": str(view_item.item.url),
                            "item_score": (
                                view_item.score if view_item.score != "?" else ""
                            ),
                            "summary": item_summary,
                        }
                    )

            if getattr(self.config, "overview_position", "first") == "last":
                return list(reversed(item_messages)) + [overview_message]

            return [overview_message] + item_messages

        return [
            {
                **base_vars,
                "message_title": (
                    f"Horizon {date} 日报"
                    if lang == "zh"
                    else f"Horizon {date}: дайджест дня"
                    if lang == "ru"
                    else f"Horizon {date} Daily"
                ),
                "message_kind": "summary",
                "summary": summary,
            }
        ]

    async def notify(self, variables: dict) -> WebhookDeliveryResult:
        """Send a webhook notification with template variable substitution.

        If request_body is empty, sends a GET request.
        If request_body is provided, sends a POST request with
        auto-detected content-type

        Args:
            variables: Dict of template variable values to replace
                       in URL, request_body, and headers.
        """
        if not self.config.enabled:
            self.console.print("[yellow]Webhook is disabled, skipping notification.[/yellow]")
            return WebhookDeliveryResult(WebhookDeliveryStatus.DISABLED)

        if not self.url:
            logger.warning(
                "Webhook enabled but URL is empty (env var %s not set), skipping notification.",
                self.config.url_env,
            )
            self.console.print(
                f"[yellow]Webhook enabled but URL is empty — "
                f"env var '{self.config.url_env}' is not set. Skipping notification.[/yellow]"
            )
            return WebhookDeliveryResult(
                WebhookDeliveryStatus.SKIPPED,
                detail=f"Webhook URL environment variable '{self.config.url_env}' is not set.",
            )

        request_url, body_content, headers = self._render_request_components(variables)
        safe_url = redact_url(request_url)
        if body_content is not None:
            logger.debug(
                "Webhook POST body prepared (%d chars)",
                len(body_content or ""),
            )

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                if body_content is None:
                    response = await safe_request(
                        client, "GET", request_url, headers=headers
                    )
                else:
                    response = await safe_request(
                        client,
                        "POST",
                        request_url,
                        content=body_content.encode("utf-8"),
                        headers=headers,
                    )

            return self._handle_response_status(response, request_url)

        except (httpx.InvalidURL, UnsafeURLError) as e:
            self.console.print(
                f"[red]Webhook URL is invalid: {e}[/red]"
            )
            logger.error("Webhook URL invalid: %s, env var: %s", e, self.config.url_env)
            return WebhookDeliveryResult(
                WebhookDeliveryStatus.NETWORK_FAILURE,
                detail=str(e),
                error_type="invalid_url",
            )
        except httpx.ConnectError as e:
            self.console.print(
                f"[red]Webhook connection failed: {e}[/red]"
            )
            logger.error("Webhook connection failed: URL=%s, error=%s", safe_url, e)
            return WebhookDeliveryResult(
                WebhookDeliveryStatus.NETWORK_FAILURE,
                detail=str(e),
                error_type="connect",
            )
        except httpx.TimeoutException as e:
            self.console.print(
                f"[red]Webhook request timed out: {e}[/red]"
            )
            logger.error("Webhook timeout: URL=%s, error=%s", safe_url, e)
            return WebhookDeliveryResult(
                WebhookDeliveryStatus.NETWORK_FAILURE,
                detail=str(e),
                error_type="timeout",
            )
        except Exception as e:
            self.console.print(
                f"[red]Webhook call failed unexpectedly: {type(e).__name__}: {e}[/red]"
            )
            logger.error("Webhook unexpected error: URL=%s, type=%s, error=%s", safe_url, type(e).__name__, e)
            return WebhookDeliveryResult(
                WebhookDeliveryStatus.INTERNAL_FAILURE,
                detail=str(e),
                error_type=type(e).__name__,
            )

    def _check_body_error_code(self, body: str) -> Optional[str]:
        """Check if a 2xx response body contains a platform-specific error code.

        Returns a descriptive string if an error is detected, or None if the
        response appears successful.

        Checked patterns:
        - Feishu/Lark: {"code": non-zero, "msg": "..."} or {"StatusCode": non-zero}
        - DingTalk: {"errcode": non-zero, "errmsg": "..."}
        - Slack/Discord: {"ok": false}
        """
        try:
            data = json.loads(body)
        except (json.JSONDecodeError, ValueError):
            return None

        platform = (self.config.platform or "").lower()
        check_all = platform in ("", "generic")

        if platform in ("feishu", "lark") or check_all:
            code = data.get("code") or data.get("StatusCode")
            if code is not None and code != 0:
                msg = data.get("msg") or data.get("StatusMessage") or ""
                return f"Feishu/Lark error (code={code}): {msg}"

        if platform == "dingtalk" or check_all:
            errcode = data.get("errcode")
            if errcode is not None and errcode != 0:
                msg = data.get("errmsg") or ""
                return f"DingTalk error (errcode={errcode}): {msg}"

        if platform in ("slack", "discord") or check_all:
            if data.get("ok") is False:
                error = data.get("error") or ""
                return f"Slack/Discord error: {error}"

        return None

    def _handle_response_status(
        self, response: httpx.Response, request_url: str
    ) -> WebhookDeliveryResult:
        """Log and display HTTP response status by category.

        Even 2xx responses may contain platform-specific error codes
        in the JSON body (e.g. Feishu code=19001, DingTalk errcode=400,
        Slack ok=false).
        """
        safe_url = redact_url(request_url)
        status = response.status_code
        body = response.text[:500]
        detail = body

        if 200 <= status < 300:
            error_hint = self._check_body_error_code(body)
            if error_hint:
                logger.warning(
                    "Webhook 2xx but body contains error: URL=%s, status=%d, error=%s",
                    safe_url, status, error_hint,
                )
                self.console.print(
                    f"[yellow]Webhook response failed (status={status}): {error_hint}[/yellow]"
                )
                return WebhookDeliveryResult(
                    WebhookDeliveryStatus.PLATFORM_FAILURE,
                    status_code=status,
                    detail=error_hint,
                )
            else:
                logger.info("Webhook sent OK. URL: %s, status=%d", safe_url, status)
                self.console.print(
                    f"[green]Webhook sent successfully (status={status})[/green]"
                )
                return WebhookDeliveryResult(
                    WebhookDeliveryStatus.SUCCESS,
                    status_code=status,
                )

        if 300 <= status < 400:
            location = response.headers.get("location", "")
            self.console.print(
                f"[yellow]Webhook received redirect (status={status})[/yellow]"
            )
            logger.warning(
                "Webhook redirect: URL=%s, status=%d, location=%s",
                safe_url, status, location,
            )
        elif 400 <= status < 500:
            description = None
            if self.config.platform == "telegram":
                token_pattern = _telegram_token_pattern(request_url)
                if token_pattern:
                    safe_url = token_pattern.sub("<redacted>", safe_url)
                description = _telegram_error_description(response, token_pattern)
                detail = description
            message = f"Webhook client error (status={status})"
            if description:
                self.console.print(Text(f"{message}: {description}", style="red"))
            else:
                self.console.print(f"[red]{message}[/red]")
            logger.error(
                "Webhook client error: URL=%s, status=%d%s",
                safe_url, status, f": {description}" if description else "",
            )
        elif 500 <= status < 600:
            self.console.print(
                f"[red]Webhook server error (status={status})[/red]"
            )
            logger.error(
                "Webhook server error: URL=%s, status=%d",
                safe_url, status,
            )
        else:
            self.console.print(
                f"[red]Webhook unexpected status={status}: {response.text[:500]}[/red]"
            )
            logger.error("Webhook unexpected status: URL=%s, status=%d", safe_url, status)

        return WebhookDeliveryResult(
            WebhookDeliveryStatus.HTTP_FAILURE,
            status_code=status,
            detail=detail,
        )

    async def send_daily_summary(
        self,
        summary: str,
        important_items: List[ContentItem],
        all_items_count: int,
        date: str,
        lang: str,
        summarizer: DailySummarizer,
    ) -> None:
        """Send daily summary webhook notification.

        Handles language filtering, delivery mode (summary vs summary_and_items),
        and variable construction internally.

        Args:
            summary: Full markdown summary text
            important_items: List of important content items
            all_items_count: Total number of items fetched
            date: Date string (YYYY-MM-DD)
            lang: Language code ("en", "zh" or "ru")
            summarizer: DailySummarizer instance for generating webhook overviews
        """
        messages = self.build_daily_summary_messages(
            summary=summary,
            important_items=important_items,
            all_items_count=all_items_count,
            date=date,
            lang=lang,
            summarizer=summarizer,
        )
        if not messages:
            self.console.print(
                f"{self.icons['webhook_skip']} Skipping {lang.upper()} webhook notification "
                f"(filtered by webhook.languages)"
            )
            return

        self.console.print(
            f"{self.icons['webhook']} Sending {lang.upper()} webhook notification..."
        )
        is_telegram = (self.config.platform or "").lower() == "telegram"
        for index, message in enumerate(messages):
            if is_telegram and index:
                await asyncio.sleep(TELEGRAM_SEND_INTERVAL)
            await self.notify(message)

    async def send_failure(
        self,
        date: str,
        error_message: str,
    ) -> None:
        """Send webhook notification when the pipeline fails.

        Args:
            date: Date string (YYYY-MM-DD)
            error_message: Description of the failure
        """
        self.console.print(
            f"{self.icons['webhook']} Sending webhook failure notification..."
        )
        await self.notify(
            {
                "date": date,
                "language": "",
                "important_items": 0,
                "all_items": 0,
                "result": "failed",
                "timestamp": str(int(datetime.now(timezone.utc).timestamp())),
                "message_title": "Horizon generation failed",
                "message_kind": "failure",
                "summary": f"generation failed: {error_message}",
            }
        )
