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

from mirage import MountMode, RAMResource, Workspace


async def _ws() -> Workspace:
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("mkdir -p /data; printf a > /data/a.txt")
    return ws


@pytest.mark.asyncio
@pytest.mark.parametrize("line", [
    "echo x 3>/data/f",
    "echo x >&3",
    "echo x 2>&3",
    "cat <&3",
    "exec 3>/data/g",
    "exec 3>&-",
])
async def test_descriptor_above_two_is_refused_and_touches_nothing(line):
    ws = await _ws()
    io = await ws.execute(f"{line}; echo code=$?")
    assert await io.stderr_str() == "3: Bad file descriptor\n"
    assert await io.stdout_str() == "code=1\n"
    listing = await ws.execute("ls /data")
    assert await listing.stdout_str() == "a.txt\n"


@pytest.mark.asyncio
async def test_bad_descriptor_short_circuits_like_a_shell_error():
    ws = await _ws()
    io = await ws.execute("echo x >&3 && echo and || echo or")
    assert await io.stdout_str() == "or\n"


@pytest.mark.asyncio
async def test_exec_redirect_refusal_leaves_the_shell_streams_alone():
    ws = await _ws()
    ws.create_session("s")
    await ws.execute("exec 3>&-", session_id="s")
    io = await ws.execute("echo still", session_id="s")
    assert await io.stdout_str() == "still\n"


@pytest.mark.asyncio
async def test_closed_stdout_drops_output_and_reports_the_write():
    ws = await _ws()
    io = await ws.execute("echo x >&-; echo code=$?")
    assert await io.stdout_str() == "code=1\n"
    assert await io.stderr_str() == "echo: write error: Bad file descriptor\n"


@pytest.mark.asyncio
async def test_closed_stderr_and_stdin_are_quiet():
    ws = await _ws()
    io = await ws.execute("echo x 2>&-; echo code=$?")
    assert await io.stdout_str() == "x\ncode=0\n"
    io = await ws.execute("cat /data/a.txt <&-; echo code=$?")
    assert await io.stdout_str() == "acode=0\n"


@pytest.mark.asyncio
async def test_a_numeric_target_is_routed_by_the_claimed_descriptor():
    ws = await _ws()
    io = await ws.execute("cat /data/missing 2<&-; echo code=$?")
    assert await io.stdout_str() == "code=1\n"
    assert await io.stderr_str() == ""
    io = await ws.execute("echo x 1<&-; echo code=$?")
    assert await io.stdout_str() == "code=1\n"
    assert await io.stderr_str() == "echo: write error: Bad file descriptor\n"
    io = await ws.execute("cat /data/missing 2<&1; echo code=$?")
    assert await io.stdout_str() == (
        "cat: /data/missing: No such file or directory\ncode=1\n")
    assert await io.stderr_str() == ""


@pytest.mark.asyncio
async def test_a_bare_zero_before_the_operator_is_the_descriptor():
    ws = await _ws()
    io = await ws.execute("echo x 0>&-; echo code=$?")
    assert await io.stdout_str() == "x\ncode=0\n"
    io = await ws.execute("cat 0</data/a.txt; echo code=$?")
    assert await io.stdout_str() == "acode=0\n"
    io = await ws.execute("echo 0 >&-; echo code=$?")
    assert await io.stdout_str() == "code=1\n"
    assert await io.stderr_str() == "echo: write error: Bad file descriptor\n"


@pytest.mark.asyncio
async def test_exec_closes_by_the_claimed_descriptor():
    ws = await _ws()
    io = await ws.execute("exec 2<&-; cat /data/missing; echo code=$?")
    assert await io.stdout_str() == "code=1\n"
    assert await io.stderr_str() == ""
    io = await ws.execute("exec 0>&-; echo x; echo code=$?")
    assert await io.stdout_str() == "x\ncode=0\n"


