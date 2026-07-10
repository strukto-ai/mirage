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
    ram1._store.files["/f.txt"] = b"aaa\n"
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


# ── single-mount: good + missing keeps partial output, GNU-style ──


def test_cat_good_then_missing():
    out, err, code = _run(_make_ws(), "cat /a/f.txt /a/missing.txt")
    assert out == "aaa\n"
    assert err == "cat: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_cat_missing_then_good():
    out, err, code = _run(_make_ws(), "cat /a/missing.txt /a/f.txt")
    assert out == "aaa\n"
    assert err == "cat: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_cat_all_missing_reports_each():
    out, err, code = _run(_make_ws(), "cat /a/m1.txt /a/m2.txt")
    assert out == ""
    assert err == ("cat: /a/m1.txt: No such file or directory\n"
                   "cat: /a/m2.txt: No such file or directory\n")
    assert code == 1


def test_wc_good_then_missing_keeps_total():
    out, err, code = _run(_make_ws(), "wc -l /a/f.txt /a/missing.txt")
    assert out == "1 /a/f.txt\n1 total\n"
    assert err == "wc: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_wc_all_missing_zero_total():
    out, err, code = _run(_make_ws(), "wc -l /a/m1.txt /a/m2.txt")
    assert out == "0 total\n"
    assert err == ("wc: /a/m1.txt: No such file or directory\n"
                   "wc: /a/m2.txt: No such file or directory\n")
    assert code == 1


def test_head_good_then_missing_keeps_banner():
    out, err, code = _run(_make_ws(), "head -n 1 /a/f.txt /a/missing.txt")
    assert out == "==> /a/f.txt <==\naaa\n"
    assert err == "head: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_head_missing_first_no_leading_blank():
    out, err, code = _run(_make_ws(), "head -n 1 /a/missing.txt /a/f.txt")
    assert out == "==> /a/f.txt <==\naaa\n"
    assert err == "head: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_tail_good_then_missing_keeps_banner():
    out, err, code = _run(_make_ws(), "tail -n 1 /a/f.txt /a/missing.txt")
    assert out == "==> /a/f.txt <==\naaa\n"
    assert err == "tail: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_single_missing_operand_unchanged():
    out, err, code = _run(_make_ws(), "cat /a/missing.txt")
    assert out == ""
    assert err == "cat: /a/missing.txt: No such file or directory\n"
    assert code == 1


# ── cross-mount: same bytes as single-mount ──


def test_cross_cat_good_then_missing():
    out, err, code = _run(_make_ws(), "cat /a/f.txt /b/missing.txt")
    assert out == "aaa\n"
    assert err == "cat: /b/missing.txt: No such file or directory\n"
    assert code == 1


def test_cross_wc_good_then_missing_keeps_total():
    out, err, code = _run(_make_ws(), "wc -l /a/f.txt /b/missing.txt")
    assert out == "1 /a/f.txt\n1 total\n"
    assert err == "wc: /b/missing.txt: No such file or directory\n"
    assert code == 1


def test_cross_head_good_then_missing_keeps_banner():
    out, err, code = _run(_make_ws(), "head -n 1 /a/f.txt /b/missing.txt")
    assert out == "==> /a/f.txt <==\naaa\n"
    assert err == "head: /b/missing.txt: No such file or directory\n"
    assert code == 1


def test_cross_tail_good_then_missing_keeps_banner():
    out, err, code = _run(_make_ws(), "tail -n 1 /a/f.txt /b/missing.txt")
    assert out == "==> /a/f.txt <==\naaa\n"
    assert err == "tail: /b/missing.txt: No such file or directory\n"
    assert code == 1
