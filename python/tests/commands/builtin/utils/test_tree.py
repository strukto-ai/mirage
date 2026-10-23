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

from dataclasses import replace

import pytest

from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.utils.tree import ScanBudget, tree_walk
from mirage.errors.fs import enotdir, enotsup, walk_declined
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.view.types import MountView
from mirage.workspace import Workspace

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
        self.asked: list[str] = []
        self.calls: list[str] = []

    async def read_tree(self, path: PathSpec):
        self.asked.append(path.virtual)
        if self.refuse is not None:
            raise self.refuse("ram", "read_tree", path)
        return self.answer

    async def readdir(self, path: PathSpec, index=None) -> list[str]:
        self.calls.append(f"readdir {path.virtual}")
        return []

    async def stat(self, path: PathSpec, index=None) -> FileStat:
        self.calls.append(f"stat {path.virtual}")
        return FileStat(name=path.virtual, type=FILE)


def _walk(mount: _Mount):
    return tree_walk(mount.read_tree, mount.readdir, mount.stat)


@pytest.mark.asyncio
async def test_one_answer_lists_and_stats_the_whole_walk():
    mount = _Mount(_found())
    readdir, stat = _walk(mount)
    root = PathSpec.from_str_path("/m")
    assert await readdir(root) == ["/m/a", "/m/b.txt", "/m/e"]
    assert await readdir(PathSpec.from_str_path("/m/a")) == ["/m/a/c.txt"]
    assert await readdir(PathSpec.from_str_path("/m/e")) == []
    implied = await stat(PathSpec.from_str_path("/m/a"))
    assert (implied.name, implied.type) == ("a", DIR)
    assert (await stat(PathSpec.from_str_path("/m/a/c.txt"))).size == 3
    assert mount.asked == ["/m"]
    assert mount.calls == []


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
    assert mount.asked == ["/m", "/other"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mount",
    [
        _Mount(None),
        _Mount(refuse=walk_declined),
        # A subtree read stops at a link at the final name; readdir
        # opens what it leads to.
        _Mount(refuse=lambda _vfs, _op, path: enotdir(path)),
    ],
    ids=["none", "declined", "link"],
)
async def test_no_answer_walks_the_usual_way_and_asks_once(mount):
    readdir, _ = _walk(mount)
    for _ in range(2):
        await readdir(PathSpec.from_str_path("/m"))
    assert mount.calls == ["readdir /m", "readdir /m"]
    assert mount.asked == ["/m"]


@pytest.mark.asyncio
async def test_a_backends_refusal_propagates():
    readdir, _ = _walk(_Mount(refuse=enotsup))
    with pytest.raises(OSError):
        await readdir(PathSpec.from_str_path("/m"))


def test_no_read_tree_hands_back_the_walk():
    mount = _Mount()
    assert tree_walk(None, mount.readdir, mount.stat) == (
        mount.readdir,
        mount.stat,
    )


@pytest.mark.asyncio
async def test_a_dotted_or_refused_operand_is_never_answered_from_an_earlier_answer():
    mount = _Mount(_found())
    readdir, stat = _walk(mount)
    await readdir(PathSpec.from_str_path("/m"))
    dotted = PathSpec.from_str_path("/m/x/../a", cwd="/")
    await stat(dotted)
    await readdir(dotted)
    refused = replace(PathSpec.from_str_path("/m/e"), walk_error="ENOENT")
    await stat(refused)
    await readdir(refused)
    assert mount.asked == ["/m", "/m/a", "/m/e"]
    assert mount.calls == ["stat /m/a", "stat /m/e"]


class GuardedRAM(RAMVFS):
    """A RAM mount that refuses every full scan, keeping its reads."""

    def __init__(self) -> None:
        super().__init__()
        self.scans: list[str] = []
        self.reads: list[str] = []

    async def read(self, path, offset=0, size=None):
        self.reads.append(path.virtual)
        return await super().read(path, offset, size)

    def read_stream(self, path):
        self.reads.append(path.virtual)
        return super().read_stream(path)

    async def before_full_scan(self, path, *, files=None, index=NULL_INDEX):
        self.scans.append(path.virtual)
        raise ValueError(f"{files} files in scope, narrow the path")


