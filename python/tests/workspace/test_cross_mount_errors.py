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

from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.vfs_io import run_text

pytestmark = pytest.mark.asyncio


def _make_ws():
    ram1 = RAMVFS()
    ram2 = RAMVFS()
    ram1._store.files["/file.txt"] = b"line1\nline2\nline3\nline4\nline5\n"
    ram2._store.files["/file.txt"] = b"aaa\nbbb\nccc\n"
    return Workspace(
        {"/a/": (ram1, MountMode.WRITE), "/b/": (ram2, MountMode.WRITE)},
    )


async def test_cross_mount_head_invalid_n():
    ws = _make_ws()
    code, out, err = await run_text(ws, "head -n abc /a/file.txt /b/file.txt")
    assert code == 1
    assert "abc" in err


async def test_cross_mount_tail_invalid_n():
    ws = _make_ws()
    code, out, err = await run_text(ws, "tail -n abc /a/file.txt /b/file.txt")
    assert code == 1
    assert "abc" in err


async def test_cross_mount_head_valid_n():
    ws = _make_ws()
    code, out, err = await run_text(ws, "head -n 2 /a/file.txt /b/file.txt")
    assert code == 0
    assert "line1" in out
    assert "line2" in out
    assert "aaa" in out
    assert "bbb" in out


async def test_cross_mount_tail_valid_n():
    ws = _make_ws()
    code, out, err = await run_text(ws, "tail -n 1 /a/file.txt /b/file.txt")
    assert code == 0
    assert "line5" in out
    assert "ccc" in out


async def test_cross_mount_head_default_n():
    ws = _make_ws()
    code, out, err = await run_text(ws, "head /a/file.txt /b/file.txt")
    assert code == 0
    assert "line1" in out
    assert "aaa" in out


async def test_cross_mount_head_byte_mode():
    ws = _make_ws()
    code, out, err = await run_text(ws, "head -c 3 /a/file.txt /b/file.txt")
    assert code == 0
    assert "/a/file.txt" in out
    assert "lin" in out
    assert "line1" not in out
    assert "bbb" not in out


async def test_cross_mount_grep_invert():
    ws = _make_ws()
    code, out, err = await run_text(
        ws, "grep -v line1 /a/file.txt /b/file.txt"
    )
    assert code == 0
    assert "/a/file.txt:line2" in out
    assert "aaa" in out
    assert "line1" not in out


async def test_cross_mount_wc_total():
    ws = _make_ws()
    code, out, err = await run_text(ws, "wc -l /a/file.txt /b/file.txt")
    assert code == 0
    assert "total" in out
    assert "5" in out
    assert "3" in out
    assert "8" in out


async def test_cross_mount_cat_missing_has_strerror():
    ws = _make_ws()
    code, out, err = await run_text(ws, "cat /a/file.txt /b/missing.txt")
    assert code == 1
    assert err == "cat: /b/missing.txt: No such file or directory\n"


async def test_cross_mount_diff_missing_has_strerror():
    ws = _make_ws()
    code, out, err = await run_text(ws, "diff /a/missing.txt /b/file.txt")
    # GNU diff reserves exit 1 for "files differ"; trouble is exit 2.
    assert code == 2
    assert err == "diff: /a/missing.txt: No such file or directory\n"


async def test_cross_mount_cmp_missing_has_strerror():
    ws = _make_ws()
    code, out, err = await run_text(ws, "cmp /a/file.txt /b/missing.txt")
    # GNU cmp reserves exit 1 for "files differ"; trouble is exit 2.
    assert code == 2
    assert err == "cmp: /b/missing.txt: No such file or directory\n"


def _make_readonly_src_ws():
    ro = RAMVFS()
    rw = RAMVFS()
    ro._store.files["/report.csv"] = b"name,age\nalice,30\n"
    return Workspace(
        {"/mail/": (ro, MountMode.READ), "/scratch/": (rw, MountMode.EXEC)},
    )


async def test_cross_mount_mv_unremovable_source_keeps_both():
    # GNU mv on a cross-device move that cannot remove the source: the
    # copy stays in place and the failure is a per-entry GNU line.
    ws = _make_readonly_src_ws()
    code, out, err = await run_text(ws, "mv /mail/report.csv /scratch/x.csv")
    assert code == 1
    assert err == (
        "mv: cannot remove '/mail/report.csv': Read-only file system\n"
    )
    code, out, err = await run_text(ws, "cat /scratch/x.csv")
    assert (out, code) == ("name,age\nalice,30\n", 0)
    code, out, err = await run_text(ws, "cat /mail/report.csv")
    assert (out, code) == ("name,age\nalice,30\n", 0)


async def test_cross_mount_relay_mv_expands_glob():
    # RELAY bypasses the mount command wrappers that expand globs for
    # single-mount runs, so the executor expands relay operands itself.
    ws = _make_ws()
    ws.mount("/a/").vfs._store.files["/g1.txt"] = b"g1\n"
    ws.mount("/a/").vfs._store.files["/g2.txt"] = b"g2\n"
    code, out, err = await run_text(ws, "mv /a/g*.txt /b/")
    assert (err, code) == ("", 0)
    code, out, err = await run_text(ws, "cat /b/g1.txt /b/g2.txt")
    assert (out, code) == ("g1\ng2\n", 0)
    code, out, err = await run_text(ws, "ls /a/g1.txt")
    assert code != 0


async def test_cross_mount_relay_mv_unmatched_glob_stays_literal():
    ws = _make_ws()
    code, out, err = await run_text(ws, "mv /a/nomatch*.zzz /b/")
    assert code == 1
    assert err == (
        "mv: cannot stat '/a/nomatch*.zzz': No such file or directory\n"
    )
