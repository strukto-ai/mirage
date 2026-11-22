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

from functools import partial

from mirage.accessor.base import Accessor
from mirage.core.posix.types import RunFn
from mirage.execution.machine.table import MachineTable
from mirage.io.types import ByteSource
from mirage.machine.handle import MachineHandle
from mirage.vfs.machine.config import MachineVFSConfig


class MachineAccessor(Accessor):
    """The machines whose own files a mount shows, reached through the
    exec each machine's handle already holds. Bound to the workspace's
    machines once it has them, as a machine runtime is.

    Args:
        config (MachineVFSConfig): which machines, and the root on each.
    """

    def __init__(self, config: MachineVFSConfig) -> None:
        self.config = config
        self._machines: MachineTable | None = None
        self._default: str | None = None

    @property
    def root(self) -> str:
        return self.config.root

    def bind_machines(self, machines: MachineTable, default: str) -> None:
        """Reach the workspace's machines.

        Args:
            machines (MachineTable): the workspace's machines.
            default (str): where a new name lands when the config names
                no ``default_machine``.

        Raises:
            ValueError: the config names a machine the workspace lacks,
                or a ``default_machine`` the mount does not show.
        """
        for name in (
            *(self.config.machines or ()),
            self.config.default_machine,
        ):
            if name is not None:
                machines.get(name)
        self._machines = machines
        names = self.names()
        chosen = self.config.default_machine
        if chosen is not None and chosen not in names:
            raise ValueError(
                f"machine: default_machine {chosen!r} is not one of the"
                f" mount's machines: {', '.join(names)}"
            )
        self._default = chosen or (default if default in names else names[0])

    @property
    def bound(self) -> bool:
        """Whether the mount is in a workspace that has machines."""
        return self._machines is not None and bool(self._machines.names())

    def names(self) -> list[str]:
        """The machines the mount shows, in the order ``machines:`` lists
        them.

        Raises:
            ValueError: the mount is not in a workspace with machines.
        """
        if self._machines is None or not self._machines.names():
            raise ValueError("machine: the mount is not bound to machines")
        return list(self.config.machines or self._machines.names())

    @property
    def several(self) -> bool:
        """Whether the mount shows more than one machine, the only case
        where several can hold one name."""
        return len(self.names()) > 1

    @property
    def default_machine(self) -> str:
        """Where a new name lands when no program decides."""
        names = self.names()
        return self._default if self._default is not None else names[0]

    def handle(self, machine: str) -> MachineHandle:
        """The handle of one of the mount's machines.

        Args:
            machine (str): its name under ``machines:``.
        """
        if self._machines is None:
            raise ValueError("machine: the mount is not bound to machines")
        return self._machines.get(machine)

    async def run(
        self,
        machine: str,
        command: str,
        stdin: ByteSource | None = None,
        *,
        bounded: bool = False,
    ) -> tuple[int | None, bytes, bytes]:
        """Run one shell line on a machine, at ``/`` in its environment:
        its exit status, output and error output. A machine whose exec
        merges the two (Daytona) gives its output as the error output of
        a line that failed.

        Args:
            machine (str): the machine's name.
            command (str): the line, as ``/bin/sh -c`` reads it.
            stdin (ByteSource | None): the bytes fed to the line.
            bounded (bool): hold its answer to the workspace's memory
                room, for a line that reads a file's content.
        """
        handle = self.handle(machine)
        await handle.ensure_connected()
        done = await handle.exec_line(
            command, stdin, dict(handle.config.env), "/", bounded=bounded
        )
        if handle.joins_streams and done.exit_code:
            return done.exit_code, b"", done.stdout
        return done.exit_code, done.stdout, done.stderr

    def runner(self, machine: str) -> RunFn:
        """``run`` on one machine, as the shared POSIX ops take it.

        Args:
            machine (str): the machine's name.
        """
        return partial(self.run, machine)
