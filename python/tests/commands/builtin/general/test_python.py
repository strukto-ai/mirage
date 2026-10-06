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

import sys

import pytest
import pytest_asyncio

from mirage import RAMVFS, MountMode, Workspace
from mirage.io.types import materialize
from mirage.runtime.python import LocalRuntime


@pytest_asyncio.fixture
async def ws():
    workspace = Workspace({"/": RAMVFS()}, mode=MountMode.EXEC)
    yield workspace
    await workspace.close()


@pytest_asyncio.fixture
async def ws_cpython():
    workspace = Workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, runtimes=[LocalRuntime()]
    )
    yield workspace
    await workspace.close()


GUARDED = {
    "commands": {
        "deny": [
            {"reason": "protected", "commands": {"python3": ["/secret.py"]}}
        ]
    }
}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, shown",
    [("python3 ./secret.py", "./secret.py")],
)
async def test_a_rule_on_the_script_reads_it_however_it_is_typed(line, shown):
    ws = Workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, profiles={"guarded": GUARDED}
    )
    try:
        await ws.shell("printf 'print(1)\\n' > /secret.py")
        agent = await ws.session("agent", profile="guarded")
        io = await agent.shell(line)
        assert io.exit_code == 1
        assert await io.stdout_str() == ""
        assert (
            await io.stderr_str() == f"python3: {shown}: Permission denied\n"
        )
        assert io.refusal is not None and io.refusal.reason == "protected"
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    ["python3 -c 'print(argv[1:])' secret.py"],
)
async def test_the_words_after_the_script_stay_its_argv(line):
    ws = Workspace(
        {"/": RAMVFS()}, mode=MountMode.EXEC, profiles={"guarded": GUARDED}
    )
    try:
        await ws.shell("printf 'print(argv[1:])\\n' > /s.py")
        agent = await ws.session("agent", profile="guarded")
        io = await agent.shell(line)
        assert io.exit_code == 0
        assert await io.stdout_str() == "['secret.py']\n"
    finally:
        await ws.close()


@pytest_asyncio.fixture
async def two_mounts():
    workspace = Workspace(
        {"/w": RAMVFS(), "/t": RAMVFS()}, mode=MountMode.EXEC
    )
    await workspace.shell("mkdir -p /w")
    await workspace.shell("printf 'print(argv[1:])\\n' > /w/s.py")
    await workspace.shell("echo q > /t/q.txt")
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, argv",
    [
        (
            "cd /t && python3 /w/s.py --input /t/q.txt --out=/t/o.csv",
            "['--input', '/t/q.txt', '--out=/t/o.csv']",
        ),
    ],
)
async def test_a_path_shaped_word_is_the_programs_argv_as_typed(
    two_mounts, line, argv
):
    # bash hands the words over as typed, globs expanded, and the
    # program opens what it likes: a word naming another mount is no
    # second mount for the line.
    io = await two_mounts.shell(line)
    assert await io.stderr_str() == ""
    assert io.exit_code == 0
    assert await io.stdout_str() == argv + "\n"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, file",
    [("cd /w && python3 s.py", "/w/s.py")],
)
async def test_the_file_door_binds_file_on_a_cpython_runtime(
    ws_cpython, line, file
):
    # CPython 3.13.5: the operand made absolute as typed, never
    # normalized, and <stdin> for a program piped in.
    await ws_cpython.shell("mkdir /w && printf 'print(__file__)\\n' > /w/s.py")
    io = await ws_cpython.shell(line)
    assert io.exit_code == 0
    assert await io.stdout_str() == file + "\n"


@pytest.mark.asyncio
async def test_a_payload_binds_no_file_on_a_cpython_runtime(ws_cpython):
    io = await ws_cpython.shell("python3 -c 'print(__file__)'")
    assert io.exit_code == 1
    assert "NameError: name '__file__' is not defined" in (
        await io.stderr_str()
    )


@pytest.mark.asyncio
async def test_dash_u_before_a_script_is_a_flag_not_the_script(ws):
    await ws.shell("printf 'print(42)\\n' > /s.py")
    io = await ws.shell("python3 -u /s.py")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"42\n"


