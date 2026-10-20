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
import importlib
import inspect
from pathlib import Path
from typing import Any, NamedTuple
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import mirage.core.gdrive as gdrive_pkg
import mirage.core.google.drive as wire
from mirage.accessor.gdrive import GDriveAccessor
from mirage.core.gdrive.api import DriveApi, DriveClient
from mirage.core.google.drive import ITEM_FIELDS
from mirage.utils.ranges import ByteWindow
from tests.e2e.gdrive_mock import FakeDriveApi
from tests.fixtures.gdrive_api import FakeDrive

GOOGLE = "mirage.core.google"
API = "mirage.core.gdrive.api"

REQUEST_FREE = frozenset({"feed_checkpoint", "feed_state"})


def _reaches_drive(module: str, name: str) -> bool:
    """Whether ``from module import name`` hands over a way to Drive.

    Args:
        module (str): the module imported from.
        name (str): the name imported.
    """
    if API in (module, f"{module}.{name}"):
        return name != "DriveApi"
    if not f"{module}.{name}".startswith(GOOGLE):
        return False
    if name == "*":
        return True
    value = getattr(importlib.import_module(module), name)
    return inspect.ismodule(value) or (
        inspect.isfunction(value) and name not in REQUEST_FREE
    )


def drive_bypasses(source: str) -> list[str]:
    """Every import in ``source`` that reaches Drive past the accessor.

    Args:
        source (str): a module's Python source.
    """
    found = [hook for hook in ("__import__", "importlib") if hook in source]
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            found += [
                a.name for a in node.names if a.name.startswith((GOOGLE, API))
            ]
        elif isinstance(node, ast.ImportFrom) and node.level:
            found.append(f"relative import of {node.module}")
        elif isinstance(node, ast.ImportFrom) and node.module:
            found += [
                f"{node.module}.{a.name}"
                for a in node.names
                if _reaches_drive(node.module, a.name)
            ]
    return found


@pytest.mark.parametrize(
    "planted",
    [
        "from mirage.core.google.drive import FOLDER_MIME, list_files",
        "from mirage.core.google.entry import get_file",
        "from mirage.core.google.drive import *",
        "from mirage.core.google import drive",
        "import mirage.core.google.drive",
        "import mirage.core.gdrive.api",
        "from ..google.drive import list_files",
        "from mirage.core.gdrive.api import DriveClient",
        "wire = __import__('mirage.core.google.drive')",
    ],
)
def test_the_detector_catches_a_planted_bypass(planted):
    assert drive_bypasses(planted)


@pytest.mark.parametrize(
    "allowed",
    [
        "from mirage.core.google.drive import FOLDER_MIME, MIME_TO_EXT",
        "from mirage.core.google.events import feed_checkpoint, feed_state",
        "from mirage.core.gdrive.api import DriveApi",
    ],
)
def test_the_detector_leaves_what_makes_no_request(allowed):
    assert drive_bypasses(allowed) == []


def test_no_gdrive_core_module_reaches_drive_past_the_accessor():
    root = Path(gdrive_pkg.__file__).parent
    offenders = {
        path.name: found
        for path in sorted(root.rglob("*.py"))
        if path.name != "api.py"
        and (found := drive_bypasses(path.read_text()))
    }
    assert offenders == {}


def _protocol_calls() -> list[str]:
    return sorted(
        name
        for name, value in vars(DriveApi).items()
        if not name.startswith("_") and inspect.isfunction(value)
    )


def _parameters(call: Any) -> list[tuple[str, Any, Any]]:
    return [
        (p.name, p.kind, p.default)
        for p in inspect.signature(call).parameters.values()
    ]


@pytest.mark.parametrize("fake", [DriveClient, FakeDrive, FakeDriveApi])
def test_each_implementation_takes_the_protocols_parameters(fake):
    drift = {
        name: _parameters(vars(fake)[name])
        for name in _protocol_calls()
        if name in vars(fake)
        and _parameters(vars(fake)[name]) != _parameters(vars(DriveApi)[name])
    }
    assert drift == {}


class Delegation(NamedTuple):
    call: str
    args: tuple[Any, ...]
    sent: tuple[Any, ...]
    sent_kwargs: dict[str, Any] = {}


WINDOW = ByteWindow(2, 3)
BODY = {"name": "n"}

DELEGATIONS = [
    Delegation(
        "list_files",
        ("f1", "d1", 1),
        ("f1",),
        {"drive_id": "d1", "limit": 1},
    ),
    Delegation("list_children", (["f1"], "d1"), (["f1"], "d1")),
    Delegation("list_shared_drives", (), ()),
    Delegation("search_files", ("t", ["p"]), ("t", ["p"])),
    Delegation("get_file", ("f1",), ("f1", ITEM_FIELDS)),
    Delegation("storage_quota", (), ()),
    Delegation("delete_file", ("f1",), ("f1",)),
    Delegation("download_file", ("f1", WINDOW), ("f1", WINDOW)),
    Delegation("download_file_stream", ("f1",), ("f1",)),
    Delegation("create_folder", ("n", "p"), ("n", "p")),
    Delegation("upload_file", ("n", "p", b"x"), ("n", "p", b"x")),
    Delegation("update_file_content", ("f1", b"x"), ("f1", b"x")),
    Delegation(
        "patch_file",
        ("f1", BODY, "a", "r"),
        ("f1", BODY),
        {"add_parents": "a", "remove_parents": "r"},
    ),
    Delegation("copy_file", ("f1", "n", "p"), ("f1", "n", "p")),
    Delegation("start_page_token", (), ()),
    Delegation("list_changes", ("tok",), ("tok",)),
    Delegation(
        "download_revision", ("f1", "r1", WINDOW), ("f1", "r1", WINDOW)
    ),
    Delegation("download_revision_stream", ("f1", "r1"), ("f1", "r1")),
]


def test_every_forwarding_call_has_a_case():
    assert (
        sorted({case.call for case in DELEGATIONS} | {"capture_file_metadata"})
        == _protocol_calls()
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("case", DELEGATIONS, ids=lambda case: case.call)
async def test_each_call_sends_its_wire_request(case):
    manager = MagicMock()
    streaming = case.call.endswith("_stream")
    answer = object()
    fake = (MagicMock if streaming else AsyncMock)(return_value=answer)
    with patch.object(wire, case.call, fake):
        got = getattr(DriveClient(manager), case.call)(*case.args)
        if not streaming:
            got = await got
    fake.assert_called_once_with(manager, *case.sent, **case.sent_kwargs)
    assert got is (None if case.call == "delete_file" else answer)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("item", "captured"),
    [
        ({"md5Checksum": "m5", "headRevisionId": "r9"}, ("m5", "r9")),
        ({"headRevisionId": "r9"}, (None, "r9")),
    ],
    ids=["both", "no-md5"],
)
async def test_a_capture_is_the_files_md5_and_head_revision(item, captured):
    manager = MagicMock()
    with patch.object(wire, "get_file", AsyncMock(return_value=item)) as get:
        assert (
            await DriveClient(manager).capture_file_metadata("f1") == captured
        )
    get.assert_awaited_once_with(manager, "f1", "headRevisionId,md5Checksum")


def test_the_accessor_serves_the_live_client(
    gdrive_accessor: GDriveAccessor,
):
    drive = gdrive_accessor.drive
    assert isinstance(drive, DriveClient)
    assert drive.token_manager is gdrive_accessor.token_manager