async def _guarded(line: str) -> tuple[GuardedRAM, bytes, bytes, int]:
    vfs = GuardedRAM()
    vfs._store.dirs.update({"/d", "/d/sub", "/e"})
    vfs._store.files.update(
        {"/d/a.txt": b"ada\n", "/d/sub/b.txt": b"bob\n", "/e/a.txt": b"x\n"}
    )
    ws = Workspace({"/g/": vfs, "/out/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        result = await ws.shell(line)
        stdout = await result.stdout_str()
        return vfs, stdout.encode(), result.stderr or b"", result.exit_code
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "tar -cf /out/a.tar /g/d",
        "tar -cf - /g/d",
        "zip -qr /out/a.zip /g/d",
        "cp -r /g/d /out/c",
        "cp -r /g/d /g/c",
        "mv /g/d /out/m",
        "diff -r /g/d /g/e",
        "rm -r /g/d",
    ],
)
async def test_a_command_reading_a_whole_directory_asks_first(line):
    vfs, _, stderr, code = await _guarded(line)
    name = line.split()[0]
    assert vfs.scans and vfs.reads == []
    assert stderr == f"{name}: 2 files in scope, narrow the path\n".encode()
    assert code != 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, out",
    [
        (
            "printf x > /out/t; cp -rb -T /g/d /out/t; cat /out/t; ls /out",
            "xt\n",
        ),
        ("mkdir /out/t; mv -T /g/d /out/t; ls -d /out/t", "/out/t\n"),
        ("rm -rf /g/d; ls /g/d", "a.txt\nsub\n"),
    ],
)
async def test_a_refused_tree_copy_leaves_the_destination_alone(line, out):
    _, stdout, stderr, _ = await _guarded(line)
    assert stdout == out.encode()
    assert stderr.endswith(b"2 files in scope, narrow the path\n")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "cat /g/d/a.txt",
        "find /g/d",
        "ls -R /g/d",
        "du -a /g/d",
        "cp /g/d/a.txt /out/a.txt",
        "zip -q /out/a.zip /g/d/a.txt",
        "grep ada /g/d/a.txt",
        "rg --files --sort path /g/d /out",
    ],
)
async def test_a_command_reading_named_files_asks_nothing(line):
    vfs, _, stderr, code = await _guarded(line)
    assert (vfs.scans, stderr, code) == ([], b"", 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    ["grep -r ada /g/d", "rg ada /g/d", "rg --sort modified ada /g/d /out"],
)
async def test_a_search_stops_at_the_limit_rather_than_asking(line):
    vfs, stdout, stderr, code = await _guarded(line)
    assert (vfs.scans, stdout, stderr, code) == (
        [],
        b"/g/d/a.txt:ada\n",
        b"",
        0,
    )


def _limits(limits: dict[str, int]) -> MountView:
    def root_of(path: str) -> str:
        return max(
            (r for r in limits if (path.rstrip("/") + "/").startswith(r)),
            key=len,
        )

    return MountView(
        descendants=lambda path: [],
        visible_descendants=lambda path: [],
        is_root=lambda path: False,
        root_of=root_of,
        full_scan_limit=lambda path: limits[root_of(path)],
    )


STOP = "stopped after {} files (full_scan_limit); narrow the path"


def test_a_scan_budget_stops_once_spent_and_opens_nothing_more():
    budget = ScanBudget(PathSpec.from_str_path("/m/d"), _limits({"/m/": 2}))
    assert [budget.spend("/m/d") for _ in range(3)] == [True, True, False]
    assert not budget.opens("/m/d/sub")
    assert budget.stopped == [f"/m/d: {STOP.format(2)}"]


def test_a_scan_budget_charges_each_mount_under_its_own_root():
    budget = ScanBudget(
        PathSpec.from_str_path("/"), _limits({"/": -1, "/m/": 2, "/n/": 3})
    )
    assert all(budget.spend("/") for _ in range(50))
    assert [budget.spend("/m/d") for _ in range(3)] == [True, True, False]
    assert all(budget.spend("/n") for _ in range(3))
    assert budget.stopped == [f"/m: {STOP.format(2)}"]


@pytest.mark.parametrize("raw, shown", [("d", "d"), ("", ".")])
def test_a_scan_budget_names_the_operand_as_typed(raw, shown):
    operand = replace(PathSpec.from_str_path("/m/d"), raw_path=raw)
    budget = ScanBudget(operand, _limits({"/m/": 0}))
    assert not budget.spend("/m/d")
    assert budget.stopped == [f"{shown}: {STOP.format(0)}"]


@pytest.mark.asyncio
async def test_a_scan_budget_listing_cuts_one_and_skips_the_next():
    asked: list[str] = []

    async def readdir(path: PathSpec) -> list[str]:
        asked.append(path.virtual)
        return [f"{path.virtual}/{i}" for i in range(3)]

    budget = ScanBudget(PathSpec.from_str_path("/m"), _limits({"/m/": 2}))
    listed = await budget.listing(readdir, PathSpec.from_str_path("/m"))
    assert listed == ["/m/0", "/m/1"]
    assert await budget.listing(readdir, PathSpec.from_str_path("/m/0")) == []
    assert asked == ["/m"]
    assert budget.stopped == [f"/m: {STOP.format(2)}"]
