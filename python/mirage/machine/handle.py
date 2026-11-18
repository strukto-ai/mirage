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
import logging
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from importlib import import_module
from time import monotonic
from types import ModuleType
from typing import Any, ClassVar

from mirage.commands.config import Context
from mirage.context.session_context import current_caller
from mirage.execution.job.constants import HANGUP_EXIT_CODE
from mirage.execution.machine.types import MachineProcess
from mirage.execution.process.types import ProcessUsage
from mirage.execution.types import MachineName, MachinePid, MachineResources
from mirage.io.errors import PipeClosed
from mirage.io.types import ByteSource
from mirage.machine.config import MachineConfig, check_mount_type
from mirage.machine.constants import (
    CHECK_LINE,
    CHECK_MARK,
    CHECK_WAIT_SECONDS,
    EXIT_DIGITS,
    FAKETIME_PROBE_SECONDS,
    MACHINE_STOP_WAIT_SECONDS,
    NOT_RUNNING_STATUS,
    PIPE_SIGNAL,
    RESOURCE_WAIT_SECONDS,
    RUN_DRAIN_SECONDS,
    RUN_PID_HOLD,
    RUN_PID_MARK,
    SCAN_FACTS_MARK,
    SCAN_MARK,
    SCAN_WAIT_SECONDS,
    STOP_POLL_SECONDS,
    faketime_env,
    faketime_probe,
    resources_line,
    run_argv,
    run_done_mark,
    run_exit_mark,
    scan_line,
    signal_line,
    stop_line,
)
from mirage.machine.errors import ConnectionLostError
from mirage.machine.mixin import PipeTransportMixin
from mirage.machine.mounts import MachineMounts
from mirage.machine.resources import parse_resources
from mirage.machine.types import MachineMemory, RunStatus, ScanFacts
from mirage.runtime.binding import WorkspaceBinding, answer_of
from mirage.runtime.constants import sdk_install_hint
from mirage.runtime.types import OutputFn, RunAnswer, RunResult
from mirage.shell.constants import CANNOT_EXECUTE_STATUS
from mirage.utils.clock import bound_system_clock
from mirage.utils.quote import shell_quote

logger = logging.getLogger(__name__)


class PidLineFilter:
    """One stream of a run with the pid line its wrapper writes ahead of
    the program (``RUN_PID_MARK``) taken out, and the pid and start the
    line gives handed to ``found``.

    stderr may carry the exec client's own words ahead of the line, so
    there it is looked for within ``RUN_PID_HOLD`` bytes, which wait until
    it shows; stdout carries it only where the exec returns the two
    streams joined, at its very start, so there only what can still
    begin it waits. Once it is out, or can no longer come, everything
    passes as it arrives.

    Args:
        sink (OutputFn): receives the stream without the line.
        found (Callable[[RunStatus], None]): told what the line says.
        search (bool): look for the line past the stream's start.
    """

    def __init__(
        self,
        sink: OutputFn,
        found: Callable[[RunStatus], None],
        search: bool,
    ) -> None:
        self._sink = sink
        self._found = found
        self._search = search
        self._held = bytearray()
        self._passing = False

    async def write(self, data: bytes) -> None:
        """Pass on what can no longer be, or hold, the pid line.

        Args:
            data (bytes): the stream's next bytes.
        """
        if not self._passing:
            self._held += data
            data = self._take()
        if data:
            await self._sink(data)

    async def finish(self) -> None:
        """Pass on what is still held once the stream has ended."""
        held = bytes(self._held)
        self._held.clear()
        self._passing = True
        if held:
            await self._sink(held)

    def _take(self) -> bytes:
        """What is held, less the pid line, once the line is out or can
        no longer come; nothing while it still may."""
        held = bytes(self._held)
        if self._search:
            at = held.find(RUN_PID_MARK)
        else:
            at = 0 if held.startswith(RUN_PID_MARK) else -1
        end = held.find(b"\n", at) if at >= 0 else -1
        if end >= 0:
            report = _parse_pid(
                held[at + len(RUN_PID_MARK) : end].decode(errors="replace")
            )
            if report is not None:
                self._found(report)
            held = held[:at] + held[end + 1 :]
        elif len(held) < RUN_PID_HOLD and (
            at >= 0 or self._search or RUN_PID_MARK.startswith(held)
        ):
            return b""
        self._held.clear()
        self._passing = True
        return held


