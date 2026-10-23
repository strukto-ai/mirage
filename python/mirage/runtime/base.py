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
from abc import ABC
from collections.abc import Sequence
from dataclasses import replace
from typing import Any, Callable, ClassVar, Generic, cast

from mirage.commands.config import Context
from mirage.context.session_context import bind_caller, reset_caller
from mirage.runtime.binding import WorkspaceBinding, refused_run
from mirage.runtime.config import RuntimeConfig
from mirage.runtime.errors import UnsupportedExecutionError
from mirage.runtime.mixin import E, LineExecutorMixin, ProcessExecutorMixin
from mirage.runtime.types import (
    ExecutionKind,
    FilesystemOperation,
    OutputFn,
    RunResult,
    RuntimeReach,
)
from mirage.types import PathSpec
from mirage.utils.activity import Activity

logger = logging.getLogger(__name__)


class Runtime(ABC, Generic[E]):
    """An engine the workspace can route commands or whole lines to.

    A runtime is to its commands what the regex engine is to grep: the
    machinery inside a handler, invisible to the dispatcher. Each
    runtime declares the command names it captures; a command binds to
    the first runtime in the workspace's ordered list that captures
    it. Its hooks take what a handler takes, ``(engine, paths, texts,
    ctx)``: the engine (``E``) is built once by ``open_engine``.

    The base holds only what every tier shares: the registry name, the
    captured command names, the coerced config and the engine. What a
    runtime can DO is declared by its tier and mixins, detected by type
    and never by probing: LanguageRuntime interprets code in its
    language (run), LineExecutorMixin takes whole lines (run_line),
    ProcessExecutorMixin runs an argv (run_process).
    """

    name: str
    captures: tuple[str, ...] = ()
    # Which entry points this runtime's code has to the outside world (see
    # RuntimeReach): "workspace" when the workspace dispatch is its only
    # one, as the bridged engines (monty, quickjs, wasi) and the workspace
    # routing marker declare, "process" or "remote" when the code can
    # act around that gate. The default is "process", the no-promise
    # claim, so a custom runtime must declare a narrower reach
    # explicitly rather than inherit it. Embedders read the aggregate:
    # only a world in which every runtime reaches "workspace" makes "agent
    # code cannot bypass mount modes and policy" a true statement; one
    # wider runtime voids it.
    reach: RuntimeReach = "process"
    filesystem: ClassVar[tuple[FilesystemOperation, ...]] = ()
    # Each runtime's config class; coerce() makes unknown fields fail
    # loud, so runtimes need no per-field rejection code.
    config_cls: ClassVar[type[RuntimeConfig]] = RuntimeConfig
    config: RuntimeConfig = RuntimeConfig()
    _binding: WorkspaceBinding | None = None
    _activity: Activity | None = None
    _retired: bool = False
    _engine_task: "asyncio.Future[E] | None" = None
    _closing: "asyncio.Task[None] | None" = None

    def __init__(
        self,
        captures: Sequence[str] | None = None,
        config: RuntimeConfig | dict[str, Any] | None = None,
    ) -> None:
        """Every runtime is constructed the same way.

        Args:
            captures (Sequence[str] | None): commands this runtime
                claims, overriding the class default; EXTERNAL_COMMANDS
                captures unresolved program names. ("*",) claims
                every line for a line-executing runtime. None keeps
                the default.
            config (RuntimeConfig | dict[str, Any] | None): the
                runtime's implementation knobs, coerced through its
                own config class (config_cls), so a field the runtime
                does not have fails loud; the dict form is a yaml
                entry's ``config`` block.
        """
        if captures is not None:
            self.captures = tuple(captures)
        self.config = self.config_cls.coerce(config)

    @property
    def file_effects_dispatched(self) -> bool:
        """Whether workspace file mutations already invalidate through dispatch."""
        return self.reach == "workspace"

    async def settle(self) -> None:
        """Land the file writes this runtime still holds for a line.

        The executor calls it when a line ends, however it ended, so the
        line's writes are in the workspace by the time it returns. Holds
        none by default; a sandbox serving the workspace over SFTP lands
        what its servers hold.
        """
        return None

    def bind(self, binding: WorkspaceBinding) -> None:
        """Bind this instance to one workspace."""
        if self._retired:
            raise ValueError(
                f"{self.name}: runtime was removed from its workspace; "
                "construct a new one"
            )
        if self._binding is not None and self._binding is not binding:
            raise ValueError(
                f"{self.name}: runtime is already bound to another workspace"
            )
        self._binding = binding

    async def execute(
        self,
        paths: Sequence[PathSpec],
        texts: Sequence[str],
        ctx: Context,
        *,
        kind: ExecutionKind = "code",
        output: OutputFn | None = None,
        errors: OutputFn | None = None,
    ) -> RunResult:
        """Run once, as the session the bound workspace captures.

        The capture supplies the files (``ctx.vfs``, judged as the
        program's own calls) and the session; the caller's ``ctx`` the
        rest.

        Args:
            paths (Sequence[PathSpec]): the path operands (a script).
            texts (Sequence[str]): the text operands (argv; a process's
                program first).
            ctx (Context): the run's context.
            kind (ExecutionKind): code in the runtime's language, a
                whole line (``sh -c`` with ``ctx.flags["c"]``), or a
                process.
            output (OutputFn | None): where a streamed process writes
                its output; None collects it in the result.
            errors (OutputFn | None): the same for its stderr.
        """
        release = self.admit()
        try:
            capture = self._binding.capture() if self._binding else None
            if (
                capture is not None
                and self.reach != "workspace"
                and capture.restricted_mounts
                and not self._serves_session(capture.restricted_mounts)
            ):
                return refused_run(
                    self.name,
                    "runtime cannot enforce this session's file restrictions",
                )
            engine = await self.engine()
            if capture is None:
                return await self._run(
                    kind, engine, list(paths), list(texts), ctx, output, errors
                )
            run_ctx = replace(
                ctx,
                vfs=capture.ctx.vfs,
                session=(
                    capture.ctx.session
                    if capture.ctx.session is not None
                    else ctx.session
                ),
                processes=(
                    ctx.processes
                    if ctx.processes is not None
                    else capture.ctx.processes
                ),
            )
            token = bind_caller(capture.caller)
            try:
                return await self._run(
                    kind,
                    engine,
                    list(paths),
                    list(texts),
                    run_ctx,
                    output,
                    errors,
                )
            finally:
                reset_caller(token)
        finally:
            release()

    async def _run(
        self,
        kind: ExecutionKind,
        engine: E,
        paths: list[PathSpec],
        texts: list[str],
        ctx: Context,
        output: OutputFn | None,
        errors: OutputFn | None,
    ) -> RunResult:
        """Hand the run to the capability its kind asks for.

        Args:
            kind (ExecutionKind): what is asked.
            engine (E): the engine.
            paths (list[PathSpec]): the path operands.
            texts (list[str]): the text operands.
            ctx (Context): the run's context.
            output (OutputFn | None): a streamed process's output.
            errors (OutputFn | None): a streamed process's stderr.
        """
        if kind == "process" and not texts:
            raise ValueError("process argv must not be empty")
        if kind == "code":
            return await self.run(engine, paths, texts, ctx)
        if kind == "line" and isinstance(self, LineExecutorMixin):
            return await self.run_line(engine, paths, texts, ctx)
        if kind == "process" and isinstance(self, ProcessExecutorMixin):
            return await self.run_process(
                engine, paths, texts, ctx, output, errors
            )
        raise UnsupportedExecutionError(
            f"{self.name}: {kind} execution is unsupported"
        )

    async def run(
        self, engine: E, paths: list[PathSpec], texts: list[str], ctx: Context
    ) -> RunResult:
        """Run code in this runtime's language; only a language runtime
        has one.

        Args:
            engine (E): the install's engine.
            paths (list[PathSpec]): the script operand, if any.
            texts (list[str]): the program's argv.
            ctx (Context): the run's context.
        """
        raise UnsupportedExecutionError(
            f"{self.name}: code execution is unsupported"
        )

    async def open_engine(self) -> E:
        """Build the engine every run reuses, once; the default is None."""
        return cast(E, None)

    async def close_engine(self, engine: E) -> None:
        """Release what ``open_engine`` built.

        Args:
            engine (E): the engine.
        """
        return None

    async def engine(self) -> E:
        """The engine, opened once and shared; a failed open is retried."""
        if self._engine_task is None:
            self._engine_task = asyncio.ensure_future(self.open_engine())
        opening = self._engine_task
        try:
            return await asyncio.shield(opening)
        except Exception:
            if self._engine_task is opening:
                self._engine_task = None
            raise

    def _serves_session(self, restricted_mounts: tuple[str, ...]) -> bool:
        """Whether every restricted mount is served through this caller's gate.

        Args:
            restricted_mounts (tuple[str, ...]): the mounts the session
                restricts.
        """
        return False

    def admit(self) -> Callable[[], None]:
        """Count one unit of work, refused once the runtime is retired."""
        if self._retired:
            raise RuntimeError(
                f"{self.name}: runtime was removed from the workspace"
            )
        if self._activity is None:
            self._activity = Activity()
        return self._activity.acquire()

    async def retire(self) -> None:
        """Refuse new executions and binds, then wait for running ones."""
        self._retired = True
        if self._activity is not None:
            await self._activity.wait()

    async def close(self) -> None:
        """Close the engine, when one was opened.

        The close runs as its own task, so a cancelled caller leaves it
        running, and a close that comes while it runs waits for it rather
        than finding nothing left to close.
        """
        closing = self._closing
        if closing is None:
            closing = self._closing = asyncio.ensure_future(
                self._drop_engine()
            )
        try:
            await asyncio.shield(closing)
        finally:
            if closing.done() and self._closing is closing:
                self._closing = None

    async def _drop_engine(self) -> None:
        opening, self._engine_task = self._engine_task, None
        if opening is None:
            return
        try:
            engine = await opening
        except Exception as exc:
            logger.debug("%s: engine never opened: %s", self.name, exc)
            return
        await self.close_engine(engine)
