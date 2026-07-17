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

import pytest

from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _run(coro):
    return asyncio.run(coro)


def _stdout(io):
    if io.stdout is None:
        return b""
    if isinstance(io.stdout, bytes):
        return io.stdout
    if isinstance(io.stdout, memoryview):
        return bytes(io.stdout)
    return b""


# ═══════════════════════════════════════════════
# RAM resource integration
# ═══════════════════════════════════════════════


def _ram_ws():
    p = RAMResource()
    p._store.files["/hello.txt"] = b"hello world\n"
    p._store.files["/data.csv"] = b"name,age\nalice,30\nbob,25\n"
    p._store.dirs.add("/sub")
    p._store.files["/sub/nested.txt"] = b"nested content\n"
    ws = Workspace(resources={"/ram/": (p, MountMode.WRITE)}, )
    ws.get_session(ws.default_session_id).cwd = "/ram"
    return ws


def test_ram_cat():
    ws = _ram_ws()
    io = _run(ws.execute("cat /ram/hello.txt"))
    assert io.exit_code == 0
    assert b"hello world" in _stdout(io)


def test_ram_grep():
    ws = _ram_ws()
    io = _run(ws.execute("grep alice /ram/data.csv"))
    assert io.exit_code == 0
    assert b"alice" in _stdout(io)


def test_ram_pipeline():
    ws = _ram_ws()
    io = _run(ws.execute("cat /ram/data.csv | grep alice | wc -l"))
    assert io.exit_code == 0
    assert b"1" in _stdout(io)


def test_ram_redirect_write():
    ws = _ram_ws()
    _run(ws.execute("echo test > /ram/out.txt"))
    io = _run(ws.execute("cat /ram/out.txt"))
    assert b"test" in _stdout(io)


def test_ram_ls():
    ws = _ram_ws()
    io = _run(ws.execute("ls /ram/"))
    assert io.exit_code == 0


def test_ram_head():
    ws = _ram_ws()
    io = _run(ws.execute("head -n 1 /ram/data.csv"))
    assert io.exit_code == 0
    assert b"name" in _stdout(io)


def test_ram_awk():
    ws = _ram_ws()
    io = _run(ws.execute("awk -F, '{print $1}' /ram/data.csv"))
    assert io.exit_code == 0
    assert b"alice" in _stdout(io)


def test_ram_sed():
    ws = _ram_ws()
    io = _run(ws.execute("sed 's/alice/ALICE/' /ram/data.csv"))
    assert b"ALICE" in _stdout(io)


def test_ram_sort():
    ws = _ram_ws()
    io = _run(ws.execute("cat /ram/data.csv | sort"))
    assert io.exit_code == 0


# ═══════════════════════════════════════════════
# Disk resource integration
# ═══════════════════════════════════════════════


@pytest.fixture
def disk_ws(tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / "hello.txt").write_bytes(b"hello from disk\n")
    (data_dir / "nums.txt").write_bytes(b"3\n1\n2\n")
    (data_dir / "report.csv").write_bytes(b"name,age\nalice,30\nbob,25\n")
    sub = data_dir / "sub"
    sub.mkdir()
    (sub / "nested.txt").write_bytes(b"nested\n")

    p = DiskResource(root=str(data_dir))
    ws = Workspace(resources={"/disk/": (p, MountMode.WRITE)}, )
    ws.get_session(ws.default_session_id).cwd = "/disk"
    return ws


def test_disk_cat(disk_ws):
    io = _run(disk_ws.execute("cat /disk/hello.txt"))
    assert io.exit_code == 0
    assert b"hello from disk" in _stdout(io)


def test_disk_grep(disk_ws):
    io = _run(disk_ws.execute("grep alice /disk/report.csv"))
    assert io.exit_code == 0
    assert b"alice" in _stdout(io)


def test_disk_pipeline(disk_ws):
    io = _run(disk_ws.execute("cat /disk/report.csv | grep alice | wc -l"))
    assert io.exit_code == 0
    assert b"1" in _stdout(io)


def test_disk_ls(disk_ws):
    io = _run(disk_ws.execute("ls /disk/"))
    assert io.exit_code == 0


def test_disk_head(disk_ws):
    io = _run(disk_ws.execute("head -n 1 /disk/report.csv"))
    assert io.exit_code == 0
    assert b"name" in _stdout(io)


def test_disk_sort(disk_ws):
    io = _run(disk_ws.execute("sort -n /disk/nums.txt"))
    assert io.exit_code == 0
    lines = _stdout(io).decode().strip().split("\n")
    assert lines == ["1", "2", "3"]


def test_disk_redirect_write(disk_ws):
    _run(disk_ws.execute("echo written > /disk/out.txt"))
    io = _run(disk_ws.execute("cat /disk/out.txt"))
    assert b"written" in _stdout(io)


def test_disk_nested_cat(disk_ws):
    io = _run(disk_ws.execute("cat /disk/sub/nested.txt"))
    assert io.exit_code == 0
    assert b"nested" in _stdout(io)


