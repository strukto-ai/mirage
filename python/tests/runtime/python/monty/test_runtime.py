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

import pydantic_monty
import pytest

from mirage.commands.config import Context
from mirage.runtime.python import MontyRuntime
from mirage.runtime.types import Program, RunResult
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


async def _run(rt: MontyRuntime, program: Program, **fields) -> RunResult:
    return await rt.interpret(await rt.engine(), program, Context(**fields))


def _args(code: str, env: dict[str, str] | None = None, **fields):
    return Program(code=code, **fields), env


# A program's whole answer on both hosts: what it prints, its exit
# code, and a phrase its stderr carries (None: nothing on stderr). The
# clock rows read the engine's own host clock, and resolve() is
# absolute() against '/' with no symlinks in the tree, a str on both
# hosts.
@pytest.mark.parametrize(
    ("args", "exit_code", "stdout", "stderr"),
    [
        pytest.param(
            _args(code="print(21 * 2)"), 0, b"42\n", None, id="print"
        ),
        pytest.param(
            _args(code="def broken("), 1, b"", b"SyntaxError", id="syntax"
        ),
        pytest.param(
            _args(code="print('before')\n1/0"),
            1,
            b"before\n",
            b"ZeroDivisionError",
            id="error-keeps-stdout",
        ),
        pytest.param(
            _args(code="print(argv[1:])", args=["a", "b"]),
            0,
            b"['a', 'b']\n",
            None,
            id="argv",
        ),
        pytest.param(
            _args(code="print(stdin.decode())", stdin=b"piped"),
            0,
            b"piped\n",
            None,
            id="stdin",
        ),
        pytest.param(
            _args(code="print(stdin is None)"),
            0,
            b"True\n",
            None,
            id="no-stdin",
        ),
        pytest.param(
            _args(
                code="import os; print(os.environ.get('MY_VAR', 'unset'))",
                env={"MY_VAR": "v1"},
            ),
            0,
            b"v1\n",
            None,
            id="run-env",
        ),
        pytest.param(
            _args(
                code="import os\n"
                "try:\n"
                "    os.environ['nope']\n"
                "except KeyError as e:\n"
                "    print('KeyError', e)",
                env={"K": "v"},
            ),
            0,
            b"KeyError 'nope'\n",
            None,
            id="missing-env-key",
        ),
        pytest.param(
            _args(
                code="import os\nos.environ['K'] = 'guest'\n"
                "print(os.getenv('K'))",
                env={"K": "v"},
            ),
            0,
            b"v\n",
            None,
            id="env-mutation-stays-in-the-guest",
        ),
        pytest.param(
            _args(
                code="from datetime import datetime, timezone\n"
                "print(datetime.now().tzinfo)\n"
                "print(datetime.now(timezone.utc).tzinfo)"
            ),
            0,
            b"None\nUTC\n",
            None,
            id="host-clock",
        ),
        pytest.param(
            _args(
                code="from pathlib import Path\n"
                "r = Path('rel/x.txt').resolve()\n"
                "print(type(r).__name__, r)"
            ),
            0,
            b"str /rel/x.txt\n",
            None,
            id="lexical-resolve",
        ),
    ],
)
def test_monty_runs_a_program(args, exit_code, stdout, stderr):
    program, env = args
    result = asyncio.run(_run(MontyRuntime(), program, env=env))
    assert (result.exit_code, result.stdout) == (exit_code, stdout)
    if stderr is None:
        assert result.stderr is None
    else:
        assert stderr in result.stderr


def test_monty_argv0_is_prog_when_named():
    # A named caller (a CLI install) owns argv[0]; without one the
    # interpreter's own placeholder stands, as `python3 -c` expects.
    runtime = MontyRuntime()
    result = asyncio.run(
        _run(runtime, Program(code="print(argv[0])", args=["a"], prog="pager"))
    )
    assert (result.exit_code, result.stdout) == (0, b"pager\n")
    plain = asyncio.run(_run(runtime, Program(code="print(argv[0])")))
    assert plain.stdout == b"main.py\n"


def test_monty_environ_is_a_dict_of_the_run_env():
    # The surface the TS host must match: same nine reads, same output
    # (its bridge answered os.getenv only and raised on os.environ).
    runtime = MontyRuntime()
    code = "\n".join(
        (
            "import os",
            "print(os.environ.get('K'))",
            "print(os.environ.get('nope', 'dflt'))",
            "print(os.environ['K'])",
            "print('K' in os.environ, 'nope' in os.environ)",
            "print(sorted(os.environ))",
            "print(sorted(os.environ.items()))",
            "print(len(os.environ))",
            "print(type(os.environ).__name__)",
        )
    )
    result = asyncio.run(
        _run(runtime, Program(code=code), env={"K": "v", "OTHER": "w"})
    )
    assert result.exit_code == 0
    assert result.stdout == (
        b"v\n"
        b"dflt\n"
        b"v\n"
        b"True False\n"
        b"['K', 'OTHER']\n"
        b"[('K', 'v'), ('OTHER', 'w')]\n"
        b"2\n"
        b"dict\n"
    )


