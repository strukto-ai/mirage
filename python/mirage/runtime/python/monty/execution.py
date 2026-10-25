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
import concurrent.futures
import logging
import os
import signal
from typing import Any

from mirage.io.types import materialize
from mirage.runtime.python.execution import main_filename
from mirage.runtime.python.monty.constants import DEFAULT_PROG, LIMITS
from mirage.runtime.python.monty.fs import MontyFs
from mirage.runtime.python.monty.loader import pydantic_monty
from mirage.runtime.types import OutputFn, Program, RunResult
from mirage.types import PathSpec

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
        opening = self._pool_task
        try:
            self._pool = await opening
        except BaseException:
            if self._pool_task is opening:
                self._pool_task = None
            raise
        return self._pool

    async def _open_pool(self) -> Any:
        pool = pydantic_monty.AsyncMonty()
        await pool.__aenter__()
        return pool

    async def run(
        self,
        program: Program,
        cwd: PathSpec | None,
        fs: MontyFs,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        """Run one program on a pooled worker.

        Args:
            program (Program): the source and argv to run.
            cwd (PathSpec | None): the directory a feed starts in.
            fs (MontyFs): the files the program reaches.
            output (OutputFn | None): receives stdout as it is printed;
                None returns it in the result.
            errors (OutputFn | None): the same for stderr.
        """
        prints = _Prints(output, errors)
        code, note = await self._feed(program, cwd, fs, prints)
        stdout, stderr = prints.streams()
        if note:
            stderr = (stderr or b"") + note
        return RunResult(stdout=stdout, stderr=stderr, exit_code=code)

    async def _feed(
        self,
        program: Program,
        cwd: PathSpec | None,
        fs: MontyFs,
        prints: _Prints,
    ) -> tuple[int, bytes]:
        """Feed the program to a worker; its status and what to add to
        its stderr.

        Args:
            program (Program): the source and argv to run.
            cwd (PathSpec | None): the directory a feed starts in.
            fs (MontyFs): the files the program reaches.
            prints (_Prints): where its prints go.
        """
        # Execution lives in a monty worker subprocess (0.0.19 moved it
        # out of process so an interpreter crash cannot take the host
        # with it). feed_run awaits off the event loop, so the loop
        # stays free; a dead or timed-out worker surfaces as
        # MontyCrashedError and the pool replaces it.
        pool = await self._ensure_pool()
        # argv[0] is the program's own name when the caller has one (a
        # CLI install's head word), else the interpreter's placeholder.
        # `is None`, not falsy: "" is CPython's own argv[0] for a
        # program piped in with no operand, so an empty prog is an
        # answer rather than an absent one.
        prog = program.prog if program.prog is not None else DEFAULT_PROG
        argv = [prog, *program.args]
        # Monty has no `sys.stdin`, so piped bytes ride in as a global
        # the same way argv does: raw bytes, None when nothing was piped.
        stdin = (
            None if program.stdin is None else await materialize(program.stdin)
        )
        inputs = {"argv": argv, "stdin": stdin}
        start = cwd.virtual if cwd is not None else None
        # A script is Monty's own script_name, which it keeps the last
        # part of for `__file__`, under the directory a feed starts in.
        checkout = pool.checkout(
            limits=self._limits,
            assert_message_annotations=False,
            os_policy={"sleep_system_max": float("inf")},
            **(
                {"script_name": main_filename(program, cwd)}
                if program.script_path is not None
                else {}
            ),
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
                        program.code,
                        inputs=inputs,
                        print_callback=prints,
                        cwd=start,
                        os=fs,
                    )
                except asyncio.CancelledError:
                    _kill_worker(worker_pid)
                    # The checkout's exit waits for the turn, which may be
                    # waiting on a print its sink holds: release it first.
                    await prints.stop()
                    raise
        except pydantic_monty.MontySyntaxError as exc:
            return 1, (exc.display(format="traceback") + "\n").encode()
        except pydantic_monty.MontyRuntimeError as exc:
            if isinstance(exc.exception(), SystemExit):
                message = exc.display(format="msg")
                if message:
                    return 1, (message + "\n").encode()
                return 0, b""
            return 1, (exc.display(format="traceback") + "\n").encode()
        except pydantic_monty.MontyCrashedError as exc:
            reason = "timed out" if exc.timed_out else "crashed"
            return 1, f"{self.name}: worker {reason}\n".encode()
        return 0, b""

    async def close(self) -> None:
        # A pool still being opened must be awaited before teardown, or
        # its workers outlive the runtime that asked for them. One that
        # fails to open has nothing to close; the command that asked
        # already reported it.
        if self._pool is None and self._pool_task is not None:
            try:
                self._pool = await self._pool_task
            except Exception as exc:
                logger.debug(
                    "monty pool being opened at close failed: %s", exc
                )
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


class _Prints:
    """What a program prints, in the order it printed it: each write
    handed to its stream's sink as it comes, or kept for the result where
    the stream has none.

    Monty calls back from a thread of its own and goes on only once the
    callback returns, so a write for a sink waits there until the loop
    has handed it on: a reader that falls behind holds the program back,
    as a full pipe would. One write waits at a time, and ``stop``
    cancels it when the run is cancelled, so neither it nor the callback
    outlives the run.

    Args:
        output (OutputFn | None): where stdout goes; None keeps it.
        errors (OutputFn | None): where stderr goes; None keeps it.
    """

    def __init__(
        self, output: OutputFn | None, errors: OutputFn | None
    ) -> None:
        self._sinks = {"stdout": output, "stderr": errors}
        self._kept: dict[str, list[str]] = {"stdout": [], "stderr": []}
        self._loop = asyncio.get_running_loop()
        self._writing: concurrent.futures.Future[None] | None = None
        self._handing: asyncio.Task[Any] | None = None
        self._stopped = False

    def __call__(self, stream: str, text: str) -> None:
        sink = self._sinks.get(stream)
        if sink is None:
            self._kept.setdefault(stream, []).append(text)
            return
        self._writing = asyncio.run_coroutine_threadsafe(
            self._hand(sink, text.encode()), self._loop
        )
        if self._stopped:
            self._writing.cancel()
        self._writing.result()

    async def _hand(self, sink: OutputFn, data: bytes) -> None:
        self._handing = asyncio.current_task()
        await sink(data)

    async def stop(self) -> None:
        """Cancel the write still waiting on its sink, then wait for it."""
        self._stopped = True
        if self._writing is not None:
            self._writing.cancel()
        if self._handing is not None:
            await asyncio.gather(self._handing, return_exceptions=True)

    def streams(self) -> tuple[bytes, bytes | None]:
        """The stdout and stderr kept for the result, None for no stderr."""
        err = self._kept["stderr"]
        stderr = "".join(err).encode() if err else None
        return "".join(self._kept["stdout"]).encode(), stderr
