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

import logging
from typing import ClassVar

from mirage.io.types import ByteSource
from mirage.machine.handle import MachineHandle
from mirage.machine.mixin import PipeTransportMixin
from mirage.machine.program import exec_args, open_program_pipe, run_program
from mirage.machine.types import MachinePipe
from mirage.runtime.binding import answer_of
from mirage.runtime.types import OutputFn, RunAnswer, RunResult

logger = logging.getLogger(__name__)


class ProgramMachine(MachineHandle, PipeTransportMixin):
    """A machine reached through a program on this host: each run is one
    exec of it with the merged environment, the session cwd, real stdin
    and separated stderr, so there is no SDK to load and no daemon
    socket to wire.

    Args:
        name (str): the machine's name, its key under ``machines:``.
        config (MachineConfig | dict[str, Any] | None): how to reach it.
    """

    program: ClassVar[str]
    install_hint: ClassVar[str]

    def exec_words(self) -> tuple[tuple[str, ...], tuple[str, ...]]:
        """The program's words before each ``-e`` variable and after
        them, the second the target or ``--``."""
        raise NotImplementedError

    async def _exec_program(
        self,
        args: list[str],
        stdin: ByteSource | None,
        output: OutputFn,
        errors: OutputFn,
    ) -> RunResult:
        """Run the program once; the seam tests override.

        Args:
            args (list[str]): the arguments after the program.
            stdin (ByteSource | None): the input; None for none.
            output (OutputFn): receives stdout as it arrives.
            errors (OutputFn): receives stderr as it arrives.
        """
        return await run_program(
            self.program,
            self.install_hint,
            args,
            stdin,
            output=output,
            errors=errors,
            connection=True,
        )

    async def _program_answer(self, args: list[str]) -> RunAnswer:
        """Run the program once for Mirage's own question (a status, a
        pause), its answer kept whole.

        Args:
            args (list[str]): the arguments after the program.
        """
        return await answer_of(
            lambda output, errors: self._exec_program(
                args, None, output, errors
            )
        )

    async def _change_state(
        self, args: list[str], gone: str | None = None
    ) -> None:
        """Pause or resume the machine through the program, failing loud
        unless its stderr says the machine is already gone.

        Args:
            args (list[str]): the arguments after the program.
            gone (str | None): what the program's stderr says of a machine
                already gone, which then counts as done; None fails on it
                too.
        """
        result = await self._program_answer(args)
        if result.exit_code == 0:
            return
        said = result.stderr.decode().strip()
        if gone is not None and gone in said:
            logger.debug("%s: already gone: %s", self.machine, said)
            return
        raise RuntimeError(f"{self.program} {' '.join(args)} failed: {said}")

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn,
        errors: OutputFn,
    ) -> RunResult:
        head, tail = self.exec_words()
        return await self._exec_program(
            exec_args(head, tail, env, cwd, argv), stdin, output, errors
        )

    async def open_pipe(self, command: str) -> MachinePipe:
        head, tail = self.exec_words()
        return await open_program_pipe(
            self.program,
            exec_args(head, tail, {}, None, ("/bin/sh", "-c", command)),
        )
