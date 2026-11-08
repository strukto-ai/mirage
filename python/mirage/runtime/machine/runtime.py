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

from collections.abc import Sequence
from typing import Any

from mirage.commands.config import Context
from mirage.execution.machine.table import MachineTable
from mirage.execution.types import MachineId
from mirage.machine.handle import MachineHandle
from mirage.runtime.base import Runtime
from mirage.runtime.config import RuntimeConfig
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.types import OutputFn, RunResult, RuntimeReach
from mirage.types import PathSpec


class MachineRuntime(
    Runtime[None], LineExecutorMixin[None], ProcessExecutorMixin[None]
):
    """Run a machine's own programs through that machine's exec.

    The runtime is the same whatever the provider: the machine handle a
    workspace declares under ``machines:`` is the transport. A run goes
    to the machine its route names (``execute(machine=)``, a policy's
    Route), else to this entry's ``machine``. Captures default to
    ``@external``, the programs nothing in Mirage resolves; an explicit
    ``@line`` sends whole lines, run as ``/bin/sh -c``.

    Args:
        captures (Sequence[str] | None): commands routed to this runtime.
        config (RuntimeConfig | dict[str, Any] | None): no knobs; a
            machine's settings live in its ``machines:`` entry.
        machine (str | None): the machine a run goes to when its route
            names none.
    """

    name = "machine"
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
    def machine(self) -> MachineId | None:
        if self._machines is None or self.default_machine is None:
            return None
        return self._machines.get(self.default_machine).id

    def machine_for(self, ctx: Context) -> MachineId | None:
        return self.handle(ctx).id

    def voice(self, ctx: Context) -> str:
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
        return await self.handle(ctx).run(
            tuple(texts), ctx, self._binding, output, errors
        )

    async def settle(self) -> None:
        """Land what a line's programs left on every machine."""
        for handle in self._machines.handles() if self._machines else []:
            await handle.settle()
