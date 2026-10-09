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

from abc import ABC
from collections.abc import Sequence
from typing import Any, Callable, ClassVar

from mirage.runtime.binding import RuntimeContext, WorkspaceBinding
from mirage.runtime.config import RuntimeConfig
from mirage.runtime.errors import UnsupportedExecutionError
from mirage.runtime.mixin import (
    EvaluatorMixin,
    LineExecutorMixin,
    ProcessExecutorMixin,
)
from mirage.runtime.routing.types import RouteScript
from mirage.runtime.types import (
    ExecutionRequest,
    FilesystemOperation,
    ProcessExecution,
    RunResult,
    RuntimeCapabilities,
    RuntimeReach,
    ShellExecution,
)
from mirage.utils.activity import Activity


class Runtime(ABC):
    """An engine the workspace can route commands or whole lines to.

    A runtime is to its commands what the regex engine is to grep: the
    machinery inside a handler, invisible to the dispatcher. Each
    runtime declares the command names it captures; a command binds to
    the first runtime in the workspace's ordered list that captures
    it. Implementations own their engine lifecycle (lazy boot, reuse
    across runs, teardown in close).

    The base holds only what every tier shares: the registry name, the
    captured command names, the coerced config, and the per-line
    admission script. What a runtime can DO is declared by its tier
    and mixins, detected by type and never by probing: LanguageRuntime
    interprets one command's code (run), LineExecutorMixin takes whole
    lines (run_line), EvaluatorMixin evaluates expressions (eval).
    """

    name: str
    captures: tuple[str, ...] = ()
    # Which entry points this runtime's code has to the outside world (see
    # RuntimeReach): "workspace" when the workspace dispatch is its only
    # one, as the bridged engines (monty, quickjs, wasi) and the vfs
    # routing marker declare, "process" or "remote" when the code can
    # act around that gate. The default is "process", the no-promise
    # claim, so a custom runtime must declare a narrower reach
    # explicitly rather than inherit it. Embedders read the aggregate:
    # only a world in which every runtime reaches "workspace" makes "agent
    # code cannot bypass mount modes and policy" a true statement; one
    # wider runtime voids it.
    reach: RuntimeReach = "process"
    filesystem: ClassVar[tuple[FilesystemOperation, ...]] = ()
    # Per-line admission script for the routing ladder, answering "do
    # I want this line": a callable taking a RouteContext, or a
    # config-borne ScriptSource. None = always willing. Policy, not
    # capability: it can only refuse lines the captures already allow.
    script: RouteScript | None = None
    # Each runtime's config class; coerce() makes unknown fields fail
    # loud, so runtimes need no per-field rejection code.
    config_cls: ClassVar[type[RuntimeConfig]] = RuntimeConfig
    config: RuntimeConfig = RuntimeConfig()
    _binding: WorkspaceBinding | None = None
    _activity: Activity | None = None
    _retired: bool = False

    def __init__(
        self,
        captures: Sequence[str] | None = None,
        config: RuntimeConfig | dict[str, Any] | None = None,
        script: RouteScript | None = None,
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
            script (RouteScript | None): per-line
                admission script for the routing ladder.
        """
        if captures is not None:
            self.captures = tuple(captures)
        self.config = self.config_cls.coerce(config)
        self.script = script

    @property
    def capabilities(self) -> RuntimeCapabilities:
        return RuntimeCapabilities(
            process=isinstance(self, ProcessExecutorMixin),
            shell=isinstance(self, LineExecutorMixin),
            evaluate=isinstance(self, EvaluatorMixin),
            reach=self.reach,
            filesystem=self.filesystem,
        )

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
        self, request: ExecutionRequest, context: RuntimeContext | None = None
    ) -> RunResult:
        """Execute directly, or under the bound workspace's captured context.

        This is the engine entry point. Workspace.shell remains the shell
        admission and routing entry point, as it was for callers of run and
        run_line.
        """
        release = self.admit()
        try:
            if context is None and self._binding is not None:
                context = self._binding.capture()
            if context is not None:
                if context.binding is not self._binding:
                    raise ValueError(
                        f"{self.name}: context belongs to another binding"
                    )
                return await context.scope.run(
                    lambda: self._execute(request, context)
                )
            return await self._execute(request, None)
        finally:
            release()

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

    def _capture_context(self) -> RuntimeContext | None:
        return self._binding.capture() if self._binding is not None else None

    async def _execute(
        self, request: ExecutionRequest, context: RuntimeContext | None
    ) -> RunResult:
        if isinstance(request, ProcessExecution) and isinstance(
            self, ProcessExecutorMixin
        ):
            if not request.argv:
                raise ValueError("process argv must not be empty")
            return await self.run_process(request)
        if isinstance(request, ShellExecution) and isinstance(
            self, LineExecutorMixin
        ):
            return await self.run_line(
                request.line, request.stdin, request.env, request.cwd.virtual
            )
        raise UnsupportedExecutionError(
            f"{self.name}: {request.kind} execution is unsupported"
        )

    async def close(self) -> None:
        """Release engine resources. Default: nothing held."""
