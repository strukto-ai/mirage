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

import asyncio
import importlib
import os
import shutil
from pathlib import Path

import pytest

from mirage import MountMode, Workspace
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.core.disk import listing_version
from mirage.core.disk.listing_version import folder_version
from mirage.types import ReadPolicy, ReadSpec
from mirage.vfs.disk import DiskVFS
from mirage.workspace.mount import Mount
from mirage.workspace.reconcile import Reconciler

readdir_module = importlib.import_module("mirage.core.disk.readdir")

QUIET_NS = 3_000_000_000
OLD_NS = 1_000_000_000_000_000_000


class Clock:
    """The wall clock the folder version reads, patched.

    Args:
        monkeypatch (pytest.MonkeyPatch): the test's patcher.
    """

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.now = 0
        monkeypatch.setattr(listing_version, "time_ns", lambda: self.now)

    def settle(self, *folders: Path) -> None:
        """Sit 3 s past the latest change of every folder given.

        Args:
            *folders (Path): the host folders a fill or a check reads.
        """
        self.now = (
            max(
                max(st.st_ctime_ns, st.st_mtime_ns)
                for st in map(os.stat, folders)
            )
            + QUIET_NS
        )


@pytest.fixture
def clock(monkeypatch):
    return Clock(monkeypatch)


@pytest.fixture
def scans(monkeypatch):
    seen: list[Path] = []
    original = readdir_module.read_entries

    def counted(directory):
        seen.append(Path(directory))
        return original(directory)

    monkeypatch.setattr(readdir_module, "read_entries", counted)
    return seen


@pytest.fixture
def checks(monkeypatch):
    seen: list[str] = []
    original = Reconciler._listing_fingerprint

    async def counted(self, mount, path):
        seen.append(path)
        return await original(self, mount, path)

    monkeypatch.setattr(Reconciler, "_listing_fingerprint", counted)
    return seen


def _expected(folder: Path) -> str:
    st = os.stat(folder)
    return f"{st.st_dev}:{st.st_ino}:{st.st_ctime_ns}:{st.st_mtime_ns}"


def _ws(root: Path, **knobs) -> Workspace:
    return Workspace(
        {
            "/m": Mount(
                vfs=DiskVFS(str(root), **knobs),
                mode=MountMode.WRITE,
                read=ReadSpec(policy=ReadPolicy.FRESH, ttl=600),
            )
        }
    )


async def _ls(ws: Workspace, path: str = "/m") -> str:
    result = await asyncio.wait_for(ws.shell(f"ls {path}"), 10)
    out = await result.stdout_str()
    assert (result.exit_code, await result.stderr_str()) == (0, "")
    return out


async def _stored(ws: Workspace, key: str = "/m") -> str | None:
    return (await ws.mount(key).index_store.list_dir(key)).version


async def _checked(ws: Workspace, key: str = "/m") -> str | None:
    remote = await ws.mount(key).call("stat", key, index=RAMIndexCacheStore())
    return remote.fingerprint


def test_a_folder_changed_within_two_seconds_has_no_version(tmp_path):
    st = os.stat(tmp_path)
    changed = max(st.st_ctime_ns, st.st_mtime_ns)
    assert folder_version(tmp_path, changed + 1_999_999_999) is None
    assert folder_version(tmp_path, changed + 2_000_000_000) is not None


def test_a_fresh_ctime_withholds_the_version_of_an_old_mtime(tmp_path):
    os.utime(tmp_path, ns=(OLD_NS, OLD_NS))
    st = os.stat(tmp_path)
    assert st.st_mtime_ns == OLD_NS
    assert folder_version(tmp_path, st.st_ctime_ns + 1_000_000_000) is None


FUTURE_NS = 60_000_000_000


def _mtime_ahead(folder: Path) -> tuple[int, int]:
    """Set a folder's mtime a minute past its ctime; return both.

    Args:
        folder (Path): the host folder.
    """
    ctime = os.stat(folder).st_ctime_ns
    os.utime(folder, ns=(ctime, ctime + FUTURE_NS))
    st = os.stat(folder)
    assert st.st_mtime_ns > st.st_ctime_ns
    return st.st_ctime_ns, st.st_mtime_ns


