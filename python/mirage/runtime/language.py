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
from dataclasses import replace
from typing import ClassVar

from mirage.runtime.base import Runtime
from mirage.runtime.errors import UnsupportedExecutionError
from mirage.runtime.types import (CodeExecution, ExecutionRequest, Language,
                                  RunArgs, RunResult, RuntimeCapabilities,
                                  RuntimeContext)


class LanguageRuntime(Runtime):
    """A runtime that interprets one language's code inside a command.

    The engine inside a single command (python3, node): the workspace
    splits the line, and a captured stage's code lands here as run().
    Never the whole line; that is LineExecutorMixin's door.

    The language it interprets is declared once, for both doors: run()
    for a script CLI (runtime_for_language) and eval() for a
    config-borne policy script (evaluator_of). One attribute, because
    two would let a runtime claim python at one door and js at the
    other, and the disagreement would only surface as an unexplained
    127 or a policy evaluated on the wrong engine. Concrete runtimes
    inherit it from their language tier (PythonRuntime, JsRuntime)
    rather than declaring it per class.

    A host adapter receives data, namespace and gated session views through
    WorkspaceBinding and its per-execution RuntimeContext. Guests receive
    only RunArgs.env,
    a copy whose writes do not mutate the Mirage session; the adapter must
    explicitly use the gated SessionView for any intended session write.
    """

    language: ClassVar[Language]

    @property
    def capabilities(self) -> RuntimeCapabilities:
        return replace(super().capabilities, languages=(self.language, ))

    async def _execute(self, request: ExecutionRequest,
                       context: RuntimeContext | None) -> RunResult:
        if isinstance(request, CodeExecution):
            if request.language != self.language:
                raise UnsupportedExecutionError(
                    f"{self.name}: {request.language} execution is unsupported"
                )
            return await self._execute_code(request, context)
        return await super()._execute(request, context)

    async def _execute_code(self, args: RunArgs,
                            context: RuntimeContext | None) -> RunResult:
        return await self.run(args)

    async def version(self, env: dict[str, str]) -> RunResult:
        """Report the bound interpreter's version.

        Args:
            env (dict[str, str]): the session environment.
        """
        return RunResult(
            stdout=b"",
            stderr=f"{self.name}: version information unavailable\n".encode(),
            exit_code=1)

    @abstractmethod
    async def run(self, args: RunArgs) -> RunResult:
        """Execute one program and return its captured outcome.

        Args:
            args (RunArgs): the execution request.
        """
