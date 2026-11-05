import pytest

from mirage.io.stream import materialize
from mirage.shell.array import ShellArray
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.session.budget import args_bytes, entry_bytes
from mirage.workspace.session.constants import MAX_ENV


def test_entries_count_their_utf8_bytes():
    assert entry_bytes("a", "é") == 3
    assert args_bytes(["ab", "c"]) == 5
    assert args_bytes([""]) == 1
    assert entry_bytes("a", ShellArray({0: "xy", 2: "z"})) == 6
    assert entry_bytes("m", {"k": "vv"}) == 5


async def run(
    line: str, max_env: int | str | None = 200
) -> tuple[str, str, int]:
    ws = Workspace({"/": RAMVFS()}, mode=MountMode.WRITE, max_env=max_env)
    try:
        io = await ws.shell(line)
        err = (await materialize(io.stderr)).decode()
        return await io.stdout_str(), err, io.exit_code
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_doubling_variable_stops_the_line_at_max_env():
    out, err, code = await run("x=a; while :; do x=$x$x; done; echo after")
    assert (out, code) == ("", 2)
    assert err == (
        "bash: xmalloc: cannot allocate 257 bytes (past max_env of 200"
        " bytes, a mirage workspace setting)\n"
    )


@pytest.mark.asyncio
async def test_functions_aliases_and_parameters_count_too():
    body = "x" * 300
    for line in (
        f"f() {{ echo {body}; }}",
        f"alias a='{body}'",
        f"set -- {body}",
    ):
        _, err, code = await run(f"{line}; echo after")
        assert code == 2 and "past max_env of 200 bytes" in err


@pytest.mark.asyncio
async def test_a_subshell_dies_alone_and_the_variable_keeps_its_value():
    out, _, code = await run(
        "x=ab; (x=$(printf %0300d 0); echo no); echo sub=$? ${#x}"
    )
    assert (out, code) == ("sub=2 2\n", 0)


@pytest.mark.asyncio
async def test_a_lifted_max_env_lets_the_state_grow():
    out, _, code = await run(
        "x=a; for i in 1 2 3 4 5 6 7 8 9 10; do x=$x$x; done; echo ${#x}",
        None,
    )
    assert (out, code) == ("1024\n", 0)
    assert MAX_ENV == 1 << 21


@pytest.mark.asyncio
async def test_fresh_names_count_with_no_value():
    names = [f"n{i}" for i in range(100)]
    for line in (
        "alias " + " ".join(f"{name}=" for name in names) + ";",
        "export " + " ".join(names) + ";",
    ):
        _, err, code = await run(f"{line} echo after")
        assert code == 2 and "past max_env of 200 bytes" in err, line


@pytest.mark.asyncio
async def test_arguments_a_call_or_source_passes_count():
    for line in (
        'FUNCNEST=30; f() { f "$@" "$@"; }; f aaaaaaaa',
        'FUNCNEST=30; f() { f "$@" "$@"; }; f \'\'',
        'echo \'source /s "$@" "$@"\' > /s; source /s aaaaaaaa',
        "set -- aaaaaaaa; echo 'source /s' > /s; source /s",
    ):
        _, err, code = await run(line)
        assert code == 2 and "past max_env of 200 bytes" in err, line


@pytest.mark.asyncio
async def test_a_function_s_own_parameters_count():
    out, _, code = await run(
        "(f() { set -- a; while :; do set -- $1$1; done; }; f); echo rc=$?"
    )
    assert (out, code) == ("rc=2\n", 0)


@pytest.mark.asyncio
async def test_a_session_cannot_start_past_max_env():
    with pytest.raises(ValueError, match="past max_env of 200 bytes"):
        Workspace({"/": RAMVFS()}, env={"X": "x" * 300}, max_env=200)
    ws = Workspace(
        {"/": RAMVFS()},
        max_env=200,
        profiles={"big": {"env": {"X": "x" * 300}}},
    )
    try:
        with pytest.raises(ValueError, match="past max_env of 200 bytes"):
            ws.create_session("agent", profile="big")
        assert "agent" not in [s.session_id for s in ws.list_sessions()]
    finally:
        await ws.close()
