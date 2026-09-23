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

import errno

import pytest

from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.remnants import (VisibleRemnant, child_spec, entry_name,
                                   remove_remnants, visible_below)


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual.rsplit("/", 1)[0] or "/",
                    vfs_path=virtual.lstrip("/"))


def _nothing_visible(virtual: str) -> bool:
    return False


class TreeChannel:
    """A dict-backed channel recording every removal in call order."""

    def __init__(self, dirs: set[str], files: set[str]) -> None:
        self.dirs = set(dirs)
        self.files = set(files)
        self.removed: list[tuple[str, str]] = []
        self.readonly: set[str] = set()
        # Listed but gone by stat time: the mid-walk vanish case.
        self.ghosts: set[str] = set()

    async def readdir(self, spec: PathSpec) -> list[str]:
        base = spec.virtual.rstrip("/")
        if base not in self.dirs:
            raise FileNotFoundError(base)
        names = set()
        for p in self.dirs | self.files | self.ghosts:
            if p.startswith(base + "/"):
                names.add(p[len(base) + 1:].split("/", 1)[0])
        return sorted(names)

    async def stat(self, spec: PathSpec) -> FileStat:
        if spec.virtual in self.dirs:
            return FileStat(name=spec.virtual, type=FileType.DIRECTORY)
        if spec.virtual in self.files:
            return FileStat(name=spec.virtual, type=FileType.FILE)
        raise FileNotFoundError(spec.virtual)

    async def unlink(self, spec: PathSpec) -> None:
        if spec.virtual in self.readonly:
            raise PermissionError(errno.EROFS, "Read-only file system",
                                  spec.virtual)
        if spec.virtual not in self.files:
            raise FileNotFoundError(spec.virtual)
        self.files.remove(spec.virtual)
        self.removed.append(("unlink", spec.virtual))

    async def rmdir(self, spec: PathSpec) -> None:
        if spec.virtual not in self.dirs:
            raise FileNotFoundError(spec.virtual)
        self.dirs.remove(spec.virtual)
        self.removed.append(("rmdir", spec.virtual))


@pytest.mark.asyncio
async def test_removes_a_nested_tree_children_first():
    ch = TreeChannel(dirs={"/d", "/d/sub"}, files={"/d/a", "/d/sub/b"})
    await remove_remnants(ch, _nothing_visible, _spec("/d"))
    assert not ch.dirs and not ch.files
    assert ch.removed.index(("unlink", "/d/sub/b")) < ch.removed.index(
        ("rmdir", "/d/sub"))
    assert ch.removed[-1] == ("rmdir", "/d")


@pytest.mark.asyncio
async def test_a_visible_entry_aborts_before_it_is_touched():
    ch = TreeChannel(dirs={"/d", "/d/sec"},
                     files={"/d/sec/k", "/d/sec/new.txt"})
    with pytest.raises(VisibleRemnant) as exc:
        await remove_remnants(ch, lambda v: v == "/d/sec/new.txt", _spec("/d"))
    assert exc.value.errno == errno.ENOTEMPTY
    assert "/d/sec/new.txt" in ch.files
    assert "/d" in ch.dirs and "/d/sec" in ch.dirs


@pytest.mark.asyncio
async def test_entries_vanished_mid_walk_are_completed_removals():
    ch = TreeChannel(dirs={"/d"}, files={"/d/a"})
    ch.ghosts.add("/d/ghost")
    await remove_remnants(ch, _nothing_visible, _spec("/d"))
    assert not ch.dirs and not ch.files


@pytest.mark.asyncio
async def test_a_directory_vanished_before_its_listing_is_done():
    ch = TreeChannel(dirs=set(), files=set())
    await remove_remnants(ch, _nothing_visible, _spec("/d"))
    assert ch.removed == []


@pytest.mark.asyncio
async def test_a_channel_refusal_propagates_to_the_caller():
    # The channel carries the plane's mode axis; a read-only entry
    # refuses the deletion and the cascade must surface that, so the
    # arm can fall back to its original refusal.
    ch = TreeChannel(dirs={"/d"}, files={"/d/k"})
    ch.readonly.add("/d/k")
    with pytest.raises(PermissionError):
        await remove_remnants(ch, _nothing_visible, _spec("/d"))
    assert "/d" in ch.dirs and "/d/k" in ch.files


def test_visible_below_normalizes_slashes_and_paths():
    seen: list[str] = []

    def probe(virtual: str) -> bool:
        seen.append(virtual)
        return virtual == "/d/pub"

    assert visible_below("/d/", ["sec/", "/d/pub"], probe)
    assert seen == ["/d/sec", "/d/pub"]
    assert not visible_below("/d", ["sec", "hidden.txt"], _nothing_visible)


def test_entry_name_takes_the_last_component():
    assert entry_name("sub/") == "sub"
    assert entry_name("/a/b/c") == "c"
    assert entry_name("plain") == "plain"


def test_child_spec_appends_to_the_vfs_key():
    parent = PathSpec(virtual="/m/d", directory="/m", vfs_path="d")
    child = child_spec(parent, "x")
    assert child.virtual == "/m/d/x"
    assert child.vfs_path == "d/x"
    root = PathSpec(virtual="/m", directory="/", vfs_path="")
    assert child_spec(root, "x").vfs_path == "x"
