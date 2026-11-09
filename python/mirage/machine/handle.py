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
from functools import partial
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
    JOB_END,
    JOB_END_PART,
    JOB_LOST,
    JOB_MARK,
    JOB_REFUSED_STATUS,
    JOB_REMOVE,
    JOB_START,
    JOB_VIEW,
    MACHINE_STOP_WAIT_SECONDS,
    NOT_RUNNING_STATUS,
    PROCESS,
    SCAN_MARK,
    SCAN_WAIT_SECONDS,
    SETSID_PROBE,
    VIEW_RETRY_MAX_SECONDS,
    VIEW_RETRY_SECONDS,
    faketime_env,
    faketime_probe,
    job_folder,
    scan_line,
    signal_line,
    stop_line,
)
from mirage.machine.errors import ConnectionLostError
from mirage.machine.mixin import PipeTransportMixin
from mirage.machine.mounts import MachineMounts
from mirage.runtime.binding import WorkspaceBinding
from mirage.runtime.types import OutputFn, RunResult
from mirage.shell.constants import (
    CANNOT_EXECUTE_STATUS,
    NOT_FOUND_STATUS,
    SIGTERM,
)
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
    # Whether a background job's one program runs detached here, under a
    # wrapper in the box (``JOB_START``), so it outlives the connection;
    # on only for the providers it was measured on.
    detaches: ClassVar[bool] = False
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
        # Whether the box holds setsid, asked once a job first detaches; a
        # probe that got no answer is not kept.
        self._setsid = False
        self._setsid_known = False
        self._setsid_lock = asyncio.Lock()
        # The folder of each detached job's run here, by its tag.
        self._detached: dict[str, str] = {}
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
        detached = await self._detaches(runner, ctx)
        self._executing += 1
        try:
            if detached:
                done = await self._run_detached(
                    run,
                    {**given, **clock},
                    ctx.cwd.virtual,
                    tag,
                    runner,
                    output,
                    errors,
                )
            else:
                done = await self._exec_argv(
                    run,
                    ctx.stdin,
                    {**given, **clock, PROCESS: tag},
                    ctx.cwd.virtual,
                    output,
                    errors,
                )
        except asyncio.CancelledError:
            if runner is None or not runner.released:
                await asyncio.shield(self.stop(tag, _stop_with(runner)))
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
            self._executing -= 1
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
        return _parse_scan_rows(done.stdout)

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
        group = isinstance(target, str) and target in self._detached
        done = await self._connected_line(
            signal_line(target, signum, group), MACHINE_STOP_WAIT_SECONDS
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

    async def _detaches(
        self, runner: ProcessHandle | None, ctx: Context
    ) -> bool:
        """Whether a run detaches: a detachable job's one program
        (``ProcessHandle.detachable``), fed no input, on a machine that
        detaches, holds setsid and is served no mounts, whose pipe would
        go with the connection.

        Args:
            runner (ProcessHandle | None): the process the run is.
            ctx (Context): the run's context.
        """
        if not (
            self.detaches
            and runner is not None
            and runner.detachable
            and ctx.stdin is None
            and self._mounts is None
        ):
            return False
        if not self._setsid_known:
            await self._probe_setsid()
        return self._setsid

    async def _probe_setsid(self) -> None:
        """Ask the box whether it holds setsid, once."""
        async with self._setsid_lock:
            if self._setsid_known:
                return
            try:
                async with asyncio.timeout(CHECK_WAIT_SECONDS):
                    found = await self._setup(SETSID_PROBE)
            except Exception:
                logger.debug("%s: setsid probe failed", self.id, exc_info=True)
                return
            if found.exit_code not in (0, 1, NOT_FOUND_STATUS):
                logger.debug(
                    "%s: setsid probe exited %d", self.id, found.exit_code
                )
                return
            self._setsid = found.exit_code == 0
            self._setsid_known = True
            if not self._setsid:
                logger.debug("%s: no setsid, so jobs stay attached", self.id)

    async def _run_detached(
        self,
        argv: tuple[str, ...],
        env: dict[str, str],
        cwd: str,
        tag: str,
        runner: ProcessHandle | None,
        output: OutputFn | None,
        errors: OutputFn | None,
    ) -> RunResult:
        """Run a job's program detached (``JOB_START``) and view it to
        its end (``_view``), then remove its folder; a box that cannot
        detach it runs it attached, as any other run. A start the
        connection dropped in is viewed all the same: the job may run. A
        cancelled run removes its folder; ``run`` stops it by its tag.

        Args:
            argv (tuple[str, ...]): the program and its arguments.
            env (dict[str, str]): its environment, the tag left out.
            cwd (str): its working directory.
            tag (str): the id of the process the run is.
            runner (ProcessHandle | None): that process.
            output (OutputFn | None): receives stdout as it arrives.
            errors (OutputFn | None): receives stderr as it arrives.
        """
        folder = job_folder(tag)
        if runner is not None and not await _tell_detached(
            runner, self.id, folder
        ):
            return await self._exec_argv(
                argv, None, {**env, PROCESS: tag}, cwd, output, errors
            )
        self._detached[tag] = folder
        try:
            try:
                started = await self._exec_argv(
                    ("/bin/sh", "-c", JOB_START, "sh", folder, tag, *argv),
                    None,
                    env,
                    cwd,
                    None,
                    None,
                )
            except ConnectionLostError:
                logger.debug("%s: job start lost", self.id, exc_info=True)
            except Exception:
                # The wrapper may have started what nothing now views.
                await self.stop(tag, SIGTERM)
                await self._remove(folder)
                raise
            else:
                if started.exit_code == JOB_REFUSED_STATUS:
                    logger.debug(
                        "%s: job not detached: %r", self.id, started.stderr
                    )
                    self._detached.pop(tag, None)
                    await self._remove(folder)
                    return await self._exec_argv(
                        argv, None, {**env, PROCESS: tag}, cwd, output, errors
                    )
                if started.exit_code != 0:
                    # A wrapper that outlived the start's wait may run it.
                    await self.stop(tag, SIGTERM)
                    await self._remove(folder)
                    return started
            if runner is not None:
                runner.detached = True
            done = await self._view(folder, tag, runner, output, errors)
            await self._settled(runner, folder)
            return done
        except asyncio.CancelledError:
            if runner is None or not runner.released:
                await asyncio.shield(self._remove(folder))
            raise
        finally:
            self._detached.pop(tag, None)

    async def resume(
        self,
        folder: str,
        tag: str,
        sent: tuple[int, int],
        output: OutputFn | None,
        errors: OutputFn | None,
    ) -> RunResult:
        """View a detached job a daemon before this one started to its
        end, as ``run`` would have, from the bytes its console already
        holds; stopped by its tag once cancelled, as ``run`` is.

        Args:
            folder (str): the job's folder.
            tag (str): the id of the process its run was.
            sent (tuple[int, int]): the stdout and stderr bytes already
                delivered.
            output (OutputFn | None): receives stdout as it arrives.
            errors (OutputFn | None): receives stderr as it arrives.
        """
        runner = current_caller().process
        if runner is not None:
            runner.detached = True
        self._detached[tag] = folder
        self._executing += 1
        try:
            done = await self._view(folder, tag, runner, output, errors, sent)
        except asyncio.CancelledError:
            if runner is None or not runner.released:
                await asyncio.shield(self.stop(tag, _stop_with(runner)))
                await asyncio.shield(self._remove(folder))
            raise
        finally:
            self._detached.pop(tag, None)
            self._executing -= 1
        await self._settled(runner, folder)
        return done

    async def _view(
        self,
        folder: str,
        tag: str,
        runner: ProcessHandle | None,
        output: OutputFn | None,
        errors: OutputFn | None,
        sent: tuple[int, int] = (0, 0),
    ) -> RunResult:
        """View a detached job to its end mark (``JOB_VIEW``), viewing
        again from the bytes delivered whenever a viewer ends without it,
        however it ended, after a wait that doubles while nothing new
        arrives. A job whose wrapper is gone with no exit code ends hung
        up, its program stopped by its tag should it still run. Output a
        transport returns whole, or a callback that is None, is kept and
        returned.

        Args:
            folder (str): the job's folder.
            tag (str): the id of the process the run is.
            runner (ProcessHandle | None): the process the run is.
            output (OutputFn | None): receives stdout as it arrives.
            errors (OutputFn | None): receives stderr as it arrives.
            sent (tuple[int, int]): the stdout and stderr bytes already
                delivered.
        """
        delivered = list(sent)
        kept = (bytearray(), bytearray())
        wait = VIEW_RETRY_SECONDS
        while True:
            held = bytearray()
            undelivered: list[BaseException] = []

            async def out(data: bytes) -> None:
                if output is None:
                    kept[0].extend(data)
                else:
                    try:
                        await output(data)
                    except BaseException as exc:
                        undelivered.append(exc)
                        raise
                delivered[0] += len(data)

            async def err(data: bytes) -> None:
                held.extend(data)
                cut = _unmarked(held)
                if not cut:
                    return
                chunk = bytes(held[:cut])
                if errors is None:
                    kept[1].extend(chunk)
                else:
                    try:
                        await errors(chunk)
                    except BaseException as exc:
                        undelivered.append(exc)
                        raise
                del held[:cut]
                delivered[1] += len(chunk)

            before = tuple(delivered)
            returned: tuple[bytes | None, bytes | None] = (None, None)
            try:
                await self._ensure_connected()
                done = await self._exec_argv(
                    (
                        "/bin/sh",
                        "-c",
                        JOB_VIEW,
                        "sh",
                        folder,
                        *map(str, delivered),
                    ),
                    None,
                    dict(self.config.env),
                    "/",
                    out,
                    err,
                )
                returned = (done.stdout, done.stderr)
            except ConnectionLostError as exc:
                logger.debug("%s: job view lost", self.id, exc_info=True)
                returned = (exc.stdout, exc.stderr)
            except Exception:
                logger.debug("%s: job view failed", self.id, exc_info=True)
            try:
                if returned[0]:
                    await out(returned[0])
                if returned[1]:
                    await err(returned[1])
            except Exception:
                logger.debug("%s: job output not kept", self.id, exc_info=True)
            # A view whose output did not all land is viewed again, however
            # it ended.
            ended = None if undelivered else JOB_END.fullmatch(bytes(held))
            if ended is not None:
                stderr = bytes(kept[1])
                code = ended.group(1).decode()
                if code != JOB_LOST:
                    return RunResult(bytes(kept[0]), stderr or None, int(code))
                await self.stop(tag, SIGTERM)
                if runner is not None:
                    runner.program_signaled(HANGUP_EXIT_CODE - 128)
                said = f"mirage: {self.id}: job lost\n".encode()
                return RunResult(
                    bytes(kept[0]), stderr + said, HANGUP_EXIT_CODE
                )
            if tuple(delivered) != before:
                wait = VIEW_RETRY_SECONDS
            await asyncio.sleep(wait)
            wait = min(wait * 2, VIEW_RETRY_MAX_SECONDS)

    async def _settled(
        self, runner: ProcessHandle | None, folder: str
    ) -> None:
        """Remove a viewed job's folder once its ending is kept: after its
        job's ending is recorded (``ProcessHandle.after_ending``), so a
        daemon that adopts the job before then still reads how it ended;
        at once for a run no job ending is recorded for.

        Args:
            runner (ProcessHandle | None): the process the run is.
            folder (str): the job's folder.
        """
        if runner is not None and runner.after_ending is not None:
            runner.after_ending.append(partial(self._remove, folder))
        else:
            await self._remove(folder)

    async def _remove(self, folder: str) -> None:
        """Remove a detached job's folder, bounded as a stop is; a box
        that does not answer keeps it.

        Args:
            folder (str): the folder.
        """
        try:
            async with asyncio.timeout(MACHINE_STOP_WAIT_SECONDS):
                await self._exec_argv(
                    ("/bin/sh", "-c", JOB_REMOVE, "sh", folder),
                    None,
                    dict(self.config.env),
                    "/",
                    None,
                    None,
                )
        except Exception:
            logger.debug("%s: %s not removed", self.id, folder, exc_info=True)

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
            if self._mounts is not None:
                await self._mounts.close()
        finally:
            self._connected = False


def _stop_with(runner: ProcessHandle | None) -> int:
    """The signal a cancelled run is stopped with in the box: the one its
    process was stopped with, or the interrupt it took, else TERM.

    Args:
        runner (ProcessHandle | None): the process the run is.
    """
    if runner is None:
        return SIGTERM
    signum = runner.signal if runner.signal is not None else runner.interrupted
    return signum or SIGTERM


async def _tell_detached(
    runner: ProcessHandle, machine: MachineId, folder: str
) -> bool:
    """Tell the job a run is where its program is about to run detached,
    before it starts, so a daemon that outlives this one finds it. A job
    that could not be told runs attached instead: one no daemon could find
    must not outlive this one.

    Args:
        runner (ProcessHandle): the job's process.
        machine (MachineId): the machine it runs on.
        folder (str): its folder there.

    Returns:
        bool: whether it may run detached: told, or no job to tell.
    """
    if runner.on_detach is None:
        return True
    try:
        await runner.on_detach(
            {
                "machine": str(machine),
                "folder": folder,
                "tag": str(runner.record.id),
                "runtime": runner.record.runtime,
            }
        )
    except Exception:
        logger.debug("%s: detached job not recorded", machine, exc_info=True)
        return False
    return True


def _unmarked(held: bytearray) -> int:
    """How much of the stderr a job's viewer printed is the job's for
    sure: all of it but a tail from a NUL that is, or may still grow
    into, the end mark (``JOB_END``).

    Args:
        held (bytearray): the stderr not yet delivered.
    """
    at = held.rfind(b"\0")
    if at < 0:
        return len(held)
    tail = bytes(held[at:])
    mark = JOB_MARK.encode()
    if len(tail) <= len(mark):
        return at if mark.startswith(tail) else len(held)
    return (
        at
        if JOB_END.fullmatch(tail) or JOB_END_PART.fullmatch(tail)
        else len(held)
    )


def _parse_scan_rows(stdout: bytes | None) -> list[MachineProcess]:
    """The rows a scan printed (``scan_line``), each one a process; a
    line without the mark, or with a field that is not a number, is a
    message the provider mixed in.

    Args:
        stdout (bytes | None): what the scan printed.
    """
    found: list[MachineProcess] = []
    for line in (stdout or b"").decode(errors="replace").splitlines():
        fields = line.split(" ", 5)
        if len(fields) < 6 or fields[0] != SCAN_MARK:
            continue
        _, tag, pid, ppid, started, args = fields
        if not (pid.isdigit() and ppid.isdigit() and started.isdigit()):
            continue
        found.append(
            MachineProcess(
                tag, int(pid), int(ppid), float(started), args.strip()
            )
        )
    return found
