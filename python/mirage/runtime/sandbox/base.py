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
from collections.abc import Sequence
from typing import Any, ClassVar

from mirage.commands.config import Context
from mirage.context.session_context import current_caller
from mirage.io.types import ByteSource
from mirage.runtime.base import Runtime
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.sandbox.config import SandboxConfig, check_mount_type
from mirage.runtime.sandbox.constants import (
    FAKETIME_PROBE_SECONDS,
    PROCESS,
    REAP_ABSENT,
    REAP_WAIT_SECONDS,
    faketime_env,
    faketime_probe,
    reap_line,
)
from mirage.runtime.sandbox.mixin import PipeTransportMixin
from mirage.runtime.sandbox.mounts import SandboxMounts
from mirage.runtime.types import (
    OutputFn,
    RunResult,
    RuntimeReach,
)
from mirage.shell.constants import CANNOT_EXECUTE_STATUS
from mirage.types import PathSpec
from mirage.utils.clock import bound_system_clock

logger = logging.getLogger(__name__)


class RemoteSandbox(
    Runtime[None], LineExecutorMixin[None], ProcessExecutorMixin[None]
):
    """A runtime that executes programs in a sandbox the user runs.

    Captures default to ``@external``, the programs nothing in Mirage
    resolves: interpreter names (python3, node) stay with the language
    runtime unless named. An explicit WHOLE_LINE delegates whole shell
    lines.

    Mirage never creates, provisions, or deletes sandboxes: you bring
    your own (a running container, a live Daytona or E2B sandbox) and
    the provider config says how to reach it. The workspace reaches
    the sandbox at the same prefixes as the host's, so the session cwd
    and every path in a line resolve unchanged: a provider with a
    ``mount_type`` serves them itself (SandboxMounts), otherwise serve
    them inside it yourself (``mirage workspace create`` in the image
    entrypoint or by hand). There is no interpreter entry point.
    Subclasses adapt one provider by implementing connect() and
    _exec_argv(), and PipeTransportMixin for a ``mount_type``; every
    run derives from _exec_argv: a whole line runs as ``/bin/sh -c``,
    a program from its argv, and a stream hands its output over as it
    comes. Routing and captures are inherited. Constructed like every
    runtime (captures, config); config is how to reach the sandbox,
    coerced through the provider's own config class.
    """

    # Lines execute on the provider's machine and act on that
    # machine's world (its filesystem, its network); the workspace
    # gate never sees those effects, however well isolated the
    # sandbox itself is.
    reach: RuntimeReach = "remote"
    captures: tuple[str, ...] = (EXTERNAL_COMMANDS,)
    config_cls: ClassVar[type[SandboxConfig]] = SandboxConfig
    config: SandboxConfig

    def __init__(
        self,
        captures: Sequence[str] | None = None,
        config: SandboxConfig | dict[str, Any] | None = None,
    ) -> None:
        super().__init__(captures, config)
        # Connect-once latch: the first captured line connects; later
        # lines just execute. A failed connect leaves it unset so the
        # next line retries.
        self._connected = False
        self._connect_lock = asyncio.Lock()
        self._mounts: SandboxMounts | None = None
        # The libfaketime each sandbox holds (``machine``), asked once the
        # first program runs there under a system_time: None for none. A
        # lock per sandbox lets its concurrent first runs share one probe
        # without holding up another sandbox's; a failed probe is not kept,
        # so a later run asks again.
        self._faketime: dict[str, str | None] = {}
        self._faketime_locks: dict[str, asyncio.Lock] = {}
        check_mount_type(self.name, self.config.mount_type)
        if self.config.mount_type is not None:
            if not isinstance(self, PipeTransportMixin):
                raise ValueError(
                    f"{self.name}: mount_type needs a pipe transport"
                )
            self._mounts = SandboxMounts(
                self.name,
                self.config.mount_type,
                self._setup,
                self.open_pipe,
            )

    @property
    def file_effects_dispatched(self) -> bool:
        return (
            self._mounts is not None
            and self._mounts.file_effects_dispatched
            and self._binding is not None
            and self._binding.mount_prefixes is not None
            and "/" not in self._binding.mount_prefixes()
        )

    def _serves_session(self, restricted_mounts: tuple[str, ...]) -> bool:
        return self._mounts is not None and all(
            prefix.rstrip("/") not in ("", "/dev")
            for prefix in restricted_mounts
        )

    async def run_line(
        self,
        engine: None,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        """Run one raw line in the sandbox, connecting once.

        The line, cwd, and paths pass through verbatim: the sandbox is
        expected to serve the workspace at the same prefixes as the
        host, so nothing is rewritten. The session environment merges
        over the config environment.

        Args:
            engine (None): a sandbox keeps its own connection.
            paths (list[PathSpec]): unused; the line names its paths.
            texts (list[str]): unused.
            ctx (Context): the line in ``flags["c"]``, the bytes piped
                into it, the session environment and working directory.
            output (OutputFn | None): receives stdout as it arrives.
            errors (OutputFn | None): receives stderr as it arrives.
        """
        line = ctx.flags.get("c")
        return await self._run_argv(
            ("/bin/sh", "-c", line if isinstance(line, str) else ""),
            ctx,
            output,
            errors,
        )

    async def run_process(
        self,
        engine: None,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        return await self._run_argv(tuple(texts), ctx, output, errors)

    async def settle(self) -> None:
        """Land what a line's program left, however the line ended. Its
        exit reported the landings that failed then; one that fails only
        here (the deadline stopped the program or its exit's landing) is
        logged."""
        if self._mounts is not None:
            for lost in await self._mounts.sync():
                logger.warning("%s", lost)

    async def _run_argv(
        self,
        argv: tuple[str, ...],
        ctx: Context,
        output: OutputFn | None,
        errors: OutputFn | None,
    ) -> RunResult:
        """Connect once, bring the served mounts in step, run, then land
        what sshfs acknowledged, failing the run with a landing that failed.

        Args:
            argv (tuple[str, ...]): the program and its arguments.
            ctx (Context): the run's stdin, environment and cwd.
            output (OutputFn | None): receives stdout as it arrives.
            errors (OutputFn | None): receives stderr as it arrives.
        """
        if self._mounts is not None:
            refusal = self._mounts.enter(self._binding, ctx.cwd.virtual)
            if refusal is not None:
                return refusal
        await self._ensure_connected()
        run = argv
        if self._mounts is not None:
            refusal = await self._mounts.admit(self._binding)
            if refusal is not None:
                return refusal
            run = self._mounts.guarded(argv)
        given = {**self.config.env, **(ctx.env or {})}
        clock = await self._system_time_env(given)
        # The run is the process it runs as, which its tag names; one run
        # outside a process gets a tag of its own.
        runner = current_caller().process
        tag = str(runner.record.id) if runner is not None else uuid.uuid4().hex
        try:
            done = await self._exec_argv(
                run,
                ctx.stdin,
                {**given, **clock, PROCESS: tag},
                ctx.cwd.virtual,
                output,
                errors,
            )
        except asyncio.CancelledError:
            signum = None
            if runner is not None:
                signum = (
                    runner.signal
                    if runner.signal is not None
                    else runner.interrupted
                )
            await asyncio.shield(self._reap(tag, signum or 15))
            raise
        if (
            self._mounts is not None
            and done.exit_code == CANNOT_EXECUTE_STATUS
        ):
            self._mounts.forget()
        if self._mounts is not None:
            # sshfs acknowledged the writes before they landed.
            lost = await self._mounts.land()
            if lost:
                said = "".join(f"{line}\n" for line in lost).encode()
                done = RunResult(
                    stdout=done.stdout,
                    stderr=(done.stderr or b"") + said,
                    exit_code=done.exit_code or 1,
                )
        return done

    async def reap(self, tag: str, signum: int) -> bool:
        """Stop a run a lapsed workspace left in the box: every process
        its ``PROCESS`` tag marks gets ``signum``, then KILL a second
        later. Connecting is bounded as the stop is
        (``REAP_WAIT_SECONDS``).

        Args:
            tag (str): the id of the process the run is, as ``PROCESS``
                carries it.
            signum (int): the first signal.

        Returns:
            bool: True once the box held the run's processes and they
            were stopped; False when it holds none of them, as a box
            other than the run's does.

        Raises:
            RuntimeError: the box could not be reached, or the stop
                failed.
        """
        async with asyncio.timeout(REAP_WAIT_SECONDS):
            await self._ensure_connected()
        code = await self._reap(tag, signum)
        if code not in (0, REAP_ABSENT):
            raise RuntimeError(f"{self.name}: run {tag} not stopped")
        return code == 0

    async def _reap(self, tag: str, signum: int) -> int | None:
        """Stop what a cancelled or failed run left in the box
        (``PROCESS``), for at most ``REAP_WAIT_SECONDS``: a box that
        stopped answering would otherwise hold the cancel or the error.

        Args:
            tag (str): the run's tag.
            signum (int): the signal the run is stopped with first.

        Returns:
            int | None: the stop line's status (``reap_line``); None when
            the box did not answer.
        """
        try:
            async with asyncio.timeout(REAP_WAIT_SECONDS):
                done = await self._exec_argv(
                    ("/bin/sh", "-c", reap_line(tag, signum)),
                    None,
                    dict(self.config.env),
                    "/",
                    None,
                    None,
                )
        except Exception:
            logger.debug(
                "%s: run %s not stopped", self.name, tag, exc_info=True
            )
            return None
        if done.exit_code not in (0, REAP_ABSENT):
            logger.debug(
                "%s: run %s not stopped: exit %d",
                self.name,
                tag,
                done.exit_code,
            )
        return done.exit_code

    async def _system_time_env(self, env: dict[str, str]) -> dict[str, str]:
        """What a program in this sandbox needs to read the running
        workspace's system time (``faketime_env``), through the
        libfaketime the sandbox holds. Empty when the workspace keeps the
        host's time, and when the sandbox has no libfaketime, where the
        program runs on the sandbox's clock. Mirrors TypeScript's
        ``SandboxRuntime.systemTimeEnv``.

        Args:
            env (dict[str, str]): the program's environment, whose
                ``LD_PRELOAD`` libraries load after libfaketime.
        """
        if bound_system_clock() is None:
            return {}
        key = str(self.machine)
        if key not in self._faketime:
            await self._probe_faketime(key)
        library = self._faketime.get(key)
        return {} if library is None else faketime_env(library, env)

    async def _probe_faketime(self, key: str) -> None:
        """Ask the sandbox ``key`` names for its libfaketime, once.

        Args:
            key (str): the sandbox, its ``machine``.
        """
        async with self._faketime_locks.setdefault(key, asyncio.Lock()):
            if key not in self._faketime:
                try:
                    async with asyncio.timeout(FAKETIME_PROBE_SECONDS):
                        found = await self.exec_line(
                            faketime_probe(), None, dict(self.config.env), "/"
                        )
                except Exception:
                    found = None
                    logger.debug(
                        "%s: libfaketime probe failed",
                        self.name,
                        exc_info=True,
                    )
                if found is None or found.exit_code != 0:
                    # Unanswered: this run keeps the sandbox's clock, and
                    # a later one asks again.
                    if found is not None:
                        logger.debug(
                            "%s: libfaketime probe exited %d",
                            self.name,
                            found.exit_code,
                        )
                    return
                self._faketime[key] = found.stdout.decode().strip() or None
                if self._faketime[key] is None:
                    logger.debug(
                        "%s: no libfaketime, so programs run on its clock",
                        self.name,
                    )

    async def _setup(self, line: str) -> RunResult:
        return await self.exec_line(line, None, dict(self.config.env), "/")

    async def _ensure_connected(self) -> None:
        async with self._connect_lock:
            if not self._connected:
                await self.connect()
                self._connected = True

    async def connect(self) -> None:
        """Attach to the user's live sandbox, failing loud if absent."""
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
        """Execute one argv inside the sandbox: the provider's transport.

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
        """Execute one shell line inside the sandbox, as ``/bin/sh -c``.

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
        """Unmount what the sandbox was served; the sandbox is the user's."""
        if self._mounts is not None:
            await self._mounts.close()
        await super().close()
