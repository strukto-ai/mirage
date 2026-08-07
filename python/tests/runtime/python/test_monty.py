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
import errno

import pydantic_monty
import pytest

from mirage.resource.ram import RAMResource
from mirage.runtime.errors import EvalError
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.python import MontyRuntime
from mirage.runtime.types import RunArgs
from mirage.types import MountMode
from mirage.utils.errors import OperationNotSupportedError
from mirage.workspace import Workspace


class FakeDispatch:
    """Async dispatch stub backed by a dict of virtual files."""

    def __init__(self,
                 files: dict[str, bytes],
                 supports_append: bool = True) -> None:
        self.files = files
        self.supports_append = supports_append
        self.writes: list[tuple[str, bytes]] = []
        self.appends: list[tuple[str, bytes]] = []
        self.unlinked: list[str] = []
        self.dirs: list[str] = []
        self.renamed: list[tuple[str, str]] = []
        self.mkdir_kwargs: list[dict] = []

    async def __call__(self, op, path, **kwargs):
        virtual = path.virtual
        if op == "read":
            if virtual not in self.files:
                raise FileNotFoundError(virtual)
            return self.files[virtual], None
        if op == "readdir":
            prefix = virtual.rstrip("/") + "/"
            names = set()
            for p in self.files:
                if p.startswith(prefix):
                    names.add(p[len(prefix):].split("/")[0])
            if not names and virtual.rstrip("/") not in ("", "/"):
                raise FileNotFoundError(virtual)
            return sorted(names), None
        if op == "write":
            data = kwargs["data"]
            self.files[virtual] = data
            self.writes.append((virtual, data))
            return None, None
        if op == "append":
            if not self.supports_append:
                # What a backend without the op really raises (S3
                # registers write but not append).
                raise OperationNotSupportedError(errno.ENOTSUP,
                                                 "no op 'append'", virtual)
            data = kwargs["data"]
            self.files[virtual] = self.files.get(virtual, b"") + data
            self.appends.append((virtual, data))
            return None, None
        if op == "unlink":
            self.files.pop(virtual, None)
            self.unlinked.append(virtual)
            return None, None
        if op == "mkdir":
            self.dirs.append(virtual)
            self.mkdir_kwargs.append(dict(kwargs))
            return None, None
        if op == "rmdir":
            self.dirs = [d for d in self.dirs if d != virtual]
            return None, None
        if op == "rename":
            dst = kwargs["dst"].virtual
            if virtual in self.files:
                self.files[dst] = self.files.pop(virtual)
            self.renamed.append((virtual, dst))
            return None, None
        raise ValueError(f"unexpected op {op}")


def test_monty_runs_sandboxed_print():
    runtime = MontyRuntime()
    result = asyncio.run(runtime.run(RunArgs(code="print(21 * 2)")))
    assert result.exit_code == 0
    assert result.stdout == b"42\n"
    assert result.stderr is None


def test_monty_syntax_error():
    runtime = MontyRuntime()
    result = asyncio.run(runtime.run(RunArgs(code="def broken(")))
    assert result.exit_code == 1
    assert b"SyntaxError" in result.stderr


def test_monty_runtime_error_keeps_stdout():
    runtime = MontyRuntime()
    result = asyncio.run(runtime.run(RunArgs(code="print('before')\n1/0")))
    assert result.exit_code == 1
    assert result.stdout == b"before\n"
    assert b"ZeroDivisionError" in result.stderr


def test_monty_argv_global():
    runtime = MontyRuntime()
    result = asyncio.run(
        runtime.run(RunArgs(code="print(argv[1:])", args=["a", "b"])))
    assert result.exit_code == 0
    assert result.stdout == b"['a', 'b']\n"


def test_monty_argv0_is_prog_when_named():
    # A named caller (a CLI install) owns argv[0]; without one the
    # interpreter's own placeholder stands, as `python3 -c` expects.
    runtime = MontyRuntime()
    result = asyncio.run(
        runtime.run(RunArgs(code="print(argv[0])", args=["a"], prog="pager")))
    assert (result.exit_code, result.stdout) == (0, b"pager\n")
    plain = asyncio.run(runtime.run(RunArgs(code="print(argv[0])")))
    assert plain.stdout == b"main.py\n"


def test_monty_stdin_global():
    runtime = MontyRuntime()
    result = asyncio.run(
        runtime.run(RunArgs(code="print(stdin.decode())", stdin=b"piped")))
    assert result.exit_code == 0
    assert result.stdout == b"piped\n"