class ExitLineFilter:
    """One stream of a run with the exit line its wrapper writes once the
    program has exited (``run_exit_mark``) taken out, and the status the
    line gives handed to ``ended``.

    Only an ending that can still become the line is held; everything
    else passes as it arrives, what the program left running included.
    The status is told once the bytes written with the line have been
    passed on, so a reader slow to take the program's last output (a
    transport that answers whole, the line inside it) never has the run
    let go while that output is still on its way.

    Args:
        sink (OutputFn): receives the stream without the line.
        ended (Callable[[int], None]): told the program's exit status.
        mark (bytes): what the run's exit line starts with.
    """

    def __init__(
        self, sink: OutputFn, ended: Callable[[int], None], mark: bytes
    ) -> None:
        self._sink = sink
        self._ended = ended
        self._mark = mark
        self._held = b""
        self._passing = False
        self._status: int | None = None

    async def write(self, data: bytes) -> None:
        """Pass on what can no longer be, or hold, the exit line.

        Args:
            data (bytes): the stream's next bytes.
        """
        if not self._passing:
            held, self._held = self._held + data, b""
            data = self._take(held)
        try:
            if data:
                await self._sink(data)
        finally:
            if self._status is not None:
                status, self._status = self._status, None
                self._ended(status)

    async def finish(self) -> None:
        """Pass on what is still held once the stream has ended."""
        held, self._held = self._held, b""
        self._passing = True
        if held:
            await self._sink(held)

    def _take(self, held: bytes) -> bytes:
        """What is held, less the exit line once it is out, and less an
        ending that may still become it, which stays held.

        Args:
            held (bytes): what is held so far.
        """
        out = bytearray()
        while (at := held.find(self._mark)) >= 0:
            rest = held[at + len(self._mark) :]
            digits = len(rest) - len(rest.lstrip(b"0123456789"))
            if (
                0 < digits <= EXIT_DIGITS
                and rest[digits : digits + 1] == b"\n"
            ):
                self._passing = True
                self._status = int(rest[:digits])
                return bytes(out + held[:at] + rest[digits + 1 :])
            if digits == len(rest) and digits <= EXIT_DIGITS:
                self._held = held[at:]
                return bytes(out + held[:at])
            out += held[: at + 1]
            held = held[at + 1 :]
        keep = next(
            (
                size
                for size in range(min(len(held), len(self._mark) - 1), 0, -1)
                if self._mark.startswith(held[-size:])
            ),
            0,
        )
        self._held = held[len(held) - keep :]
        return bytes(out + held[: len(held) - keep])


class OutputWatch:
    """How long a run's output has been quiet. A chunk still being handed
    to its sink counts as moving until the sink takes it, so a reader slow
    to take what the program wrote never makes the output quiet.
    """

    def __init__(self) -> None:
        self._busy = 0
        self._moved = monotonic()

    def watched(self, sink: OutputFn) -> OutputFn:
        """``sink``, with each chunk handed to it counted as moving.

        Args:
            sink (OutputFn): where the stream goes.
        """

        async def write(data: bytes) -> None:
            self._busy += 1
            self._moved = monotonic()
            try:
                await sink(data)
            finally:
                self._busy -= 1
                self._moved = monotonic()

        return write

    def quiet(self) -> float:
        """Seconds since the output last moved; 0 while a chunk is still
        being handed on."""
        return 0.0 if self._busy else monotonic() - self._moved


