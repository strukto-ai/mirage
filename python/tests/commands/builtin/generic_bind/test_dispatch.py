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

from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.cache.index.scope import command_scope, command_started
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.dispatch import run_dispatch
from mirage.commands.config import command
from mirage.commands.spec import SPECS
from mirage.errors.fs import eacces
from mirage.io import IOResult
from mirage.types import MountMode, PathSpec
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import install, replaces


@pytest.mark.asyncio
async def test_output_is_read_inside_the_running_command():
    # A fresh mount trusts only the listings the running command made, so
    # a walk read lazily after the command ended was served stale ones.
    seen: list[int | None] = []

    async def fn(accessor, paths, texts, ctx):
        async def walk():
            seen.append(command_started())
            yield b"hit\n"

        return walk(), IOResult()

    async def dispatch(op, path, **kwargs):
        raise AssertionError(op)

    async with command_scope():
        started = command_started()
        stdout, _ = await run_dispatch(
            GenericCommand("grep", fn), [], [], {}, dispatch, "/"
        )
    assert (stdout, seen) == (b"hit\n", [started])


@pytest.mark.asyncio
@pytest.mark.parametrize("overwrite", [False, True])
async def test_relay_sort_caches_inputs_and_replacements(overwrite):
    left, right = RAMVFS(), RAMVFS()
    left.caches_reads = right.caches_reads = True
    left.load_state({"files": {"/input": b"z\na\n"}})
    right.load_state({"files": {"/input": b"m\n"}})
    ws = Workspace({"/a": left, "/b": right}, mode=MountMode.WRITE)
    command = "sort /a/input /b/input"
    try:
        result = await ws.shell(
            command + (" -o /a/input" if overwrite else "")
        )
        assert result.exit_code == 0
        assert await result.materialize_stdout() == (
            b"" if overwrite else b"a\nm\nz\n"
        )
        assert await ws.cache.get("/a/input") == (
            b"a\nm\nz\n" if overwrite else b"z\na\n"
        )
        assert await ws.cache.get("/b/input") == b"m\n"
        left.load_state({"files": {"/input": b"changed\n"}})
        again = await ws.shell("cat /a/input" if overwrite else command)
        assert await again.materialize_stdout() == b"a\nm\nz\n"
    finally:
        await ws.close()


@command("du", vfs="ram", spec=SPECS["du"])
async def _unmeasured_du(accessor, paths, texts, opts):
    return b"0\t" + paths[0].raw_path.encode() + b"\n", IOResult()


@pytest.mark.asyncio
async def test_du_walk_charges_each_mount_its_own_limit():
    # A du that reports no measurement leaves the line to this walk.
    outer, inner = RAMVFS(full_scan_limit=-1), RAMVFS(full_scan_limit=2)
    outer.load_state({"files": {f"/f{i}": b"x" for i in range(4)}})
    inner.load_state({"files": {f"/g{i}": b"y" for i in range(3)}})
    ws = Workspace({"/a": outer, "/a/b": inner}, mode=MountMode.WRITE)
    install(ws.mount("/a/b"), [_unmeasured_du])
    try:
        result = await ws.shell("du -a /a")
        rows = (await result.materialize_stdout()).decode().splitlines()
        assert [r for r in rows if "/a/f" in r] == [
            f"1\t/a/f{i}" for i in range(4)
        ]
        assert len([r for r in rows if "/a/b/g" in r]) == 2
        assert result.stderr == (
            b"du: /a/b: stopped after 2 files (full_scan_limit); "
            b"narrow the path\n"
        )
        assert result.exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_du_x_never_lists_a_mount_below_the_operand():
    @replaces("readdir")
    async def refusing(accessor, path, **kwargs):
        raise eacces(path)

    ws = Workspace(
        {"/a": RAMVFS(), "/a/b": RAMVFS(), "/c": RAMVFS()},
        mode=MountMode.WRITE,
    )
    try:
        await ws.shell("echo aa > /a/f; echo ccc > /a/b/g; echo d > /c/h")
        install(ws.mount("/a/b"), [refusing])
        result = await ws.shell("du -x /a /c")
        assert await result.materialize_stdout() == b"3\t/a\n2\t/c\n"
        assert not result.stderr
        assert result.exit_code == 0
    finally:
        await ws.close()


class _Lines(RAMVFS):
    """A RAM mount that answers the read stand-ins on its own."""

    def __init__(self) -> None:
        super().__init__()
        self.asked: list[str] = []

    async def first_lines(
        self, path: PathSpec, n: int, index: IndexCacheStore = NULL_INDEX
    ) -> bytes | None:
        self.asked.append(f"first_lines {n}")
        return b"first\n" * n

    async def last_lines(
        self, path: PathSpec, n: int, index: IndexCacheStore = NULL_INDEX
    ) -> bytes | None:
        self.asked.append(f"last_lines {n}")
        return b"last\n" * n

    async def line_count(
        self, path: PathSpec, index: IndexCacheStore = NULL_INDEX
    ) -> int | None:
        self.asked.append("line_count")
        return 42


