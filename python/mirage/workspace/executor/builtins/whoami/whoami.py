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
from mirage.shell.bytes import encode_text
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.types import ExecutionNode


async def handle_whoami(
    namespace: Namespace,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    # GNU whoami reports the effective user and never consults $USER;
    # the workspace user (launch agent_id, shared via the namespace
    # store) is the effective identity here. With no claimed identity
    # it fails like GNU does for a uid with no passwd entry.
    if namespace.user is None:
        err = b"whoami: cannot find name for user ID\n"
        return (
            None,
            IOResult(exit_code=1, stderr=err),
            ExecutionNode(command="whoami", exit_code=1, stderr=err),
        )
    out = encode_text(f"{namespace.user}\n")
    return out, IOResult(), ExecutionNode(command="whoami", exit_code=0)


async def whoami_builtin(call: BuiltinCall) -> Result:
    """The ``whoami`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_whoami(call.namespace)
