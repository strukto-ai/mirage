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
from mirage.execution.machine.table import MachineTable
from mirage.execution.types import MachineName
from mirage.machine.constants import FIFO_PREFIX, RUN_DRAIN_SECONDS
from mirage.machine.handle import MachineHandle
from mirage.runtime.base import Runtime
from mirage.runtime.config import RuntimeConfig
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.types import OutputFn, RunResult, RuntimeReach
from mirage.types import FileType, PathSpec
from mirage.utils.quote import shell_quote
from mirage.workspace.files import Files

logger = logging.getLogger(__name__)


async def _substitution(files: Files, text: str) -> bool:
    """Whether a program's word names a live process substitution, the
    ``/dev/fd/N`` the shell handed it.

    Args:
        files (Files): the session's files.
        text (str): the word.
    """
    if not text.startswith("/dev/fd/"):
        return False
    try:
        return (await files.stat(text)).type == FileType.FIFO
    except FileNotFoundError as exc:
        logger.debug("%s: %s", text, exc)
        return False


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


class RemoteRuntime(
    Runtime[None], LineExecutorMixin[None], ProcessExecutorMixin[None]
):
    """Run a machine's own programs through that machine's exec.

    The runtime is the same whatever the provider: the machine handle a
    workspace declares under ``machines:`` is the transport. A run goes
    to the machine its route names (``execute(machine=)``, a policy's
    Route), else to this entry's ``machine``. Captures default to
    ``@external``, the programs nothing in Mirage resolves; an explicit
    ``@line`` sends whole lines, run as ``/bin/sh -c``. An entry with a
    ``machine`` is named for it, ``remote:<machine>``, so a workspace can
    hold one per machine.

    Args:
        captures (Sequence[str] | None): commands routed to this runtime.
        config (RuntimeConfig | dict[str, Any] | None): no knobs; a
            machine's settings live in its ``machines:`` entry.
        machine (str | None): the machine a run goes to when its route
            names none.
    """

    name = "remote"
    # Programs execute on the machine and act on its world (its
    # filesystem, its network); the workspace gate never sees those
    # effects, however well isolated the machine itself is.
    reach: RuntimeReach = "remote"
    captures: tuple[str, ...] = (EXTERNAL_COMMANDS,)

    def __init__(
        self,
        captures: Sequence[str] | None = None,
        config: RuntimeConfig | dict[str, Any] | None = None,
        machine: str | None = None,
    ) -> None:
        super().__init__(captures, config)
        if machine is not None:
            self.name = f"{self.name}:{machine}"
        self.default_machine = machine
        self._machines: MachineTable | None = None

    def bind_machines(self, machines: MachineTable) -> None:
        """Reach the workspace's machines.

        Args:
            machines (MachineTable): the machines its runs go to.

        Raises:
            ValueError: the entry's ``machine`` is none of them.
        """
        if self.default_machine is not None:
            machines.get(self.default_machine)
        self._machines = machines

    def handle(self, ctx: Context) -> MachineHandle:
        """The machine one run goes to.

        Args:
            ctx (Context): the run's context, whose ``machine`` its route
                set.

        Raises:
            ValueError: no machine is named, or the workspace has none
                by that name.
        """
        name = ctx.machine or self.default_machine
        if name is None:
            raise ValueError(
                f"{self.name}: no machine to run on; name one with the "
                "entry's machine or the line's route"
            )
        if self._machines is None:
            raise ValueError(f"{self.name}: runtime is not in a workspace")
        return self._machines.get(name)

    @property
    def machine(self) -> MachineName | None:
        if self._machines is None or self.default_machine is None:
            return None
        return self._machines.get(self.default_machine).machine

    def machine_for(self, ctx: Context) -> MachineName | None:
        return self.handle(ctx).machine

    def refusal_name(self, ctx: Context) -> str:
        """The provider of the machine the run goes to, as a refusal of
        its mounts names it; the runtime's name when it names none."""
        name = ctx.machine or self.default_machine
        if self._machines is None or name not in self._machines.names():
            return self.name
        return self._machines.get(name).provider

    @property
    def file_effects_dispatched(self) -> bool:
        handles = self._machines.handles() if self._machines else []
        return bool(handles) and all(
            h.file_effects_dispatched(self._binding) for h in handles
        )

    def _serves_session(
        self, restricted_mounts: tuple[str, ...], ctx: Context
    ) -> bool:
        return self.handle(ctx).serves_session(restricted_mounts)

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
        return await self.handle(ctx).run(
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
        names by path (``node read.js <(python3 gen.py)``) becomes a named
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
        handle = self.handle(ctx)
        env = dict(handle.config.env)
        argv = list(texts)
        feeds: list[tuple[str, asyncio.Task[RunResult]]] = []
        try:
            for at, text in enumerate(texts):
                if ctx.vfs is None or not await _substitution(ctx.vfs, text):
                    continue
                fifo = f"{FIFO_PREFIX}{uuid.uuid4().hex}"
                made = await handle.exec_line(
                    f"mkfifo {shell_quote(fifo)}", None, env, "/"
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
            for fifo, task in feeds:
                quoted = shell_quote(fifo)
                await handle.exec_line(
                    f"exec 3<>{quoted}; exec 3>&-; rm -f {quoted}",
                    None,
                    env,
                    "/",
                )
                await asyncio.wait({task}, timeout=RUN_DRAIN_SECONDS)
                task.cancel()
                for result in await asyncio.gather(
                    task, return_exceptions=True
                ):
                    if isinstance(result, BaseException) and not isinstance(
                        result, asyncio.CancelledError
                    ):
                        logger.debug("%s: feed failed: %s", fifo, result)

    async def settle(self) -> None:
        """Land what a line's programs left on every machine."""
        for handle in self._machines.handles() if self._machines else []:
            await handle.settle()
