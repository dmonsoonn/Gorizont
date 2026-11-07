import json
import re
from pathlib import Path
from typing import Any, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from ..models import Config, SourcesConfig
from ..storage.manager import ConfigError, _expand_env_vars

_USER_ID_PATTERN = re.compile(r"[1-9][0-9]*")


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


def users_dir(data_dir: Path) -> Path:
    return Path(data_dir) / "users"


def user_path(data_dir: Path, user_id: str) -> Path:
    if not _USER_ID_PATTERN.fullmatch(user_id):
        raise ConfigError(f"Invalid user id: {user_id!r}")
    return users_dir(data_dir) / f"{user_id}.json"


def load_user(data_dir: Path, user_id: str) -> UserConfig:
    path = user_path(data_dir, user_id)
    if not path.exists():
        raise ConfigError(f"User config not found: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        user = UserConfig.model_validate(_expand_env_vars(data))
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
    data["webhook"]["request_body"]["chat_id"] = user.id if user.chat_id is None else user.chat_id
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
