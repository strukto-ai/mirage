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

from mirage.commands.builtin.utils.limit import run_with_timeout
from mirage.io import IOResult
from mirage.io.types import ByteSource, materialize
from mirage.policy import resolve_limit
from mirage.runtime.constants import EXTERNAL_COMMANDS
from mirage.runtime.mixin import ProcessExecutorMixin
from mirage.runtime.routing.types import RouteDecision
from mirage.runtime.types import ProcessExecution, RunResult, ShellExecution
from mirage.types import PathSpec, Producer
from mirage.workspace.expand.argv import Argv
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import Session, env_snapshot
from mirage.workspace.types import ExecutionNode


async def run_external(
    argv: Argv,
    stdin: ByteSource | None,
    session: Session,
    registry: MountRegistry,
    routing: RouteDecision | None = None
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Execute one admitted program; its surrounding shell stays in Mirage."""
    bindings = (routing.bindings
                if routing is not None else registry.runtime_bindings)
    runtime = bindings.get(argv.name, bindings.get(EXTERNAL_COMMANDS))
    command = shlex.join(argv.tokens)
    if runtime is None:
        err = f"{argv.name}: no runtime accepted this line\n".encode()
        return None, IOResult(exit_code=126,
                              stderr=err), ExecutionNode(command=command,
                                                         exit_code=126,
                                                         stderr=err)
    cwd = PathSpec.from_str_path(session.cwd)
    env = env_snapshot(session)
    guard = resolve_limit(argv.name, registry.mounts())

    async def execute() -> RunResult:
        data = await materialize(stdin) if stdin is not None else None
        if isinstance(runtime, ProcessExecutorMixin):
            return await runtime.execute(
                ProcessExecution(argv=argv.tokens,
                                 cwd=cwd,
                                 env=env,
                                 stdin=data))
        return await runtime.execute(
            ShellExecution(line=command, cwd=cwd, env=env, stdin=data))

    try:
        result = await run_with_timeout(
            execute(), guard.timeout_seconds if guard is not None else None,
            argv.name)
    finally:
        await registry.invalidate_after_external()
    io = IOResult(exit_code=result.exit_code,
                  stderr=result.stderr or b"",
                  producer=Producer(command=argv.name,
                                    prefixes=tuple(
                                        m.prefix for m in registry.mounts())))
    return result.stdout, io, ExecutionNode(command=command,
                                            exit_code=result.exit_code,
                                            stderr=result.stderr or b"")