def test_monty_stdin_global_none_without_pipe():
    runtime = MontyRuntime()
    result = asyncio.run(runtime.run(RunArgs(code="print(stdin is None)")))
    assert result.exit_code == 0
    assert result.stdout == b"True\n"


def test_monty_env_isolated_to_run_env():
    runtime = MontyRuntime()
    result = asyncio.run(
        runtime.run(
            RunArgs(code="import os; print(os.environ.get('MY_VAR', 'unset'))",
                    env={"MY_VAR": "v1"})))
    assert result.stdout == b"v1\n"


def test_monty_environ_is_a_dict_of_the_run_env():
    # The surface the TS host must match: same nine reads, same output
    # (its bridge answered os.getenv only and raised on os.environ).
    runtime = MontyRuntime()
    code = "\n".join((
        "import os",
        "print(os.environ.get('K'))",
        "print(os.environ.get('nope', 'dflt'))",
        "print(os.environ['K'])",
        "print('K' in os.environ, 'nope' in os.environ)",
        "print(sorted(os.environ))",
        "print(sorted(os.environ.items()))",
        "print(len(os.environ))",
        "print(type(os.environ).__name__)",
    ))
    result = asyncio.run(
        runtime.run(RunArgs(code=code, env={
            "K": "v",
            "OTHER": "w"
        })))
    assert result.exit_code == 0
    assert result.stdout == (b"v\n"
                             b"dflt\n"
                             b"v\n"
                             b"True False\n"
                             b"['K', 'OTHER']\n"
                             b"[('K', 'v'), ('OTHER', 'w')]\n"
                             b"2\n"
                             b"dict\n")


def test_monty_missing_environ_key_raises_key_error():
    runtime = MontyRuntime()
    code = ("import os\n"
            "try:\n"
            "    os.environ['nope']\n"
            "except KeyError as e:\n"
            "    print('KeyError', e)")
    result = asyncio.run(runtime.run(RunArgs(code=code, env={"K": "v"})))
    assert (result.exit_code, result.stdout) == (0, b"KeyError 'nope'\n")


def test_monty_environ_mutation_cannot_reach_the_host_env():
    runtime = MontyRuntime()
    code = ("import os\n"
            "os.environ['K'] = 'guest'\n"
            "print(os.getenv('K'))")
    result = asyncio.run(runtime.run(RunArgs(code=code, env={"K": "v"})))
    assert (result.exit_code, result.stdout) == (0, b"v\n")


def test_monty_host_filesystem_invisible():
    runtime = MontyRuntime()
    result = asyncio.run(
        runtime.run(RunArgs(code="print(open('/etc/passwd').read())")))
    assert result.exit_code == 1
    assert b"FileNotFoundError" in result.stderr


def test_monty_reads_virtual_file_via_dispatch():
    dispatch = FakeDispatch({"/s3/a.txt": b"virtual"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: [])
    result = asyncio.run(
        runtime.run(RunArgs(code="print(open('/s3/a.txt').read().upper())")))
    assert result.exit_code == 0
    assert result.stdout == b"VIRTUAL\n"


def test_monty_missing_virtual_file():
    dispatch = FakeDispatch({})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: [])
    result = asyncio.run(runtime.run(RunArgs(code="open('/s3/missing.txt')")))
    assert result.exit_code == 1
    assert b"FileNotFoundError" in result.stderr


def test_monty_write_flushes_through_dispatch():
    dispatch = FakeDispatch({"/s3/seed.txt": b"x"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: [])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/out.txt').write_text('data')")))
    assert result.exit_code == 0
    assert ("/s3/out.txt", b"data") in dispatch.writes
    assert dispatch.files["/s3/out.txt"] == b"data"


def test_monty_append_sends_only_the_new_bytes():
    """An append must carry the delta, never the whole file.

    Monty hands the append hook the new text alone, so re-sending the
    accumulated content would make a write loop quadratic against the
    backend: N appends shipping O(N^2) bytes over N round trips.
    """
    dispatch = FakeDispatch({"/s3/log.txt": b"a"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: [])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="for part in ['b', 'c', 'd']:\n"
                    "    with open('/s3/log.txt', 'a') as f:\n"
                    "        f.write(part)")))
    assert result.exit_code == 0, result.stderr
    assert dispatch.files["/s3/log.txt"] == b"abcd"
    assert dispatch.appends == [("/s3/log.txt", b"b"), ("/s3/log.txt", b"c"),
                                ("/s3/log.txt", b"d")]
    assert dispatch.writes == []