def test_monty_name():
    assert MontyRuntime().name == "monty"


@pytest.mark.asyncio
async def test_monty_runs_off_loop_and_cancellation_halts():
    rt = MontyRuntime()
    hot = "n = 0\nwhile True:\n    n = n + 1"
    task = asyncio.ensure_future(_run(rt, Program(code=hot)))
    ticks = 0
    for _ in range(6):
        await asyncio.sleep(0.05)
        ticks += 1
    assert ticks == 6  # the loop stayed free while the interpreter ran
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    result = await _run(rt, Program(code="print(6 * 7)"))
    assert result.exit_code == 0
    assert result.stdout == b"42\n"


def test_monty_missing_extra_raises(monkeypatch):
    import mirage.runtime.python.monty.runtime as monty_module

    monkeypatch.setattr(monty_module, "pydantic_monty", None)
    with pytest.raises(ImportError, match="monty' extra"):
        MontyRuntime()


def test_python3_reports_missing_extra(monkeypatch):
    import mirage.runtime.python.monty.runtime as monty_module

    monkeypatch.setattr(monty_module, "pydantic_monty", None)
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC)
    io = asyncio.run(ws.shell("python3 -c 'print(1)'"))
    assert io.exit_code == 127
    assert b"monty' extra" in io.stderr


def test_workspace_explicit_monty_fails_loud(monkeypatch):
    import mirage.runtime.python.monty.runtime as monty_module

    monkeypatch.setattr(monty_module, "pydantic_monty", None)
    with pytest.raises(ImportError, match="monty' extra"):
        Workspace({"/data": RAMVFS()}, mode=MountMode.EXEC, runtimes=["monty"])


@pytest.mark.asyncio
async def test_a_bound_run_takes_the_callers_cwd_not_the_sessions():
    runtime = MontyRuntime()
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[runtime, "workspace"],
    )
    try:
        assert (await ws.shell("mkdir /data/sub; cd /data")).exit_code == 0
        code = "import os; print(os.getcwd())"
        default = await runtime.execute([], [], Context(flags={"c": code}))
        assert default.stdout == b"/\n"
        cwd = PathSpec.from_str_path("/data/sub")
        explicit = await runtime.execute(
            [], [], Context(flags={"c": code}, cwd=cwd)
        )
        assert explicit.stdout == b"/data/sub\n"
    finally:
        await ws.close()


def test_upstream_entry_points_this_runtime_binds_to():
    """Guard the pydantic-monty API surface run() uses.

    monty's API moves fast: 0.0.19 replaced the whole execution model
    (`Monty` became a worker pool, `MontyRepl` disappeared, `run_async`
    moved onto a checked-out session). A bump that shifts any of these
    breaks python3 lines and policy programs together. Fail here, at
    the seam, rather than in every caller.
    """
    pool = pydantic_monty.AsyncMonty()
    assert hasattr(pool, "__aenter__") and hasattr(pool, "__aexit__")
    session = pool.checkout()
    for attr in ("__aenter__", "__aexit__", "feed_run", "worker_pid"):
        assert hasattr(session, attr), f"session lost {attr}"
    assert hasattr(pydantic_monty.MontyCrashedError, "timed_out")


def test_reach_is_vfs():
    assert MontyRuntime.reach == "workspace"


@pytest.mark.asyncio
async def test_max_memory_caps_a_run_and_leaves_a_small_one_alone():
    runtime = MontyRuntime(config={"max_memory": "1M"})
    try:
        big = await _run(runtime, Program(code="x = [0] * 10_000_000"))
        assert big.exit_code == 1
        assert big.stderr is not None and b"MemoryError" in big.stderr
        small = await _run(runtime, Program(code="print(sum(range(10)))"))
        assert (small.exit_code, small.stdout) == (0, b"45\n")
    finally:
        await runtime.close()


def test_max_memory_must_be_a_size():
    with pytest.raises(ValueError, match="max_memory must be a size"):
        MontyRuntime(config={"max_memory": "lots"})


def test_monty_refuses_a_path_no_mount_serves():
    # The only filesystem a guest sees is the workspace's: with nothing
    # mounted, a directory cannot be made and a file cannot be written,
    # and a probe answers False rather than inventing a scratch tree.
    runtime = MontyRuntime()
    for code in (
        "from pathlib import Path\nPath('/tmp').mkdir()",
        "open('/tmp/x.txt', 'w').write('hi')",
    ):
        result = asyncio.run(_run(runtime, Program(code=code)))
        assert result.exit_code == 1
        assert b"FileNotFoundError" in result.stderr
    result = asyncio.run(
        _run(
            runtime,
            Program(
                code="from pathlib import Path\nprint(Path('/tmp').exists())"
            ),
        )
    )
    assert result.exit_code == 0, result.stderr
    assert result.stdout == b"False\n"
