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
"""exec: the redirect-only form, and the refused process-replacement one.

``exec > file`` sends the shell's own output to a file for the rest of
the shell (and across later lines of the same session); ``exec cmd`` has
no OS-process referent and is refused loudly. Output is read back from a
second session, since the first has its own output diverted.
"""
import pytest

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _ws() -> Workspace:
    ws = Workspace({"data": RAMResource()}, mode=MountMode.WRITE)
    ws._session_mgr.create("reader")
    return ws


async def _file(ws: Workspace, path: str) -> str:
    io = await ws.execute(f"cat {path}", session_id="reader")
    return await io.stdout_str()


@pytest.mark.asyncio
async def test_stdout_redirect_and_persistence():
    ws = _ws()
    await ws.execute("exec > /data/f; echo a; echo b")
    assert await _file(ws, "/data/f") == "a\nb\n"
    # Persists to a later line of the same (default) session.
    await ws.execute("echo c")
    assert await _file(ws, "/data/f") == "a\nb\nc\n"
    await ws.close()


@pytest.mark.asyncio
async def test_append_keeps_existing():
    ws = _ws()
    await ws.execute("echo old > /data/f; exec >> /data/f; echo new")
    assert await _file(ws, "/data/f") == "old\nnew\n"
    await ws.close()


@pytest.mark.asyncio
async def test_stderr_redirect():
    ws = _ws()
    await ws.execute("exec 2> /data/e; echo out; echo err >&2")
    assert await _file(ws, "/data/e") == "err\n"
    await ws.close()


@pytest.mark.asyncio
async def test_stdin_redirect_feeds_read():
    ws = _ws()
    io = await ws.execute(
        "printf 'l1\\nl2\\n' > /data/in; exec < /data/in; read a; read b; "
        "echo $a-$b",
        session_id="reader")
    assert (await io.stdout_str()) == "l1-l2\n"
    await ws.close()


@pytest.mark.asyncio
async def test_stdin_dup_onto_itself_keeps_the_bound_file():
    # bash: `0<&0` and `0>&0` are a descriptor dup onto itself, so the
    # file an earlier `exec <f` bound stays; `<&-` still closes it.
    ws = _ws()
    io = await ws.execute(
        "printf 'l1\\nl2\\n' > /data/in; exec < /data/in; exec 0<&0; "
        "read a; exec 0>&0; read b; echo $a-$b; exec <&-; read c; echo rc=$?",
        session_id="reader")
    assert (await io.stdout_str()) == "l1-l2\nrc=1\n"
    await ws.close()


@pytest.mark.asyncio
async def test_bare_exec_is_a_noop():
    ws = _ws()
    io = await ws.execute("exec; echo ok", session_id="reader")
    assert (await io.stdout_str()) == "ok\n"
    assert io.exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_exec_command_is_refused():
    ws = _ws()
    io = await ws.execute("exec echo hi; echo after", session_id="reader")
    assert io.exit_code == 0
    assert (await io.stdout_str()) == "after\n"
    assert b"process replacement is not supported" in (io.stderr or b"")
    await ws.close()


@pytest.mark.asyncio
async def test_missing_target_leaves_redirect_unchanged():
    ws = _ws()
    io = await ws.execute("exec > /nodir/f; echo after", session_id="reader")
    assert (await io.stdout_str()) == "after\n"
    await ws.close()


@pytest.mark.asyncio
async def test_append_creates_the_target_with_no_output():
    """bash opens an `exec >>` target as it processes the exec, so the
    file is there before any statement runs."""
    ws = _ws()
    io = await ws.execute("( exec >> /data/new; ); test -e /data/new",
                          session_id="reader")
    assert io.exit_code == 0
    await ws.close()


@pytest.mark.asyncio
async def test_append_open_keeps_existing_bytes():
    ws = _ws()
    io = await ws.execute(
        "echo old > /data/keep; ( exec >> /data/keep; ); cat /data/keep",
        session_id="reader")
    assert (await io.stdout_str()) == "old\n"
    await ws.close()