# Where st_ctime is a creation time, the mtime is what a change moves, so
# a folder whose mtime is ahead of the clock is still settling however
# long ago its ctime was.
@pytest.mark.asyncio
async def test_a_folder_whose_mtime_is_ahead_is_relisted_until_it_passes(
    tmp_path, clock, scans
):
    (tmp_path / "a.txt").write_text("a")
    ctime, mtime = _mtime_ahead(tmp_path)
    clock.now = ctime + QUIET_NS
    ws = _ws(tmp_path)
    try:
        await _ls(ws)
        assert await _stored(ws) is None
        clock.now = mtime + QUIET_NS
        await _ls(ws)
        assert await _stored(ws) == _expected(tmp_path)
        assert scans == [tmp_path, tmp_path]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_quiet_folder_stores_the_version_its_stat_answers(
    tmp_path, clock
):
    (tmp_path / "a.txt").write_text("a")
    clock.settle(tmp_path)
    ws = _ws(tmp_path)
    try:
        assert await _ls(ws) == "a.txt\n"
        stored = await _stored(ws)
        assert stored == _expected(tmp_path)
        assert await _checked(ws) == stored
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_add_with_its_mtime_put_back_still_moves_the_version(
    tmp_path, clock
):
    (tmp_path / "a.txt").write_text("a")
    os.utime(tmp_path, ns=(OLD_NS, OLD_NS))
    clock.settle(tmp_path)
    ws = _ws(tmp_path)
    try:
        await _ls(ws)
        stored = await _stored(ws)
        assert stored is not None
        (tmp_path / "b.txt").write_text("b")
        os.utime(tmp_path, ns=(OLD_NS, OLD_NS))
        assert os.stat(tmp_path).st_mtime_ns == OLD_NS
        clock.settle(tmp_path)
        moved = await _checked(ws)
        assert moved is not None
        assert moved != stored
        assert await _ls(ws) == "a.txt\nb.txt\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_folder_made_again_under_its_old_mtime_moves_the_version(
    tmp_path, clock
):
    folder = tmp_path / "d"
    folder.mkdir()
    (folder / "x.txt").write_text("x")
    os.utime(folder, ns=(OLD_NS, OLD_NS))
    clock.settle(folder)
    ws = _ws(tmp_path)
    try:
        assert await _ls(ws, "/m/d") == "x.txt\n"
        stored = await _stored(ws, "/m/d")
        assert stored is not None
        shutil.rmtree(folder)
        folder.mkdir()
        (folder / "y.txt").write_text("y")
        os.utime(folder, ns=(OLD_NS, OLD_NS))
        assert os.stat(folder).st_mtime_ns == OLD_NS
        clock.settle(folder)
        moved = await _checked(ws, "/m/d")
        assert moved is not None
        assert moved != stored
        assert await _ls(ws, "/m/d") == "y.txt\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_in_place_edit_of_a_child_keeps_the_listing_served(
    tmp_path, clock, scans, checks
):
    child = tmp_path / "c.txt"
    child.write_text("abc")
    clock.settle(tmp_path)
    ws = _ws(tmp_path)
    try:
        await _ls(ws)
        stored = await _stored(ws)
        assert stored is not None
        with open(child, "r+") as fh:
            fh.write("X")
        clock.settle(tmp_path)
        assert await _checked(ws) == stored
        checks.clear()
        assert await _ls(ws) == "c.txt\n"
        assert scans == [tmp_path]
        assert checks == ["/m"]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_file_made_during_the_scan_is_seen_by_the_next_command(
    tmp_path, clock, scans, monkeypatch
):
    (tmp_path / "a.txt").write_text("a")
    clock.settle(tmp_path)
    counted = readdir_module.read_entries
    made: list[Path] = []

    def racing(directory):
        rows = counted(directory)
        if not made:
            late = Path(directory) / "late.txt"
            late.write_text("l")
            made.append(late)
        return rows

    monkeypatch.setattr(readdir_module, "read_entries", racing)
    ws = _ws(tmp_path)
    try:
        assert await _ls(ws) == "a.txt\n"
        assert await _stored(ws) is not None
        clock.settle(tmp_path)
        assert await _ls(ws) == "a.txt\nlate.txt\n"
        assert scans == [tmp_path, tmp_path]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_folder_versions_off_relists_every_command(
    tmp_path, clock, scans, checks
):
    (tmp_path / "a.txt").write_text("a")
    clock.settle(tmp_path)
    ws = _ws(tmp_path, folder_versions=False)
    try:
        await _ls(ws)
        assert await _stored(ws) is None
        await _ls(ws)
        assert checks == []
        assert scans == [tmp_path, tmp_path]
    finally:
        await ws.close()
