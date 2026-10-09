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

from unittest.mock import AsyncMock, patch

import pytest

from mirage.accessor.dropbox import DropboxAccessor
from mirage.core.dropbox.client import DropboxApiError, DropboxTokenManager
from mirage.core.dropbox.rm import rm_r
from mirage.observe.context import RecordingScope
from mirage.types import PathSpec
from mirage.vfs.dropbox.config import DropboxConfig


def make_accessor(root_path: str = "/") -> DropboxAccessor:
    config = DropboxConfig(
        client_id="c",
        client_secret="s",
        refresh_token="r",
        root_path=root_path,
    )
    return DropboxAccessor(config, DropboxTokenManager(config))


@pytest.mark.asyncio
async def test_rm_r_deletes_recursively_in_one_call():
    with patch(
        "mirage.core.dropbox.rm.delete_path", new_callable=AsyncMock
    ) as deleted:
        await rm_r(make_accessor("/Team"), PathSpec.from_str_path("/docs"))
    assert deleted.await_args.args[1] == "/Team/docs"


@pytest.mark.asyncio
async def test_rm_r_missing_raises_enoent():
    with patch(
        "mirage.core.dropbox.rm.delete_path",
        new_callable=AsyncMock,
        side_effect=DropboxApiError("nf", 409, "path_lookup/not_found/..."),
    ):
        with pytest.raises(FileNotFoundError):
            await rm_r(make_accessor(), PathSpec.from_str_path("/ghost"))


@pytest.mark.asyncio
async def test_a_walk_records_each_removal_before_the_next():
    entries = [
        {".tag": "file", "name": "a", "content_hash": "s", "rev": "1"},
        {".tag": "file", "name": "b", "content_hash": "t", "rev": "1"},
    ]

    async def listing(_tm, _path, limit=None):
        return [] if limit else entries

    scope = RecordingScope()
    seen: list[list[tuple[str, str]]] = []

    async def deleted(*_args, **_kwargs):
        seen.append([(r.op, r.path) for r in scope.records])

    try:
        with (
            patch(
                "mirage.core.dropbox.rm.lookup",
                new=AsyncMock(return_value={".tag": "folder", "name": "d"}),
            ),
            patch("mirage.core.dropbox.rm.list_folder", new=listing),
            patch("mirage.core.dropbox.rm.conditioned", return_value=True),
            patch(
                "mirage.core.dropbox.rm.held_versions",
                new=AsyncMock(return_value=[None, None]),
            ),
            patch("mirage.core.dropbox.rm.delete_path", new=deleted),
            patch(
                "mirage.core.dropbox.rm.invalidate_after_unlink",
                new_callable=AsyncMock,
            ),
            patch(
                "mirage.core.dropbox.rm.invalidate_ancestors",
                new_callable=AsyncMock,
            ),
        ):
            await rm_r(make_accessor(), PathSpec.from_str_path("/d"))
    finally:
        scope.close()
    a, b = ("unlink", "/d/a"), ("unlink", "/d/b")
    assert seen == [[], [a], [a, b]]
    assert [(r.op, r.path) for r in scope.records] == [a, b, ("rm_r", "/d")]