@pytest.mark.asyncio
async def test_self_dups_change_nothing():
    ws = await _ws()
    io = await ws.execute("echo x 1>&1; echo y 2>&2; cat <&0 </data/a.txt")
    assert await io.stdout_str() == "x\ny\na"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,out,err,code",
    [
        ('echo x 1>&0', '', 'echo: write error: Bad file descriptor\n', 1),
        # A self-dup never reopens a closed descriptor, transient or
        # persistent; a file redirect on it does.
        ('touch /data/marker 1>&- 1>&1 2>&1; echo rc=$? >&2; '
         'test -e /data/marker; echo e=$? >&2', '',
         '1: Bad file descriptor\nrc=1\ne=1\n', 0),
        ('exec 1>&-; touch /data/marker 1>&1 2>&1; echo rc=$? >&2; '
         'test -e /data/marker; echo e=$? >&2', '',
         '1: Bad file descriptor\nrc=1\ne=1\n', 0),
        ('touch /data/marker 1>&- 1>&1 >/data/f 2>&1; echo rc=$? >&2; '
         'test -e /data/marker; echo e=$? >&2', '', 'rc=0\ne=0\n', 0),
        ('echo x 2>&0 1>&2', '', '', 1),
        ('echo x 0>&1 1>&0', 'x\n', '', 0),
        ('echo x 1>&0 0>&1', '', 'echo: write error: Bad file descriptor\n',
         1),
        ('echo x 1>&0 2>&1', '', '', 1),
        # A dup from a descriptor closed earlier on the line refuses the
        # line, and the command never runs; a self-dup stays a no-op.
        ('touch /data/marker 0<&- 1<&0; test -e /data/marker', '',
         '0: Bad file descriptor\n', 1),
        ('echo hi 1>&- 2>&1', '', '1: Bad file descriptor\n', 1),
        ('cat 0<&- 0<&0 </data/a.txt', 'a', '', 0),
        # `>&word` on a descriptor other than 1 is bash's ambiguous
        # redirect, refused before the command runs; bare and on 1 it is
        # the both-streams file.
        ('touch /data/marker 3>&/data/foo; '
         'test -e /data/marker || test -e /data/foo', '',
         '/data/foo: ambiguous redirect\n', 1),
        ('echo x 2>&/data/foo; test -e /data/foo', '',
         '/data/foo: ambiguous redirect\n', 1),
        ('( echo out; echo err >&2 ) 1>&/data/both; cat /data/both',
         'out\nerr\n', '', 0),
        # An output redirect leaves its descriptor write-only.
        ('cat 1>/data/out 0<&1; wc -c < /data/out', '0\n',
         'cat: -: Bad file descriptor\n', 0),
        ('echo x 1>&0 2>/data/err; cat /data/err',
         'echo: write error: Bad file descriptor\n', '', 0),
        ('echo x 0>/data/out 1>&0; cat /data/out', 'x\n', '', 0),
        ('cat </data/a.txt 1<&0 0<&1 1>/data/out; cat /data/out', 'a', '', 0),
        # bash 5.2: stdout is open for writing only, so the read fails.
        ('cat </data/a.txt 0<&1', '', 'cat: -: Bad file descriptor\n', 1),
        # A descriptor `exec` closed for the shell refuses a dup from it
        # too; a redirect that opens it or a rebinding takes it back.
        ('exec 1>&-; touch /data/marker 2>&1; echo rc=$? >&2; '
         'test -e /data/marker; echo e=$? >&2', '',
         '1: Bad file descriptor\nrc=1\ne=1\n', 0),
        ('exec 0<&-; touch /data/marker 1<&0; echo rc=$? >&2; '
         'test -e /data/marker; echo e=$? >&2', '',
         '0: Bad file descriptor\nrc=1\ne=1\n', 0),
        ('exec 1>&-; true 1>&1; echo rc=$? >&2', '', 'rc=0\n', 0),
        ('exec 1>&-; touch /data/marker >/data/f 2>&1; echo rc=$? >&2; '
         'test -e /data/marker; echo e=$? >&2', '', 'rc=0\ne=0\n', 0),
        ('exec 1>&-; exec 1>&2; touch /data/marker 2>&1; echo rc=$?; '
         'test -e /data/marker; echo e=$?', '', 'rc=0\ne=0\n', 0),
        ('exec 2>&-; touch /data/marker 1>&2; test -e /data/marker; '
         'echo e=$?', 'e=1\n', '', 0),
    ])
async def test_descriptor_zero_duplication_tracks_direction_and_order(
        line, out, err, code):
    ws = await _ws()
    try:
        io = await ws.execute(line)
        assert (await io.stdout_str(), await
                io.stderr_str(), io.exit_code) == (out, err, code)
    finally:
        await ws.close()
