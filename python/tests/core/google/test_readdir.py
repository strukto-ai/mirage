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

from mirage.accessor.google_api import GoogleApiAccessor
from mirage.core.google.readdir import make_app_readdir
from mirage.core.gsheets.constants import MIME
from mirage.core.gsheets.scope import detect_scope
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key

FILES = [
    {
        "id": "a1",
        "name": "Mine",
        "modifiedTime": "2026-04-01T00:00:00.000Z",
        "owners": [{"me": True}],
        "size": "12",
    },
    {
        "id": "b2",
        "name": "Theirs",
        "owners": [{"me": False}],
    },
]


def _name(title: str, file_id: str, modified: str) -> str:
    return f"{title}.{file_id}.{modified[:4]}"


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=mount_key(virtual, "/m"), virtual=virtual, directory=virtual
    )


READDIR = make_app_readdir(MIME, detect_scope, _name)


@pytest.mark.asyncio
async def test_a_corpus_lists_its_owners_files_through_the_apps_namer():
    with patch(
        "mirage.core.google.readdir.list_all_files",
        new_callable=AsyncMock,
        return_value=(FILES, True),
    ) as listed:
        out = await READDIR(GoogleApiAccessor(None, None), _spec("/m/owned"))
    (row,) = out.entries
    assert out.partial is False
    assert row.name == "Mine.a1.2026"
    assert listed.await_args.kwargs["mime_type"] == MIME
    assert row.size is None
    assert row.extra == {"doc_id": "a1", "doc_name": "Mine", "source_size": 12}


@pytest.mark.asyncio
async def test_the_root_lists_the_corpora_without_a_request():
    with patch(
        "mirage.core.google.readdir.list_all_files", new_callable=AsyncMock
    ) as listed:
        out = await READDIR(GoogleApiAccessor(None, None), _spec("/m"))
    assert [row.name for row in out] == ["owned", "shared"]
    listed.assert_not_awaited()
