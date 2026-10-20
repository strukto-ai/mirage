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

import aiohttp
import pytest

from mirage.core.gdrive.readdir import readdir
from mirage.core.gdrive.search import files_containing
from mirage.core.gdrive.tree import PARENTS_PER_QUERY
from mirage.types import PathSpec
from tests.fixtures.handed import entry_at


def scope(vfs_path: str = "") -> PathSpec:
    virtual = "/gd/" + vfs_path if vfs_path else "/gd"
    return PathSpec(vfs_path=vfs_path, virtual=virtual, directory=virtual)


@pytest.mark.asyncio
async def test_hits_are_the_walked_files_drive_names(
    fake_drive, gdrive_accessor
):
    sub = fake_drive.folder("sub")
    fake_drive.add("a.txt", content=b"the wombat")
    fake_drive.add("b.txt", parent=sub, content=b"wombat here")
    fake_drive.add("c.txt", content=b"nothing")
    out = await files_containing(gdrive_accessor, "wombat", scope(), None)
    assert out is not None
    assert sorted(p.virtual for p in out) == ["/gd/a.txt", "/gd/sub/b.txt"]
    assert fake_drive.searches == [["root", sub]]


@pytest.mark.asyncio
async def test_a_subfolder_scope_searches_from_its_folder(
    fake_drive, gdrive_accessor
):
    sub = fake_drive.folder("sub")
    fake_drive.add("a.txt", content=b"wombat")
    fake_drive.add("b.txt", parent=sub, content=b"wombat")
    under = scope("sub")
    out = await files_containing(
        gdrive_accessor,
        "wombat",
        under,
        await entry_at(readdir, gdrive_accessor, under),
    )
    assert out is not None
    assert [(p.virtual, p.vfs_path) for p in out] == [
        ("/gd/sub/b.txt", "sub/b.txt")
    ]
    assert fake_drive.searches == [[sub]]


@pytest.mark.asyncio
async def test_many_folders_are_searched_in_batches(
    fake_drive, gdrive_accessor
):
    for i in range(PARENTS_PER_QUERY + 5):
        fake_drive.folder(f"d{i:02d}")
    fake_drive.add("a.txt", content=b"wombat")
    out = await files_containing(gdrive_accessor, "wombat", scope(), None)
    assert out is not None
    assert [len(s) for s in fake_drive.searches] == [PARENTS_PER_QUERY, 6]


def _raise(exc: BaseException):
    async def fail(*args, **kwargs):
        raise exc

    return fail


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "case",
    ["no hit", "incomplete", "search fails", "timeout", "listing fails"],
)
async def test_a_search_that_cannot_answer_answers_none(
    case, fake_drive, gdrive_accessor, monkeypatch
):
    fake_drive.add(
        "a.txt", content=b"nothing" if case == "no hit" else b"wombat"
    )
    fake_drive.incomplete = case == "incomplete"
    if case == "search fails":
        error = aiohttp.ClientConnectionError("down")
        monkeypatch.setattr(fake_drive, "search_files", _raise(error))
    if case == "timeout":
        monkeypatch.setattr(fake_drive, "search_files", _raise(TimeoutError()))
    if case == "listing fails":
        monkeypatch.setattr(
            fake_drive, "list_children", _raise(TimeoutError())
        )
    out = await files_containing(gdrive_accessor, "wombat", scope(), None)
    assert out is None
