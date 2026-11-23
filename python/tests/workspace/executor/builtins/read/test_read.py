import asyncio
from collections.abc import AsyncIterator

import pytest

from mirage import RAMVFS, MountMode, Workspace
from mirage.io.stream import materialize
from mirage.workspace.executor.builtins.read import handle_read
from mirage.workspace.session.session import SessionState
from mirage.workspace.session.state import session_view


def make_session() -> SessionState:
    return SessionState(session_id="s1")


async def _read_ws() -> Workspace:
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("mkdir -p /data")
    return ws


@pytest.mark.asyncio
async def test_read_invalid_option_exits_2():
    _, io, _ = await handle_read(["-q", "v"], make_session(), b"line\n")
    assert io.exit_code == 2
    assert (await materialize(io.stderr)).startswith(
        b"bash: read: -q: invalid option\nread: usage: read [-ers]"
    )


@pytest.mark.asyncio
async def test_read_dash_r_consumed_not_a_variable():
    session = make_session()
    _, io, _ = await handle_read(
        ["-r", "v"], session, b"hello world\n", state=session_view(session)
    )
    assert io.exit_code == 0
    assert session.env["v"] == "hello world"
    assert "-r" not in session.env


@pytest.mark.asyncio
async def test_read_defaults_to_reply():
    session = make_session()
    _, io, _ = await handle_read(
        [], session, b"hi\n", state=session_view(session)
    )
    assert io.exit_code == 0
    assert session.env["REPLY"] == "hi"


@pytest.mark.asyncio
async def test_read_replaces_stale_stdin_buffer():
    # A previous read's exhausted herestring buffer must not shadow a
    # new command's stdin.
    ws = await _read_ws()
    await ws.shell("read -r x <<< first")
    io = await ws.shell('read -r y <<< second\necho "y=$y"')
    assert (io.stdout or b"") == b"y=second\n"


@pytest.mark.asyncio
async def test_read_scalar_replaces_array():
    ws = await _read_ws()
    await ws.shell("a=(x y z)")
    io = await ws.shell('read -r a b <<< "one two"\necho "a=$a b=$b"')
    assert (io.stdout or b"") == b"a=one b=two\n"


