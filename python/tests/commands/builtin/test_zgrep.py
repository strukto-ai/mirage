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
import gzip

import pytest

from mirage.commands.builtin.generic.zgrep import zgrep_generic
from mirage.io.types import materialize
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def _ws():
    mem = RAMVFS()
    ws = Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )
    return ws, mem


def _run_raw(ws, cmd, cwd="/", stdin=None):
    ws._cwd = cwd
    io = asyncio.run(ws.shell(cmd, stdin=stdin))
    return io.stdout, io


def _bytes(stdout):
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    return b"".join(asyncio.run(_collect(stdout)))


async def _collect(ait):
    return [chunk async for chunk in ait]


def test_zgrep():
    ws, _ = _ws()
    compressed = gzip.compress(b"foo\nbar\nbaz\n")
    _run_raw(ws, "tee /data/f.gz", stdin=compressed)
    stdout, io = _run_raw(ws, "zgrep bar /data/f.gz")
    assert _bytes(stdout).strip() == b"bar"


def test_zgrep_no_match():
    ws, _ = _ws()
    compressed = gzip.compress(b"foo\nbar\n")
    _run_raw(ws, "tee /data/f.gz", stdin=compressed)
    stdout, io = _run_raw(ws, "zgrep xyz /data/f.gz")
    assert io.exit_code == 1


def test_zgrep_dash_f_pattern_file():
    ws, _ = _ws()
    compressed = gzip.compress(b"foo\nbar\nbaz\n")
    _run_raw(ws, "tee /data/f.gz", stdin=compressed)
    _run_raw(ws, "tee /data/pats.txt", stdin=b"bar\nbaz\n")
    stdout, io = _run_raw(ws, "zgrep -f /data/pats.txt /data/f.gz")
    assert io.exit_code == 0
    assert _bytes(stdout) == b"bar\nbaz\n"


def test_zgrep_dash_e_and_dash_f_union():
    ws, _ = _ws()
    compressed = gzip.compress(b"foo\nbar\nbaz\n")
    _run_raw(ws, "tee /data/f.gz", stdin=compressed)
    _run_raw(ws, "tee /data/pats.txt", stdin=b"baz\n")
    stdout, io = _run_raw(ws, "zgrep -e foo -f /data/pats.txt /data/f.gz")
    assert io.exit_code == 0
    assert _bytes(stdout) == b"foo\nbaz\n"


def test_zgrep_stdin_h_labels_standard_input():
    ws, _ = _ws()
    compressed = gzip.compress(b"foo\nbar\n")
    stdout, io = _run_raw(ws, "zgrep -H bar", stdin=compressed)
    assert _bytes(stdout) == b"(standard input):bar\n"
    assert io.exit_code == 0


def test_zgrep_b_prefixes_byte_offsets_in_grep_field_order():
    ws, _ = _ws()
    _run_raw(ws, "tee /data/m.gz", stdin=gzip.compress(b"hello\nworld\n"))
    stdout, _ = _run_raw(ws, "zgrep -b o /data/m.gz")
    assert _bytes(stdout) == b"0:hello\n6:world\n"
    stdout, _ = _run_raw(ws, "zgrep -bn world /data/m.gz")
    assert _bytes(stdout) == b"2:6:world\n"
    stdout, _ = _run_raw(ws, "zgrep -bo o /data/m.gz")
    assert _bytes(stdout) == b"4:o\n7:o\n"


def test_zgrep_L_lists_the_matchless_archive_with_grep_status():
    ws, _ = _ws()
    _run_raw(ws, "tee /data/m.gz", stdin=gzip.compress(b"hello\n"))
    _run_raw(ws, "tee /data/o.gz", stdin=gzip.compress(b"foo\n"))
    stdout, io = _run_raw(ws, "zgrep -L hello /data/m.gz /data/o.gz")
    assert _bytes(stdout) == b"/data/o.gz\n"
    assert io.exit_code == 0
    stdout, io = _run_raw(ws, "zgrep -L hello /data/o.gz")
    assert _bytes(stdout) == b"/data/o.gz\n"
    assert io.exit_code == 1
    stdout, io = _run_raw(ws, "zgrep -L -l hello /data/m.gz /data/o.gz")
    assert _bytes(stdout) == b"/data/m.gz\n"


def test_zgrep_m0_lists_every_archive_under_L_and_none_under_l():
    # zgrep 3.11: -m0 selects no line at all, so -L lists every archive
    # and exits 1, and -l lists nothing.
    ws, _ = _ws()
    _run_raw(ws, "tee /data/m.gz", stdin=gzip.compress(b"hello\n"))
    _run_raw(ws, "tee /data/o.gz", stdin=gzip.compress(b"foo\n"))
    stdout, io = _run_raw(ws, "zgrep -m0 -L hello /data/m.gz /data/o.gz")
    assert _bytes(stdout) == b"/data/m.gz\n/data/o.gz\n"
    assert io.exit_code == 1
    stdout, io = _run_raw(ws, "zgrep -m0 -l hello /data/m.gz /data/o.gz")
    assert _bytes(stdout) == b""
    assert io.exit_code == 1


