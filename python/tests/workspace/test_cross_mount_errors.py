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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _make_ws():
    ram1 = RAMResource()
    ram2 = RAMResource()
    ram1._store.files["/file.txt"] = b"line1\nline2\nline3\nline4\nline5\n"
    ram2._store.files["/file.txt"] = b"aaa\nbbb\nccc\n"
    return Workspace(
        {
            "/a/": (ram1, MountMode.WRITE),
            "/b/": (ram2, MountMode.WRITE)
        }, )


def _run(ws, cmd):

    async def _inner():
        io = await ws.execute(cmd)
        return await io.stdout_str(), await io.stderr_str(), io.exit_code

    return asyncio.run(_inner())


def test_cross_mount_head_invalid_n():
    ws = _make_ws()
    out, err, code = _run(ws, "head -n abc /a/file.txt /b/file.txt")
    assert code == 1
    assert "abc" in err


def test_cross_mount_tail_invalid_n():
    ws = _make_ws()
    out, err, code = _run(ws, "tail -n abc /a/file.txt /b/file.txt")
    assert code == 1
    assert "abc" in err


def test_cross_mount_head_valid_n():
    ws = _make_ws()
    out, err, code = _run(ws, "head -n 2 /a/file.txt /b/file.txt")
    assert code == 0
    assert "line1" in out
    assert "line2" in out
    assert "aaa" in out
    assert "bbb" in out


def test_cross_mount_tail_valid_n():
    ws = _make_ws()
    out, err, code = _run(ws, "tail -n 1 /a/file.txt /b/file.txt")
    assert code == 0
    assert "line5" in out
    assert "ccc" in out


def test_cross_mount_head_default_n():
    ws = _make_ws()
    out, err, code = _run(ws, "head /a/file.txt /b/file.txt")
    assert code == 0
    assert "line1" in out
    assert "aaa" in out


def test_cross_mount_head_byte_mode():
    ws = _make_ws()
    out, err, code = _run(ws, "head -c 3 /a/file.txt /b/file.txt")
    assert code == 0
    assert "/a/file.txt" in out
    assert "lin" in out
    assert "line1" not in out
    assert "bbb" not in out


def test_cross_mount_grep_invert():
    ws = _make_ws()
    out, err, code = _run(ws, "grep -v line1 /a/file.txt /b/file.txt")
    assert code == 0
    assert "/a/file.txt:line2" in out
    assert "aaa" in out
    assert "line1" not in out


def test_cross_mount_wc_total():
    ws = _make_ws()
    out, err, code = _run(ws, "wc -l /a/file.txt /b/file.txt")
    assert code == 0
    assert "total" in out
    assert "5" in out
    assert "3" in out
    assert "8" in out


def test_cross_mount_cat_missing_has_strerror():
    ws = _make_ws()
    out, err, code = _run(ws, "cat /a/file.txt /b/missing.txt")
    assert code == 1
    assert err == "cat: /b/missing.txt: No such file or directory\n"


def test_cross_mount_diff_missing_has_strerror():
    ws = _make_ws()
    out, err, code = _run(ws, "diff /a/missing.txt /b/file.txt")
    # GNU diff reserves exit 1 for "files differ"; trouble is exit 2.
    assert code == 2
    assert err == "diff: /a/missing.txt: No such file or directory\n"


def test_cross_mount_cmp_missing_has_strerror():
    ws = _make_ws()
    out, err, code = _run(ws, "cmp /a/file.txt /b/missing.txt")
    # GNU cmp reserves exit 1 for "files differ"; trouble is exit 2.
    assert code == 2
    assert err == "cmp: /b/missing.txt: No such file or directory\n"


def _make_readonly_src_ws():
    ro = RAMResource()
    rw = RAMResource()
    ro._store.files["/report.csv"] = b"name,age\nalice,30\n"
    return Workspace(
        {
            "/mail/": (ro, MountMode.READ),
            "/scratch/": (rw, MountMode.EXEC)
        }, )


def test_cross_mount_mv_unremovable_source_keeps_both():
    # GNU mv on a cross-device move that cannot remove the source: the
    # copy stays in place and the failure is a per-entry GNU line.
    ws = _make_readonly_src_ws()
    out, err, code = _run(ws, "mv /mail/report.csv /scratch/x.csv")
    assert code == 1
    assert err == "mv: cannot remove '/mail/report.csv': Permission denied\n"
    out, err, code = _run(ws, "cat /scratch/x.csv")
    assert (out, code) == ("name,age\nalice,30\n", 0)
    out, err, code = _run(ws, "cat /mail/report.csv")
    assert (out, code) == ("name,age\nalice,30\n", 0)


def test_cross_mount_relay_mv_expands_glob():
    # RELAY bypasses the mount command wrappers that expand globs for
    # single-mount runs, so the executor expands relay operands itself.
    ws = _make_ws()
    ws.mount("/a/").resource._store.files["/g1.txt"] = b"g1\n"
    ws.mount("/a/").resource._store.files["/g2.txt"] = b"g2\n"
    out, err, code = _run(ws, "mv /a/g*.txt /b/")
    assert (err, code) == ("", 0)
    out, err, code = _run(ws, "cat /b/g1.txt /b/g2.txt")
    assert (out, code) == ("g1\ng2\n", 0)
    out, err, code = _run(ws, "ls /a/g1.txt")
    assert code != 0


def test_cross_mount_relay_mv_unmatched_glob_stays_literal():
    ws = _make_ws()
    out, err, code = _run(ws, "mv /a/nomatch*.zzz /b/")
    assert code == 1
    assert err == ("mv: cannot stat '/a/nomatch*.zzz': "
                   "No such file or directory\n")
