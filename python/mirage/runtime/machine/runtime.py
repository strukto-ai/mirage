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
from typing import Any

from mirage.commands.config import Context
from mirage.context.session_context import current_caller
from mirage.execution.machine.table import MachineTable
from mirage.execution.types import MachineName
from mirage.machine.constants import FIFO_PREFIX, RUN_DRAIN_SECONDS
from mirage.machine.handle import MachineHandle
from mirage.runtime.base import Runtime
from mirage.runtime.config import RuntimeConfig
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.types import OutputFn, RunResult, RuntimeReach
from mirage.types import PathSpec
from mirage.utils.quote import shell_quote
from mirage.workspace.files import Files

logger = logging.getLogger(__name__)


async def _feed(
    handle: MachineHandle,
    files: Files,
    text: str,
    fifo: str,
    env: dict[str, str],
) -> RunResult:
    """Stream a process substitution into the named pipe on the machine
    that stands for it, while the pipe is still there.

    Args:
        handle (MachineHandle): the machine.
        files (Files): the session's files.
        text (str): the substitution's ``/dev/fd/N``.
        fifo (str): the named pipe.
        env (dict[str, str]): the machine's environment.
    """
    quoted = shell_quote(fifo)
    return await handle.exec_line(
        f"[ -p {quoted} ] && exec cat > {quoted}",
        await files.read(text, stream=True),
        env,
        "/",
    )


async def _unfeed(
    handle: MachineHandle,
    feeds: list[tuple[str, asyncio.Task[RunResult]]],
    env: dict[str, str],
) -> None:
    """Remove the named pipes a run's substitutions fed, then stop their
    feeds, each given ``RUN_DRAIN_SECONDS`` to end, whatever the machine
    answers.

    Args:
        handle (MachineHandle): the machine.
        feeds (list[tuple[str, asyncio.Task[RunResult]]]): each pipe and
            the feed writing it.
        env (dict[str, str]): the machine's environment.
    """
    try:
        for fifo, _ in feeds:
            quoted = shell_quote(fifo)
            try:
                await handle.exec_line(
                    f"exec 3<>{quoted}; exec 3>&-; rm -f {quoted}",
                    None,
                    env,
                    "/",
                )
            except Exception as exc:
                logger.debug("%s: not removed: %s", fifo, exc)
        if feeds:
            await asyncio.wait(
                {task for _, task in feeds}, timeout=RUN_DRAIN_SECONDS
            )
    finally:
        for _, task in feeds:
            task.cancel()
        for (fifo, _), result in zip(
            feeds,
            await asyncio.gather(
                *(task for _, task in feeds), return_exceptions=True
            ),
        ):
            if isinstance(result, BaseException) and not isinstance(
                result, asyncio.CancelledError
            ):
                logger.debug("%s: feed failed: %s", fifo, result)


