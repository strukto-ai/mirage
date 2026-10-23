# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import ast
import functools
import importlib
import inspect
import pkgutil
from pathlib import Path
from types import ModuleType
from typing import Any
from unittest.mock import AsyncMock

import pytest

import mirage.core as core_pkg
from mirage.accessor.base import Accessor
from mirage.accessor.gdocs import GDocsAccessor
from mirage.accessor.google_api import GoogleApiAccessor
from mirage.core.gcal.api import CalendarClient
from mirage.core.gdocs.api import DocsClient
from mirage.core.gdrive.api import DriveClient
from mirage.core.gmail.api import GmailClient
from mirage.core.gsheets.api import SheetsClient
from mirage.core.gslides.api import SlidesClient

CORE = Path(core_pkg.__file__).parent
PACKAGES = ("gcal", "gdocs", "gdrive", "gmail", "google", "gsheets", "gslides")
# The modules that build Google requests from a token manager: each
# package's client, and the request helpers those clients and the gws
# CLI call. Every other module in a Google package goes through its
# accessor's client.
WIRE = frozenset(
    {
        "gcal/client.py",
        "gdocs/write.py",
        "gmail/history.py",
        "gmail/labels.py",
        "gmail/messages.py",
        "gmail/send.py",
        "google/client.py",
        "google/drive.py",
        "gsheets/write.py",
    }
)
# Requests made without a token manager in hand: the shared HTTP helpers,
# the token exchange and a raw HTTP client.
RAW = frozenset(
    {
        "mirage.core.api.client.api_request",
        "mirage.core.api.client.api_stream",
        "mirage.core.google.client.refresh_access_token",
        "aiohttp.ClientSession",
        "aiohttp.request",
    }
)
CLIENTS = {
    "drive": DriveClient,
    "docs": DocsClient,
    "sheets": SheetsClient,
    "slides": SlidesClient,
    "gmail": GmailClient,
    "calendar": CalendarClient,
}


def _takes_a_token_manager(value: Any) -> bool:
    """Whether ``value`` is a token manager or is called with one: the
    one way to a Google request. An accessor is the door itself.

    Args:
        value (Any): a name a module imports.
    """
    if inspect.isclass(value) and issubclass(value, Accessor):
        return False
    if inspect.isclass(value) and value.__name__ == "TokenManager":
        return True
    if not callable(value):
        return False
    try:
        params = inspect.signature(value).parameters.values()
    except (TypeError, ValueError):
        return False
    return any("TokenManager" in str(p.annotation) for p in params)


@functools.cache
def _holds_wire(module: ModuleType) -> bool:
    """Whether ``module`` hands out a way to a Google request: a name that
    is one, or for a package, any module below it.

    Args:
        module (ModuleType): an imported module.
    """
    if any(_takes_a_token_manager(v) for v in vars(module).values()):
        return True
    return any(
        _holds_wire(importlib.import_module(f"{module.__name__}.{sub.name}"))
        for sub in pkgutil.iter_modules(getattr(module, "__path__", []))
    )


def _reaches_wire(module: str, name: str) -> bool:
    """Whether ``from module import name`` hands over a way to a Google
    request.

    Args:
        module (str): the module imported from.
        name (str): the name imported.
    """
    source = importlib.import_module(module)
    if name == "*":
        return _holds_wire(source)
    value = getattr(source, name, None)
    if value is None:
        value = importlib.import_module(f"{module}.{name}")
    if inspect.ismodule(value):
        return _holds_wire(value)
    return _takes_a_token_manager(value)


def _reads_config(node: ast.Attribute) -> bool:
    """Whether ``node`` (an ``x.token_manager``) is only read for its
    config, as ``x.token_manager.config``.

    Args:
        node (ast.Attribute): the ``token_manager`` access.
    """
    parent = getattr(node, "parent", None)
    return isinstance(parent, ast.Attribute) and parent.attr == "config"


def wire_imports(source: str) -> list[str]:
    """Every import in ``source`` that reaches a Google request past the
    accessor's clients.

    Args:
        source (str): a module's Python source.
    """
    found = [
        hook for hook in ("__import__", "importlib", "httpx") if hook in source
    ]
    tree = ast.parse(source)
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            child.parent = node  # type: ignore[attr-defined]
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and node.attr == "token_manager"
            and not _reads_config(node)
        ):
            found.append(f"{ast.unparse(node)} past its config")
        elif isinstance(node, ast.Attribute) and (
            f"{ast.unparse(node.value)}.{node.attr}" in RAW
        ):
            found.append(ast.unparse(node))
        elif isinstance(node, ast.Import):
            found += [
                a.name
                for a in node.names
                if a.name.startswith("mirage.")
                and _holds_wire(importlib.import_module(a.name))
            ]
        elif isinstance(node, ast.ImportFrom) and node.level:
            found.append(f"relative import of {node.module}")
        elif isinstance(node, ast.ImportFrom) and node.module:
            found += [
                f"{node.module}.{a.name}"
                for a in node.names
                if f"{node.module}.{a.name}" in RAW
                or node.module.startswith("mirage.")
                and _reaches_wire(node.module, a.name)
            ]
    return found


