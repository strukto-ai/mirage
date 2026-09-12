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
from mirage.core.dropbox.watch import DropboxDeltaHook, DropboxWalk
from mirage.resource.dropbox.config import DropboxConfig
from mirage.types import FileChangeKind, PathSpec


def _accessor(root_path: str) -> DropboxAccessor:
    config = DropboxConfig(client_id="c",
                           client_secret="s",
                           refresh_token="r",
                           root_path=root_path)
    return DropboxAccessor(config, DropboxTokenManager(config))


def _root() -> PathSpec:
    return PathSpec(virtual="/m", directory="/m", resource_path="")


async def _collect(walk, root):
    return [entry async for entry in walk(root)]


@pytest.mark.asyncio
async def test_server_casing_of_the_root_is_still_stripped() -> None:
    # Dropbox paths are case-insensitive: path_display carries the
    # server's casing and root_path the user's. Comparing them exactly
    # left the root on the front of every virtual path, which put every
    # event outside the watch scope and silently disabled delivery.
    listing = [{
        ".tag": "file",
        "path_display": "/Team/notes.txt",
        "path_lower": "/team/notes.txt",
        "size": 4,
        "rev": "r1",
    }]
    with patch("mirage.core.dropbox.watch.list_folder", return_value=listing):
        entries = await _collect(DropboxWalk(_accessor("/team")), _root())
    assert [e.virtual for e in entries] == ["/m/notes.txt"]


@pytest.mark.asyncio
async def test_casing_below_the_root_is_preserved() -> None:
    listing = [{
        ".tag": "file",
        "path_display": "/Team/Notes/Report.TXT",
        "path_lower": "/team/notes/report.txt",
        "size": 4,
        "rev": "r1",
    }]
    with patch("mirage.core.dropbox.watch.list_folder", return_value=listing):
        entries = await _collect(DropboxWalk(_accessor("/team")), _root())
    assert [e.virtual for e in entries] == ["/m/Notes/Report.TXT"]


def _file(path_display: str, digest: str, size: int = 4) -> dict:
    return {
        ".tag": "file",
        "path_display": path_display,
        "path_lower": path_display.lower(),
        "size": size,
        "content_hash": digest,
        "rev": digest[:8],
    }


@pytest.mark.asyncio
async def test_native_pull_baseline_emits_nothing() -> None:
    listing = [_file("/team/keep.txt", "h1")]
    with patch("mirage.core.dropbox.watch.list_folder_state",
               new_callable=AsyncMock,
               return_value=(listing, "c0")):
        hook = DropboxDeltaHook(_accessor("/team"))
        delta = await hook.pull(_root(), None)
    assert delta.changes == ()
    assert delta.checkpoint is not None
    assert '"_dbx": 1' in delta.checkpoint


@pytest.mark.asyncio
async def test_native_pull_continue_create_update_delete() -> None:
    listing = [_file("/team/keep.txt", "h1"), _file("/team/gone.txt", "h0")]
    with patch("mirage.core.dropbox.watch.list_folder_state",
               new_callable=AsyncMock,
               return_value=(listing, "c0")):
        hook = DropboxDeltaHook(_accessor("/team"))
        base = await hook.pull(_root(), None)
    changed = [
        _file("/team/keep.txt", "h2"),
        _file("/team/new.txt", "h3"),
        {
            ".tag": "deleted",
            "path_display": "/team/gone.txt",
            "path_lower": "/team/gone.txt",
        },
    ]
    with patch("mirage.core.dropbox.watch.continue_folder",
               new_callable=AsyncMock,
               return_value=(changed, "c1")):
        delta = await hook.pull(_root(), base.checkpoint)
    kinds = {(c.path.virtual, c.kind) for c in delta.changes}
    assert ("/m/keep.txt", FileChangeKind.UPDATE) in kinds
    assert ("/m/new.txt", FileChangeKind.CREATE) in kinds
    assert ("/m/gone.txt", FileChangeKind.DELETE) in kinds


