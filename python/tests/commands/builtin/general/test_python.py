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
import pytest_asyncio

from mirage import MountMode, RAMResource, Workspace
from mirage.io.types import materialize
from mirage.runtime.python import LocalRuntime


@pytest_asyncio.fixture
async def ws():
    workspace = Workspace({"/": RAMResource()}, mode=MountMode.EXEC)
    yield workspace
    await workspace.close()


@pytest_asyncio.fixture
async def ws_cpython():
    workspace = Workspace({"/": RAMResource()},
                          mode=MountMode.EXEC,
                          runtimes=[LocalRuntime()])
    yield workspace
    await workspace.close()


@pytest.mark.asyncio
async def test_dash_u_before_a_script_is_a_flag_not_the_script(ws):
    await ws.execute("printf 'print(42)\\n' > /s.py")
    io = await ws.execute("python3 -u /s.py")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"42\n"


@pytest.mark.asyncio
async def test_unknown_short_option_exits_2_naming_the_letter(ws):
    io = await ws.execute("python3 -zz -c 'print(1)'")
    assert io.exit_code == 2
    assert b"Unknown option: -z" in (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_unknown_long_option_uses_cpythons_lowercase_shape(ws):
    io = await ws.execute("python3 --nope")
    assert io.exit_code == 2
    assert b"unknown option --nope" in (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_payload_option_without_its_argument_exits_2(ws):
    io = await ws.execute("python3 -c")
    assert io.exit_code == 2
    err = await materialize(io.stderr)
    assert b"Argument expected for the -c option" in err
    assert b"usage: python3 [option] ..." in err


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["python3 -V", "python3 -VV"])
async def test_dash_v_aliases_the_version_tier(ws, line):
    io = await ws.execute(line)
    assert io.exit_code == 0
    assert b"(Mirage)" in (await materialize(io.stdout))


@pytest.mark.asyncio
async def test_dash_h_aliases_the_help_tier(ws):
    io = await ws.execute("python3 -h")
    assert io.exit_code == 0
    assert b"Usage: python3" in (await materialize(io.stdout))


@pytest.mark.asyncio
async def test_words_after_the_script_reach_the_script_verbatim(ws):
    await ws.execute("printf 'print(argv[1])\\n' > /s.py")
    io = await ws.execute("python3 /s.py --not-my-flag")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"--not-my-flag\n"


@pytest.mark.asyncio
async def test_argv0_is_the_script_path_as_typed(ws):
    await ws.execute("printf 'print(argv[0])\\n' > /s.py")
    io = await ws.execute("python3 /s.py")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"/s.py\n"


@pytest.mark.asyncio
async def test_dash_operand_reads_the_program_from_stdin(ws):
    io = await ws.execute("echo 'print(7)' | python3 -")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"7\n"


@pytest.mark.asyncio
async def test_argv0_under_dash_c_is_dash_c(ws):
    io = await ws.execute("python3 -c 'print(argv[0])'")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"-c\n"


@pytest.mark.asyncio
async def test_dash_m_on_a_runtime_without_modules_refuses(ws):
    io = await ws.execute("python3 -m json.tool")
    assert io.exit_code == 1
    err = await materialize(io.stderr)
    assert b"-m" in err
    assert b"monty" in err


@pytest.mark.asyncio
async def test_dash_m_runs_a_module_on_a_cpython_runtime(ws_cpython):
    io = await ws_cpython.execute("python3 -m json.tool --help")
    assert io.exit_code == 0
    assert b"json.tool" in (await materialize(io.stdout))


@pytest.mark.asyncio
async def test_dash_m_missing_module_is_one_line_not_a_traceback(ws_cpython):
    io = await ws_cpython.execute("python3 -m nosuchmod")
    assert io.exit_code == 1
    err = await materialize(io.stderr)
    assert err == b"python3: No module named nosuchmod\n"


@pytest.mark.asyncio
async def test_dash_o_strips_asserts_on_a_cpython_runtime(ws_cpython):
    io = await ws_cpython.execute(
        "python3 -O -c 'assert False, \"boom\"; print(\"ok\")'")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"ok\n"


@pytest.mark.asyncio
async def test_init_flag_warns_on_a_runtime_that_cannot_honor_it(ws):
    io = await ws.execute("python3 -O -c 'print(1)'")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"1\n"
    err = await materialize(io.stderr)
    assert b"-O is ignored by the 'monty' runtime" in err


@pytest.mark.asyncio
async def test_ignored_by_design_flags_do_not_warn(ws):
    io = await ws.execute("python3 -u -q -c 'print(1)'")
    assert io.exit_code == 0
    assert not (await materialize(io.stderr))


@pytest.mark.asyncio
async def test_argv0_on_a_cpython_runtime_is_the_script_not_dash_c(ws_cpython):
    await ws_cpython.execute(
        "printf 'import sys\\nprint(sys.argv[0])\\n' > /s.py")
    io = await ws_cpython.execute("python3 /s.py")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"/s.py\n"


@pytest.mark.asyncio
async def test_argv0_on_a_cpython_runtime_under_dash_operand(ws_cpython):
    io = await ws_cpython.execute(
        "echo 'import sys; print(sys.argv[0])' | python3 - a")
    assert io.exit_code == 0
    assert await materialize(io.stdout) == b"-\n"


@pytest.mark.asyncio
async def test_traceback_names_the_script_on_a_cpython_runtime(ws_cpython):
    await ws_cpython.execute("printf 'raise ValueError(1)\\n' > /boom.py")
    io = await ws_cpython.execute("python3 /boom.py")
    assert io.exit_code == 1
    assert b'File "/boom.py"' in (await materialize(io.stderr))
