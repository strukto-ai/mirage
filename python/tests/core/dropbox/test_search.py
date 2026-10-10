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
from mirage.core.dropbox.search import files_containing
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


def mount_root() -> PathSpec:
    return PathSpec(vfs_path="", virtual="/data", directory="/data")


def subdir() -> PathSpec:
    return PathSpec(
        vfs_path="docs", virtual="/data/docs", directory="/data/docs"
    )


async def _search(results, scope, root_path="/", truncated=False):
    with patch(
        "mirage.core.dropbox.search.search_files",
        new_callable=AsyncMock,
        return_value=(results, truncated),
    ) as spy:
        out = await files_containing(
            make_accessor(root_path), "needle", [scope]
        )
    return out, spy.await_args.kwargs["path"]


@pytest.mark.asyncio
async def test_hits_are_keyed_from_their_display_path():
    results = [("/x.txt", "/x.txt"), ("/sub/y.txt", "/Sub/Y.txt")]
    assert await _search(results, mount_root()) == ({"x.txt", "Sub/Y.txt"}, "")


@pytest.mark.asyncio
async def test_the_root_path_is_stripped_case_insensitively():
    results = [("/team/sub/a.txt", "/Team/Sub/A.txt")]
    out = await _search(results, mount_root(), "/Team")
    assert out == ({"Sub/A.txt"}, "/Team")


@pytest.mark.asyncio
async def test_hits_outside_the_scope_are_dropped():
    results = [
        ("/docs/in.txt", "/docs/in.txt"),
        ("/other/out.txt", "/other/out.txt"),
    ]
    assert await _search(results, subdir()) == ({"docs/in.txt"}, "/docs")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "results, truncated",
    [([("/x.txt", "/x.txt")], True), ([], False)],
    ids=["truncated", "no-hit"],
)
async def test_an_answer_that_may_miss_a_match_is_none(results, truncated):
    # No hit is distrusted too: Dropbox indexes a write after it lands.
    out, _ = await _search(results, mount_root(), truncated=truncated)
    assert out is None


@pytest.mark.asyncio
async def test_an_api_error_is_none():
    with patch(
        "mirage.core.dropbox.search.search_files",
        new_callable=AsyncMock,
        side_effect=DropboxApiError("boom", 500),
    ):
        out = await files_containing(make_accessor(), "needle", [mount_root()])
    assert out is None
