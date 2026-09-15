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
from typing import Any, Callable, ClassVar

from mirage.runtime.config import RuntimeConfig
from mirage.runtime.mixin import EvaluatorMixin
from mirage.runtime.python.base import PythonRuntime
from mirage.runtime.python.flags import unhonored_notice
from mirage.runtime.python.monty.binding import pydantic_monty
from mirage.runtime.python.monty.constants import MISSING_EXTRA_HINT
from mirage.runtime.python.monty.execution import MontyExecution
from mirage.runtime.python.monty.osaccess import MirageOSAccess
from mirage.runtime.types import (EvalResult, EvalValue, FilesystemOperation,
                                  RunArgs, RunResult, RuntimeContext,
                                  RuntimeReach, ScriptSource)


class MontyRuntime(PythonRuntime, EvaluatorMixin):
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
    are unavailable, and the stdlib is json/re/math/datetime/typing —
    use the `local` runtime for those.
    """

    name = "monty"
    version_suffix = " (monty)"
    # The pooled worker subprocess exists for crash isolation, not
    # host access: the interpreter inside it has no host filesystem,
    # environment, or network door, and its file I/O is serviced only
    # through the workspace dispatch, so nothing goes around the gate.
    reach: RuntimeReach = "vfs"
    filesystem: ClassVar[tuple[FilesystemOperation,
                               ...]] = ('read', 'write', 'list', 'stat')
    # No import system to resolve a module with, so `-m` has nothing to
    # run; the refusal names this runtime rather than inventing a
    # "No module named" that would imply a search happened.
    runs_modules: ClassVar[bool] = False

    def __init__(
            self,
            captures: Sequence[str] | None = None,
            config: RuntimeConfig | dict[str, Any] | None = None,
            script: Callable[..., Any] | ScriptSource | None = None) -> None:
        if pydantic_monty is None:
            raise ImportError(MISSING_EXTRA_HINT)
        super().__init__(captures, config, script)
        self._execution = MontyExecution()

    async def _execute_code(self, args: RunArgs,
                            context: RuntimeContext | None) -> RunResult:
        return await self.run(args, context)

    async def run(self,
                  args: RunArgs,
                  context: RuntimeContext | None = None) -> RunResult:
        """Run one program, reporting any switch this engine cannot honor.

        Monty implements a Python subset with no ``compile``, no
        ``warnings`` and no ``sys.path``, so the interpreter-init
        switches have nothing to act on here even though every
        real-CPython engine honors them. The notice rides on stderr and
        the program's own exit code stands.

        Args:
            args (RunArgs): the execution request.
        """
        notice = unhonored_notice(args.flags, self.name)
        result = await self._execution.run(
            args, self._bridge(args.env, context or self._capture_context()))
        if not notice:
            return result
        return replace(result, stderr=notice + (result.stderr or b""))

    async def eval(self,
                   code: str,
                   *,
                   inputs: dict[str, EvalValue] | None = None,
                   session: str | None = None) -> EvalResult:
        bridge = self._bridge({}, self._capture_context())
        return await self._execution.eval(code,
                                          bridge,
                                          inputs=inputs,
                                          session=session)

    async def close(self) -> None:
        await self._execution.close()

    def _bridge(self, env: dict[str, str],
                context: RuntimeContext | None) -> MirageOSAccess:
        return MirageOSAccess(
            asyncio.get_running_loop(),
            context.dispatch if context is not None else None, env,
            context.resolver if context is not None else None)