@pytest.mark.asyncio
async def test_opened_targets_take_the_umask_mode():
    """The same rule a plain `>` redirect follows, since both open a
    file: 0666 masked by the session umask."""
    ws = _ws()
    io = await ws.execute(
        "umask 077; ( exec > /data/m; echo z ); ( exec >> /data/a; ); "
        "stat -c '%a %n' /data/m /data/a",
        session_id="reader")
    assert (await io.stdout_str()) == "600 /data/m\n600 /data/a\n"
    await ws.close()


@pytest.mark.asyncio
async def test_standard_descriptors_open_in_the_other_direction():
    # bash accepts `exec 0>f` (fd 0 write-only: a read is EBADF) and
    # `exec 1<f` / `exec 2<f` (the stream read-only: a write fails),
    # pinned on 5.2; the file itself stays what the redirect made it.
    ws = _ws()
    try:
        await ws.execute(
            "echo original > /data/input; echo readable > /data/source")
        io = await ws.execute("( exec 0>/data/input; echo rc=$?; cat; "
                              "echo rc=$?; read v; echo rc=$? )")
        assert await io.stdout_str() == "rc=0\nrc=1\nrc=1\n"
        assert "cat: -: Bad file descriptor" in (await io.stderr_str())
        assert await _file(ws, "/data/input") == ""
        io = await ws.execute("( exec 1</data/source; echo hi; "
                              "echo rc=$? >&2 )")
        assert await io.stdout_str() == ""
        assert await io.stderr_str() == (
            "echo: write error: Bad file descriptor\nrc=1\n")
        io = await ws.execute("( exec 2</data/source; echo hi >&2; "
                              "echo rc=$? )")
        assert await io.stdout_str() == "rc=1\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_explicit_stdin_file_redirect_persists():
    ws = _ws()
    try:
        await ws.execute("echo readable > /data/input; exec 0</data/input")
        io = await ws.execute("read value; echo $value")
        assert await io.stdout_str() == "readable\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_failed_later_redirect_puts_every_earlier_one_back():
    # bash 5.2 keeps the file each earlier redirect opened but restores
    # the descriptors, and writes the diagnostic through the descriptors
    # as they stood at the failure.
    ws = _ws()
    missing = "/data/missing: No such file or directory\n"
    try:
        io = await ws.execute("exec > /data/good < /data/missing; echo visible"
                              )
        assert (await io.stdout_str(), await
                io.stderr_str(), io.exit_code) == ("visible\n", missing, 0)
        assert await _file(ws, "/data/good") == ""
        io = await ws.execute("exec 2> /data/e < /data/missing; echo toerr >&2"
                              )
        assert (await io.stdout_str(), await
                io.stderr_str()) == ("", "toerr\n")
        assert await _file(ws, "/data/e") == missing
        io = await ws.execute(
            "exec > /data/g2; exec >> /data/g3 < /data/missing; echo where")
        assert (await io.stdout_str(), await io.stderr_str()) == ("", missing)
        assert await _file(ws, "/data/g2") == "where\n"
        assert await _file(ws, "/data/g3") == ""
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_dups_copy_the_terminal_stream_they_name():
    # bash 5.2: `exec 2>&1` puts stderr on the terminal's stdout, `exec
    # 1>&2` the reverse, and a dup copies the target as it stood, so
    # `1>&2` then `2>&1` leaves both on stderr.
    ws = _ws()
    try:
        io = await ws.execute("( exec 2>&1; echo err >&2 ); echo after >&2")
        assert (await io.stdout_str(), await
                io.stderr_str()) == ("err\n", "after\n")
        io = await ws.execute("( exec 1>&2; echo a ); echo b")
        assert (await io.stdout_str(), await io.stderr_str()) == ("b\n", "a\n")
        io = await ws.execute("( exec 1>&2; exec 2>&1; echo a; echo b >&2 )")
        assert (await io.stdout_str(), await io.stderr_str()) == ("", "a\nb\n")
        io = await ws.execute(
            "( exec 2>&1 < /data/missing; echo out; echo err >&2 )")
        assert (await io.stdout_str(), await
                io.stderr_str(), io.exit_code) == (
                    "/data/missing: No such file or directory\nout\n", "err\n",
                    0)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_stream_bound_to_stdin_cannot_be_written():
    # bash 5.2: after `exec 1>&0` every write to stdout is `write error:
    # Bad file descriptor`, status 1; with stderr bound there the
    # message itself has nowhere to go.
    ws = _ws()
    try:
        io = await ws.execute(
            "( exec 1>&0; echo hi; echo rc=$? >&2; echo again ); echo back")
        assert (await io.stdout_str(), await io.stderr_str()) == (
            "back\n", "echo: write error: Bad file descriptor\nrc=1\n"
            "echo: write error: Bad file descriptor\n")
        io = await ws.execute("( exec 2>&0; echo hi >&2; echo rc=$? )")
        assert (await io.stdout_str(), await io.stderr_str()) == ("rc=1\n", "")
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,stdout,stderr,code",
    [
        ('printf x >/data/f; exec 1</data/f; exec 0<&1; cat >&2', '', 'x', 0),
        # A stream aliased onto stdin's read end reads what stdin reads, and
        # keeps the file a `exec <f` bound even after `exec 0<&-`.
        ('printf x >/data/f; exec </data/f; exec 1<&0; cat <&1 >&2; '
         'echo rc=$? >&2', '', 'xrc=0\n', 0),
        ('printf x >/data/f; exec </data/f; exec 1<&0; exec 0<&-;'
         'cat <&1 >&2; '
         'echo rc=$? >&2', '', 'xrc=0\n', 0),
        ('printf x >/data/f; exec </data/f; exec 2<&0; cat <&2 >&2', '', '',
         1),
        ('printf x | { exec 1<&0; cat <&1 >&2; }; echo rc=$? >&2', '',
         'xrc=0\n', 0),
        ('printf xy >/data/f; exec 1</data/f; exec 0<&1; exec 1>&-; cat >&2',
         '', 'xy', 0),
        ('printf x >/data/f; exec 1</data/f; exec 0<&1; exec 1>&2; cat', '',
         'x', 0),
        ('printf x >/data/f; exec 2</data/f; exec 0<&2; cat >&2', '', '', 1),
        ('printf x >/data/f; exec 1</data/f; cat <&1 >&2; echo rc=$? >&2', '',
         'xrc=0\n', 0),
        ('exec 0>/data/f; echo x >&0; echo y >&0; cat /data/f', 'x\ny\n', '',
         0),
        ('exec 0>/data/f; { echo a; echo b; } >&0; cat /data/f', 'a\nb\n', '',
         0),
        ('exec 0>/data/f; echo x >&0; exec 0<&-; cat /data/f', 'x\n', '', 0),
        ('exec 0>/data/f; echo x >&0; exec 1>&0; echo y; exec 1>&2; '
         'cat /data/f >&2', '', 'x\ny\n', 0),
        ('exec 0>/data/f; echo x 1>&0 2>&0; cat /data/f', 'x\n', '', 0),
        ('exec 0<&1; echo x >&0', 'x\n', '', 0),
        ('echo x >&0; echo rc=$?', 'rc=1\n',
         'echo: write error: Bad file descriptor\n', 0),
    ])
async def test_descriptor_identities_survive_dups(command, stdout, stderr,
                                                  code):
    # bash 5.2 on debian:stable-slim with stdin from /dev/null: a stream
    # opened for reading keeps the file through a dup (`exec 1<f; exec
    # 0<&1`) and answers a transient `<&1`; fd 0 opened for writing takes
    # a transient `>&0`, appending as bash's shared offset does.
    ws = _ws()
    try:
        io = await ws.execute(command)
        assert await io.stdout_str() == stdout
        assert await io.stderr_str() == stderr
        assert io.exit_code == code
    finally:
        await ws.close()
