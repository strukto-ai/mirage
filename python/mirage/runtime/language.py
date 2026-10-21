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

from abc import abstractmethod
from typing import ClassVar

from mirage.commands.config import Context
from mirage.runtime.base import Runtime
from mirage.runtime.mixin import E
from mirage.runtime.source import Argv0Rules, resolve_program
from mirage.runtime.types import (
    Language,
    Program,
    RunResult,
)
from mirage.types import PathSpec


class LanguageRuntime(Runtime[E]):
    """A runtime that interprets one language's code inside a command.

    The engine inside a single command (python3, node): the workspace
    splits the line, and a captured stage's operands land here as run().
    Never the whole line; that is LineExecutorMixin's entry point.

    The language it interprets is declared once, on its language tier
    (PythonRuntime, JsRuntime), and a script CLI finds its interpreter
    by it (runtime_for_language).

    run() resolves the program from the operands the way a real
    interpreter does (``-c`` in ``ctx.flags``, else the script operand
    read through ``ctx.vfs``, else piped stdin) and hands it to
    interpret(). A guest sees ``ctx.env``, a copy whose writes do not
    mutate the Mirage session; an adapter that means to write the
    session uses ``ctx.session``.
    """

    language: ClassVar[Language]
    # The head words of this language's interpreter commands, the first
    # naming a program run with no command of its own.
    commands: ClassVar[tuple[str, ...]] = ()
    # What this interpreter calls itself where no file names the program.
    argv0_rules: ClassVar[Argv0Rules] = Argv0Rules()

    async def run(
        self, engine: E, paths: list[PathSpec], texts: list[str], ctx: Context
    ) -> RunResult:
        """Resolve the program from the operands, then interpret it.

        Args:
            engine (E): the install's engine.
            paths (list[PathSpec]): the script operand, if any.
            texts (list[str]): the program's argv.
            ctx (Context): the run's context.
        """
        label = (ctx.spec.name if ctx.spec is not None else "") or (
            self.commands[0] if self.commands else self.name
        )
        program = await resolve_program(
            paths,
            texts,
            ctx,
            label,
            self.argv0_rules,
            self.module_code,
            self.name,
        )
        if isinstance(program, RunResult):
            return program
        return await self.interpret(engine, program, ctx)

    def module_code(self, name: str, label: str) -> str | None:
        """The program ``-m name`` runs; None where this runtime cannot
        run a module.

        Args:
            name (str): the module.
            label (str): the command name a not-found message uses.
        """
        return None

    async def version(self, env: dict[str, str]) -> RunResult:
        """Report the bound interpreter's version.

        Args:
            env (dict[str, str]): the session environment.
        """
        return RunResult(
            stdout=b"",
            stderr=f"{self.name}: version information unavailable\n".encode(),
            exit_code=1,
        )

    @abstractmethod
    async def interpret(
        self, engine: E, program: Program, ctx: Context
    ) -> RunResult:
        """Execute one program and return its captured outcome.

        Each call represents an independent language command, such as
        python3 or node. Guest globals, imports and builtin mutations
        do not carry over from earlier commands or evaluator sessions.
        The adapter owns engine reuse; this does not reset workspace
        state or undo external effects.

        Args:
            engine (E): the install's engine.
            program (Program): the source and argv to run.
            ctx (Context): the run's context: working directory,
                environment, switches, files.
        """
