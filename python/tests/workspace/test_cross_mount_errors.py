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


def test_cross_mount_glob_expands_in_operand_order():
    ws = _make_ws()
    out, err, code = _run(ws, "cat /a/*.txt /b/*.txt")
    assert code == 0
    assert out == "line1\nline2\nline3\nline4\nline5\naaa\nbbb\nccc\n"


def test_cross_mount_cat_n_numbers_continuously():
    ws = _make_ws()
    out, err, code = _run(ws, "cat -n /a/*.txt /b/*.txt")
    assert code == 0
    assert "1\tline1" in out
    assert "6\taaa" in out


def test_cross_mount_wc_totals_expanded_globs():
    ws = _make_ws()
    out, err, code = _run(ws, "wc -l /a/*.txt /b/*.txt")
    assert code == 0
    assert "8 total" in out


def test_cross_mount_grep_counts_expanded_globs():
    ws = _make_ws()
    out, err, code = _run(ws, "grep -c a /a/*.txt /b/*.txt")
    assert code == 0
    assert "/a/file.txt:0" in out
    assert "/b/file.txt:1" in out


def test_cross_mount_zero_match_keeps_literal():
    ws = _make_ws()
    out, err, code = _run(ws, "cat /a/*.nope /b/*.txt")
    assert code != 0
    assert "/a/*.nope" in err


def test_cross_mount_cp_glob_sources():
    ws = _make_ws()
    out, err, code = _run(ws, "cp /a/*.txt /b/copied.txt && cat /b/copied.txt")
    assert code == 0
    assert "line1" in out