@pytest.mark.asyncio
async def test_native_pull_reset_falls_back_to_the_walk() -> None:
    listing = [_file("/team/keep.txt", "h1")]
    with patch("mirage.core.dropbox.watch.list_folder_state",
               new_callable=AsyncMock,
               return_value=(listing, "c0")):
        hook = DropboxDeltaHook(_accessor("/team"))
        base = await hook.pull(_root(), None)
    later = [_file("/team/keep.txt", "h1"), _file("/team/extra.txt", "h9")]
    with patch("mirage.core.dropbox.watch.continue_folder",
               new_callable=AsyncMock,
               side_effect=DropboxApiError("reset", 409, "reset/...")), \
         patch("mirage.core.dropbox.watch.list_folder_state",
               new_callable=AsyncMock,
               return_value=(later, "c9")):
        delta = await hook.pull(_root(), base.checkpoint)
    kinds = {(c.path.virtual, c.kind) for c in delta.changes}
    assert ("/m/extra.txt", FileChangeKind.CREATE) in kinds


@pytest.mark.asyncio
async def test_native_pull_upgrades_a_listing_checkpoint() -> None:
    listing = [_file("/team/keep.txt", "h1")]
    with patch("mirage.core.dropbox.watch.list_folder_state",
               new_callable=AsyncMock,
               return_value=(listing, "c0")):
        hook = DropboxDeltaHook(_accessor("/team"))
        base = await hook.pull(_root(), None)
    snap = json.loads(base.checkpoint)["s"]
    later = [_file("/team/keep.txt", "h1"), _file("/team/extra.txt", "h9")]
    with patch("mirage.core.dropbox.watch.list_folder_state",
               new_callable=AsyncMock,
               return_value=(later, "c2")):
        delta = await hook.pull(_root(), json.dumps(snap))
    kinds = {(c.path.virtual, c.kind) for c in delta.changes}
    assert ("/m/extra.txt", FileChangeKind.CREATE) in kinds
    assert '"_dbx": 1' in delta.checkpoint


@pytest.mark.asyncio
async def test_native_pull_empty_continue_emits_nothing() -> None:
    listing = [_file("/team/keep.txt", "h1")]
    with patch("mirage.core.dropbox.watch.list_folder_state",
               new_callable=AsyncMock,
               return_value=(listing, "c0")):
        hook = DropboxDeltaHook(_accessor("/team"))
        base = await hook.pull(_root(), None)
    with patch("mirage.core.dropbox.watch.continue_folder",
               new_callable=AsyncMock,
               return_value=([], "c1")):
        delta = await hook.pull(_root(), base.checkpoint)
    assert delta.changes == ()
    assert json.loads(delta.checkpoint)["c"] == "c1"


@pytest.mark.asyncio
async def test_native_pull_folder_delete_drops_descendants() -> None:
    listing = [{
        ".tag": "folder",
        "name": "dir",
        "path_display": "/team/dir",
        "path_lower": "/team/dir",
    },
               _file("/team/dir/a.txt", "h1")]
    with patch("mirage.core.dropbox.watch.list_folder_state",
               new_callable=AsyncMock,
               return_value=(listing, "c0")):
        hook = DropboxDeltaHook(_accessor("/team"))
        base = await hook.pull(_root(), None)
    gone = [{
        ".tag": "deleted",
        "name": "dir",
        "path_display": "/team/dir",
        "path_lower": "/team/dir",
    }]
    with patch("mirage.core.dropbox.watch.continue_folder",
               new_callable=AsyncMock,
               return_value=(gone, "c1")):
        delta = await hook.pull(_root(), base.checkpoint)
    kinds = {(c.path.virtual, c.kind) for c in delta.changes}
    assert ("/m/dir", FileChangeKind.DELETE) in kinds
    assert ("/m/dir/a.txt", FileChangeKind.DELETE) in kinds
