import json
import os
import re
from pathlib import Path
from typing import Any, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from ..models import Config, SourcesConfig
from ..storage.manager import _ENV_VAR_PATTERN, ConfigError, _expand_env_vars

_USER_ID_PATTERN = re.compile(r"[1-9][0-9]*")
MAX_USER_SOURCES = 20


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class _UserRSS(_Strict):
    name: str = Field(min_length=1, max_length=100)
    url: str
    enabled: bool = True


class _UserTelegramChannel(_Strict):
    channel: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_]{3,31}$")
    enabled: bool = True


class _UserTelegram(_Strict):
    channels: List[_UserTelegramChannel] = Field(default_factory=list)


class _UserSubreddit(_Strict):
    subreddit: str = Field(pattern=r"^[A-Za-z0-9_]{2,21}$")
    enabled: bool = True


class _UserRedditUser(_Strict):
    username: str = Field(pattern=r"^[A-Za-z0-9_-]{3,20}$")
    enabled: bool = True


class _UserReddit(_Strict):
    subreddits: List[_UserSubreddit] = Field(default_factory=list)
    users: List[_UserRedditUser] = Field(default_factory=list)


class _UserGitHub(_Strict):
    type: Literal["repo_releases", "user_events"]
    owner: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$")
    repo: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$")
    username: Optional[str] = Field(default=None, pattern=r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}$")
    enabled: bool = True

    @model_validator(mode="after")
    def _target_matches_type(self) -> "_UserGitHub":
        if self.type == "repo_releases" and not (self.owner and self.repo and self.username is None):
            raise ValueError("repo_releases needs owner and repo only")
        if self.type == "user_events" and not (self.username and self.owner is None and self.repo is None):
            raise ValueError("user_events needs username only")
        return self


class _UserSources(_Strict):
    rss: List[_UserRSS] = Field(default_factory=list)
    telegram: _UserTelegram = Field(default_factory=_UserTelegram)
    reddit: _UserReddit = Field(default_factory=_UserReddit)
    github: List[_UserGitHub] = Field(default_factory=list)

    def count(self) -> int:
        return (
            len(self.rss)
            + len(self.telegram.channels)
            + len(self.reddit.subreddits)
            + len(self.reddit.users)
            + len(self.github)
        )


class UserConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int = Field(gt=0)
    chat_id: Optional[Union[int, str]] = None
    time_window_hours: int = 1
    publish_site: bool = False
    sources: Optional[SourcesConfig] = None

    @field_validator("time_window_hours")
    @classmethod
    def _divides_day(cls, value: int) -> int:
        if value <= 0 or 24 % value:
            raise ValueError("time_window_hours must be a positive divisor of 24")
        return value

    @field_validator("chat_id")
    @classmethod
    def _non_empty_chat(cls, value: Optional[Union[int, str]]) -> Optional[Union[int, str]]:
        if isinstance(value, str) and not value.strip():
            raise ValueError("chat_id must not be empty")
        return value


def users_dir(data_dir: Path) -> Path:
    return Path(data_dir) / "users"


def user_path(data_dir: Path, user_id: str) -> Path:
    if not _USER_ID_PATTERN.fullmatch(user_id):
        raise ConfigError(f"Invalid user id: {user_id!r}")
    return users_dir(data_dir) / f"{user_id}.json"


def _owner_id() -> Optional[int]:
    value = os.environ.get("HORIZON_OWNER_ID", "")
    return int(value) if _USER_ID_PATTERN.fullmatch(value) else None


def _restrict_user_sources(data: Any, path: Path) -> Any:
    if not isinstance(data, dict) or "sources" not in data:
        return data
    sources = _UserSources.model_validate(data["sources"])
    if sources.count() > MAX_USER_SOURCES:
        raise ConfigError(f"{path} has {sources.count()} sources, the limit is {MAX_USER_SOURCES}")
    return {**data, "sources": {**sources.model_dump(), "hackernews": {"enabled": False}}}


def _reject_env_refs(data: Any, path: Path) -> Any:
    names = sorted(set(_ENV_VAR_PATTERN.findall(json.dumps(data))))
    if names:
        raise ConfigError(
            f"{path} references {', '.join(names)}: environment variables are expanded "
            "only in the owner's file (HORIZON_OWNER_ID)"
        )
    return data


def load_user(data_dir: Path, user_id: str) -> UserConfig:
    path = user_path(data_dir, user_id)
    if not path.exists():
        raise ConfigError(f"User config not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if int(user_id) == _owner_id():
            data = _expand_env_vars(data)
        else:
            data = _restrict_user_sources(_reject_env_refs(data, path), path)
        user = UserConfig.model_validate(data)
    except (json.JSONDecodeError, ValidationError) as exc:
        raise ConfigError(f"Invalid user config {path}\nDetails: {exc}") from exc
    if user.id != int(user_id):
        raise ConfigError(f"User id {user.id} in {path} does not match the file name")
    return user


def apply_overlay(base: Config, user: UserConfig) -> Config:
    webhook = base.webhook
    if webhook is None or not webhook.enabled or not isinstance(webhook.request_body, dict):
        raise ConfigError("Per-user delivery needs an enabled webhook with a JSON request_body")
    data = base.model_dump(mode="json")
    if user.sources is not None:
        data["sources"] = user.sources.model_dump(mode="json")
    data["collection"]["time_window_hours"] = user.time_window_hours
    chat_id = user.id if user.chat_id is None else user.chat_id
    if isinstance(chat_id, str) and _ENV_VAR_PATTERN.search(chat_id):
        raise ConfigError(f"chat_id {chat_id} of user {user.id} is not expanded: set the environment variable")
    data["webhook"]["request_body"]["chat_id"] = chat_id
    if not user.publish_site:
        data["email"] = None
    return Config.model_validate(data)


def due_users(data_dir: Path, hour: int) -> list[dict[str, Any]]:
    due = []
    for path in sorted(users_dir(data_dir).glob("*.json")):
        try:
            user = load_user(data_dir, path.stem)
        except ConfigError:
            due.append({"user": path.stem, "publish_site": False})
            continue
        if hour % user.time_window_hours == 0:
            due.append({"user": path.stem, "publish_site": user.publish_site})
    return due