class MachineHandle:
    """One machine a workspace runs programs on, reached through its
    provider: the live connection, held once per workspace.

    You bring your own machine (a running container, a live Daytona or
    E2B machine, an SSH host) and its config says how to reach it, or,
    for a provider that can start one, the config says what to start and
    Mirage starts it at the first run that needs it
    (``started_by_mirage``): kept in the workspace's memory
    (``bind_memory``) so a later build reaches the same one, paused as the
    workspace closes and removed as it is deleted (``destroy``). A machine
    you brought is never removed. The workspace reaches the
    machine at the same prefixes as the host's, so the session cwd and
    every path in a line resolve unchanged: a machine with a
    ``mount_type`` is served them (MachineMounts), otherwise serve them
    inside it yourself (``mirage workspace create`` in the image
    entrypoint or by hand). Subclasses adapt one provider by
    implementing connect() and _exec_argv(), and PipeTransportMixin for
    a ``mount_type``; everything Mirage does there derives from
    _exec_argv: a program's run (``run``), a stop by tag (``stop``), the
    libfaketime probe. Constructed from the name the workspace gives it
    and its config, coerced through the provider's own config class.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (MachineConfig | dict[str, Any] | None): how to reach it.
    """

    provider: ClassVar[str]
    config_cls: ClassVar[type[MachineConfig]] = MachineConfig
    # Whether ``_pause_machine`` pauses; only then does close wait for a
    # connect under way, which an unbounded connect would otherwise hold.
    pauses: ClassVar[bool] = False
    # Whether the machine's exec takes input. One that takes none
    # (Daytona) refuses a line given any before it runs, and a program
    # that reads a process substitution, which would need feeding.
    takes_input: ClassVar[bool] = True
    # Whether the machine's exec hands stderr back joined into stdout
    # (Daytona), so a run's pid and exit lines arrive on its stdout.
    joins_streams: ClassVar[bool] = False
    config: MachineConfig

    def __init__(
        self,
        name: str,
        config: MachineConfig | dict[str, Any] | None = None,
    ) -> None:
        self.name = name
        self.config = self.config_cls.coerce(config)
        # Connect-once latch: the first run connects; later runs just
        # execute. A failed connect leaves it unset so the next run
        # retries.
        self._connected = False
        self._connect_lock = asyncio.Lock()
        # Set by a provider's connect that reached the machine; close hands
        # it to ``_pausable`` for the pause after.
        self._reached = False
        self._pausable = False
        # Where the workspace keeps the machines Mirage started for it;
        # None for a handle no workspace bound.
        self._memory: MachineMemory | None = None
        # Whether Mirage started the machine this handle reaches (or
        # recalled one it started) rather than the user bringing it: set by
        # a provider that starts machines.
        self._started_here = False
        self._mounts: MachineMounts | None = None
        # The libfaketime the machine holds, asked once the first program
        # runs there under a system_time: None for none. Its first runs
        # share one probe; a failed probe is not kept, so a later run
        # asks again.
        self._faketime: str | None = None
        self._faketime_known = False
        self._faketime_lock = asyncio.Lock()
        # The runs executing here right now; a scan asks only a machine
        # with one, or with processes an earlier scan found.
        self._executing = 0
        # The work Mirage has under way here: programs' runs, its own
        # lines and stops, but not the pipe that serves the workspace
        # (``_at_work``).
        self._working = 0
        # Set once the provider's ``_became_busy`` for the work under way
        # has run: every piece of it waits for that, not only the one that
        # started it.
        self._waking: asyncio.Event | None = None
        # Whether the machine has a program, by name, asked once each.
        self._programs: dict[str, bool] = {}
        check_mount_type(self.provider, self.config.mount_type)
        if self.config.mount_type is not None:
            if not isinstance(self, PipeTransportMixin):
                raise ValueError(
                    f"{self.provider}: mount_type needs a pipe transport"
                )
            self._mounts = MachineMounts(
                self.provider,
                self.name,
                self.config.mount_type,
                self._setup,
                self.open_pipe,
                lambda: self._working > 0,
            )

    def _load_sdk(
        self, package: str, shape: type, needs: str | None = None
    ) -> ModuleType:
        try:
            module = import_module(package)
        except ModuleNotFoundError as exc:
            if exc.name != package:
                raise
            raise ImportError(sdk_install_hint(self.provider, needs)) from exc
        if not isinstance(module, shape):
            raise ImportError(
                f"the {self.provider} runtime needs a compatible {package} SDK"
            )
        return module

    @property
    def machine(self) -> MachineName:
        """The machine's name with its provider, ``<provider>:<name>``."""
        return MachineName(self.provider, self.name)

    @property
    def instance(self) -> str:
        """What the provider calls the machine: its container, sandbox,
        pod or host there. Its name, for a provider that says nothing."""
        return self.name

    def bind_memory(self, memory: MachineMemory) -> None:
        """Give the handle where its workspace keeps the machines Mirage
        started, so a provider that starts one reaches the same machine on
        a later build.

        Args:
            memory (MachineMemory): the workspace's memory of the machines
                it started.
        """
        self._memory = memory

    @property
    def started_by_mirage(self) -> bool:
        """Whether Mirage started the machine this handle reaches, rather
        than the user bringing it: its workspace pauses it as it closes and
        removes it as it is deleted. False until a connect starts or
        recalls one."""
        return self._started_here

    async def destroy(self) -> None:
        """Remove the machine Mirage started for this handle, as its
        workspace is deleted, and forget it; one the user brought stays. A
        provider that starts machines overrides this."""

    def file_effects_dispatched(
        self, binding: WorkspaceBinding | None
    ) -> bool:
        """Whether every file a program here writes goes through the
        workspace's dispatch: the machine is served every prefix, so a
        write lands as the session's own op.

        Args:
            binding (WorkspaceBinding | None): the workspace the runs
                serve.
        """
        return (
            self._mounts is not None
            and self._mounts.file_effects_dispatched
            and binding is not None
            and binding.mount_prefixes is not None
            and "/" not in binding.mount_prefixes()
        )

    def serves_session(self, restricted_mounts: tuple[str, ...]) -> bool:
        """Whether the machine is served the session's restricted view,
        so a run there keeps its hides and modes.

        Args:
            restricted_mounts (tuple[str, ...]): the prefixes a rule
                restricts.
        """
        return self._mounts is not None and all(
            prefix.rstrip("/") not in ("", "/dev")
            for prefix in restricted_mounts
        )

    async def settle(self) -> None:
        """Land what a line's program left, however the line ended. Its
        exit reported the landings that failed then; one that fails only
        here (the deadline stopped the program or its exit's landing) is
        logged."""
        if self._mounts is not None:
            for lost in await self._mounts.sync():
                logger.warning("%s", lost)

    async def run(
        self,
        argv: tuple[str, ...],
        ctx: Context,
        binding: WorkspaceBinding | None,
        output: OutputFn,
        errors: OutputFn,
    ) -> RunResult:
        """Connect once, validate the line, run it, then land what sshfs
        acknowledged, failing the run with a landing that failed. The
        machine has work from before it connects until the landing ends
        (``_at_work``).

        Args:
            argv (tuple[str, ...]): the program and its arguments.
            ctx (Context): the run's stdin, environment and cwd.
            binding (WorkspaceBinding | None): the workspace the run
                serves, whose mounts the machine is served.
            output (OutputFn): receives stdout as it arrives.
            errors (OutputFn): receives stderr as it arrives.
        """
        async with self._at_work():
            return await self._run_here(argv, ctx, binding, output, errors)

    async def _run_here(
        self,
        argv: tuple[str, ...],
        ctx: Context,
        binding: WorkspaceBinding | None,
        output: OutputFn,
        errors: OutputFn,
    ) -> RunResult:
        """``run``'s body, inside its work.

        Args:
            argv (tuple[str, ...]): the program and its arguments.
            ctx (Context): the run's stdin, environment and cwd.
            binding (WorkspaceBinding | None): the workspace the run
                serves.
            output (OutputFn): receives stdout as it arrives.
            errors (OutputFn): receives stderr as it arrives.
        """
        await self.ensure_connected()
        run = argv
        if self._mounts is not None:
            refusal = await self._mounts.validate(
                binding, ctx.cwd.virtual, errors
            )
            if refusal is not None:
                return refusal
            run = self._mounts.guarded(argv)
        given = {**self.config.env, **(ctx.env or {})}
        clock = await self._system_time_env(given)
        # The run is the process it runs as, which its tag names; one run
        # outside a process gets a tag of its own.
        runner = current_caller().process
        tag = str(runner.record.id) if runner is not None else uuid.uuid4().hex
        nonce = uuid.uuid4().hex
        mark = run_exit_mark(nonce)
        reported: list[RunStatus] = []

        def found(report: RunStatus) -> None:
            if reported:
                return
            reported.append(report)
            if runner is not None and report.started is not None:
                runner.set_machine_pid(MachinePid(report.pid, report.started))

        loop = asyncio.get_running_loop()
        ended: asyncio.Future[int] = loop.create_future()
        drained: asyncio.Future[int] = loop.create_future()

        def exited(code: int) -> None:
            if not ended.done():
                ended.set_result(code)

        def delivered(code: int) -> None:
            if not drained.done():
                drained.set_result(code)

        pid_line = PidLineFilter(errors, found, search=True)
        exit_line = ExitLineFilter(pid_line.write, exited, mark)
        done_line = ExitLineFilter(output, delivered, run_done_mark(nonce))
        filters: list[ExitLineFilter | PidLineFilter] = [
            exit_line,
            pid_line,
            done_line,
        ]
        sink = done_line.write
        if self.joins_streams:
            out_pid = PidLineFilter(done_line.write, found, search=False)
            out_exit = ExitLineFilter(out_pid.write, exited, mark)
            filters = [out_exit, out_pid, *filters]
            sink = out_exit.write
        watch = OutputWatch()
        self._executing += 1
        execution = asyncio.ensure_future(
            self._exec_argv(
                run_argv(tag, nonce, run),
                ctx.stdin,
                {**given, **clock},
                ctx.cwd.virtual,
                watch.watched(sink),
                watch.watched(exit_line.write),
            )
        )
        try:
            done = await self._outcome(execution, ended, drained, watch)
            for line_filter in filters:
                await line_filter.finish()
        except asyncio.CancelledError:
            execution.cancel()
            await asyncio.gather(execution, return_exceptions=True)
            signum = None
            if runner is not None:
                signum = (
                    runner.signal
                    if runner.signal is not None
                    else runner.interrupted
                )
            await asyncio.shield(self.stop(tag, signum or 15))
            raise
        except PipeClosed:
            await asyncio.shield(self.stop(tag, PIPE_SIGNAL))
            raise
        except ConnectionLostError:
            logger.debug("%s: connection lost", self.machine, exc_info=True)
            if runner is not None:
                runner.program_signaled(HANGUP_EXIT_CODE - 128)
            for line_filter in filters:
                await line_filter.finish()
            await errors(f"mirage: {self.machine}: connection lost\n".encode())
            done = RunResult(exit_code=HANGUP_EXIT_CODE)
        finally:
            self._executing -= 1
        if self._mounts is None:
            return done
        if done.exit_code == CANNOT_EXECUTE_STATUS:
            self._mounts.forget()
        # sshfs acknowledged the writes before they landed.
        lost = await self._mounts.land()
        if not lost:
            return done
        await errors("".join(f"{line}\n" for line in lost).encode())
        return RunResult(exit_code=done.exit_code or 1)

    async def _outcome(
        self,
        execution: asyncio.Future[RunResult],
        ended: asyncio.Future[int],
        drained: asyncio.Future[int],
        watch: OutputWatch,
    ) -> RunResult:
        """How a run ended: its exec's answer, or, when its exit line
        says its program has exited while the exec stays open because
        something the program left running holds its output, the status
        the line gave. The exec is kept until the line that ends the
        program's stdout has been handed on (``drained``), so output a slow
        reader is still taking all arrives, then let go after
        ``RUN_DRAIN_SECONDS``, and what the program left running stays. A
        stdout that never brings that line is waited on only until it has
        been quiet that long.

        Args:
            execution (asyncio.Future[RunResult]): the exec.
            ended (asyncio.Future[int]): the status the exit line gave.
            drained (asyncio.Future[int]): told once the program's stdout
                has all been handed on.
            watch (OutputWatch): how long the run's output has been quiet.
        """
        either: set[asyncio.Future[Any]] = {execution, ended}
        await asyncio.wait(either, return_when=asyncio.FIRST_COMPLETED)
        held: set[asyncio.Future[Any]] = {execution, drained}
        while not execution.done() and not drained.done():
            quiet = watch.quiet()
            if quiet >= RUN_DRAIN_SECONDS:
                break
            await asyncio.wait(
                held,
                timeout=max(RUN_DRAIN_SECONDS - quiet, STOP_POLL_SECONDS),
                return_when=asyncio.FIRST_COMPLETED,
            )
        if drained.done() and not execution.done():
            await asyncio.wait({execution}, timeout=RUN_DRAIN_SECONDS)
        if execution.done():
            return execution.result()
        execution.cancel()
        await asyncio.gather(execution, return_exceptions=True)
        return RunResult(exit_code=ended.result())

    async def input_refused(self, errors: OutputFn) -> RunResult:
        """What a line that needs input answers on a machine that takes
        none (``takes_input``): 126, with why.

        Args:
            errors (OutputFn): where why is said.
        """
        await errors(
            f"mirage: {self.machine}: the machine takes no input\n".encode()
        )
        return RunResult(exit_code=CANNOT_EXECUTE_STATUS)

    async def check(self) -> bool:
        """Reach the machine and run the check line (``CHECK_LINE``),
        within ``CHECK_WAIT_SECONDS``.

        Returns:
            bool: True when Mirage can see and stop every process a
            program here starts; False when only what it started itself.

        Raises:
            Exception: the machine could not be reached in time, or no
                shell there ran the line (a stopped container).
        """
        ran = await self._connected_line(CHECK_LINE, CHECK_WAIT_SECONDS)
        if CHECK_MARK.encode() not in ran.stdout:
            raise RuntimeError(
                f"{self.machine}: check did not run: exit {ran.exit_code}"
            )
        return ran.exit_code == 0

    @property
    def executing(self) -> bool:
        """Whether a run is executing on the machine right now."""
        return self._executing > 0

    async def status(self, workspace: str) -> list[MachineProcess]:
        """Every process the runs of ``workspace`` started on the
        machine, as one scan (``scan_line``) finds them now, within
        ``SCAN_WAIT_SECONDS``.

        Args:
            workspace (str): the workspace's id.

        Raises:
            Exception: the machine could not be reached, or the scan
                failed.
        """
        done = await self._connected_line(
            scan_line(workspace), SCAN_WAIT_SECONDS
        )
        if done.exit_code != 0:
            raise RuntimeError(f"{self.machine}: scan exited {done.exit_code}")
        return _parse_scan(done.stdout)

    async def resources(self, cpu: bool) -> MachineResources:
        """What the machine holds now (``resources_line``), within
        ``RESOURCE_WAIT_SECONDS``.

        Args:
            cpu (bool): read the processors' time and the process
                states too, which takes ``CPU_SAMPLE_SECONDS``.

        Raises:
            Exception: the machine could not be reached, or what it
                printed does not read.
        """
        done = await self._connected_line(
            resources_line(cpu), RESOURCE_WAIT_SECONDS
        )
        if done.exit_code != 0:
            raise RuntimeError(f"{self.machine}: read exited {done.exit_code}")
        return parse_resources(
            done.stdout.decode(errors="replace"), str(self.machine)
        )

    async def signal(self, target: str | MachinePid, signum: int) -> bool:
        """Send ``signum`` to one process on the machine, as ``kill``
        sent it (``signal_line``): the program a run's tag names, or the
        process a MachinePid names while it is the one that started
        then. Connecting and sending are bounded as a stop is
        (``MACHINE_STOP_WAIT_SECONDS``).

        Args:
            target (str | MachinePid): the run's tag, or the process.
            signum (int): the signal.

        Returns:
            bool: True once sent; False when no such process runs there.

        Raises:
            Exception: the machine could not be reached, or the line
                failed.
        """
        done = await self._connected_line(
            signal_line(target, signum), MACHINE_STOP_WAIT_SECONDS
        )
        if done.exit_code not in (0, NOT_RUNNING_STATUS):
            raise RuntimeError(
                f"{self.machine}: signal {signum} not sent: exit {done.exit_code}"
            )
        return done.exit_code == 0

    async def stop(self, tag: str, signum: int) -> bool:
        """Stop a run: every process its ``PROCESS`` tag marks gets
        ``signum``, then KILL a second later. Connecting and stopping
        take at most ``MACHINE_STOP_WAIT_SECONDS``, so a machine that
        stopped answering never holds a cancel or an error.

        Args:
            tag (str): the id of the process the run is, as ``PROCESS``
                carries it.
            signum (int): the first signal.

        Returns:
            bool: True once the machine held the run's processes and they
            were stopped; False when it holds none of them, could not be
            reached, or the stop failed.
        """
        try:
            async with asyncio.timeout(MACHINE_STOP_WAIT_SECONDS):
                await self.ensure_connected()
                async with self._at_work():
                    done = await answer_of(
                        lambda output, errors: self._exec_argv(
                            ("/bin/sh", "-c", stop_line(tag, signum)),
                            None,
                            dict(self.config.env),
                            "/",
                            output,
                            errors,
                        )
                    )
        except Exception:
            logger.debug(
                "%s: run %s not stopped", self.machine, tag, exc_info=True
            )
            return False
        if done.exit_code not in (0, NOT_RUNNING_STATUS):
            logger.debug(
                "%s: run %s not stopped: exit %d",
                self.machine,
                tag,
                done.exit_code,
            )
        return done.exit_code == 0

    async def _system_time_env(self, env: dict[str, str]) -> dict[str, str]:
        """What a program on this machine needs to read the running
        workspace's system time (``faketime_env``), through the
        libfaketime the machine holds. Empty when the workspace keeps the
        host's time, and when the machine has no libfaketime, where the
        program runs on the machine's clock. Mirrors TypeScript's
        ``MachineHandle.systemTimeEnv``.

        Args:
            env (dict[str, str]): the program's environment, whose
                ``LD_PRELOAD`` libraries load after libfaketime.
        """
        if bound_system_clock() is None:
            return {}
        if not self._faketime_known:
            await self._probe_faketime()
        library = self._faketime
        return {} if library is None else faketime_env(library, env)

    async def _probe_faketime(self) -> None:
        """Ask the machine for its libfaketime, once."""
        async with self._faketime_lock:
            if self._faketime_known:
                return
            try:
                async with asyncio.timeout(FAKETIME_PROBE_SECONDS):
                    found = await self._setup(faketime_probe())
            except Exception:
                found = None
                logger.debug(
                    "%s: libfaketime probe failed", self.machine, exc_info=True
                )
            if found is None or found.exit_code != 0:
                # Unanswered: this run keeps the machine's clock, and a
                # later one asks again.
                if found is not None:
                    logger.debug(
                        "%s: libfaketime probe exited %d",
                        self.machine,
                        found.exit_code,
                    )
                return
            self._faketime = found.stdout.decode().strip() or None
            self._faketime_known = True
            if self._faketime is None:
                logger.debug(
                    "%s: no libfaketime, so programs run on its clock",
                    self.machine,
                )

    async def _setup(self, line: str) -> RunAnswer:
        """Run one of Mirage's own lines on the machine: its environment,
        at ``/``.

        Args:
            line (str): the shell line.
        """
        return await self.exec_line(line, None, dict(self.config.env), "/")

    async def _connected_line(self, line: str, wait: float) -> RunAnswer:
        """Connect, then run one of Mirage's own lines, within ``wait``
        seconds in all.

        Args:
            line (str): the shell line.
            wait (float): how long connecting and running may take.
        """
        async with asyncio.timeout(wait):
            await self.ensure_connected()
            return await self._setup(line)

    async def ensure_connected(self) -> None:
        """Connect once; after a disconnect, or once the provider says the
        connection went stale (``_stale``), the next call connects
        again."""
        if self._stale():
            self._disconnected()
        async with self._connect_lock:
            if not self._connected:
                await self.connect()
                self._connected = True

    async def connect(self) -> None:
        """Attach to the user's live machine, failing loud if absent."""
        raise NotImplementedError

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn,
        errors: OutputFn,
    ) -> RunResult:
        """Execute one argv on the machine: the provider's transport.

        Args:
            argv (tuple[str, ...]): the program and its arguments.
            stdin (ByteSource | None): the input, read as the program
                consumes it; None for none.
            env (dict[str, str]): the merged environment.
            cwd (str): the working directory, passed through verbatim.
            output (OutputFn): receives stdout as it arrives; a
                transport that gets it whole writes it once.
            errors (OutputFn): the same for stderr.
        """
        raise NotImplementedError

    async def exec_line(
        self,
        line: str,
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
    ) -> RunAnswer:
        """Execute one of Mirage's own shell lines on the machine, as
        ``/bin/sh -c``, and keep its answer whole for the caller.

        Args:
            line (str): the raw shell line.
            stdin (ByteSource | None): bytes piped into the line.
            env (dict[str, str]): the merged environment.
            cwd (str): the working directory, passed through verbatim.
        """
        async with self._at_work():
            return await answer_of(
                lambda output, errors: self._exec_argv(
                    ("/bin/sh", "-c", line), stdin, env, cwd, output, errors
                )
            )

    @asynccontextmanager
    async def _at_work(self) -> AsyncIterator[None]:
        """Count what runs inside as Mirage's work on the machine: the
        first piece to start tells the provider the machine is busy
        (``_became_busy``), and the last to end that it is idle
        (``_became_idle``)."""
        self._working += 1
        try:
            if self._working == 1:
                waking = self._waking = asyncio.Event()
                try:
                    await self._became_busy()
                finally:
                    waking.set()
            elif self._waking is not None:
                await self._waking.wait()
            yield
        finally:
            self._working -= 1
            if self._working == 0:
                self._waking = None
                self._became_idle()

    async def _became_busy(self) -> None:
        """Told as Mirage starts work on the machine while it had none: a
        program's run, before it connects, or one of Mirage's own lines.
        A provider whose machine pauses itself when idle keeps it up from
        here; the work waits for it."""
        return

    def _became_idle(self) -> None:
        """Told as the last of Mirage's work on the machine ends."""
        return

    def _stale(self) -> bool:
        """Whether the connection may have gone since the last work, so
        the next connect reaches the machine anew: a machine that paused
        itself once idle. Asked as each connect starts."""
        return False

    async def has_program(self, name: str) -> bool:
        """Whether the machine has a program of this name on its PATH,
        asked once.

        Args:
            name (str): the program's name.
        """
        known = self._programs.get(name)
        if known is None:
            await self.ensure_connected()
            done = await self._setup(
                f"command -v {shell_quote(name)} >/dev/null 2>&1"
            )
            known = self._programs[name] = done.exit_code == 0
        return known

    def _disconnected(self) -> None:
        """Let the next run connect again, and read the machine's mounts
        again then: a connection that went may have taken them with it."""
        self._connected = False
        if self._mounts is not None:
            self._mounts.forget()

    async def close(self) -> None:
        """Unmount what the machine was served; the machine is the user's.
        The next run connects again, so a workspace that takes the handle
        after this one reaches the machine anew. On a machine that pauses, a
        connect still under way settles first, and what this workspace
        reached, cleanup included, is handed to the pause after."""
        if self.pauses:
            async with self._connect_lock:
                pass
        try:
            if self._mounts is not None:
                await self._mounts.close()
        finally:
            self._pausable = self._reached
            self._reached = False
            self._disconnected()

    def config_asks_to_pause(self) -> bool:
        """Whether the machine's config asks to pause it when its
        workspace pauses without naming the machines to pause."""
        return False

    async def pause(self) -> None:
        """Pause the machine after its workspace closed to pause, when that
        workspace reached it; by default the machine is only
        disconnected."""
        pausable = self._pausable
        self._pausable = False
        if pausable:
            await self._pause_machine()

    async def _pause_machine(self) -> None:
        """Pause the machine a closed workspace reached. A provider that
        can pause overrides this, and its next connect resumes the
        machine; a machine already gone counts as paused."""


