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

from mirage.commands.builtin.utils.tree import tree_walk
from mirage.errors.fs import enotsup, walk_declined
from mirage.types import FileStat, FileType, PathSpec

FILE = FileType.FILE
DIR = FileType.DIRECTORY


def _found() -> dict[str, FileStat]:
    return {
        "b.txt": FileStat(name="b.txt", type=FILE, size=2),
        "a/c.txt": FileStat(name="c.txt", type=FILE, size=3),
        "e": FileStat(name="e", type=DIR),
    }


class _Mount:
    def __init__(self, answer=None, refuse=None) -> None:
        self.answer = answer
        self.refuse = refuse
        self.asked: list[tuple[str, int | None]] = []
        self.calls: list[str] = []

    async def read_tree(self, path: PathSpec, maxdepth: int | None):
        self.asked.append((path.virtual, maxdepth))
        if self.refuse is not None:
            raise self.refuse("ram", "read_tree", path)
        return self.answer

    async def readdir(self, path: PathSpec, index=None) -> list[str]:
        self.calls.append(f"readdir {path.virtual}")
        return []

    async def stat(self, path: PathSpec, index=None) -> FileStat:
        self.calls.append(f"stat {path.virtual}")
        return FileStat(name=path.virtual, type=FILE)


def _walk(mount: _Mount, maxdepth: int | None = None, answered=None):
    return tree_walk(
        mount.read_tree, mount.readdir, mount.stat, maxdepth, answered
    )


@pytest.mark.asyncio
async def test_one_answer_lists_and_stats_the_whole_walk():
    mount = _Mount(_found())
    answered: set[str] = set()
    readdir, stat = _walk(mount, answered=answered)
    root = PathSpec.from_str_path("/m")
    assert await readdir(root) == ["/m/a", "/m/b.txt", "/m/e"]
    assert await readdir(PathSpec.from_str_path("/m/a")) == ["/m/a/c.txt"]
    assert await readdir(PathSpec.from_str_path("/m/e")) == []
    implied = await stat(PathSpec.from_str_path("/m/a"))
    assert (implied.name, implied.type) == ("a", DIR)
    assert (await stat(PathSpec.from_str_path("/m/a/c.txt"))).size == 3
    assert mount.asked == [("/m", None)]
    assert mount.calls == []
    assert answered == {"/m", "/m/a", "/m/e"}


@pytest.mark.asyncio
async def test_listings_are_in_code_point_order():
    names = ["\U0001f600.txt", "\ue000.txt"]
    mount = _Mount({n: FileStat(name=n, type=FILE, size=1) for n in names})
    readdir, _ = _walk(mount)
    assert await readdir(PathSpec.from_str_path("/m")) == [
        "/m/\ue000.txt",
        "/m/\U0001f600.txt",
    ]


@pytest.mark.asyncio
async def test_the_root_and_paths_the_answer_lacks_go_to_the_mount():
    mount = _Mount(_found())
    readdir, stat = _walk(mount)
    await readdir(PathSpec.from_str_path("/m"))
    await stat(PathSpec.from_str_path("/m"))
    await stat(PathSpec.from_str_path("/m/zz"))
    await readdir(PathSpec.from_str_path("/other"))
    assert mount.calls == ["stat /m", "stat /m/zz"]
    assert mount.asked == [("/m", None), ("/other", None)]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mount",
    [_Mount(None), _Mount(refuse=walk_declined)],
    ids=["none", "declined"],
)
async def test_no_answer_walks_the_usual_way_and_asks_once(mount):
    readdir, _ = _walk(mount)
    for _ in range(2):
        await readdir(PathSpec.from_str_path("/m"))
    assert mount.calls == ["readdir /m", "readdir /m"]
    assert mount.asked == [("/m", None)]


@pytest.mark.asyncio
async def test_a_backends_refusal_propagates():

    readdir, _ = _walk(_Mount(refuse=enotsup))
    with pytest.raises(OSError):
        await readdir(PathSpec.from_str_path("/m"))


@pytest.mark.asyncio
async def test_maxdepth_bounds_what_the_answer_stands_in_for():
    mount = _Mount({"a": FileStat(name="a", type=DIR)})
    readdir, stat = _walk(mount, maxdepth=1)
    assert await readdir(PathSpec.from_str_path("/m")) == ["/m/a"]
    assert (await stat(PathSpec.from_str_path("/m/a"))).type == DIR
    await readdir(PathSpec.from_str_path("/m/a"))
    assert mount.asked == [("/m", 1)]
    assert mount.calls == ["readdir /m/a"]


def test_no_read_tree_hands_back_the_walk():
    mount = _Mount()
    assert tree_walk(None, mount.readdir, mount.stat) == (
        mount.readdir,
        mount.stat,
    )
