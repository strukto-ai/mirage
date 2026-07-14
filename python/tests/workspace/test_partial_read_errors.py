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


def _make_numbered_ws():
    ram = RAMResource()
    ram._store.files["/f.txt"] = b"1\n2\n"
    ram._store.files["/g.txt"] = b"3\n4\n"
    ram._store.files["/h.txt"] = b"hello\n"
    return Workspace({"/a/": (ram, MountMode.WRITE)}, )


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


# ── every operand is processed, not just the first (paths[0] bugs) ──


def test_cut_processes_all_operands():
    out, err, code = _run(_make_numbered_ws(), "cut -c1 /a/f.txt /a/g.txt")
    assert out == "1\n2\n3\n4\n"
    assert err == ""
    assert code == 0


def test_tac_reverses_each_operand():
    out, err, code = _run(_make_numbered_ws(), "tac /a/f.txt /a/g.txt")
    assert out == "2\n1\n4\n3\n"
    assert err == ""
    assert code == 0


def test_nl_numbering_continues_across_operands():
    out, err, code = _run(_make_numbered_ws(), "nl /a/f.txt /a/g.txt")
    assert out == "     1\t1\n     2\t2\n     3\t3\n     4\t4\n"
    assert err == ""
    assert code == 0


def test_strings_scans_all_operands():
    ws = _make_numbered_ws()
    _run(ws, "printf 'worlds\\n' > /a/h2.txt")
    out, err, code = _run(ws, "strings /a/h.txt /a/h2.txt")
    assert out == "hello\nworlds\n"
    assert err == ""
    assert code == 0


def test_zcat_concatenates_all_operands():
    ws = _make_numbered_ws()
    _run(
        ws, "printf 'z\\n' > /a/z1.txt && printf 'y\\n' > /a/z2.txt"
        " && gzip /a/z1.txt /a/z2.txt")
    out, err, code = _run(ws, "zcat /a/z1.txt.gz /a/z2.txt.gz")
    assert out == "z\ny\n"
    assert err == ""
    assert code == 0


# ── the rest of the read family keeps partial output past missing ──


def test_nl_good_then_missing():
    out, err, code = _run(_make_numbered_ws(), "nl /a/f.txt /a/missing.txt")
    assert out == "     1\t1\n     2\t2\n"
    assert err == "nl: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_nl_all_missing_reports_each():
    out, err, code = _run(_make_numbered_ws(), "nl /a/m1.txt /a/m2.txt")
    assert out == ""
    assert err == ("nl: /a/m1.txt: No such file or directory\n"
                   "nl: /a/m2.txt: No such file or directory\n")
    assert code == 1


