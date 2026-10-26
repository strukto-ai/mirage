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
from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import replace
from typing import Any, ClassVar

from mirage.commands.config import Context
from mirage.concurrency.limiter import settle
from mirage.runtime.config import RuntimeConfig, memory_limit
from mirage.runtime.files import RuntimeFiles
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.python.flags import unhonored_notice
from mirage.runtime.python.monty.config import MontyConfig
from mirage.runtime.python.monty.constants import MISSING_EXTRA_HINT
from mirage.runtime.python.monty.execution import MontyExecution
from mirage.runtime.python.monty.fs import MontyFs
from mirage.runtime.python.monty.loader import pydantic_monty
from mirage.runtime.types import (
    FilesystemOperation,
    OutputFn,
    Program,
    RunResult,
    RuntimeReach,
)


class MontyRuntime(PythonRuntime[MontyExecution]):
    """Run Python code on the Monty sandboxed interpreter.

    Code executes in Monty's Rust interpreter, inside a pooled worker
    subprocess: no host filesystem, environment, or network access, and
    an interpreter crash costs a worker rather than this process. File
    I/O and `os.environ` are serviced through the injected workspace
    dispatch, so the code sees the workspace mounts and nothing else.
    Command-line arguments are exposed as the `argv` global (`argv[0]`
    is the script name) and piped input as the `stdin` global (bytes,
    None when nothing was piped). Monty implements a Python subset;
    host-only features (`sys.stdin`, `sys.argv`, third-party imports)
    are unavailable; supported stdlib modules are listed under "Python
    subset" in docs/home/setup/runtime/monty.mdx. The parser refuses
    class inheritance, method decorators and `yield` — use the `wasi`
    or `local` runtime for a program that needs those.
    """

    name = "monty"
    version_suffix = " (monty)"
    # The pooled worker subprocess exists for crash isolation, not
    # host access: the interpreter inside it has no host filesystem,
    # environment, or network entry point, and its file I/O is serviced only
    # through the workspace dispatch, so nothing goes around the gate.
    reach: RuntimeReach = "workspace"
    filesystem: ClassVar[tuple[FilesystemOperation, ...]] = (
        "read",
        "write",
        "list",
        "stat",
    )
    # No import system to resolve a module with, so `-m` has nothing to
    # run; the refusal names this runtime rather than inventing a
    # "No module named" that would imply a search happened.
    runs_modules: ClassVar[bool] = False

    config_cls: ClassVar[type[RuntimeConfig]] = MontyConfig
    config: MontyConfig

    def __init__(
        self,
        captures: Sequence[str] | None = None,
        config: MontyConfig | dict[str, Any] | None = None,
    ) -> None:
        if pydantic_monty is None:
            raise ImportError(MISSING_EXTRA_HINT)
        super().__init__(captures, config)
        self._max_memory = memory_limit(self.config.max_memory)

    async def open_engine(self) -> MontyExecution:
        return MontyExecution(self._max_memory)

    async def close_engine(self, engine: MontyExecution) -> None:
        await engine.close()

    async def interpret(
        self,
        engine: MontyExecution,
        program: Program,
        ctx: Context,
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        """Run one program, reporting any switch this engine cannot honor.

        Monty implements a Python subset with no ``compile``, no
        ``warnings`` and no ``sys.path``, so the interpreter-init
        switches have nothing to act on here even though every
        real-CPython engine honors them. The notice rides on stderr,
        ahead of what the program writes there, and the program's own
        exit code stands.

        Args:
            engine (MontyExecution): the install's worker pool.
            program (Program): the source and argv to run.
            ctx (Context): the run's context.
            output (OutputFn | None): receives stdout as it is printed.
            errors (OutputFn | None): receives stderr as it is printed.
        """
        notice = unhonored_notice(ctx.flags, self.name)
        if notice and errors is not None:
            await errors(notice)
            notice = b""
        # A nested call must not queue behind a parent holding this pool.
        nested = ctx.processes is not None and ctx.processes.depth > 0
        execution = MontyExecution(self._max_memory) if nested else engine
        files = RuntimeFiles.of(ctx, self._binding)
        try:
            result = await execution.run(
                program,
                ctx.cwd,
                MontyFs(files, ctx.env or {}),
                output,
                errors,
            )
        except asyncio.CancelledError:
            if files is not None:
                await settle(asyncio.create_task(files.abort()))
            raise
        finally:
            if execution is not engine:
                await execution.close()
        if not notice:
            return result
        return replace(result, stderr=notice + (result.stderr or b""))
