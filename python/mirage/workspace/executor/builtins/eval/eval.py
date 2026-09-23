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

from collections.abc import Callable
from typing import Any

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecutionNode


async def handle_eval(
    execute_fn: Callable[..., Any],
    args: list[str],
    session: SessionState,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    script = " ".join(args)
    io = await execute_fn(script, session_id=session.session_id)
    return io.stdout, io, ExecutionNode(command="eval", exit_code=io.exit_code)


async def eval_builtin(call: BuiltinCall) -> Result:
    """The ``eval`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_eval(call.execute_fn, list(call.argv.args),
                             call.session)
