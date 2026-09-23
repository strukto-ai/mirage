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

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import env_snapshot
from mirage.workspace.types import ExecutionNode


async def handle_printenv(
    name: str | None,
    session: SessionState,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    # The process view, not the shell view: GNU printenv is a separate
    # binary, so the only names it can possibly see are the exported
    # ones. A plain `X=hello` is invisible to it and exits 1.
    env = env_snapshot(session)
    if name:
        val = env.get(name)
        if val is None:
            return None, IOResult(exit_code=1), ExecutionNode(
                command="printenv", exit_code=1)
        out = f"{val}\n".encode()
    else:
        lines = [f"{k}={v}" for k, v in env.items()]
        out = ("\n".join(sorted(lines)) + "\n").encode()
    return out, IOResult(), ExecutionNode(command="printenv", exit_code=0)


async def printenv_builtin(call: BuiltinCall) -> Result:
    """The ``printenv`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    args = list(call.argv.args)
    var_name = args[0] if args else None
    return await handle_printenv(var_name, call.session)
