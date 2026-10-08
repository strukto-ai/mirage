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

from mirage.commands.builtin.utils.wrap import (
    mount_parent_readdir,
    mount_parent_stat,
)
from mirage.types import ContentType, FileStat, FileType
from mirage.view.types import MountView


def _mounts(
    descendants: tuple[str, ...] = (), hidden: tuple[str, ...] = ()
) -> MountView:
    def under(path: str) -> list[str]:
        return [d for d in descendants if d.startswith(path.rstrip("/") + "/")]

    return MountView(
        descendants=under,
        visible_descendants=lambda p: [d for d in under(p) if d not in hidden],
        is_root=lambda p: (
            p.rstrip("/") in {d.rstrip("/") for d in descendants}
        ),
        root_of=lambda p: "/",
    )


async def _absent(path):
    raise FileNotFoundError(path)


async def _denied(path):
    raise PermissionError(path)


async def _listing(path):
    return ["a.txt"]


async def _row(path):
    return FileStat(
        name="a.txt", type=FileType.FILE, content=ContentType.TEXT, size=1
    )


@pytest.mark.asyncio
async def test_readdir_passes_through_without_a_mount_view():
    assert await mount_parent_readdir(_listing, None, "")("/x") == ["a.txt"]


@pytest.mark.asyncio
async def test_readdir_lists_a_mount_parent_as_empty():
    rd = mount_parent_readdir(
        _absent, _mounts(descendants=("/ghost/deep",)), ""
    )
    assert await rd("/ghost") == []


@pytest.mark.asyncio
async def test_readdir_re_raises_where_no_mount_sits_below():
    rd = mount_parent_readdir(
        _absent, _mounts(descendants=("/ghost/deep",)), ""
    )
    with pytest.raises(FileNotFoundError):
        await rd("/nope")


@pytest.mark.asyncio
async def test_readdir_re_raises_when_the_only_mount_below_is_hidden():
    # Answering at all says the directory is there, so the parent of a
    # mount the session may not be told about has to keep reading as
    # absent: keyed on every descendant instead of the visible ones,
    # this returned an empty listing and a recursive search reported an
    # ordinary no-match where every other verb reports ENOENT.
    rd = mount_parent_readdir(
        _absent,
        _mounts(descendants=("/ghost/deep",), hidden=("/ghost/deep",)),
        "",
    )
    with pytest.raises(FileNotFoundError):
        await rd("/ghost")


@pytest.mark.asyncio
async def test_readdir_answers_when_one_of_two_mounts_below_is_visible():
    rd = mount_parent_readdir(
        _absent,
        _mounts(
            descendants=("/ghost/deep", "/ghost/seen"), hidden=("/ghost/deep",)
        ),
        "",
    )
    assert await rd("/ghost") == []


@pytest.mark.asyncio
async def test_stat_passes_the_backend_row_through():
    st = mount_parent_stat(_row, _mounts(descendants=("/ghost/deep",)))
    assert (await st("/x")).name == "a.txt"


@pytest.mark.asyncio
async def test_stat_synthesizes_a_directory_for_a_mount_parent():
    st = mount_parent_stat(_absent, _mounts(descendants=("/ghost/deep",)))
    row = await st("/ghost")
    assert row.name == "ghost"
    assert row.type == FileType.DIRECTORY
    assert row.size is None


@pytest.mark.asyncio
async def test_stat_re_raises_where_no_mount_sits_below():
    st = mount_parent_stat(_absent, _mounts(descendants=("/ghost/deep",)))
    with pytest.raises(FileNotFoundError):
        await st("/nope")


@pytest.mark.asyncio
async def test_stat_re_raises_when_the_only_mount_below_is_hidden():
    st = mount_parent_stat(
        _absent, _mounts(descendants=("/ghost/deep",), hidden=("/ghost/deep",))
    )
    with pytest.raises(FileNotFoundError):
        await st("/ghost")


@pytest.mark.asyncio
async def test_readdir_re_raises_a_refusal_that_is_not_an_absence():
    # A directory the backend refused is there and holds data this run
    # cannot read. Calling it empty would let grep -r print the mount
    # below it and exit 0 while silently omitting the parent.
    st = mount_parent_readdir(
        _denied, _mounts(descendants=("/ghost/deep",)), ""
    )
    with pytest.raises(PermissionError):
        await st("/ghost")


@pytest.mark.asyncio
async def test_stat_re_raises_a_refusal_that_is_not_an_absence():
    st = mount_parent_stat(_denied, _mounts(descendants=("/ghost/deep",)))
    with pytest.raises(PermissionError):
        await st("/ghost")