def test_zgrep_lists_stdin_as_dash():
    # zgrep (gzip 1.13) lists stdin by the name it hands grep, `-`, while -H
    # labels its lines `(standard input)`.
    ws, _ = _ws()
    compressed = gzip.compress(b"foo\nbar\n")
    stdout, io = _run_raw(ws, "zgrep -l bar", stdin=compressed)
    assert (_bytes(stdout), io.exit_code) == (b"-\n", 0)
    stdout, io = _run_raw(ws, "zgrep -L zzz", stdin=compressed)
    assert (_bytes(stdout), io.exit_code) == (b"-\n", 1)


def test_zgrep_names_stdin_operands_like_gnu():
    # zgrep hands grep a stdin operand as `-`: -l lists it as `-` while
    # its lines are labelled `(standard input)`; /dev/stdin is as typed.
    ws, _ = _ws()
    data = gzip.compress(b"hello\n")
    for cmd, want in (
        ("zgrep -H hello -", b"(standard input):hello\n"),
        ("zgrep -H hello /dev/stdin", b"/dev/stdin:hello\n"),
        ("zgrep -l hello -", b"-\n"),
        ("zgrep -l hello /dev/stdin", b"/dev/stdin\n"),
    ):
        stdout, io = _run_raw(ws, cmd, stdin=data)
        assert (_bytes(stdout), io.exit_code) == (want, 0), cmd


def test_zgrep_searches_a_plain_input_as_it_is():
    # zgrep decompresses with `gzip -cdfq`, which passes a plain file.
    ws, _ = _ws()
    _run_raw(ws, "tee /data/plain.txt", stdin=b"hello\nworld\n")
    stdout, io = _run_raw(ws, "zgrep -c o /data/plain.txt")
    assert (_bytes(stdout), io.exit_code) == (b"2\n", 0)
    stdout, io = _run_raw(ws, "zgrep hello", stdin=b"hello\n")
    assert (_bytes(stdout), io.exit_code) == (b"hello\n", 0)


def test_zgrep_i_folds_ascii_only():
    # zgrep is gzip piped into grep, which folds ASCII only under LC_ALL=C:
    # neither U+212A nor U+017F matches k or s (gzip 1.13, grep 3.11).
    ws, _ = _ws()
    lookalikes = "K\nſ\n".encode()
    _run_raw(ws, "tee /data/f.gz", stdin=gzip.compress(lookalikes + b"k\n"))
    for cmd, out, code in (
        ("zgrep -ci k /data/f.gz", b"1\n", 0),
        ("zgrep -ci s /data/f.gz", b"0\n", 1),
        ("zgrep -io k /data/f.gz", b"k\n", 0),
        ("zgrep -iv k /data/f.gz", lookalikes, 0),
        ("zgrep -il s /data/f.gz", b"", 1),
        ("zgrep -iL s /data/f.gz", b"/data/f.gz\n", 1),
    ):
        stdout, io = _run_raw(ws, cmd)
        assert (_bytes(stdout), io.exit_code) == (out, code), cmd


def test_zgrep_w_word_boundary_is_ascii():
    # Under LC_ALL=C neither byte of U+00E9 is a word constituent, so -w
    # and \b see a boundary beside it (gzip 1.13, grep 3.11).
    ws, _ = _ws()
    data = "éab\nab\nabé\n".encode()
    _run_raw(ws, "tee /data/w.gz", stdin=gzip.compress(data))
    for cmd, out in (
        ("zgrep -w ab /data/w.gz", data),
        ("zgrep -cw ab /data/w.gz", b"3\n"),
        ("zgrep -ow ab /data/w.gz", b"ab\nab\nab\n"),
        ("zgrep -c '\\bab' /data/w.gz", b"3\n"),
    ):
        stdout, io = _run_raw(ws, cmd)
        assert (_bytes(stdout), io.exit_code) == (out, 0), cmd


def test_zgrep_reports_a_bad_archive_and_exits_2_beside_a_match():
    ws, _ = _ws()
    _run_raw(ws, "tee /data/cut.gz", stdin=gzip.compress(b"hello\n")[:10])
    _run_raw(ws, "tee /data/h.gz", stdin=gzip.compress(b"hello\n"))
    stdout, io = _run_raw(ws, "zgrep hello /data/cut.gz /data/h.gz")
    assert _bytes(stdout) == b"/data/h.gz:hello\n"
    assert (
        _bytes(io.stderr) == b"\ngzip: /data/cut.gz: unexpected end of file\n"
    )
    assert io.exit_code == 2