def test_disk_awk(disk_ws):
    io = _run(disk_ws.execute("awk -F, '{print $1}' /disk/report.csv"))
    assert io.exit_code == 0
    assert b"alice" in _stdout(io)


def test_disk_sed(disk_ws):
    io = _run(disk_ws.execute("sed 's/bob/BOB/' /disk/report.csv"))
    assert b"BOB" in _stdout(io)


# ═══════════════════════════════════════════════
# Cross-resource: RAM + Disk
# ═══════════════════════════════════════════════


@pytest.fixture
def multi_ws(tmp_path):
    data_dir = tmp_path / "diskdata"
    data_dir.mkdir()
    (data_dir / "disk_file.txt").write_bytes(b"from disk\n")

    ram = RAMResource()
    ram._store.files["/ram_file.txt"] = b"from ram\n"

    disk = DiskResource(root=str(data_dir))

    ws = Workspace(resources={
        "/ram/": (ram, MountMode.WRITE),
        "/disk/": (disk, MountMode.WRITE),
    }, )
    ws.get_session(ws.default_session_id).cwd = "/ram"
    return ws


def test_cross_cat_ram(multi_ws):
    io = _run(multi_ws.execute("cat /ram/ram_file.txt"))
    assert b"from ram" in _stdout(io)


def test_cross_cat_disk(multi_ws):
    io = _run(multi_ws.execute("cat /disk/disk_file.txt"))
    assert b"from disk" in _stdout(io)


def test_cross_pipeline(multi_ws):
    """Read from RAM, pipe through commands, write to Disk."""
    _run(
        multi_ws.execute(
            "cat /ram/ram_file.txt | tr 'a-z' 'A-Z' > /disk/upper.txt"))
    io = _run(multi_ws.execute("cat /disk/upper.txt"))
    assert b"FROM RAM" in _stdout(io)


def test_cross_for_loop(multi_ws):
    """for loop across resources."""
    _run(
        multi_ws.execute("for f in /ram/ram_file.txt /disk/disk_file.txt; do "
                         "cat $f; done"))


def test_cross_redirect(multi_ws):
    """Read RAM, write to Disk."""
    _run(multi_ws.execute("echo hello > /disk/from_ram.txt"))
    io = _run(multi_ws.execute("cat /disk/from_ram.txt"))
    assert b"hello" in _stdout(io)


def test_cross_cp_ram_to_disk(multi_ws):
    """cp /ram/file /disk/file → cross-mount copy."""
    io = _run(multi_ws.execute("cp /ram/ram_file.txt /disk/copied.txt"))
    assert io.exit_code == 0
    io = _run(multi_ws.execute("cat /disk/copied.txt"))
    assert b"from ram" in _stdout(io)


def test_cross_cp_disk_to_ram(multi_ws):
    """cp /disk/file /ram/file → cross-mount copy."""
    io = _run(multi_ws.execute("cp /disk/disk_file.txt /ram/copied.txt"))
    assert io.exit_code == 0
    io = _run(multi_ws.execute("cat /ram/copied.txt"))
    assert b"from disk" in _stdout(io)


def test_cross_mv_ram_to_disk(multi_ws):
    """mv /ram/file /disk/file → cross-mount move."""
    _run(multi_ws.execute("echo moveme > /ram/move_src.txt"))
    io = _run(multi_ws.execute("mv /ram/move_src.txt /disk/move_dst.txt"))
    assert io.exit_code == 0
    io = _run(multi_ws.execute("cat /disk/move_dst.txt"))
    assert b"moveme" in _stdout(io)
    io = _run(multi_ws.execute("cat /ram/move_src.txt"))
    assert io.exit_code == 1


def test_cross_diff_same(multi_ws):
    """diff across mounts — identical files."""
    _run(multi_ws.execute("echo same > /ram/a.txt"))
    _run(multi_ws.execute("echo same > /disk/a.txt"))
    io = _run(multi_ws.execute("diff /ram/a.txt /disk/a.txt"))
    assert io.exit_code == 0


def test_cross_diff_different(multi_ws):
    """diff across mounts — different files."""
    io = _run(multi_ws.execute("diff /ram/ram_file.txt /disk/disk_file.txt"))
    assert io.exit_code == 1
    out = _stdout(io)
    assert b"from ram" in out or b"---" in out


def test_cross_cmp_same(multi_ws):
    """cmp across mounts — identical files."""
    _run(multi_ws.execute("echo identical > /ram/c.txt"))
    _run(multi_ws.execute("echo identical > /disk/c.txt"))
    io = _run(multi_ws.execute("cmp /ram/c.txt /disk/c.txt"))
    assert io.exit_code == 0


def test_cross_cmp_different(multi_ws):
    """cmp across mounts — different files."""
    io = _run(multi_ws.execute("cmp /ram/ram_file.txt /disk/disk_file.txt"))
    assert io.exit_code == 1
    assert b"differ" in _stdout(io)
