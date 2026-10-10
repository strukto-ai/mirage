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

from mirage.accessor.box import BoxAccessor
from mirage.core.box.client import BoxApiError, BoxTokenManager
from mirage.core.box.search import files_containing
from mirage.types import PathSpec
from mirage.vfs.box.config import BoxConfig


def make_accessor(root_folder_id: str | None = None) -> BoxAccessor:
    config = BoxConfig(
        access_token="tok", root_folder_id=root_folder_id, content_search=True
    )
    return BoxAccessor(config, BoxTokenManager(config))


def mount_root() -> PathSpec:
    return PathSpec(vfs_path="", virtual="/data", directory="/data")


def _file(item_id: str, name: str, chain: list[tuple[str, str]]) -> dict:
    return {
        "id": item_id,
        "name": name,
        "type": "file",
        "path_collection": {
            "total_count": len(chain),
            "entries": [
                {"type": "folder", "id": cid, "name": cname}
                for cid, cname in chain
            ],
        },
    }


ROOT = [("0", "All Files")]


@pytest.mark.asyncio
async def test_hits_are_keyed_from_their_path_collection():
    results = [
        _file("2", "x.txt", ROOT),
        _file("3", "y.txt", ROOT + [("100", "Sub")]),
        _file("4", "out.txt", [("7", "Elsewhere")]),
    ]
    with patch(
        "mirage.core.box.search.search_content",
        new_callable=AsyncMock,
        return_value=(results, False),
    ) as spy:
        out = await files_containing(make_accessor(), "needle", [mount_root()])
    assert spy.await_args.args[2] == "0"
    assert out == {"x.txt", "Sub/y.txt"}


@pytest.mark.asyncio
async def test_a_subfolder_scope_searches_under_its_folder_id():
    scope = PathSpec(
        vfs_path="docs", virtual="/data/docs", directory="/data/docs"
    )
    results = [_file("5", "in.txt", ROOT + [("100", "docs")])]
    with (
        patch(
            "mirage.core.box.search.resolve_item",
            new_callable=AsyncMock,
            return_value={"id": "100", "type": "folder"},
        ),
        patch(
            "mirage.core.box.search.search_content",
            new_callable=AsyncMock,
            return_value=(results, False),
        ) as spy,
    ):
        out = await files_containing(make_accessor(), "needle", [scope])
    assert spy.await_args.args[2] == "100"
    assert out == {"docs/in.txt"}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer",
    [
        {"side_effect": BoxApiError("boom", 500)},
        {"return_value": ([_file("2", "x.txt", ROOT)], True)},
        {"return_value": ([], False)},
    ],
    ids=["api-error", "truncated", "no-hit"],
)
async def test_an_answer_that_may_miss_a_match_is_none(answer):
    # No hit is distrusted too: Box indexes a write after it lands.
    with patch(
        "mirage.core.box.search.search_content",
        new_callable=AsyncMock,
        **answer,
    ):
        out = await files_containing(make_accessor(), "needle", [mount_root()])
    assert out is None


@pytest.mark.asyncio
async def test_a_scope_that_is_no_folder_is_none():
    scope = PathSpec(
        vfs_path="a.txt", virtual="/data/a.txt", directory="/data/a.txt"
    )
    with patch(
        "mirage.core.box.search.resolve_item",
        new_callable=AsyncMock,
        return_value={"id": "9", "type": "file"},
    ):
        out = await files_containing(make_accessor(), "needle", [scope])
    assert out is None