# What bash printed for each line (debian:stable-slim): the commands a
# group, loop, list, function or nested shell runs read one descriptor,
# so `read` takes its own and the next command reads on from there.
READ_LEAVES_THE_REST = [
    ("printf 'a\\nb\\n' | { read x; echo \"[$x]\"; cat; }", b"[a]\nb\n"),
    ("printf 'a\\nb\\n' | sh -c 'read x; echo \"[$x]\"; cat'", b"[a]\nb\n"),
    (
        "printf 'a\\nb\\nc\\n' | { ( read x; echo \"[$x]\" ); cat; }",
        b"[a]\nb\nc\n",
    ),
    (
        "printf 'a\\nb\\nc\\n' | { read x; read y; echo \"$x $y\"; cat; }",
        b"a b\nc\n",
    ),
    ("printf 'a\\nb\\n' | { read -n1 x; echo \"[$x]\"; cat; }", b"[a]\n\nb\n"),
    (
        "printf 'abc\\ndef\\n' | { read -N2 x; echo \"[$x]\"; cat; }",
        b"[ab]\nc\ndef\n",
    ),
    (
        "printf 'a:b\\nc\\n' | { read -d: x; echo \"[$x]\"; cat; }",
        b"[a]\nb\nc\n",
    ),
    ("printf 'a\\nb\\n' | { cat; read x; echo \"[$x]\"; }", b"a\nb\n[]\n"),
    (
        "printf 'a\\nb\\nc\\n' | while read x; do echo \"[$x]\"; cat; done",
        b"[a]\nb\nc\n",
    ),
    (
        "printf 'a\\nb\\nc\\n' | { read x; for i in 1 2; do read y; "
        'echo "[$y]"; done; }',
        b"[b]\n[c]\n",
    ),
    (
        "f() { read x; echo \"[$x]\"; }; printf 'a\\nb\\nc\\n' | { f; f; cat; }",
        b"[a]\n[b]\nc\n",
    ),
    (
        "printf 'a\\nb\\nc\\n' | { eval 'read x'; echo \"[$x]\"; cat; }",
        b"[a]\nb\nc\n",
    ),
    (
        "printf 'read y; echo \"[$y]\"\\n' > /data/s.sh; "
        "printf 'a\\nb\\n' | { source /data/s.sh; cat; }",
        b"[a]\nb\n",
    ),
    ("printf 'a\\nb\\nc\\n' | { read x && cat; }", b"b\nc\n"),
    (
        "printf 'a\\nb\\n' | case x in x) read a; read b; echo \"$a$b\";; esac",
        b"ab\n",
    ),
    (
        "printf 'a\\nb\\nc\\n' | { read x; mapfile -t r; "
        'echo "[$x] ${#r[@]}"; }',
        b"[a] 2\n",
    ),
    (
        "printf '1\\n2\\n' | { select v in p q; do echo \"[$v]\"; break; done; "
        "cat; }",
        b"[p]\n2\n",
    ),
    ("printf 'a\\nb\\nc\\n' | { read x; xargs echo; }", b"b c\n"),
    (
        "printf 'a\\nb\\n' > /data/f; { read x; echo \"[$x]\"; cat; } < /data/f",
        b"[a]\nb\n",
    ),
    ("{ read x; echo \"[$x]\"; cat; } <<< $'a\\nb'", b"[a]\nb\n"),
    (
        "printf 'a\\nb\\nc\\n' > /data/f; exec < /data/f; read x; read y; "
        'echo "[$x][$y]"',
        b"[a][b]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; exec < /data/f; read x; exec < /data/f; "
        'read y; echo "[$x][$y]"',
        b"[a][a]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; (exec < /data/f; read x; exec < /data/f; "
        'read y; echo "[$x][$y]")',
        b"[a][a]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; exec < /data/f; read x; "
        '(exec < /data/f; read y; echo "[$x][$y]")',
        b"[a][a]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; exec < /data/f; read x; "
        '(read y; echo "[$x][$y]")',
        b"[a][b]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; printf 'z\\n' | "
        '(read a; exec < /data/f; read b; echo "[$a][$b]")',
        b"[z][a]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; printf 'z\\n' | "
        "eval 'exec < /data/f; read a; echo \"[$a]\"'",
        b"[a]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; { exec < /data/f; read a; echo \"[$a]\"; }",
        b"[a]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; { exec < /data/f; read a; }; read b; "
        'echo "[$a][$b]"',
        b"[a][b]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; g() { exec < /data/f; read a; "
        "echo \"[$a]\"; }; printf 'z\\n' | g",
        b"[a]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; g() { exec < /data/f; }; g; read a; "
        'echo "[$a]"',
        b"[a]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; exec < /data/f; read a; "
        '{ exec < /data/f; read b; }; echo "[$a][$b]"',
        b"[a][a]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; printf 'z\\n' | "
        '{ read a; exec < /data/f; read b; echo "[$a][$b]"; }',
        b"[z][a]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; exec < /data/f && read a && echo \"[$a]\"",
        b"[a]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; if true; then exec < /data/f; read a; fi; "
        'read b; echo "[$a][$b]"',
        b"[a][b]\n",
    ),
    (
        "printf 'a\\nb\\n' > /data/f; case x in x) exec < /data/f; read a;; "
        'esac; read b; echo "[$a][$b]"',
        b"[a][b]\n",
    ),
    ("read x <<< ''; read y <<< ''; echo \"$? [$y]\"", b"0 []\n"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("line, expected", READ_LEAVES_THE_REST)
async def test_read_leaves_the_rest_for_the_next_command(
    line: str, expected: bytes
):
    ws = await _read_ws()
    io = await ws.shell(line)
    assert await materialize(io.stdout) == expected
    assert io.exit_code == 0


# fd 0 is the shell's, not the line's: a script's next line reads on
# from where `exec <` left it.
@pytest.mark.asyncio
async def test_read_after_exec_reads_on_across_lines():
    ws = await _read_ws()
    await ws.shell("printf 'a\\nb\\n' > /data/f; exec < /data/f; read a")
    io = await ws.shell('read b; echo "[$a][$b]"')
    assert await materialize(io.stdout) == b"[a][b]\n"


async def _stalls() -> AsyncIterator[bytes]:
    yield b"partial"
    await asyncio.Event().wait()


# bash's read stops at once for a signal the shell dies of, to run its EXIT
# action; a signal it traps lets it read on.
@pytest.mark.asyncio
async def test_read_stops_for_a_signal_the_shell_dies_of():
    session = make_session()
    session.exit_trap = "echo bye"
    session.signal_traps = {10: "echo usr1"}
    reading = asyncio.ensure_future(
        handle_read(["v"], session, _stalls(), state=session_view(session))
    )
    await asyncio.sleep(0.01)
    assert session.catch_signal(10, 1)
    await asyncio.sleep(0.01)
    assert not reading.done()
    assert session.takes_fatal_signal(15, 1)
    async with asyncio.timeout(5):
        _, io, _ = await reading
    assert io.exit_code == 143
    assert "v" not in session.env