@pytest.mark.parametrize("data", [b"", b"hello\n"])
@pytest.mark.parametrize("mode", ["", "-l", "-L", "-c", "-o", "-q"])
@pytest.mark.parametrize(
    "pattern, diagnostic",
    [
        ("(", "Unmatched ( or \\("),
        ("[z-a]", "Invalid range end"),
        ("a{2,1}", "Invalid content of \\{\\}"),
        ("\\", "Trailing backslash"),
    ],
)
def test_zgrep_invalid_ere(data, mode, pattern, diagnostic):
    ws, _ = _ws()
    stdout, io = _run_raw(
        ws, f"zgrep -E {mode} '{pattern}'", stdin=gzip.compress(data)
    )
    assert (_bytes(stdout), _bytes(io.stderr), io.exit_code) == (
        b"",
        f"grep: {diagnostic}\n".encode(),
        2,
    )


@pytest.mark.parametrize("pattern", ["hello", "("])
@pytest.mark.parametrize(
    "mode, output",
    [
        ("", b""),
        ("-l", b""),
        ("-L", b"-\n"),
        ("-c", b""),
        ("-o", b""),
        ("-v", b""),
        ("-q -L", b"-\n"),
    ],
)
def test_zgrep_m0_skips_validation_and_selection(pattern, mode, output):
    ws, _ = _ws()
    stdout, io = _run_raw(
        ws, f"zgrep -E -m0 {mode} '{pattern}'", stdin=gzip.compress(b"hello\n")
    )
    assert (_bytes(stdout), _bytes(io.stderr), io.exit_code) == (
        output,
        b"",
        1,
    )


def _opens(line):
    """Run ``line`` in /data over a.txt, x.gz (a.txt compressed), a
    directory and a link to x.gz, as zgrep 1.13 was pinned."""
    ws, _ = _ws()
    _run_raw(ws, "printf 'hello\\nworld\\n' > /data/a.txt")
    _run_raw(
        ws,
        "tee /data/x.gz > /dev/null",
        stdin=gzip.compress(b"hello\nworld\n"),
    )
    _run_raw(ws, "mkdir /data/dir && cd /data && ln -s x.gz xl.gz")
    stdout, io = _run_raw(ws, f"cd /data && {line}")
    return _bytes(stdout).decode(), _bytes(io.stderr).decode(), io.exit_code


@pytest.mark.parametrize(
    "line,out,err,code",
    [
        # gzip retries a missing name with each suffix, a link included.
        ("zgrep hello x", "hello\n", "", 0),
        ("zgrep hello xl", "hello\n", "", 0),
        ("zgrep -l hello x", "x\n", "", 0),
        (
            "zgrep hello nope",
            "",
            "gzip: nope.gz: No such file or directory\n",
            2,
        ),
        ("zgrep hello ''", "", "gzip: .gz: No such file or directory\n", 2),
        # A failed open is empty input to grep, and the run goes on.
        (
            "zgrep hello nope x a.txt",
            "x:hello\na.txt:hello\n",
            "gzip: nope.gz: No such file or directory\n",
            2,
        ),
        (
            "zgrep -c hello nope x",
            "nope:0\nx:1\n",
            "gzip: nope.gz: No such file or directory\n",
            2,
        ),
        (
            "zgrep -L hello nope",
            "nope\n",
            "gzip: nope.gz: No such file or directory\n",
            2,
        ),
        # gzip -q keeps a directory's warning to itself.
        ("zgrep hello dir", "", "", 1),
        ("zgrep -c hello dir a.txt", "dir:0\na.txt:1\n", "", 0),
        ("zgrep -L hello dir", "dir\n", "", 1),
        ("zgrep hello a.txt/x", "", "gzip: a.txt/x: Not a directory\n", 2),
        ("zgrep hello x.gz/", "", "gzip: x.gz/: Not a directory\n", 2),
        (
            "zgrep -s hello nope",
            "",
            "gzip: nope.gz: No such file or directory\n",
            2,
        ),
    ],
)
def test_zgrep_opens_each_operand_as_gzip_cdfq_does(line, out, err, code):
    assert _opens(line) == (out, err, code)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "flags,out",
    [
        ({}, b"/bad:hello\n/good.gz:hello\n"),
        ({"c": True}, b"/bad:1\n/good.gz:1\n"),
        ({"files_without_match": True}, b""),
    ],
)
async def test_zgrep_keeps_partial_matches_and_continues_after_a_read_error(
    flags, out
):
    reads = []

    async def read(path):
        reads.append(path.virtual)
        if path.virtual == "/bad":
            raise FileNotFoundError(path.virtual)
        yield gzip.compress(b"hello\n")
        if path.virtual == "/bad.gz":
            raise PermissionError(path.virtual)

    body, io = await zgrep_generic(
        [PathSpec.from_str_path("/bad"), PathSpec.from_str_path("/good.gz")],
        ["hello"],
        flags,
        read_bytes=read,
    )
    assert await materialize(body) == out
    assert io.exit_code == 2
    assert io.stderr == b"\ngzip: /bad.gz: Permission denied\n"
    assert reads == ["/bad", "/bad.gz", "/good.gz"]
