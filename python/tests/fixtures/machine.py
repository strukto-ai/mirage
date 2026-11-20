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

import shlex
import weakref
from collections.abc import Callable, Sequence
from dataclasses import replace
from typing import Any

from mirage.commands.config import Context
from mirage.execution.machine.table import MachineTable
from mirage.io.types import ByteSource, materialize
from mirage.machine.constants import RUN_PROGRAM_AT, RUN_WRAPPER_JOINED, is_run
from mirage.machine.handle import MachineHandle
from mirage.runtime.binding import answer_of
from mirage.runtime.machine import RemoteRuntime
from mirage.runtime.types import ExecutionKind, OutputFn, RunAnswer, RunResult

Answer = Callable[[str, bytes | None], RunAnswer]


def ok(out: bytes = b"") -> RunAnswer:
    """A line that exited 0 and printed ``out``."""
    return RunAnswer(0, out)


def failed(err: bytes, code: int = 1) -> RunAnswer:
    """A line that exited ``code`` and said ``err``."""
    return RunAnswer(code, b"", err)


class ScriptedMachine(MachineHandle):
    """A machine whose every line ``answer`` answers, recording each line
    and what it was fed.

    Args:
        name (str): the machine's name.
        answer (Answer): the result for a line and its input.
    """

    provider = "scripted"

    def __init__(self, name: str, answer: Answer) -> None:
        super().__init__(name)
        self.answer = answer
        self.lines: list[str] = []
        self.fed: list[bytes | None] = []
        self.cwds: list[str] = []
        self.joined: list[bool] = []

    async def connect(self) -> None:
        return None

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn,
        errors: OutputFn,
    ) -> RunResult:
        joined = is_run(argv) and argv[2] == RUN_WRAPPER_JOINED
        if is_run(argv):
            self.cwds.append(cwd)
            self.joined.append(joined)
            argv = argv[RUN_PROGRAM_AT:]
        line = argv[2] if argv[:2] == ("/bin/sh", "-c") else shlex.join(argv)
        data = await materialize(stdin) if stdin is not None else None
        self.lines.append(line)
        self.fed.append(data)
        done = self.answer(line, data)
        if done.stdout:
            await output(done.stdout)
        if done.stderr:
            await (output if self.joins_streams or joined else errors)(
                done.stderr
            )
        return RunResult(done.exit_code)


class InputlessMachine(ScriptedMachine):
    """A scripted machine whose exec takes no input (Daytona), refusing a
    line given any."""

    takes_input = False

    async def _exec_argv(
        self,
        argv: tuple[str, ...],
        stdin: ByteSource | None,
        env: dict[str, str],
        cwd: str,
        output: OutputFn,
        errors: OutputFn,
    ) -> RunResult:
        if stdin is not None and stdin != b"":
            return await self.input_refused(errors)
        return await super()._exec_argv(argv, stdin, env, cwd, output, errors)


class JoinedMachine(ScriptedMachine):
    """A scripted machine whose exec hands stderr back joined into
    stdout (Daytona)."""

    joins_streams = True


def table_of(*handles: MachineHandle) -> MachineTable:
    """A machine table holding ``handles``, in order."""
    return MachineTable({h.name: h for h in handles})


# One table per handle, as one workspace holds a handle however many
# runtimes a test binds to it.
_TABLES: "weakref.WeakKeyDictionary[MachineHandle, MachineTable]" = (
    weakref.WeakKeyDictionary()
)


def machine_runtime(handle: MachineHandle) -> RemoteRuntime:
    """A remote runtime on one machine, bound to it as a workspace binds
    its entries, capturing what a fake handle's ``captures`` names.

    Args:
        handle (MachineHandle): the machine.
    """
    runtime = RemoteRuntime(handle.name, captures_of(handle))
    table = _TABLES.get(handle)
    if table is None:
        table = _TABLES[handle] = MachineTable({handle.name: handle})
    runtime.bind_machines(table)
    return runtime


async def machine_answer(
    handle: MachineHandle,
    texts: Sequence[str],
    ctx: Context,
    kind: ExecutionKind = "process",
) -> RunAnswer:
    """What one run on a machine's runtime answered, kept whole.

    Args:
        handle (MachineHandle): the machine.
        texts (Sequence[str]): the argv, or nothing for a line.
        ctx (Context): the run's context.
        kind (ExecutionKind): a process or a whole line.
    """
    runtime = machine_runtime(handle)
    return await answer_of(
        lambda output, errors: runtime.execute(
            [], list(texts), ctx, kind=kind, output=output, errors=errors
        )
    )


def on(handle: MachineHandle) -> dict[str, Any]:
    """The workspace arguments that run one machine's programs, capturing
    what a fake handle's ``captures`` names.

    Args:
        handle (MachineHandle): the machine.
    """
    captures = captures_of(handle)
    if captures is not None:
        handle.config = replace(handle.config, captures=tuple(captures))
    return {"machines": {handle.name: handle}}


def captures_of(handle: MachineHandle) -> Sequence[str] | None:
    """What a test's fake handle says its runtime captures, None for a
    real one.

    Args:
        handle (MachineHandle): the machine.
    """
    captures: Sequence[str] | None = getattr(handle, "captures", None)
    return captures