def _parse_pid(text: str) -> RunStatus | None:
    """What a run's pid line says (``RUN_WRAPPER``), None when it names
    no pid.

    Args:
        text (str): the pid and start, space separated.
    """
    words = text.split()
    if not words or not words[0].isdigit():
        return None
    return RunStatus(
        int(words[0]),
        float(words[1]) if len(words) > 1 and words[1].isdigit() else None,
    )


def _parse_facts(text: str) -> ScanFacts | None:
    """What ``SCAN_FACTS_MARK``'s row says, None if it is not numbers.

    Args:
        text (str): the row after its mark.
    """
    try:
        up, ticks, page, memory = text.split()
        return ScanFacts(float(up), int(ticks), int(page), int(memory))
    except ValueError as exc:
        logger.debug("scan facts unread: %s", exc)
        return None


def _usage_of(
    facts: ScanFacts | None, started: float, ticks: list[str]
) -> ProcessUsage | None:
    """A process's use of its machine, as ``ps`` works it out: CPU time
    over the whole seconds it has run, and resident memory over the
    machine's, each in truncated tenths of a percent.

    Args:
        facts (ScanFacts | None): the scan's facts, None if it had none.
        started (float): when it started, in clock ticks after boot.
        ticks (list[str]): its user and system time in clock ticks, its
            virtual size in bytes and its resident pages.
    """
    if facts is None or not all(field.isdigit() for field in ticks):
        return None
    user, system, vsize, pages = (int(field) for field in ticks)
    cpu_seconds = (user + system) / facts.ticks
    elapsed = int(facts.up_seconds - started / facts.ticks)
    rss = pages * facts.page // 1024
    return ProcessUsage(
        cpu_seconds,
        min(int(cpu_seconds * 1000 / elapsed), 9990) / 10 if elapsed else 0.0,
        int(rss * 1000 / facts.memory) / 10 if facts.memory else 0.0,
        rss,
        vsize // 1024,
    )


def _parse_scan(stdout: bytes | None) -> list[MachineProcess]:
    """What a scan printed (``scan_line``): each process. A line without
    a mark, or with a field that is not a number, is a message the
    provider mixed in.

    Args:
        stdout (bytes | None): what the scan printed.
    """
    found: list[MachineProcess] = []
    facts: ScanFacts | None = None
    for line in (stdout or b"").decode(errors="replace").splitlines():
        mark, _, rest = line.partition(" ")
        if mark == SCAN_FACTS_MARK:
            facts = _parse_facts(rest)
            continue
        fields = rest.split(" ", 9)
        if mark != SCAN_MARK or len(fields) < 10:
            continue
        tag, pid, ppid, started, state, *ticks, args = fields
        if not (pid.isdigit() and ppid.isdigit() and started.isdigit()):
            continue
        found.append(
            MachineProcess(
                tag,
                int(pid),
                int(ppid),
                float(started),
                args.strip(),
                state,
                usage=_usage_of(facts, float(started), ticks),
            )
        )
    return found
