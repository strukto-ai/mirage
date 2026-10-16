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

import json
from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.events import DropboxDeltaHook
from mirage.types import FileChangeKind, JsonValue, PathSpec
from mirage.vfs.dropbox.config import DropboxConfig

ROOT = PathSpec(virtual="/m", directory="/m", vfs_path="")
C, U, D = FileChangeKind.CREATE, FileChangeKind.UPDATE, FileChangeKind.DELETE


def _hook(root_path: str = "/team") -> DropboxDeltaHook:
    config = DropboxConfig(
        client_id="c",
        client_secret="s",
        refresh_token="r",
        root_path=root_path,
    )
    return DropboxDeltaHook(
        DropboxAccessor(config, DropboxTokenManager(config))
    )


def _file(path_display: str, digest: str) -> dict[str, JsonValue]:
    return {
        ".tag": "file",
        "path_display": path_display,
        "content_hash": digest,
    }


def _row(tag: str, path_display: str) -> dict[str, JsonValue]:
    return {".tag": tag, "path_display": path_display}


def _pairs(delta) -> list[tuple[FileChangeKind, str]]:
    return [(change.kind, change.path.virtual) for change in delta.changes]


@pytest.mark.asyncio
async def test_each_ping_replays_the_cursor_and_lists_nothing():
    # A baseline takes a cursor at the present; each pull after it is one
    # continue from the stored cursor. A path seen before is an UPDATE,
    # or nothing when its content hash did not move; the root is stripped
    # however the server cases it, and the rest keeps the server's casing.
    hook = _hook()
    replies = [
        ([_file("/Team/Docs/A.txt", "h1"), _row("folder", "/TEAM/sub")], "c2"),
        (
            [_file("/team/Docs/A.txt", "h2"), _file("/team/Docs/A.txt", "h2")],
            "c3",
        ),
        ([_file("/team/sub/b.txt", "h3"), _row("deleted", "/team/sub")], "c4"),
    ]
    with (
        patch(
            "mirage.core.dropbox.events.latest_cursor",
            AsyncMock(return_value="c1"),
        ) as latest,
        patch(
            "mirage.core.dropbox.events.continue_folder",
            AsyncMock(side_effect=replies),
        ) as replay,
    ):
        delta = await hook.pull(ROOT, None)
        got = []
        for _ in replies:
            delta = await hook.pull(ROOT, delta.checkpoint)
            got.append(_pairs(delta))
    assert got == [
        [(C, "/m/Docs/A.txt"), (C, "/m/sub")],
        [(U, "/m/Docs/A.txt")],
        [(C, "/m/sub/b.txt"), (D, "/m/sub")],
    ]
    assert [call.args[1] for call in replay.await_args_list] == [
        "c1",
        "c2",
        "c3",
    ]
    assert latest.await_count == 1
    assert json.loads(delta.checkpoint or "")["dropbox"]["seen"] == {
        "Docs/A.txt": "h2"
    }


@pytest.mark.asyncio
async def test_a_reset_or_a_root_that_comes_back_reports_the_root():
    # A cursor Dropbox resets, and a root it could not find that is back,
    # both leave the root UNKNOWN with a fresh cursor, never a walk.
    hook = _hook()
    reset = DropboxApiError("409", 409, "reset/..")
    missing = DropboxApiError("409", 409, "path/not_found/..")
    with (
        patch(
            "mirage.core.dropbox.events.latest_cursor",
            AsyncMock(side_effect=[missing, "c1", "c2"]),
        ),
        patch(
            "mirage.core.dropbox.events.continue_folder",
            AsyncMock(side_effect=reset),
        ),
    ):
        baseline = await hook.pull(ROOT, None)
        back = await hook.pull(ROOT, baseline.checkpoint)
        renewed = await hook.pull(ROOT, back.checkpoint)
    assert json.loads(baseline.checkpoint or "")["dropbox"]["cursor"] == ""
    assert _pairs(back) == _pairs(renewed) == [(FileChangeKind.UNKNOWN, "/m")]
    assert json.loads(renewed.checkpoint or "")["dropbox"]["cursor"] == "c2"
