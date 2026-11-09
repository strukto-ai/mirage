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
from dataclasses import replace
from typing import Any, ClassVar

from mirage.commands.config import Context
from mirage.context.session_context import current_caller
from mirage.execution.job.constants import HANGUP_EXIT_CODE
from mirage.execution.machine.types import MachineProcess
from mirage.execution.process.handle import ProcessHandle
from mirage.execution.types import MachineId, MachinePid
from mirage.io.types import ByteSource
from mirage.machine.config import MachineConfig, check_mount_type
from mirage.machine.constants import (
    CHECK_LINE,
    CHECK_MARK,
    CHECK_WAIT_SECONDS,
    FAKETIME_PROBE_SECONDS,
    MACHINE_STOP_WAIT_SECONDS,
    NOT_RUNNING_STATUS,
    RUN_DRAIN_SECONDS,
    RUN_START_WAIT_SECONDS,
    RUN_WATCH_SECONDS,
    SCAN_MARK,
    SCAN_RUN_MARK,
    SCAN_WAIT_SECONDS,
    faketime_env,
    faketime_probe,
    remove_line,
    run_argv,
    run_status_path,
    scan_line,
    signal_line,
    status_line,
    stop_line,
)
from mirage.machine.errors import ConnectionLostError
from mirage.machine.mixin import PipeTransportMixin
from mirage.machine.mounts import MachineMounts
from mirage.machine.types import RunStatus
from mirage.runtime.binding import WorkspaceBinding
from mirage.runtime.types import OutputFn, RunResult
from mirage.shell.constants import CANNOT_EXECUTE_STATUS
from mirage.utils.clock import bound_system_clock

logger = logging.getLogger(__name__)


