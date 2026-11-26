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

import pytest

from mirage.core.dropbox.events import DropboxDeltaHook
from mirage.types import FileChangeKind, JsonValue, PathSpec

ROOT = PathSpec(virtual="/m", directory="/m", vfs_path="")
C, U, D = FileChangeKind.CREATE, FileChangeKind.UPDATE, FileChangeKind.DELETE
LATEST_ROUTE = "/2/files/list_folder/get_latest_cursor"
CONTINUE_ROUTE = "/2/files/list_folder/continue"


def _hook(account, root_path: str = "/team") -> DropboxDeltaHook:
    return DropboxDeltaHook(account.accessor(root_path))


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
async def test_each_ping_replays_the_cursor_and_lists_nothing(account):
    # A baseline takes a cursor at the present; each pull after it is one
    # continue from the stored cursor. A path seen before is an UPDATE,
    # or nothing when its content hash did not move; the root is stripped
    # however the server cases it, and the rest keeps the server's casing.
    # The fake keeps one casing, so Dropbox's pages are answered here, and
    # its baseline cursor too, so the first continue's cursor is known.
    await account.mkdir("/team")
    hook = _hook(account)
    await account.run.answer_next("POST", LATEST_ROUTE, 200, {"cursor": "c1"})
    pages = [
        ([_file("/Team/Docs/A.txt", "h1"), _row("folder", "/TEAM/sub")], "c2"),
        (
            [_file("/team/Docs/A.txt", "h2"), _file("/team/Docs/A.txt", "h2")],
            "c3",
        ),
        ([_file("/team/sub/b.txt", "h3"), _row("deleted", "/team/sub")], "c4"),
    ]
    for entries, cursor in pages:
        await account.run.answer_next(
            "POST",
            CONTINUE_ROUTE,
            200,
            {"entries": entries, "cursor": cursor, "has_more": False},
        )
    await account.run.record_requests()
    delta = await hook.pull(ROOT, None)
    got = []
    for _ in pages:
        delta = await hook.pull(ROOT, delta.checkpoint)
        got.append(_pairs(delta))
    assert got == [
        [(C, "/m/Docs/A.txt"), (C, "/m/sub")],
        [(U, "/m/Docs/A.txt")],
        [(C, "/m/sub/b.txt"), (D, "/m/sub")],
    ]
    (baseline,) = await account.run.bodies("POST", LATEST_ROUTE)
    replayed = await account.run.bodies("POST", CONTINUE_ROUTE)
    assert [body["cursor"] for body in replayed] == ["c1", "c2", "c3"]
    assert baseline["path"] == "/team"
    assert json.loads(delta.checkpoint or "")["dropbox"]["seen"] == {
        "Docs/A.txt": "h2"
    }


@pytest.mark.asyncio
async def test_a_reset_or_a_root_that_comes_back_reports_the_root(account):
    # A cursor Dropbox resets, and a root it could not find that is back,
    # both leave the root UNKNOWN with a fresh cursor, never a walk.
    hook = _hook(account)
    await account.run.record_requests()
    baseline = await hook.pull(ROOT, None)
    await account.mkdir("/team")
    back = await hook.pull(ROOT, baseline.checkpoint)
    await account.run.answer_next(
        "POST", CONTINUE_ROUTE, 409, {"error_summary": "reset/.."}
    )
    renewed = await hook.pull(ROOT, back.checkpoint)
    assert json.loads(baseline.checkpoint or "")["dropbox"]["cursor"] == ""
    assert _pairs(back) == _pairs(renewed) == [(FileChangeKind.UNKNOWN, "/m")]
    came_back = json.loads(back.checkpoint or "")["dropbox"]["cursor"]
    cursor = json.loads(renewed.checkpoint or "")["dropbox"]["cursor"]
    assert len(await account.run.bodies("POST", LATEST_ROUTE)) == 3
    assert cursor not in ("", came_back)
