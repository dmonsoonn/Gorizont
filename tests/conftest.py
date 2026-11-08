from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest


ROOT = Path(__file__).resolve().parents[1]

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture
def public_dns(monkeypatch):
    monkeypatch.setattr("src.url_security._resolve_hostname", AsyncMock(return_value={"93.184.216.34"}))