class MachineHandle:
    """One machine a workspace runs programs on, reached through its
    provider: the live connection, held once per workspace.

    Mirage never creates, provisions, or deletes a machine: you bring
    your own (a running container, a live Daytona or E2B machine, an SSH
    host) and its config says how to reach it. The workspace reaches the
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
        # Each executing run's end and its task, by tag, for a look at its
        # report to settle while its exec stays open.
        self._ended: dict[
            str, tuple[asyncio.Future[int], asyncio.Task[Any]]
        ] = {}
        # The reports of runs that have ended, which the next run removes.
        self._spent: list[str] = []
        check_mount_type(self.provider, self.config.mount_type)
        if self.config.mount_type is not None:
            if not isinstance(self, PipeTransportMixin):
                raise ValueError(
                    f"{self.provider}: mount_type needs a pipe transport"
                )
            self._mounts = MachineMounts(
                self.provider,
                self.config.mount_type,
                self._setup,
                self.open_pipe,
            )

    @property
    def id(self) -> MachineId:
        """The machine's id, ``<provider>:<name>``."""
        return MachineId(self.provider, self.name)

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
        output: OutputFn | None,
        errors: OutputFn | None,
    ) -> RunResult:
        """Connect once, validate the line, run it, then land what sshfs
        acknowledged, failing the run with a landing that failed.

        Args:
            argv (tuple[str, ...]): the program and its arguments.
            ctx (Context): the run's stdin, environment and cwd.
            binding (WorkspaceBinding | None): the workspace the run
                serves, whose mounts the machine is served.
            output (OutputFn | None): receives stdout as it arrives.
            errors (OutputFn | None): receives stderr as it arrives.
        """
        await self._ensure_connected()
        run = argv
        if self._mounts is not None:
            refusal = await self._mounts.validate(binding, ctx.cwd.virtual)
            if refusal is not None:
                return refusal
            run = self._mounts.guarded(argv)
        given = {**self.config.env, **(ctx.env or {})}
        clock = await self._system_time_env(given)
        # The run is the process it runs as, which its tag names; one run
        # outside a process gets a tag of its own.
        runner = current_caller().process
        tag = str(runner.record.id) if runner is not None else uuid.uuid4().hex
        status = run_status_path(tag)
        spent, self._spent = self._spent, []
        kept: tuple[bytearray, bytearray] = (bytearray(), bytearray())

        async def keep_output(data: bytes) -> None:
            kept[0].extend(data)

        async def keep_errors(data: bytes) -> None:
            kept[1].extend(data)

        ended: asyncio.Future[int] = asyncio.get_running_loop().create_future()
        task = asyncio.current_task()
        if task is not None:
            self._ended[tag] = (ended, task)
        self._executing += 1
        execution = asyncio.ensure_future(
            self._exec_argv(
                run_argv(tag, status, spent, run),
                ctx.stdin,
                {**given, **clock},
                ctx.cwd.virtual,
                output or keep_output,
                errors or keep_errors,
            )
        )
        background = runner is not None and runner.background
        watching = asyncio.ensure_future(
            self._report_start(runner, status, execution)
            if runner is not None and background
            else self._watch(status, ended)
        )
        try:
            done = await self._outcome(execution, ended)
            if background:
                await watching
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
        except ConnectionLostError as exc:
            logger.debug("%s: connection lost", self.id, exc_info=True)
            if runner is not None:
                runner.program_signaled(HANGUP_EXIT_CODE - 128)
            said = f"mirage: {self.id}: connection lost\n".encode()
            done = RunResult(
                stdout=exc.stdout,
                stderr=(exc.stderr or b"") + said,
                exit_code=HANGUP_EXIT_CODE,
            )
        finally:
            watching.cancel()
            self._executing -= 1
            self._ended.pop(tag, None)
            self._spent.append(status)
        done = RunResult(
            stdout=done.stdout or bytes(kept[0]),
            stderr=done.stderr or (bytes(kept[1]) or None),
            exit_code=done.exit_code,
        )
        if self._mounts is None:
            return done
        if done.exit_code == CANNOT_EXECUTE_STATUS:
            self._mounts.forget()
        # sshfs acknowledged the writes before they landed.
        lost = await self._mounts.land()
        if not lost:
            return done
        said = "".join(f"{line}\n" for line in lost).encode()
        return RunResult(
            stdout=done.stdout,
            stderr=(done.stderr or b"") + said,
            exit_code=done.exit_code or 1,
        )

    async def _outcome(
        self, execution: asyncio.Future[RunResult], ended: asyncio.Future[int]
    ) -> RunResult:
        """How a run ended: its exec's answer, or, when a look at its
        report found its program gone while the exec stays open because
        something the program left running holds its output, the status
        the report gave. That exec is let go after a moment for the
        output still arriving, and what the program left running stays.

        Args:
            execution (asyncio.Future[RunResult]): the exec.
            ended (asyncio.Future[int]): the program's reported status.
        """
        either: set[asyncio.Future[Any]] = {execution, ended}
        await asyncio.wait(either, return_when=asyncio.FIRST_COMPLETED)
        if not execution.done():
            await asyncio.wait({execution}, timeout=RUN_DRAIN_SECONDS)
        if execution.done():
            return execution.result()
        execution.cancel()
        await asyncio.gather(execution, return_exceptions=True)
        return RunResult(stdout=b"", stderr=None, exit_code=ended.result())

    async def _read_status(self, status: str) -> RunStatus | None:
        """One run's report as it stands, None when it wrote none.

        Args:
            status (str): the file it reports in.

        Raises:
            Exception: the machine could not be reached.
        """
        done = await self._connected_line(
            status_line(status), SCAN_WAIT_SECONDS
        )
        lines = (done.stdout or b"").decode(errors="replace").split("\n")
        return _parse_status(lines[0], lines[1] if len(lines) > 1 else "")

    async def _watch(self, status: str, ended: asyncio.Future[int]) -> None:
        """Look for the end of a foreground run, which someone waits on,
        every ``RUN_WATCH_SECONDS``. A look that fails is tried again.

        Args:
            status (str): the file it reports in.
            ended (asyncio.Future[int]): settled with the program's status.
        """
        while not ended.done():
            await asyncio.sleep(RUN_WATCH_SECONDS)
            try:
                found = await self._read_status(status)
            except Exception as exc:
                logger.debug("%s: run not read: %s", self.id, exc)
                continue
            if found is not None and found.exit_code is not None:
                if not ended.done():
                    ended.set_result(found.exit_code)

    async def _report_start(
        self,
        runner: ProcessHandle,
        status: str,
        execution: asyncio.Future[RunResult],
    ) -> None:
        """Give a background run's process its program's pid as soon as
        the program has started, which ``$!`` waits for. One that ended
        at once still reported it.

        Args:
            runner (ProcessHandle): the run's process.
            status (str): the file it reports in.
            execution (asyncio.Future[RunResult]): the exec.
        """
        delay = 0.01
        waited = 0.0
        while waited < RUN_START_WAIT_SECONDS:
            try:
                found = await self._read_status(status)
            except Exception as exc:
                logger.debug("%s: run not read: %s", self.id, exc)
                found = None
            if found is not None and found.pid is not None:
                if found.started is not None:
                    runner.set_machine_pid(
                        MachinePid(found.pid, found.started)
                    )
                return
            if execution.done():
                return
            await asyncio.sleep(delay)
            waited += delay
            delay = min(delay * 2, 0.5)

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
        if CHECK_MARK.encode() not in (ran.stdout or b""):
            raise RuntimeError(
                f"{self.id}: check did not run: exit {ran.exit_code}"
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
            raise RuntimeError(f"{self.id}: scan exited {done.exit_code}")
        rows, reports = _parse_scan(done.stdout, workspace)
        finishing: list[asyncio.Task[Any]] = []
        for tag, report in reports.items():
            running = self._ended.get(tag)
            if report.exit_code is None or running is None:
                continue
            ended, task = running
            if not ended.done():
                ended.set_result(report.exit_code)
            finishing.append(task)
        # So whoever asked sees those runs as ended, not as about to.
        if finishing:
            await asyncio.wait(finishing, timeout=RUN_DRAIN_SECONDS + 1)
        return rows

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
                f"{self.id}: signal {signum} not sent: exit {done.exit_code}"
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
                await self._ensure_connected()
                done = await self._exec_argv(
                    ("/bin/sh", "-c", stop_line(tag, signum)),
                    None,
                    dict(self.config.env),
                    "/",
                    None,
                    None,
                )
        except Exception:
            logger.debug("%s: run %s not stopped", self.id, tag, exc_info=True)
            return False
        if done.exit_code not in (0, NOT_RUNNING_STATUS):
            logger.debug(
                "%s: run %s not stopped: exit %d",
                self.id,
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
                    "%s: libfaketime probe failed", self.id, exc_info=True
                )
            if found is None or found.exit_code != 0:
                # Unanswered: this run keeps the machine's clock, and a
                # later one asks again.
                if found is not None:
                    logger.debug(
                        "%s: libfaketime probe exited %d",
                        self.id,
                        found.exit_code,
                    )
                return
            self._faketime = found.stdout.decode().strip() or None
            self._faketime_known = True
            if self._faketime is None:
                logger.debug(
                    "%s: no libfaketime, so programs run on its clock",
                    self.id,
                )

    async def _remove_spent(self) -> None:
        """Remove the reports no later run will, leaving them when the
        machine does not answer."""
        spent, self._spent = self._spent, []
        try:
            await self._connected_line(
                remove_line(spent), MACHINE_STOP_WAIT_SECONDS
            )
        except Exception as exc:
            logger.debug("%s: reports not removed: %s", self.id, exc)

    async def _setup(self, line: str) -> RunResult:
        """Run one of Mirage's own lines on the machine: its environment,
        at ``/``.

        Args:
            line (str): the shell line.
        """
        return await self.exec_line(line, None, dict(self.config.env), "/")

    async def _connected_line(self, line: str, wait: float) -> RunResult:
        """Connect, then run one of Mirage's own lines, within ``wait``
        seconds in all.

        Args:
            line (str): the shell line.
            wait (float): how long connecting and running may take.
        """
        async with asyncio.timeout(wait):
            await self._ensure_connected()
            return await self._setup(line)

    async def _ensure_connected(self) -> None:
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
        output: OutputFn | None,
        errors: OutputFn | None,
    ) -> RunResult:
        """Execute one argv on the machine: the provider's transport.

        Args:
            argv (tuple[str, ...]): the program and its arguments.
            stdin (ByteSource | None): the input, read as the program
                consumes it; None for none.
            env (dict[str, str]): the merged environment.
            cwd (str): the working directory, passed through verbatim.
            output (OutputFn | None): receives stdout as it arrives,
                which the result then leaves out; None, or a transport
                that cannot stream, returns it whole.
        """
        raise NotImplementedError

    async def exec_line(
        self,
        line: str,
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
    ) -> RunResult:
        """Execute one shell line on the machine, as ``/bin/sh -c``.

        Args:
            line (str): the raw shell line.
            stdin (ByteSource | None): bytes piped into the line.
            env (dict[str, str]): the merged environment.
            cwd (str): the working directory, passed through verbatim.
        """
        return await self._exec_argv(
            ("/bin/sh", "-c", line), stdin, env, cwd, None, None
        )

    async def close(self) -> None:
        """Unmount what the machine was served; the machine is the user's.
        The next run connects again, so a workspace that takes the handle
        after this one reaches the machine anew."""
        try:
            if self._spent:
                await self._remove_spent()
            if self._mounts is not None:
                await self._mounts.close()
        finally:
            self._connected = False


