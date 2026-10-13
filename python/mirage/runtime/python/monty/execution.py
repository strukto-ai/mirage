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
from typing import Any

from mirage.runtime.python.execution import main_filename
from mirage.runtime.python.monty.constants import DEFAULT_PROG, LIMITS
from mirage.runtime.python.monty.fs import MontyFs
from mirage.runtime.python.monty.loader import pydantic_monty
from mirage.runtime.types import RunArgs, RunResult

logger = logging.getLogger(__name__)


class MontyExecution:
    """Runs on one runtime's pooled monty workers.

    Args:
        max_memory (int | None): the heap one run may use, in bytes;
            None for no cap.
    """

    name = "monty"

    def __init__(self, max_memory: int | None = None) -> None:
        self._limits: dict[str, int] = (
            LIMITS
            if max_memory is None
            else {**LIMITS, "max_memory": max_memory}
        )
        self._pool: Any = None
        self._pool_task: asyncio.Task[Any] | None = None

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

    async def run(self, args: RunArgs, fs: MontyFs) -> RunResult:
        # Execution lives in a monty worker subprocess (0.0.19 moved it
        # out of process so an interpreter crash cannot take the host
        # with it). feed_run awaits off the event loop, so the loop
        # stays free; a dead or timed-out worker surfaces as
        # MontyCrashedError and the pool replaces it.
        collector = pydantic_monty.CollectStreams()
        pool = await self._ensure_pool()
        # argv[0] is the program's own name when the caller has one (a
        # CLI install's head word), else the interpreter's placeholder.
        # `is None`, not falsy: "" is CPython's own argv[0] for a
        # program piped in with no operand, so an empty prog is an
        # answer rather than an absent one.
        prog = args.prog if args.prog is not None else DEFAULT_PROG
        argv = [prog, *args.args]
        # Monty has no `sys.stdin`, so piped bytes ride in as a global
        # the same way argv does: raw bytes, None when nothing was piped.
        inputs = {"argv": argv, "stdin": args.stdin}
        cwd = args.cwd.virtual if args.cwd is not None else None
        # A script is Monty's own script_name, which it keeps the last
        # part of for `__file__`, under the directory a feed starts in.
        checkout = (
            pool.checkout(limits=self._limits)
            if args.script_path is None
            else pool.checkout(
                script_name=main_filename(args), limits=self._limits
            )
        )
        try:
            async with checkout as session:
                # Read the pid before the turn starts: the getter reports
                # None while a turn is in flight, and cancelling the await
                # does NOT stop the worker (0.0.19 runs it in its own
                # process). Without the kill, a safeguard timeout would
                # report exit 124 and leave the worker spinning forever,
                # and pool teardown would block on it uninterruptibly.
                worker_pid = session.worker_pid
                try:
                    await session.feed_run(
                        args.code,
                        inputs=inputs,
                        print_callback=collector,
                        cwd=cwd,
                        os=fs,
                    )
                except asyncio.CancelledError:
                    _kill_worker(worker_pid)
                    raise
        except pydantic_monty.MontySyntaxError as exc:
            trace = exc.display(format="traceback") + "\n"
            return RunResult(stdout=b"", stderr=trace.encode(), exit_code=1)
        except pydantic_monty.MontyRuntimeError as exc:
            stdout, stderr = _split_streams(collector)
            trace = exc.display(format="traceback") + "\n"
            return RunResult(
                stdout=stdout,
                stderr=(stderr or b"") + trace.encode(),
                exit_code=1,
            )
        except pydantic_monty.MontyCrashedError as exc:
            stdout, stderr = _split_streams(collector)
            reason = "timed out" if exc.timed_out else "crashed"
            note = f"{self.name}: worker {reason}\n"
            return RunResult(
                stdout=stdout,
                stderr=(stderr or b"") + note.encode(),
                exit_code=1,
            )
        stdout, stderr = _split_streams(collector)
        return RunResult(stdout=stdout, stderr=stderr, exit_code=0)

    async def close(self) -> None:
        # A pool still being opened must be awaited before teardown, or
        # its workers outlive the runtime that asked for them.
        if self._pool is None and self._pool_task is not None:
            self._pool = await self._pool_task
        self._pool_task = None
        if self._pool is not None:
            await self._pool.__aexit__(None, None, None)
            self._pool = None


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
    collector: pydantic_monty.CollectStreams,
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