def test_monty_iterdir_lists_virtual_dir():
    dispatch = FakeDispatch({"/s3/a.txt": b"1", "/s3/b.txt": b"2"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: [])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "print(sorted(str(p) "
                    "for p in Path('/s3').iterdir()))")))
    assert result.exit_code == 0
    assert result.stdout == b"['/s3/a.txt', '/s3/b.txt']\n"


def test_monty_unlink_routes_to_dispatch():
    dispatch = FakeDispatch({"/s3/a.txt": b"1"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: [])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/a.txt').unlink()")))
    assert result.exit_code == 0
    assert dispatch.unlinked == ["/s3/a.txt"]


def test_monty_mkdir_routes_to_dispatch():
    dispatch = FakeDispatch({})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: [])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/sub').mkdir()\n"
                    "Path('/s3/sub/n.txt').write_text('deep')")))
    assert result.exit_code == 0, result.stderr
    assert "/s3/sub" in dispatch.dirs
    assert dispatch.files["/s3/sub/n.txt"] == b"deep"


def test_monty_rename_routes_to_dispatch():
    dispatch = FakeDispatch({"/s3/a.txt": b"one"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: [])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/a.txt').rename('/s3/b.txt')")))
    assert result.exit_code == 0, result.stderr
    assert dispatch.renamed == [("/s3/a.txt", "/s3/b.txt")]
    assert dispatch.files["/s3/b.txt"] == b"one"


def test_monty_rmdir_routes_to_dispatch():
    dispatch = FakeDispatch({"/s3/dir/keep.txt": b"x"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: [])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/dir').rmdir()")))
    assert result.exit_code == 0, result.stderr
    assert "/s3/dir" not in dispatch.dirs


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
    import mirage.runtime.python.monty as monty_module
    monkeypatch.setattr(monty_module, "pydantic_monty", None)
    with pytest.raises(ImportError, match="monty' extra"):
        MontyRuntime()


def test_python3_reports_missing_extra(monkeypatch):
    import mirage.runtime.python.monty as monty_module
    monkeypatch.setattr(monty_module, "pydantic_monty", None)
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.EXEC)
    io = asyncio.run(ws.execute("python3 -c 'print(1)'"))
    assert io.exit_code == 127
    assert b"monty' extra" in io.stderr


def test_workspace_explicit_monty_fails_loud(monkeypatch):
    import mirage.runtime.python.monty as monty_module
    monkeypatch.setattr(monty_module, "pydantic_monty", None)
    with pytest.raises(ImportError, match="monty' extra"):
        Workspace({"/data": RAMResource()},
                  mode=MountMode.EXEC,
                  runtimes=["monty"])


@pytest.mark.asyncio
async def test_eval_returns_last_expression_with_inputs():
    runtime = MontyRuntime()
    result = await runtime.eval("print('hey'); ctx['a'] + 1",
                                inputs={"ctx": {
                                    "a": 41
                                }})
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
        rt.eval("n = 0\nwhile True:\n    n = n + 1", session="live"))
    await asyncio.sleep(0.3)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    # The killed worker took the session's heap with it, so the id is
    # dropped and the next eval gets a fresh worker rather than a dead one.
    assert "live" not in rt._eval_sessions
    again = await rt.eval("6 * 7", session="live")
    assert again.value == 42
    await rt.close()


def test_monty_append_falls_back_when_the_mount_has_no_append_op():
    """A mount without `append` keeps working, via the full flush.

    S3 registers `write` but not `append`, so dispatching the delta
    unconditionally would turn a working `open(path, "a")` into a hard
    failure on those mounts.
    """
    dispatch = FakeDispatch({"/s3/log.txt": b"a"}, supports_append=False)
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: ["/s3/"])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="for part in ['b', 'c']:\n"
                    "    with open('/s3/log.txt', 'a') as f:\n"
                    "        f.write(part)")))
    assert result.exit_code == 0, result.stderr
    assert dispatch.appends == []
    assert dispatch.files["/s3/log.txt"] == b"abc"
    # One probe per mount, not one per append.
    assert [p for p, _ in dispatch.writes] == ["/s3/log.txt", "/s3/log.txt"]