def _parse_status(first: str, second: str) -> RunStatus | None:
    """A run's report from its two lines (``RUN_WRAPPER``), None when it
    wrote nothing yet.

    Args:
        first (str): the pid and start, space separated.
        second (str): the exit status.
    """
    words = first.split()
    if not words or not words[0].isdigit():
        return None
    code = second.strip()
    return RunStatus(
        int(words[0]),
        float(words[1]) if len(words) > 1 and words[1].isdigit() else None,
        int(code) if code.isdigit() else None,
    )


def _parse_scan(
    stdout: bytes | None, workspace: str
) -> tuple[list[MachineProcess], dict[str, RunStatus]]:
    """What a scan printed (``scan_line``): each process, knowing the
    program its run reported, and each run's report by tag. A line
    without a mark, or with a field that is not a number, is a message
    the provider mixed in.

    Args:
        stdout (bytes | None): what the scan printed.
        workspace (str): the workspace's id, which each tag starts with.
    """
    found: list[MachineProcess] = []
    reports: dict[str, RunStatus] = {}
    for line in (stdout or b"").decode(errors="replace").splitlines():
        mark, _, rest = line.partition(" ")
        if mark == SCAN_RUN_MARK:
            number, _, text = rest.partition(" ")
            first, _, second = text.partition(";")
            report = _parse_status(first, second)
            if number.isdigit() and report is not None:
                reports[f"{workspace}:{number}"] = report
            continue
        fields = rest.split(" ", 5)
        if mark != SCAN_MARK or len(fields) < 6:
            continue
        tag, pid, ppid, started, state, args = fields
        if not (pid.isdigit() and ppid.isdigit() and started.isdigit()):
            continue
        found.append(
            MachineProcess(
                tag, int(pid), int(ppid), float(started), args.strip(), state
            )
        )
    return [
        replace(row, program=reports[row.tag].pid)
        if row.tag in reports
        else row
        for row in found
    ], reports
