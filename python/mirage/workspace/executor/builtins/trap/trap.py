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
from mirage.workspace.types import ExecutionNode


async def handle_trap(
        session: SessionState,  # noqa: E125
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    return None, IOResult(), ExecutionNode(command="trap", exit_code=0)


async def trap_builtin(call: BuiltinCall) -> Result:
    """The ``trap`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_trap(call.session)