class RemoteRuntime(
    Runtime[None], LineExecutorMixin[None], ProcessExecutorMixin[None]
):
    """Run a machine's own programs through that machine's exec.

    The runtime is the same whatever the provider: the machine handle a
    workspace declares under ``machines:`` is the transport. Each machine
    entry builds one, named for the machine, capturing what the entry's
    ``captures`` lists: ``@external`` by default, the programs nothing in
    Mirage resolves; an explicit ``@line`` sends whole lines, run as
    ``/bin/sh -c``.

    Args:
        machine (str): the machine every run goes to.
        captures (Sequence[str] | None): commands routed to this runtime.
        config (RuntimeConfig | dict[str, Any] | None): no knobs; a
            machine's settings live in its ``machines:`` entry.
    """

    name = "remote"
    # Programs execute on the machine and act on its world (its
    # filesystem, its network); the workspace gate never sees those
    # effects, however well isolated the machine itself is.
    reach: RuntimeReach = "remote"
    captures: tuple[str, ...] = (EXTERNAL_COMMANDS,)

    def __init__(
        self,
        machine: str,
        captures: Sequence[str] | None = None,
        config: RuntimeConfig | dict[str, Any] | None = None,
    ) -> None:
        super().__init__(captures, config)
        self.name = machine
        self.default_machine = machine
        self._machines: MachineTable | None = None

    def bind_machines(self, machines: MachineTable) -> None:
        """Reach the workspace's machines.

        Args:
            machines (MachineTable): the machines its runs go to.

        Raises:
            ValueError: the entry's ``machine`` is none of them.
        """
        machines.get(self.default_machine)
        self._machines = machines

    def handle(self) -> MachineHandle:
        """The machine every run goes to.

        Raises:
            ValueError: the runtime is not in a workspace.
        """
        if self._machines is None:
            raise ValueError(f"{self.name}: runtime is not in a workspace")
        return self._machines.get(self.default_machine)

    @property
    def machine(self) -> MachineName | None:
        if self._machines is None:
            return None
        return self._machines.get(self.default_machine).machine

    @property
    def refusal_name(self) -> str:
        """The provider of the machine its runs go to, as a refusal of
        its mounts names it; the runtime's name before it is bound."""
        if self._machines is None:
            return self.name
        return self._machines.get(self.default_machine).provider

    @property
    def file_effects_dispatched(self) -> bool:
        return (
            self._machines is not None
            and self.handle().file_effects_dispatched(self._binding)
        )

    def _serves_session(self, restricted_mounts: tuple[str, ...]) -> bool:
        return self.handle().serves_session(restricted_mounts)

    async def run_line(
        self,
        engine: None,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        """Run one raw line on the machine, connecting once.

        The line, cwd, and paths pass through verbatim: the machine is
        expected to serve the workspace at the same prefixes as the
        host, so nothing is rewritten. The session environment merges
        over the machine's.

        Args:
            engine (None): a machine keeps its own connection.
            paths (list[PathSpec]): unused; the line names its paths.
            texts (list[str]): unused.
            ctx (Context): the line in ``flags["c"]``, the bytes piped
                into it, the session environment and working directory.
            output (OutputFn | None): receives stdout as it arrives.
            errors (OutputFn | None): receives stderr as it arrives.
        """
        line = ctx.flags.get("c")
        return await self.handle().run(
            ("/bin/sh", "-c", line if isinstance(line, str) else ""),
            ctx,
            self._binding,
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
        """Run one program on the machine. A process substitution it
        reads by path (``node read.js <(python3 gen.py)``) becomes a named
        pipe on that machine, which Mirage feeds while the program runs,
        as bash hands a program a pipe it shares.

        Args:
            engine (None): a machine keeps its own connection.
            paths (list[PathSpec]): unused; the words name the paths.
            texts (list[str]): the program and its words.
            ctx (Context): the run's stdin, environment and cwd.
            output (OutputFn | None): receives stdout as it arrives.
            errors (OutputFn | None): receives stderr as it arrives.
        """
        handle = self.handle()
        env = dict(handle.config.env)
        evaluation = current_caller().evaluation
        reads = (
            {path for path, _ in evaluation.frame.writers if path is not None}
            if evaluation is not None
            else set()
        )
        argv = list(texts)
        feeds: list[tuple[str, asyncio.Task[RunResult]]] = []
        try:
            for at, text in enumerate(texts):
                if ctx.vfs is None or text not in reads:
                    continue
                await handle.ensure_connected()
                fifo = f"{FIFO_PREFIX}{uuid.uuid4().hex}"
                made = await handle.exec_line(
                    f"mkfifo -m 600 {shell_quote(fifo)}", None, env, "/"
                )
                if made.exit_code != 0:
                    logger.debug("%s: mkfifo exited %d", fifo, made.exit_code)
                    continue
                argv[at] = fifo
                feeds.append(
                    (
                        fifo,
                        asyncio.create_task(
                            _feed(handle, ctx.vfs, text, fifo, env)
                        ),
                    )
                )
            return await handle.run(
                tuple(argv), ctx, self._binding, output, errors
            )
        finally:
            await _unfeed(handle, feeds, env)

    async def settle(self) -> None:
        """Land what a line's programs left on every machine."""
        for handle in self._machines.handles() if self._machines else []:
            await handle.settle()
