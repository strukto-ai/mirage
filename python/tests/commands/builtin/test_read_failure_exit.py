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

# The exit code GNU answers when a command cannot read an operand,
# pinned on debian:stable-slim: coreutils 9.7, GNU sed 4.9, gzip 1.13,
# jq 1.7, binutils 2.44 (strings), util-linux 2.41.5 (column),
# bsdmainutils 12.1.8 (look), xxd 2024-12-07 from vim-common.
#
# The code belongs to the COMMAND, not to the errno: `sort dir` and
# `sort nope` are both 2, `cat` is 1 for both. Four commands are the
# exception and answer differently for the two cases, which is why this
# is keyed by a pair rather than by a single number: sed opens the
# directory and fails on the read (its own class, 4) where a missing
# file fails at open (2); the gzip family reports a directory as a
# warning (2) and a missing file as an error (1); and zgrep inverts
# that, because its exit code is grep's.
#
# Keyed by the whole command line, not the command name, because the
# line is what was pinned: `gzip -c` and `gzip` are not the same
# measurement.
#
# (directory_exit, missing_exit)
GNU_READ_EXIT = {
    "cat {p}": (1, 1),
    "wc {p}": (1, 1),
    "head {p}": (1, 1),
    "cut -c1 {p}": (1, 1),
    "nl {p}": (1, 1),
    "tac {p}": (1, 1),
    "rev {p}": (1, 1),
    "fold {p}": (1, 1),
    "fmt {p}": (1, 1),
    "expand {p}": (1, 1),
    "strings {p}": (1, 1),
    "md5sum {p}": (1, 1),
    "base64 {p}": (1, 1),
    "od {p}": (1, 1),
    "uniq {p}": (1, 1),
    "paste {p}": (1, 1),
    "tsort {p}": (1, 1),
    "shuf {p}": (1, 1),
    "split {p}": (1, 1),
    "csplit {p} 1": (1, 1),
    "column {p}": (1, 1),
    "look x {p}": (1, 1),
    "comm {p} {p}": (1, 1),
    "join {p} {p}": (1, 1),
    "iconv -f utf-8 -t utf-8 {p}": (1, 1),
    "xxd {p}": (2, 2),
    "sort {p}": (2, 2),
    "awk '{{print}}' {p}": (2, 2),
    "jq . {p}": (2, 2),
    "grep x {p}": (2, 2),
    # One file named twice is equal unread, so the second operand is
    # another file.
    "cmp {p} /ram/dir/inner.txt": (2, 2),
    "sed -n p {p}": (4, 2),
    "gzip -c {p}": (2, 1),
    "gunzip -c {p}": (2, 1),
    "zcat {p}": (2, 1),
    "zgrep x {p}": (1, 2),
}

# GNU's wording for a failed read is per-command: `base64: read error:
# Is a directory`, `sort: read failed: dir: Is a directory`, `rev:
# fgetwc() failed: Is a directory`, `fmt: read error` with no errno at
# all, `strings: Warning: 'dir' is a directory`, and `gzip: dir is a
# directory -- ignored`, which the gzip family prints as GNU does. mirage
# says the step in GNU's words only where that still names the operand
# (``FAILURE_WORDING``: head, tail and uniq
# say `error reading 'dir'`, tac and tsort `dir: read error`, sed `read
# error on dir`; sort's steps come from `sort_die`, whose `read failed:
# dir: Is a directory` still holds the house style) and keeps `<cmd>:
# <path>: Is a directory` for the rest, so the message test asserts that
# the operand and the errno are named and only the exit code above is
# GNU's for every line.
#
# One line prints nothing at all on a directory: `zgrep x` exits 1
# silently, because zgrep runs gzip with -q, which keeps the directory
# warning to itself. jq 1.7 was silent too, but jq 1.8.2, which both
# hosts follow, opens the directory, fails at its first read and says so
# without naming it. glibc's iconv does the same: a directory opens and
# the read fails as "error while reading the input".
SILENT_HERE = {"zgrep x {p}"}
BARE_HERE = {
    "jq . {p}": "jq: error: Is a directory\n",
    "iconv -f utf-8 -t utf-8 {p}": (
        "iconv: error while reading the input: Is a directory\n"
    ),
}


# `diff` is absent on purpose. GNU diff DESCENDS into a directory
# operand and compares its contents, so a directory is not a read
# failure for it at all: `diff dirA dirB` exits 1 with the differences
# on stdout, and `diff dir dir` exits 0. That is different semantics,
# not a message bug.
async def _ws() -> Workspace:
    ws = Workspace({"/ram/": RAMVFS()}, mode=MountMode.WRITE)
    ws.get_session(ws.default_session_id).cwd = "/"
    await ws.shell("mkdir -p /ram/dir")
    await ws.vfs.write("/ram/dir/inner.txt", b"inner\n")
    return ws


@pytest.mark.asyncio
@pytest.mark.parametrize("template", sorted(GNU_READ_EXIT))
async def test_directory_read_exit_matches_gnu(template):
    ws = await _ws()
    result = await ws.shell(template.format(p="/ram/dir"))
    assert result.exit_code == GNU_READ_EXIT[template][0]


