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
from mirage.execution.process.session import SessionProcesses
from mirage.io.memory import MemoryBudget, run_with_memory
from mirage.runtime.binding import answer_of
from mirage.runtime.python import MontyRuntime
from mirage.runtime.python.monty.config import MontyConfig, remote_url
from mirage.runtime.python.monty.constants import REMOTE_REQUEST_TIMEOUT
from mirage.runtime.types import Program, RunAnswer
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


@pytest.mark.asyncio
async def test_a_stop_holds_a_busy_program():
    ws = Workspace(
        {"/d": RAMVFS()},
        mode=MountMode.EXEC,
        machines=[MontyRuntime()],
    )
    program = (
        "import time\n"
        "start = time.monotonic()\n"
        "last = start\n"
        "worst = 0.0\n"
        "while last - start < 3.0:\n"
        "    now = time.monotonic()\n"
        "    if now - last > worst:\n"
        "        worst = now - last\n"
        "    last = now\n"
        "print(worst > 1.0)\n"
    )
    try:
        await ws.shell(f"cat > /d/gap <<'EOF'\n{program}EOF")
        await ws.shell("python3 /d/gap > /d/out & p=$!")
        await asyncio.sleep(0.5)
        said = await ws.shell("kill -STOP $p; ps -o stat= -p $p")
        assert said.stdout.decode().strip() == "T"
        await asyncio.sleep(1.5)
        await ws.shell("kill -CONT $p")
        said = await ws.shell("wait $p; echo $?; cat /d/out")
        assert said.stdout == b"0\nTrue\n"
    finally:
        await ws.close()


async def _run(rt: MontyRuntime, program: Program, **fields) -> RunAnswer:
    engine = await rt.engine()
    return await answer_of(
        lambda output, errors: rt.interpret(
            engine, program, Context(**fields), output, errors
        )
    )


async def _execute(rt: MontyRuntime, code: str, **fields) -> RunAnswer:
    return await answer_of(
        lambda output, errors: rt.execute(
            [],
            [],
            Context(flags={"c": code}, **fields),
            output=output,
            errors=errors,
        )
    )


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
        assert result.stderr == b""
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


def test_workspace_explicit_monty_fails_loud(monkeypatch):
    import mirage.runtime.python.monty.runtime as monty_module

    monkeypatch.setattr(monty_module, "pydantic_monty", None)
    with pytest.raises(ImportError, match="monty' extra"):
        Workspace(
            {"/data": RAMVFS()}, mode=MountMode.EXEC, machines=[MontyRuntime()]
        )


@pytest.mark.asyncio
async def test_a_bound_run_takes_the_callers_cwd_not_the_sessions():
    runtime = MontyRuntime()
    ws = Workspace(
        {"/data": RAMVFS()},
        mode=MountMode.EXEC,
        machines=[runtime],
    )
    try:
        assert (await ws.shell("mkdir /data/sub; cd /data")).exit_code == 0
        code = "import os; print(os.getcwd())"
        default = await _execute(runtime, code)
        assert default.stdout == b"/\n"
        cwd = PathSpec.from_str_path("/data/sub")
        explicit = await _execute(runtime, code, cwd=cwd)
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
        assert b"MemoryError" in big.stderr
        small = await _run(runtime, Program(code="print(sum(range(10)))"))
        assert (small.exit_code, small.stdout) == (0, b"45\n")
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_a_run_holds_no_more_than_its_workspace_has_left():
    runtime = MontyRuntime(config={"max_memory": "1G"})
    try:
        big = await run_with_memory(
            MemoryBudget(1 << 20, lambda: 0),
            _run(runtime, Program(code="x = [0] * 10_000_000")),
        )
        assert big.exit_code == 1
        assert b"MemoryError" in big.stderr
        free = await _run(
            runtime, Program(code="print(len([0] * 10_000_000))")
        )
        assert (free.exit_code, free.stdout) == (0, b"10000000\n")
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


_URL = "https://monty.example"
_LOCAL_POOL = pydantic_monty.AsyncMonty


class _Pool:
    """A remote pool as Mirage sees it, running on a local one."""

    def __init__(self) -> None:
        self._pool = _LOCAL_POOL()
        self.closed = False

    async def __aenter__(self) -> "_Pool":
        await self._pool.__aenter__()
        return self

    async def __aexit__(self, *exc) -> None:
        self.closed = True
        await self._pool.__aexit__(*exc)

    def checkout(self, **options):
        return self._pool.checkout(**options)


class _Remote:
    """Each remote pool Mirage asks for, and what it asked for."""

    def __init__(self) -> None:
        self.asked: list[tuple[str, dict]] = []
        self.pools: list[_Pool] = []

    def __call__(self, url: str, **options) -> _Pool:
        self.asked.append((url, options))
        self.pools.append(_Pool())
        return self.pools[-1]


def _no_local_pool(**_):
    raise AssertionError("a remote entry opened a local pool")


@pytest.fixture
def remote(monkeypatch):
    fake = _Remote()
    monkeypatch.setattr(pydantic_monty, "AsyncMontyRemote", fake)
    monkeypatch.setattr(pydantic_monty, "AsyncMonty", _no_local_pool)
    return fake


