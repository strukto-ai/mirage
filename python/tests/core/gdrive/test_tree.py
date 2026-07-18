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

import pytest

from mirage.core.gdrive.tree import iter_tree, vfs_name
from mirage.types import PathSpec

DOC_MIME = "application/vnd.google-apps.document"


def spec(virtual: str) -> PathSpec:
    return PathSpec.from_str_path(virtual)


def seed_tree(fake_drive) -> None:
    sub = fake_drive.folder("sub")
    fake_drive.add("a.txt", content=b"aaaa")
    fake_drive.add("big.bin", parent=sub, content=b"x" * 2048)
    fake_drive.add("small.bin", parent=sub, content=b"x" * 16)
    fake_drive.add("Report", mime=DOC_MIME)


@pytest.mark.asyncio
async def test_iter_tree_walks_sorted(fake_drive, gdrive_accessor):
    seed_tree(fake_drive)
    walked = []
    async for rel, item, is_dir in iter_tree(gdrive_accessor, spec("/")):
        walked.append((rel, is_dir))
    assert walked == [
        ("Report.gdoc.json", False),
        ("a.txt", False),
        ("sub", True),
        ("sub/big.bin", False),
        ("sub/small.bin", False),
    ]


@pytest.mark.asyncio
async def test_iter_tree_missing_root_raises(fake_drive, gdrive_accessor):
    walker = iter_tree(gdrive_accessor, spec("/missing"))
    with pytest.raises(FileNotFoundError):
        await anext(walker)


def test_vfs_name_renders_native_suffix():
    assert vfs_name({"name": "Report", "mimeType": DOC_MIME}) == \
        "Report.gdoc.json"
    assert vfs_name({"name": "a.txt", "mimeType": "text/plain"}) == "a.txt"