def _modules() -> list[Path]:
    return sorted(
        path for package in PACKAGES for path in (CORE / package).rglob("*.py")
    )


def _key(path: Path) -> str:
    return path.relative_to(CORE).as_posix()


@pytest.mark.parametrize(
    "planted",
    [
        "from mirage.core.google.drive import FOLDER_MIME, list_files",
        "from mirage.core.google.client import google_get",
        "from mirage.core.google.client import TokenManager",
        "from mirage.core.google.drive import *",
        "from mirage.core.google import drive",
        "import mirage.core.google.drive",
        "from mirage.core.gmail.messages import get_message_raw",
        "from mirage.core.gmail import messages",
        "from mirage.core.gcal.client import list_events",
        "from mirage.core.gdocs.write import append_text",
        "from mirage.core.gdrive.api import DriveClient",
        "from mirage.core.gmail.api import GmailClient",
        "from mirage.core.gsheets.api import SheetsClient",
        "from ..google.drive import list_files",
        "wire = __import__('mirage.core.google.drive')",
        "from mirage.core import google",
        "import mirage.core.google",
        "from mirage.core.api.client import api_request",
        "from mirage.core.google.client import refresh_access_token",
        "from aiohttp import ClientSession",
        "session = aiohttp.ClientSession()",
        "import httpx",
        "await google_get(accessor.token_manager, url)",
    ],
)
def test_the_detector_catches_a_planted_bypass(planted):
    assert wire_imports(planted)


@pytest.mark.parametrize(
    "allowed",
    [
        "from mirage.core.google.drive import FOLDER_MIME, MIME_TO_EXT",
        "from mirage.core.google.events import feed_checkpoint, feed_state",
        "from mirage.core.google.entry import resolve_app_entry",
        "from mirage.core.gdrive.api import DriveApi",
        "from mirage.core.gmail.api import GmailApi",
        "from mirage.core.gmail.messages import message_json_bytes",
        "from mirage.core.gcal.client import listed",
        "from mirage.core.gdocs import constants",
        "from mirage.accessor.gdocs import GDocsAccessor",
        "from aiohttp import ClientResponseError",
        "folder_id = accessor.token_manager.config.folder_id",
    ],
)
def test_the_detector_leaves_what_makes_no_request(allowed):
    assert wire_imports(allowed) == []


def test_no_google_module_reaches_a_request_past_its_accessor():
    offenders = {
        _key(path): found
        for path in _modules()
        if path.name != "api.py"
        and _key(path) not in WIRE
        and (found := wire_imports(path.read_text()))
    }
    assert offenders == {}


def test_no_wire_module_takes_an_accessor():
    keys = {_key(path) for path in _modules()}
    assert WIRE <= keys
    takers = [
        key
        for key in sorted(WIRE)
        if "mirage.accessor" in (CORE / key).read_text()
    ]
    assert takers == []


def _public_calls(cls: type) -> set[str]:
    return {
        name
        for name, value in vars(cls).items()
        if not name.startswith("_") and inspect.isfunction(value)
    }


@pytest.mark.parametrize("service", sorted(CLIENTS))
def test_each_live_client_makes_only_its_protocols_calls(service):
    client = CLIENTS[service]
    protocol = inspect.signature(getattr(GoogleApiAccessor, service).fget)
    assert _public_calls(client) == _public_calls(protocol.return_annotation)


@pytest.mark.parametrize("service", sorted(CLIENTS))
def test_the_accessor_serves_each_live_client(service):
    accessor = GoogleApiAccessor(config=None, token_manager="tm")
    client = getattr(accessor, service)
    assert isinstance(client, CLIENTS[service])
    assert client.token_manager == "tm"


def test_an_app_accessor_is_the_google_api_accessor():
    accessor = GDocsAccessor(config=None, token_manager="tm")
    assert isinstance(accessor, GoogleApiAccessor)
    assert accessor.token_manager == "tm"


@pytest.mark.asyncio
async def test_closing_the_accessor_drains_its_token_manager():
    token_manager = AsyncMock()
    await GDocsAccessor(config=None, token_manager=token_manager).close()
    token_manager.close.assert_awaited_once()