def test_monty_mkdir_forwards_parents_and_honors_exist_ok():
    dispatch = FakeDispatch({"/s3/a.txt": b"1"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: ["/s3/"])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/x/y').mkdir(parents=True)\n"
                    "Path('/s3/x/y').mkdir(exist_ok=True)\n"
                    "print('ok')")))
    assert result.exit_code == 0, result.stderr
    assert result.stdout == b"ok\n"
    assert dispatch.dirs == ["/s3/x/y"]
    assert dispatch.mkdir_kwargs == [{"parents": True}]


def test_monty_mkdir_without_exist_ok_raises_on_an_existing_dir():
    dispatch = FakeDispatch({"/s3/sub/a.txt": b"1"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: ["/s3/"])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/sub').mkdir()")))
    assert result.exit_code == 1
    assert b"FileExistsError" in result.stderr
    assert dispatch.dirs == []


def test_monty_mkdir_on_a_file_raises_even_under_exist_ok():
    """`exist_ok` forgives a directory, never a file.

    Pinned against CPython: `Path('a.txt').mkdir(exist_ok=True)` over a
    regular file raises FileExistsError, and only an existing directory
    is quiet.
    """
    dispatch = FakeDispatch({"/s3/a.txt": b"hi"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: ["/s3/"])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/a.txt').read_text()\n"
                    "Path('/s3/a.txt').mkdir(exist_ok=True)")))
    assert result.exit_code == 1
    assert b"FileExistsError" in result.stderr
    assert dispatch.dirs == []


def test_monty_mkdir_on_an_unread_mount_file_still_raises():
    """The file need not be in the tree yet for mkdir to refuse it."""
    dispatch = FakeDispatch({"/s3/a.txt": b"hi"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: ["/s3/"])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/a.txt').mkdir(exist_ok=True)")))
    assert result.exit_code == 1
    assert b"FileExistsError" in result.stderr
    assert dispatch.dirs == []


def test_monty_rename_across_mounts_raises_exdev():
    """The dispatcher resolves the mount from the source alone.

    Handing it a destination on another mount would delete the source
    and write the target into the wrong backend, so refuse the way
    POSIX does.
    """
    dispatch = FakeDispatch({"/a/f.txt": b"data"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: ["/a/", "/b/"])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/a/f.txt').rename('/b/f.txt')")))
    assert result.exit_code == 1
    assert dispatch.renamed == []
    assert dispatch.files["/a/f.txt"] == b"data"


def test_monty_rename_within_one_mount_still_dispatches():
    dispatch = FakeDispatch({"/a/f.txt": b"data"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, lambda: ["/a/", "/b/"])
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/a/f.txt').rename('/a/g.txt')")))
    assert result.exit_code == 0, result.stderr
    assert dispatch.renamed == [("/a/f.txt", "/a/g.txt")]


@pytest.mark.asyncio
async def test_monty_concurrent_first_use_shares_one_pool():
    """Two cold runs must not each build a pool.

    The loser of the race would be unreachable from close(), leaking
    its worker subprocesses.
    """
    runtime = MontyRuntime()
    pools: list[object] = []

    async def probe():
        pool = await runtime._ensure_pool()
        pools.append(pool)

    await asyncio.gather(probe(), probe(), probe())
    assert len({id(p) for p in pools}) == 1
    await runtime.close()


@pytest.mark.asyncio
async def test_monty_cancelled_eval_session_releases_its_checkout(monkeypatch):
    """A cancelled console session must hand its lease back.

    Dropping it from the session map alone leaves the pool holding a
    checkout that close() can no longer reach. Asserted on the release
    itself: one leaked lease would not exhaust a CPU-sized pool, so a
    later eval succeeding proves nothing.
    """
    import mirage.runtime.python.monty as monty_mod
    released: list[object] = []
    original = monty_mod._release

    async def spy(repl):
        released.append(repl)
        await original(repl)

    monkeypatch.setattr(monty_mod, "_release", spy)
    runtime = MontyRuntime()
    task = asyncio.create_task(
        runtime.eval("i = 0\nwhile True:\n    i += 1", session="s1"))
    await asyncio.sleep(0.4)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert "s1" not in runtime._eval_sessions
    assert len(released) == 1, "the cancelled checkout was never released"
    # And the runtime stays usable afterwards.
    result = await runtime.eval("1 + 1", session="s1")
    assert result.value == 2
    await runtime.close()