@pytest.mark.asyncio
async def test_head_tail_and_wc_ask_the_mount_through_the_dispatcher():
    vfs = _Lines()
    vfs.load_state({"files": {"/f": b"a\nb\nc\n"}})
    ws = Workspace({"/m/": vfs})
    try:
        head = await ws.shell("head -n 2 /m/f")
        tail = await ws.shell("tail -n 1 /m/f")
        count = await ws.shell("wc -l /m/f")
        assert (head.stdout, tail.stdout, count.stdout) == (
            b"first\nfirst\n",
            b"last\n",
            b"42 /m/f\n",
        )
        assert vfs.asked == ["first_lines 2", "last_lines 1", "line_count"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_path_rule_refuses_the_stand_ins_through_a_link():
    vfs = _Lines()
    vfs.load_state({"files": {"/f": b"a\nb\nc\n"}})
    ws = Workspace({"/m/": vfs}, mode=MountMode.WRITE)
    try:
        assert (await ws.shell("ln -s /m/f /m/l")).exit_code == 0
        await ws.set_session_profile(
            ws.default_session_id,
            {"commands": {"deny": [{"paths": ["/m/f"], "reason": "sealed"}]}},
        )
        for line in ("head -n 2 /m/l", "tail -n 1 /m/l", "wc -l /m/l"):
            refused = await ws.shell(line)
            assert refused.exit_code == 1
            assert b"Permission denied" in (refused.stderr or b"")
        assert vfs.asked == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_cached_file_is_read_from_the_cache_instead():
    vfs = _Lines()
    vfs.caches_reads = True
    vfs.load_state({"files": {"/f": b"a\nb\nc\n"}})
    ws = Workspace({"/m/": vfs})
    try:
        await ws.shell("cat /m/f")
        head = await ws.shell("head -n 2 /m/f")
        tail = await ws.shell("tail -n 1 /m/f")
        count = await ws.shell("wc -l /m/f")
        assert (head.stdout, tail.stdout, count.stdout) == (
            b"a\nb\n",
            b"c\n",
            b"3 /m/f\n",
        )
        assert vfs.asked == []
    finally:
        await ws.close()


class _Counted(RAMVFS):
    """A RAM mount that counts its listings."""

    def __init__(self) -> None:
        super().__init__()
        self.trees = 0
        self.listings = 0

    async def read_tree(self, path):
        self.trees += 1
        return await super().read_tree(path)

    async def readdir(self, path):
        self.listings += 1
        return await super().readdir(path)


class _Untreed(RAMVFS):
    """A RAM mount without read_tree: every walk lists each directory."""

    read_tree = BaseVFS.read_tree


_WALKS = (
    "find /m",
    "find /m -maxdepth 1",
    "find /m -type d",
    "find /m -empty",
    "du -a /m",
    "du -s /m/a",
    "ls -R /m",
    "ls -lR /m/a",
    "tree /m",
    "tree -L 1 /m",
    "grep -r ada /m",
    "rg ada /m",
    "cp -r /m/a /m/copy && find /m/copy",
)


async def _walks(vfs: RAMVFS) -> list[tuple[int, bytes, bytes]]:
    vfs.load_state(
        {
            "files": {
                "/a/x.txt": b"ada\n",
                "/a/b/y.py": b"print(1)\n",
                "/a/b/c/z.md": b"ada lovelace\n",
                "/top": b"t\n",
            }
        }
    )
    vfs._store.dirs.update({"/a", "/a/b", "/a/b/c", "/a/empty"})
    ws = Workspace({"/m/": vfs}, mode=MountMode.WRITE)
    try:
        out = []
        for line in _WALKS:
            r = await ws.shell(line)
            out.append((r.exit_code, r.stdout, r.stderr or b""))
        return out
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_walk_reads_the_tree_in_one_call_and_prints_the_same():
    counted = _Counted()
    assert await _walks(counted) == await _walks(_Untreed())
    assert counted.trees > 0
    # find -maxdepth 1 and tree -L 1 each list their one level.
    assert counted.listings == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,stdout",
    [
        ("find /repo -name x.txt", b"/repo/dev/x.txt\n/repo/main/x.txt\n"),
        (
            "find /repo",
            b"/repo\n/repo/dev\n/repo/dev/x.txt\n/repo/main\n/repo/main/x.txt\n",
        ),
        (
            "du -a /repo",
            b"4\t/repo/dev/x.txt\n4\t/repo/dev\n4\t/repo/main/x.txt\n"
            b"4\t/repo/main\n8\t/repo\n",
        ),
    ],
)
async def test_a_walk_reaches_mounts_without_read_tree_under_a_synthetic_dir(
    line, stdout
):
    # The operand's own part runs on the implicit root RAM, which answers
    # read_tree, and its walk reaches the mounts below through the
    # dispatcher's listing; those answer none, so each is walked rather
    # than refused ENOTSUP.
    mounts = {}
    for name in ("main", "dev"):
        vfs = _Untreed()
        vfs.load_state({"files": {"/x.txt": b"ada\n"}})
        mounts[f"/repo/{name}/"] = vfs
    ws = Workspace(mounts, mode=MountMode.WRITE)
    try:
        r = await ws.shell(line)
        assert (r.stdout, r.stderr or b"", r.exit_code) == (stdout, b"", 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_walk_following_a_link_onto_a_mount_without_read_tree_walks_it():
    # A link above the subtree leads the dispatcher onto another mount, so
    # the walk asks that mount, not the one at the path as spelled:
    # /repo/a/sub stands on the root RAM by name and on the mount at
    # /data/dev by its links.
    main = _Untreed()
    main.load_state({"files": {"/x.txt": b"ada\n"}})
    dev = _Untreed()
    dev.load_state({"files": {}, "dirs": ["/", "/sub"]})
    ws = Workspace(
        {"/repo/main/": main, "/data/dev/": dev}, mode=MountMode.WRITE
    )
    try:
        await ws.shell("ln -s /data/dev /repo/a")
        r = await ws.shell("du -aL /repo")
        assert (r.stdout, r.stderr or b"", r.exit_code) == (
            b"0\t/repo/a/sub\n0\t/repo/a\n4\t/repo/main/x.txt\n"
            b"4\t/repo/main\n4\t/repo\n",
            b"",
            0,
        )
    finally:
        await ws.close()
