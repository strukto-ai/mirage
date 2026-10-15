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

import re

import pytest
from aioresponses import aioresponses

from mirage.accessor.sharepoint import SharePointAccessor, SharePointConfig
from mirage.core.sharepoint.search import files_containing
from mirage.types import PathSpec

_BASE = "https://graph.microsoft.com/v1.0"
_SITE_ID = "tenant.sharepoint.com,site-guid,web-guid"
_DRIVE_ID = "b!driveXYZ"
_DRIVE = f"{_BASE}/drives/{_DRIVE_ID}"


def _accessor() -> SharePointAccessor:
    accessor = SharePointAccessor(SharePointConfig(access_token="tok"))
    accessor.site_cache["Engineering"] = _SITE_ID
    accessor.drive_cache[(_SITE_ID, "Documents")] = _DRIVE_ID
    return accessor


def scope(vfs_path: str) -> PathSpec:
    virtual = "/sp/" + vfs_path if vfs_path else "/sp"
    return PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)


@pytest.mark.asyncio
async def test_a_library_scope_searches_from_the_library_root():
    with aioresponses() as m:
        m.get(
            _DRIVE + "/root/children",
            payload={
                "value": [
                    {"id": "1", "name": "a.txt", "size": 7, "file": {}},
                    {"id": "2", "name": "b.txt", "size": 7, "file": {}},
                ]
            },
        )
        m.get(
            re.compile(re.escape(_DRIVE + "/root/search(q='wombat')") + ".*"),
            payload={"value": [{"id": "2"}]},
        )
        out = await files_containing(
            _accessor(),
            "wombat",
            [scope("Engineering/Documents")],
        )
    assert out is not None
    assert [p.virtual for p in out] == ["/sp/Engineering/Documents/b.txt"]


@pytest.mark.asyncio
async def test_a_scope_above_a_library_answers_none():
    for vfs_path in ("", "Engineering"):
        with aioresponses():
            out = await files_containing(
                _accessor(), "wombat", [scope(vfs_path)]
            )
        assert out is None
