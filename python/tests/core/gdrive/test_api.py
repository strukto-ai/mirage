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

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import mirage.core.google.drive as wire
from mirage.core.gdrive.api import DriveApi, DriveClient
from mirage.core.google.drive import ITEM_FIELDS
from mirage.utils.ranges import ByteWindow
from tests.e2e.gdrive_mock import FakeDriveApi
from tests.fixtures.gdrive_api import FakeDrive
from tests.fixtures.google_api import (
    Delegation,
    parameter_drift,
    protocol_calls,
    sends,
)


@pytest.mark.parametrize("fake", [DriveClient, FakeDrive, FakeDriveApi])
def test_each_implementation_takes_the_protocols_parameters(fake):
    assert parameter_drift(DriveApi, fake) == {}


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
    Delegation(
        "list_all_files",
        ("m", "lo", "hi"),
        (),
        {"mime_type": "m", "modified_after": "lo", "modified_before": "hi"},
    ),
    Delegation("search_files", ("t", ["p"], "m"), ("t", ["p"], "m")),
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
    assert sorted(
        {case.call for case in DELEGATIONS} | {"capture_file_metadata"}
    ) == protocol_calls(DriveApi)


@pytest.mark.asyncio
@pytest.mark.parametrize("case", DELEGATIONS, ids=lambda case: case.call)
async def test_each_call_sends_its_wire_request(case):
    got, answer = await sends(DriveClient, wire, case)
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
