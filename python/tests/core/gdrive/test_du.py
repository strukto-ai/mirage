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

from mirage.core.gdrive.du import du, du_all
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
async def test_du_sums_tree(fake_drive, gdrive_accessor):
    seed_tree(fake_drive)
    assert await du(gdrive_accessor, spec("/")) == 4 + 2048 + 16


@pytest.mark.asyncio
async def test_du_file_uses_stat(fake_drive, gdrive_accessor):
    seed_tree(fake_drive)
    assert await du(gdrive_accessor, spec("/a.txt")) == 4
    assert await du_all(gdrive_accessor, spec("/a.txt")) == []


@pytest.mark.asyncio
async def test_du_all_entries_plus_total(fake_drive, gdrive_accessor):
    seed_tree(fake_drive)
    assert await du_all(gdrive_accessor, spec("/sub")) == [
        ("/sub/big.bin", 2048),
        ("/sub/small.bin", 16),
        ("/sub", 2064),
    ]


@pytest.mark.asyncio
async def test_du_missing_root_raises(fake_drive, gdrive_accessor):
    with pytest.raises(FileNotFoundError):
        await du(gdrive_accessor, spec("/missing"))
