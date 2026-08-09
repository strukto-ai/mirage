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
from __future__ import annotations

import asyncio
import logging
import os
import signal
from collections.abc import Sequence
from typing import Any, Callable

from mirage.runtime.config import RuntimeConfig
from mirage.runtime.errors import EvalError
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.python.monty.binding import pydantic_monty
from mirage.runtime.python.monty.constants import (DEFAULT_PROG,
                                                   INCOMPLETE_MARKERS,
                                                   MISSING_EXTRA_HINT)
from mirage.runtime.python.monty.osaccess import MirageOSAccess
from mirage.runtime.types import (DispatchFn, EvalResult, EvalValue,
                                  PrefixSource, RunArgs, RunResult,
                                  ScriptSource)

logger = logging.getLogger(__name__)


class MontyRuntime(PythonRuntime, EvaluatorMixin):
    """Run Python code on the Monty sandboxed interpreter.

    Code executes in Monty's Rust interpreter, inside a pooled worker
    subprocess: no host filesystem, environment, or network access, and
    an interpreter crash costs a worker rather than this process. File
    I/O and `os.environ` are serviced through the injected workspace
    dispatch, so the code sees the workspace mounts and nothing else.
    Command-line arguments are exposed as the `argv` global (`argv[0]`
    is the script name) and piped input as the `stdin` global (bytes,
    None when nothing was piped). Monty implements a Python subset;
    host-only features (`sys.stdin`, `sys.argv`, third-party imports)
    are unavailable, and the stdlib is json/re/math/datetime/typing —
    use the `local` runtime for those.
    """

    name = "monty"

    def __init__(
            self,
            captures: Sequence[str] | None = None,
            config: RuntimeConfig | dict[str, Any] | None = None,
            script: Callable[..., Any] | ScriptSource | None = None) -> None:
        if pydantic_monty is None:
            raise ImportError(MISSING_EXTRA_HINT)
        super().__init__(captures, config, script)
        self._workspace_dispatch: DispatchFn | None = None
        self._mount_prefixes: PrefixSource | None = None
        self._eval_sessions: dict[str, Any] = {}
        self._pool: Any = None
        self._pool_task: asyncio.Task[Any] | None = None

    def attach(self, dispatch: DispatchFn,
               mount_prefixes: PrefixSource) -> None:
        if self._workspace_dispatch is None:
            self._workspace_dispatch = dispatch
            self._mount_prefixes = mount_prefixes

    async def _ensure_pool(self) -> Any:
        """The runtime's worker pool, spawned on first use.

        One pool per runtime instance, which is one per workspace world:
        it keeps `request_timeout` and the process cap per workspace
        rather than global. The pool spawns `min_processes` workers
        eagerly and reuses one across sequential checkouts, so an idle
        workspace costs a single worker.

        Creation is cached as a task, not guarded by an `is None`
        check: two commands reaching a cold runtime together would both
        see no pool and both await `__aenter__`, and only the last
        assignment stays reachable, so `close()` could not stop the
        other pool's workers. Mirrors the TypeScript runtime's
        `poolPromise`.
        """
        if self._pool is not None:
            return self._pool
        if self._pool_task is None:
            self._pool_task = asyncio.ensure_future(self._open_pool())
        self._pool = await self._pool_task
        return self._pool

    async def _open_pool(self) -> Any:
        pool = pydantic_monty.AsyncMonty()
        await pool.__aenter__()
        return pool

    async def run(self, args: RunArgs) -> RunResult:
        # Execution lives in a monty worker subprocess (0.0.19 moved it
        # out of process so an interpreter crash cannot take the host
        # with it). feed_run awaits off the event loop, so the loop
        # stays free; a dead or timed-out worker surfaces as
        # MontyCrashedError and the pool replaces it.
        loop = asyncio.get_running_loop()
        collector = pydantic_monty.CollectStreams()
        bridge = MirageOSAccess(loop, self._workspace_dispatch, args.env,
                                self._mount_prefixes)
        pool = await self._ensure_pool()
        # argv[0] is the program's own name when the caller has one (a
        # CLI install's head word), else the interpreter's placeholder.
        argv = [args.prog or DEFAULT_PROG, *args.args]
        # Monty has no `sys.stdin`, so piped bytes ride in as a global
        # the same way argv does: raw bytes, None when nothing was piped.
        inputs = {"argv": argv, "stdin": args.stdin}
        try:
            async with pool.checkout() as session:
                # Read the pid before the turn starts: the getter reports
                # None while a turn is in flight, and cancelling the await
                # does NOT stop the worker (0.0.19 runs it in its own
                # process). Without the kill, a safeguard timeout would
                # report exit 124 and leave the worker spinning forever,
                # and pool teardown would block on it uninterruptibly.
                worker_pid = session.worker_pid
                try:
                    await session.feed_run(args.code,
                                           inputs=inputs,
                                           print_callback=collector,
                                           os=bridge)
                except asyncio.CancelledError:
                    _kill_worker(worker_pid)
                    raise
        except pydantic_monty.MontySyntaxError as exc:
            trace = exc.display(format="traceback") + "\n"
            return RunResult(stdout=b"", stderr=trace.encode(), exit_code=1)
        except pydantic_monty.MontyRuntimeError as exc:
            stdout, stderr = _split_streams(collector)
            trace = exc.display(format="traceback") + "\n"
            return RunResult(stdout=stdout,
                             stderr=(stderr or b"") + trace.encode(),
                             exit_code=1)
        except pydantic_monty.MontyCrashedError as exc:
            stdout, stderr = _split_streams(collector)
            reason = ("timed out" if exc.timed_out else "crashed")
            note = f"{self.name}: worker {reason}\n"
            return RunResult(stdout=stdout,
                             stderr=(stderr or b"") + note.encode(),
                             exit_code=1)
        stdout, stderr = _split_streams(collector)
        return RunResult(stdout=stdout, stderr=stderr, exit_code=0)

    async def eval(self,
                   code: str,
                   *,
                   inputs: dict[str, EvalValue] | None = None,
                   session: str | None = None) -> EvalResult:
        """Evaluate code; the last expression is the value.

        One-shot mode checks a worker out for the feed and hands it
        straight back; a session id keeps its own worker (heap and
        namespace) alive per id, which is the console. Inputs bind as
        globals via monty's native mechanism, and the code sees
        workspace files through the same bridge agent code uses. The
        value crosses the worker boundary as a converted Monty value:
        dicts, lists, strings, numbers, bools and None arrive as their
        Python equivalents, which is every shape a policy verdict
        takes.

        Args:
            code (str): the python source.
            inputs (dict[str, EvalValue] | None): named globals.
            session (str | None): console session id, None for
                one-shot.

        Raises:
            EvalError: the code failed to parse or raised; the
                message is monty's own traceback.
        """
        loop = asyncio.get_running_loop()
        collector = pydantic_monty.CollectStreams()
        bridge = MirageOSAccess(loop, self._workspace_dispatch, {},
                                self._mount_prefixes)
        pool = await self._ensure_pool()
        repl = self._eval_sessions.get(session) if session is not None \
            else None
        # A checked-out session owns a worker for its lifetime, so the
        # one-shot arm hands its worker back as soon as the feed ends
        # while a console session keeps its own until close().
        one_shot = repl is None and session is None
        if repl is None:
            repl = await pool.checkout().__aenter__()
            if session is not None:
                self._eval_sessions[session] = repl
        worker_pid = repl.worker_pid
        try:
            value = await repl.feed_run(code,
                                        inputs=dict(inputs or {}),
                                        print_callback=collector,
                                        os=bridge)
        except asyncio.CancelledError:
            # Same reclaim as run(): cancelling the await leaves the
            # worker running. A console session loses its heap with the
            # worker, so drop it and let the next eval check out a
            # fresh one rather than address a dead process.
            _kill_worker(worker_pid)
            if session is not None:
                self._eval_sessions.pop(session, None)
            # The checkout was entered by hand, so dropping the session
            # is not enough: without this the pool keeps a lease that
            # close() can no longer reach, and repeated cancellations
            # exhaust its capacity.
            await _release(repl)
            raise
        except pydantic_monty.MontySyntaxError as exc:
            trace = exc.display(format="traceback")
            # Console continuation, not a broken program: the source
            # merely stopped early (an open block or unclosed suite).
            incomplete = any(m in trace for m in INCOMPLETE_MARKERS)
            if session is not None:
                if incomplete:
                    return EvalResult(status="incomplete")
                return EvalResult(stderr=(trace + "\n").encode(), exit_code=1)
            raise EvalError(trace, syntax=True)
        except pydantic_monty.MontyRuntimeError as exc:
            trace = exc.display(format="traceback")
            if session is not None:
                stdout, stderr = _split_streams(collector)
                return EvalResult(stdout=stdout,
                                  stderr=(stderr or b"") +
                                  (trace + "\n").encode(),
                                  exit_code=1)
            raise EvalError(trace)
        finally:
            if one_shot:
                await repl.__aexit__(None, None, None)
        stdout, stderr = _split_streams(collector)
        return EvalResult(value=value, stdout=stdout, stderr=stderr)

    async def close(self) -> None:
        for repl in self._eval_sessions.values():
            await _release(repl)
        self._eval_sessions.clear()
        # A pool still being opened must be awaited before teardown, or
        # its workers outlive the runtime that asked for them.
        if self._pool is None and self._pool_task is not None:
            self._pool = await self._pool_task
        self._pool_task = None
        if self._pool is not None:
            await self._pool.__aexit__(None, None, None)
            self._pool = None


async def _release(repl: Any) -> None:
    """Hand a checked-out session back, even a poisoned one.

    Args:
        repl (Any): the checked-out monty session.
    """
    try:
        await repl.__aexit__(None, None, None)
    except Exception as exc:
        # The worker is already gone in the cancel path; the lease
        # still has to be returned, so note it and move on.
        logger.debug("monty session release failed: %s", exc)


def _kill_worker(pid: int | None) -> None:
    """Stop a monty worker whose turn was cancelled.

    Args:
        pid (int | None): the worker process id, None when the pool
            had not attached one yet.
    """
    if pid is None:
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        # Already gone: the turn finished between the cancel and here.
        logger.debug("monty worker %s already exited", pid)


def _split_streams(
        collector: pydantic_monty.CollectStreams
) -> tuple[bytes, bytes | None]:
    out: list[str] = []
    err: list[str] = []
    for stream, text in collector.output:
        if stream == "stderr":
            err.append(text)
        else:
            out.append(text)
    stderr = "".join(err).encode() if err else None
    return "".join(out).encode(), stderr