@pytest.mark.asyncio
@pytest.mark.parametrize("template", sorted(GNU_READ_EXIT))
async def test_missing_read_exit_matches_gnu(template):
    ws = await _ws()
    result = await ws.shell(template.format(p="/ram/nope.txt"))
    assert result.exit_code == GNU_READ_EXIT[template][1]


@pytest.mark.asyncio
@pytest.mark.parametrize("template", sorted(SILENT_HERE))
async def test_directory_read_is_silent_like_gnu(template):
    ws = await _ws()
    result = await ws.shell(template.format(p="/ram/dir"))
    assert (result.stderr or b"") == b""


@pytest.mark.asyncio
@pytest.mark.parametrize("template", sorted(BARE_HERE))
async def test_directory_read_says_so_without_naming_it(template):
    ws = await _ws()
    result = await ws.shell(template.format(p="/ram/dir"))
    assert (result.stderr or b"").decode() == BARE_HERE[template]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "template", sorted(set(GNU_READ_EXIT) - SILENT_HERE - set(BARE_HERE))
)
async def test_directory_read_says_is_a_directory(template):
    ws = await _ws()
    result = await ws.shell(template.format(p="/ram/dir"))
    stderr = (result.stderr or b"").decode()
    assert (
        "/ram/dir: Is a directory" in stderr
        or "/ram/dir: read error: Is a directory" in stderr
        or "error reading '/ram/dir': Is a directory" in stderr
        or 'cannot open "/ram/dir" (Is a directory)' in stderr
        or "gzip: /ram/dir is a directory -- ignored" in stderr
    )
    assert "No such file" not in stderr


# GNU sed splits a failed operand two ways and only sed does: an OPEN
# error is reported and the run continues, a READ error is fatal. Every
# other command in the family continues past a directory (pinned:
# `cat ok dir ok2`, `wc`, `cut`, `nl`, `md5sum`, `od` and `paste` all
# emit the operands after the directory). sort emits nothing on any
# failure because it needs all input before it can sort.
# (command line, exit, stdout, stderr)
GNU_SED_MULTI = [
    (
        "sed -n p /ram/nope /ram/ok.txt",
        2,
        "a\nb\n",
        "sed: can't read /ram/nope: No such file or directory\n",
    ),
    (
        "sed -n p /ram/dir /ram/ok.txt",
        4,
        "",
        "sed: read error on /ram/dir: Is a directory\n",
    ),
    (
        "sed -n p /ram/ok.txt /ram/dir /ram/ok2.txt",
        4,
        "a\nb\n",
        "sed: read error on /ram/dir: Is a directory\n",
    ),
    (
        "sed -n p /ram/ok.txt /ram/nope /ram/ok2.txt",
        2,
        "a\nb\nc\nd\n",
        "sed: can't read /ram/nope: No such file or directory\n",
    ),
    (
        "sed -n p /ram/dir /ram/dir",
        4,
        "",
        "sed: read error on /ram/dir: Is a directory\n",
    ),
    (
        "sed -n p /ram/nope /ram/dir",
        4,
        "",
        "sed: can't read /ram/nope: No such file or directory\n"
        "sed: read error on /ram/dir: Is a directory\n",
    ),
    (
        "sort /ram/ok.txt /ram/dir /ram/ok2.txt",
        2,
        "",
        "sort: read failed: /ram/dir: Is a directory\n",
    ),
    (
        "cat /ram/ok.txt /ram/dir /ram/ok2.txt",
        1,
        "a\nb\nc\nd\n",
        "cat: /ram/dir: Is a directory\n",
    ),
    (
        "zcat /ram/dir /ram/nope",
        1,
        "",
        "gzip: /ram/dir is a directory -- ignored\n"
        "gzip: /ram/nope.gz: No such file or directory\n",
    ),
    # gzip's error outranks its warning in EITHER order, so the reversed
    # line is 1 too: `progerror` assigns ERROR outright while `WARN`
    # assigns only when nothing has failed yet. Two warnings and no error
    # stay 2.
    (
        "zcat /ram/nope /ram/dir",
        1,
        "",
        "gzip: /ram/nope.gz: No such file or directory\n"
        "gzip: /ram/dir is a directory -- ignored\n",
    ),
    (
        "zcat /ram/dir /ram/dir",
        2,
        "",
        "gzip: /ram/dir is a directory -- ignored\n"
        "gzip: /ram/dir is a directory -- ignored\n",
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,code,out,err", GNU_SED_MULTI, ids=[c[0] for c in GNU_SED_MULTI]
)
async def test_multi_operand_read_failures_match_gnu(line, code, out, err):
    ws = await _ws()
    await ws.shell("printf 'a\\nb\\n' > /ram/ok.txt")
    await ws.shell("printf 'c\\nd\\n' > /ram/ok2.txt")
    result = await ws.shell(line)
    assert (result.stderr or b"").decode() == err
    assert (
        await result.stdout_str() if result.stdout is not None else ""
    ) == out
    assert result.exit_code == code


@pytest.mark.asyncio
async def test_a_bad_script_is_not_a_read_failure():
    ws = await _ws()
    result = await ws.shell("sed 's/o/O/0' /ram/dir/inner.txt")
    assert result.exit_code == 1