@pytest.mark.asyncio
async def test_unknown_short_option_exits_2_naming_the_letter(ws):
    io = await ws.shell("python3 -zz -c 'print(1)'")
    assert io.exit_code == 2
    assert b"Unknown option: -z" in (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_unknown_long_option_uses_cpythons_lowercase_shape(ws):
    io = await ws.shell("python3 --nope")
    assert io.exit_code == 2
    assert b"Unknown option: --nope" in (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_payload_option_without_its_argument_exits_2(ws):
    io = await ws.shell("python3 -c")
    assert io.exit_code == 2
    err = await materialize(io.stderr)
    assert b"Argument expected for the -c option" in err
    assert b"usage: python3 [option] ..." in err


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "name, flag", [("python", "--version"), ("python3", "-VV")]
)
async def test_version_reports_the_monty_guest(ws, name, flag):
    io = await ws.shell(f"{name} {flag}")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"Python 3.14.0 (monty)\n"
    assert await materialize(io.stderr) == b""


@pytest.mark.asyncio
async def test_version_reports_the_local_interpreter(ws_cpython):
    io = await ws_cpython.shell("python3 --version")
    assert io.exit_code == 0
    assert (
        await materialize(io.stdout)
        == f"Python {sys.version.split()[0]}\n".encode()
    )


@pytest.mark.asyncio
async def test_program_version_operand_is_not_intercepted(ws):
    await ws.shell("echo 'print(argv[-1])' > /version.py")
    io = await ws.shell("python3 /version.py --version")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"--version\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["node"])
async def test_version_without_a_runtime_uses_the_invoked_name(name):
    ws = Workspace({"/": RAMVFS()}, runtimes=[])
    try:
        io = await ws.shell(f"{name} --version")
        assert io.exit_code == 127
        assert await materialize(io.stdout) == b""
        assert (
            await materialize(io.stderr)
            == f"{name}: command not found\n".encode()
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["python", "node"])
async def test_missing_script_uses_the_invoked_name(ws, name):
    io = await ws.shell(f"{name} /missing-script")
    assert io.exit_code == 1
    assert await io.stderr_str() == f"{name}: /missing-script: No such file\n"


@pytest.mark.asyncio
async def test_dash_h_aliases_the_help_tier(ws):
    io = await ws.shell("python3 -h")
    assert io.exit_code == 0
    assert b"Usage: python3" in (await materialize(io.stdout))


@pytest.mark.asyncio
async def test_words_after_the_script_reach_the_script_verbatim(ws):
    await ws.shell("printf 'print(argv[1])\\n' > /s.py")
    io = await ws.shell("python3 /s.py --not-my-flag")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"--not-my-flag\n"


@pytest.mark.asyncio
async def test_argv0_is_the_script_path_as_typed(ws):
    await ws.shell("printf 'print(argv[0])\\n' > /s.py")
    io = await ws.shell("python3 /s.py")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"/s.py\n"


@pytest.mark.asyncio
async def test_dash_operand_reads_the_program_from_stdin(ws):
    io = await ws.shell("echo 'print(7)' | python3 -")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"7\n"


@pytest.mark.asyncio
async def test_dash_m_runs_a_module_on_a_cpython_runtime(ws_cpython):
    io = await ws_cpython.shell("python3 -m json.tool --help")
    assert io.exit_code == 0
    assert b"json.tool" in (await materialize(io.stdout))


@pytest.mark.asyncio
async def test_dash_m_missing_module_is_one_line_not_a_traceback(ws_cpython):
    io = await ws_cpython.shell("python3 -m nosuchmod")
    assert io.exit_code == 1
    err = await materialize(io.stderr)
    assert err == b"python3: No module named nosuchmod\n"


@pytest.mark.asyncio
async def test_init_flag_warns_on_a_runtime_that_cannot_honor_it(ws):
    io = await ws.shell("python3 -O -c 'print(1)'")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"1\n"
    err = await materialize(io.stderr)
    assert b"-O is ignored by the 'monty' runtime" in err


@pytest.mark.asyncio
async def test_ignored_by_design_flags_do_not_warn(ws):
    io = await ws.shell("python3 -u -q -c 'print(1)'")
    assert io.exit_code == 0
    assert not (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_argv0_on_a_cpython_runtime_under_dash_operand(ws_cpython):
    io = await ws_cpython.shell(
        "echo 'import sys; print(sys.argv[0])' | python3 - a"
    )
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"-\n"


@pytest.mark.asyncio
async def test_a_shadowing_function_receives_the_words_as_typed(ws):
    # bash's own rule: a function of the same name takes the line. It
    # has no CPython option table, so the `--` the interpreter's handoff
    # would need must not be inserted into its arguments.
    await ws.shell('python3() { echo "$@"; }')
    io = await ws.shell("python3 -c payload -u x")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"-c payload -u x\n"


@pytest.mark.asyncio
async def test_command_bypasses_the_function_and_restores_the_handoff(
    ws_cpython,
):
    # `command` masks the function for its inner run, so the interpreter
    # is what runs and -u belongs to the program again.
    await ws_cpython.shell('python3() { echo "$@"; }')
    io = await ws_cpython.shell(
        'command python3 -c "import sys; print(sys.argv)" -u x'
    )
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"['-c', '-u', 'x']\n"


@pytest.mark.asyncio
async def test_unsetting_the_function_restores_the_handoff(ws_cpython):
    await ws_cpython.shell('python3() { echo "$@"; }')
    await ws_cpython.shell("unset -f python3")
    io = await ws_cpython.shell(
        'python3 -c "import sys; print(sys.argv)" -u x'
    )
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"['-c', '-u', 'x']\n"