@pytest.mark.parametrize(
    ("key", "metadata"),
    [({"api_key": "k"}, {"authorization": "Bearer k"}), ({}, None)],
)
@pytest.mark.asyncio
async def test_a_remote_entry_runs_on_a_remote_pool_of_its_own(
    remote, key, metadata
):
    entry = {"provider": "remote", "runtime": "monty", "url": _URL, **key}
    spaces = [
        Workspace(
            {"/d": RAMVFS()}, mode=MountMode.EXEC, machines={"py": dict(entry)}
        )
        for _ in range(2)
    ]
    try:
        for ws in spaces:
            said = await ws.shell(
                "echo -n 6 > /d/n;"
                " python3 -c \"print(int(open('/d/n').read()) * 7)\""
            )
            assert said.stdout == b"42\n"
    finally:
        for ws in spaces:
            await ws.close()
    assert [url for url, _ in remote.asked] == [_URL, _URL]
    for _, options in remote.asked:
        assert options["request_timeout"] == REMOTE_REQUEST_TIMEOUT
        given = options.get("metadata")
        assert (None if given is None else given()) == metadata
    assert [pool.closed for pool in remote.pools] == [True, True]


@pytest.mark.asyncio
async def test_a_nested_remote_run_stays_remote(remote):
    runtime = MontyRuntime(config={"url": _URL})
    said = await _execute(
        runtime,
        "print(1)",
        processes=SessionProcesses(
            check_spawn=lambda: None, probe=lambda _: True, depth=1
        ),
    )
    assert said.stdout == b"1\n"
    assert [url for url, _ in remote.asked] == [_URL]
    assert remote.pools[0].closed


@pytest.mark.asyncio
async def test_ps_shows_a_remote_run_on_its_own_machine(remote):
    ws = Workspace(
        {"/d": RAMVFS()},
        mode=MountMode.EXEC,
        machines={
            "py": {"provider": "remote", "runtime": "monty", "url": _URL}
        },
    )
    try:
        said = await ws.shell(
            "python3 -c 'import time; time.sleep(1)' &"
            " sleep 0.3; ps -o machine=; wait"
        )
        assert "remote:py" in said.stdout.decode().split()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_server_out_of_reach_exits_1_on_one_line():
    ws = Workspace(
        {"/d": RAMVFS()},
        mode=MountMode.EXEC,
        machines={
            "py": {
                "provider": "remote",
                "runtime": "monty",
                "url": "http://127.0.0.1:1",
                "api_key": "s3cret",
            }
        },
    )
    try:
        said = await ws.shell("python3 -c 'print(1)'")
    finally:
        await ws.close()
    told = said.stderr.decode()
    assert said.exit_code == 1
    assert told.startswith("monty: remote server: http://127.0.0.1:1")
    assert told.count("\n") == 1 and "s3cret" not in told


@pytest.mark.parametrize(
    ("given", "url"),
    [
        ({"api_key": "pylf_v2_us_k"}, "https://logfire-us.pydantic.dev"),
        ({"api_key": "pylf_v1_eu_k"}, "https://logfire-eu.pydantic.dev"),
        ({"url": _URL, "api_key": "pylf_v2_us_k"}, _URL),
        ({"url": _URL}, _URL),
        ({}, None),
    ],
)
def test_a_server_is_its_url_else_a_logfire_keys_region(given, url):
    assert remote_url(MontyConfig(**given)) == url


@pytest.mark.parametrize("key", ["k", "pylf_v2_zz_k"])
def test_a_key_that_names_no_known_region_needs_a_url(key):
    with pytest.raises(ValueError, match="needs a url"):
        MontyConfig(api_key=key)


def test_a_key_never_prints():
    assert "s3cret" not in repr(MontyConfig(url=_URL, api_key="s3cret"))


@pytest.mark.asyncio
async def test_a_logfire_key_alone_reaches_its_region(remote):
    ws = Workspace(
        {"/d": RAMVFS()},
        mode=MountMode.EXEC,
        machines={
            "py": {
                "provider": "remote",
                "runtime": "monty",
                "api_key": "pylf_v2_eu_k",
            }
        },
    )
    try:
        said = await ws.shell("python3 -c 'print(1)'")
    finally:
        await ws.close()
    assert said.stdout == b"1\n"
    assert [url for url, _ in remote.asked] == [
        "https://logfire-eu.pydantic.dev"
    ]


class _Denied(Exception):
    """Stands in for MontyRefusedError, which python cannot construct."""


@pytest.mark.asyncio
@pytest.mark.parametrize("on_open", [False, True])
async def test_a_remote_refusal_never_shows_the_key(monkeypatch, on_open):
    reason = "denied:\r\nBearer s3cret"

    class _Checkout:
        async def __aenter__(self):
            raise _Denied(reason)

        async def __aexit__(self, *exc) -> None:
            return None

    class _Pool:
        async def __aenter__(self):
            if on_open:
                raise _Denied(reason)
            return self

        async def __aexit__(self, *exc) -> None:
            return None

        def checkout(self, **_):
            return _Checkout()

    monkeypatch.setattr(pydantic_monty, "MontyRefusedError", _Denied)
    monkeypatch.setattr(
        pydantic_monty, "AsyncMontyRemote", lambda *_, **__: _Pool()
    )
    runtime = MontyRuntime(config={"url": _URL, "api_key": "s3cret"})
    said = await _execute(runtime, "print(1)")
    await runtime.close()
    assert said.exit_code == 1
    assert said.stderr == b"monty: remote server: denied: Bearer <redacted>\n"
