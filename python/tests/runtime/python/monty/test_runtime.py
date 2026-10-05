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

from mirage.runtime.errors import EvalError
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.python import MontyRuntime
from mirage.runtime.types import RunArgs
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


# A program's whole answer on both hosts: what it prints, its exit
# code, and a phrase its stderr carries (None: nothing on stderr). The
# clock rows read the engine's own host clock, and resolve() is
# absolute() against '/' with no symlinks in the tree, a str on both
# hosts.
@pytest.mark.parametrize(
    ("args", "exit_code", "stdout", "stderr"),
    [
        pytest.param(
            RunArgs(code="print(21 * 2)"), 0, b"42\n", None, id="print"
        ),
        pytest.param(
            RunArgs(code="def broken("), 1, b"", b"SyntaxError", id="syntax"
        ),
        pytest.param(
            RunArgs(code="print('before')\n1/0"),
            1,
            b"before\n",
            b"ZeroDivisionError",
            id="error-keeps-stdout",
        ),
        pytest.param(
            RunArgs(code="print(argv[1:])", args=["a", "b"]),
            0,
            b"['a', 'b']\n",
            None,
            id="argv",
        ),
        pytest.param(
            RunArgs(code="print(stdin.decode())", stdin=b"piped"),
            0,
            b"piped\n",
            None,
            id="stdin",
        ),
        pytest.param(
            RunArgs(code="print(stdin is None)"),
            0,
            b"True\n",
            None,
            id="no-stdin",
        ),
        pytest.param(
            RunArgs(
                code="import os; print(os.environ.get('MY_VAR', 'unset'))",
                env={"MY_VAR": "v1"},
            ),
            0,
            b"v1\n",
            None,
            id="run-env",
        ),
        pytest.param(
            RunArgs(
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
            RunArgs(
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
            RunArgs(
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
            RunArgs(
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
    result = asyncio.run(MontyRuntime().run(args))
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
        runtime.run(RunArgs(code="print(argv[0])", args=["a"], prog="pager"))
    )
    assert (result.exit_code, result.stdout) == (0, b"pager\n")
    plain = asyncio.run(runtime.run(RunArgs(code="print(argv[0])")))
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
        runtime.run(RunArgs(code=code, env={"K": "v", "OTHER": "w"}))
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
    task = asyncio.ensure_future(rt.run(RunArgs(code=hot)))
    ticks = 0
    for _ in range(6):
        await asyncio.sleep(0.05)
        ticks += 1
    assert ticks == 6  # the loop stayed free while the interpreter ran
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    result = await rt.run(RunArgs(code="print(6 * 7)"))
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
async def test_eval_returns_last_expression_with_inputs():
    runtime = MontyRuntime()
    result = await runtime.eval(
        "print('hey'); ctx['a'] + 1", inputs={"ctx": {"a": 41}}
    )
    assert result.value == 42
    assert result.stdout == b"hey\n"
    assert result.status == "complete"


@pytest.mark.asyncio
async def test_eval_sessions_keep_state_per_id():
    runtime = MontyRuntime()
    await runtime.eval("x = 5", session="a")
    doubled = await runtime.eval("x * 2", session="a")
    assert doubled.value == 10
    other = await runtime.eval("x", session="b")
    assert other.exit_code == 1
    assert other.stderr is not None and b"NameError" in other.stderr
    await runtime.close()


@pytest.mark.asyncio
async def test_cwd_inherits_context_and_explicit_run_cwd_wins():
    runtime = MontyRuntime()
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[runtime, "workspace"],
    )
    try:
        assert (await ws.shell("mkdir /data/sub; cd /data")).exit_code == 0
        code = "import os; print(os.getcwd())"
        inherited = await runtime.run(RunArgs(code=code))
        assert inherited.stdout == b"/data\n"
        explicit = await runtime.run(
            RunArgs(code=code, cwd=PathSpec.from_str_path("/data/sub"))
        )
        assert explicit.stdout == b"/data/sub\n"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_eval_cwd_is_seeded_once_per_session():
    runtime = MontyRuntime()
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        runtimes=[runtime, "workspace"],
    )
    try:
        assert (
            await ws.shell(
                "mkdir /data/sub; echo child > /data/sub/item; cd /data"
            )
        ).exit_code == 0
        assert (await runtime.eval("import os; os.getcwd()")).value == "/data"
        first = await runtime.eval(
            "import os; os.chdir('sub'); os.getcwd()", session="a"
        )
        assert first.value == "/data/sub"
        assert (await ws.shell("cd /")).exit_code == 0
        again = await runtime.eval("open('item').read()", session="a")
        assert again.value == "child\n"
        assert (
            await runtime.eval("import os; os.getcwd()", session="b")
        ).value == "/"
        assert (await runtime.eval("import os; os.getcwd()")).value == "/"
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_eval_session_open_block_reports_incomplete():
    runtime = MontyRuntime()
    result = await runtime.eval("def f():", session="a")
    assert result.status == "incomplete"
    assert result.value is None


@pytest.mark.asyncio
async def test_eval_errors_carry_monty_diagnostics():
    runtime = MontyRuntime()
    with pytest.raises(EvalError) as syntax_err:
        await runtime.eval("def broken(")
    assert syntax_err.value.syntax is True
    with pytest.raises(EvalError) as runtime_err:
        await runtime.eval("1 / 0")
    assert runtime_err.value.syntax is False
    assert "ZeroDivisionError" in str(runtime_err.value)


def test_monty_is_an_evaluator():
    assert isinstance(MontyRuntime(), EvaluatorMixin)


def test_upstream_entry_points_this_runtime_binds_to():
    """Guard the pydantic-monty API surface run() and eval() use.

    monty's API moves fast: 0.0.19 replaced the whole execution model
    (`Monty` became a worker pool, `MontyRepl` disappeared, `run_async`
    moved onto a checked-out session). eval() is also what the policy
    layer evaluates config-borne scripts on, so a bump that shifts any
    of these breaks python3 lines and script-source policies together.
    Fail here, at the seam, rather than in every caller.
    """
    pool = pydantic_monty.AsyncMonty()
    assert hasattr(pool, "__aenter__") and hasattr(pool, "__aexit__")
    session = pool.checkout()
    for attr in ("__aenter__", "__aexit__", "feed_run", "worker_pid"):
        assert hasattr(session, attr), f"session lost {attr}"
    assert hasattr(pydantic_monty.MontyCrashedError, "timed_out")


@pytest.mark.asyncio
async def test_eval_cancellation_reclaims_the_worker():
    rt = MontyRuntime()
    await rt.eval("x = 1", session="live")
    task = asyncio.ensure_future(
        rt.eval("n = 0\nwhile True:\n    n = n + 1", session="live")
    )
    await asyncio.sleep(0.3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # The killed worker took the session's heap with it, so the id is
    # dropped and the next eval gets a fresh worker rather than a dead one.
    assert "live" not in rt._execution._eval_sessions
    again = await rt.eval("6 * 7", session="live")
    assert again.value == 42
    await rt.close()


@pytest.mark.asyncio
async def test_monty_cancelled_eval_session_releases_its_checkout(monkeypatch):
    """A cancelled console session must hand its lease back.

    Dropping it from the session map alone leaves the pool holding a
    checkout that close() can no longer reach. Asserted on the release
    itself: one leaked lease would not exhaust a CPU-sized pool, so a
    later eval succeeding proves nothing.
    """
    import mirage.runtime.python.monty.execution as monty_mod

    released: list[object] = []
    original = monty_mod._release

    async def spy(repl):
        released.append(repl)
        await original(repl)

    monkeypatch.setattr(monty_mod, "_release", spy)
    runtime = MontyRuntime()
    task = asyncio.create_task(
        runtime.eval("i = 0\nwhile True:\n    i += 1", session="s1")
    )
    await asyncio.sleep(0.4)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert "s1" not in runtime._execution._eval_sessions
    assert len(released) == 1, "the cancelled checkout was never released"
    # And the runtime stays usable afterwards.
    result = await runtime.eval("1 + 1", session="s1")
    assert result.value == 2
    await runtime.close()


def test_reach_is_vfs():
    assert MontyRuntime.reach == "workspace"


def test_monty_refuses_a_path_no_mount_serves():
    # The only filesystem a guest sees is the workspace's: with nothing
    # mounted, a directory cannot be made and a file cannot be written,
    # and a probe answers False rather than inventing a scratch tree.
    runtime = MontyRuntime()
    for code in (
        "from pathlib import Path\nPath('/tmp').mkdir()",
        "open('/tmp/x.txt', 'w').write('hi')",
    ):
        result = asyncio.run(runtime.run(RunArgs(code=code)))
        assert result.exit_code == 1
        assert b"FileNotFoundError" in result.stderr
    result = asyncio.run(
        runtime.run(
            RunArgs(
                code="from pathlib import Path\nprint(Path('/tmp').exists())"
            )
        )
    )
    assert result.exit_code == 0, result.stderr
    assert result.stdout == b"False\n"