def test_md5_good_then_missing():
    out, err, code = _run(_make_numbered_ws(), "md5 /a/f.txt /a/missing.txt")
    assert out == "6ddb4095eb719e2a9f0a3f95677d24e0  /a/f.txt\n"
    assert err == "md5: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_sha256sum_good_then_missing():
    out, err, code = _run(_make_numbered_ws(),
                          "sha256sum /a/f.txt /a/missing.txt")
    assert out == ("a6e2b7a040683432de03a18fd8a1939a2fdf8258"
                   "5b364bfc874bdd4095c4cae1  /a/f.txt\n")
    assert err == "sha256sum: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_tac_good_then_missing():
    out, err, code = _run(_make_numbered_ws(), "tac /a/f.txt /a/missing.txt")
    assert out == "2\n1\n"
    assert err == "tac: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_rev_good_then_missing():
    out, err, code = _run(_make_numbered_ws(), "rev /a/f.txt /a/missing.txt")
    assert out == "1\n2\n"
    assert err == "rev: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_cut_good_then_missing():
    out, err, code = _run(_make_numbered_ws(),
                          "cut -c1 /a/f.txt /a/missing.txt")
    assert out == "1\n2\n"
    assert err == "cut: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_expand_good_then_missing():
    out, err, code = _run(_make_numbered_ws(),
                          "expand /a/f.txt /a/missing.txt")
    assert out == "1\n2\n"
    assert err == "expand: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_unexpand_good_then_missing():
    out, err, code = _run(_make_numbered_ws(),
                          "unexpand /a/f.txt /a/missing.txt")
    assert out == "1\n2\n"
    assert err == "unexpand: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_fold_good_then_missing():
    out, err, code = _run(_make_numbered_ws(), "fold /a/f.txt /a/missing.txt")
    assert out == "1\n2\n"
    assert err == "fold: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_fmt_good_then_missing():
    out, err, code = _run(_make_numbered_ws(), "fmt /a/f.txt /a/missing.txt")
    assert out == "1 2\n"
    assert err == "fmt: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_strings_good_then_missing():
    out, err, code = _run(_make_numbered_ws(),
                          "strings /a/h.txt /a/missing.txt")
    assert out == "hello\n"
    assert err == "strings: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_zcat_good_then_missing():
    ws = _make_numbered_ws()
    _run(ws, "printf 'z\\n' > /a/z1.txt && gzip /a/z1.txt")
    out, err, code = _run(ws, "zcat /a/z1.txt.gz /a/missing.gz")
    assert out == "z\n"
    assert err == "zcat: /a/missing.gz: No such file or directory\n"
    assert code == 1


def test_sort_still_aborts_on_missing():
    # GNU sort needs all input before emitting anything, so no partial
    # output; the repo reports the operand and exits 1 (GNU exits 2).
    out, err, code = _run(_make_numbered_ws(), "sort /a/f.txt /a/missing.txt")
    assert out == ""
    assert err == "sort: /a/missing.txt: No such file or directory\n"
    assert code == 1


def _make_cross_numbered_ws():
    ram1 = RAMResource()
    ram2 = RAMResource()
    ram1._store.files["/f.txt"] = b"1\n2\n"
    return Workspace(
        {
            "/a/": (ram1, MountMode.WRITE),
            "/b/": (ram2, MountMode.WRITE)
        }, )


def test_cross_nl_reports_own_name():
    # STREAM commands fetch operand bytes through a native cat sub-run; the
    # error line must still carry the command's own name, like single-mount.
    out, err, code = _run(_make_cross_numbered_ws(),
                          "nl /a/f.txt /b/missing.txt")
    assert out == "     1\t1\n     2\t2\n"
    assert err == "nl: /b/missing.txt: No such file or directory\n"
    assert code == 1


def test_cross_md5_good_then_missing():
    out, err, code = _run(_make_cross_numbered_ws(),
                          "md5 /a/f.txt /b/missing.txt")
    assert out == "6ddb4095eb719e2a9f0a3f95677d24e0  /a/f.txt\n"
    assert err == "md5: /b/missing.txt: No such file or directory\n"
    assert code == 1


def test_stat_good_then_missing_keeps_row():
    out, err, code = _run(_make_ws(), "stat /a/f.txt /a/missing.txt")
    assert "name=f.txt" in out
    assert err == "stat: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_sed_good_then_missing_keeps_output():
    out, err, code = _run(_make_numbered_ws(),
                          "sed s/1/X/ /a/f.txt /a/missing.txt")
    assert out == "X\n2\n"
    assert err == "sed: /a/missing.txt: No such file or directory\n"
    assert code == 1


def test_cross_sed_good_then_missing_keeps_output():
    out, err, code = _run(_make_cross_numbered_ws(),
                          "sed s/1/X/ /a/f.txt /b/missing.txt")
    assert out == "X\n2\n"
    assert err == "sed: /b/missing.txt: No such file or directory\n"
    assert code == 1


def test_cross_sort_aborts_like_single_mount():
    out, err, code = _run(_make_cross_numbered_ws(),
                          "sort /a/f.txt /b/missing.txt")
    assert out == ""
    assert err == "sort: /b/missing.txt: No such file or directory\n"
    assert code == 1
