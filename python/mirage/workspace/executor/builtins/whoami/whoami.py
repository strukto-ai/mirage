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

from mirage.commands.builtin.utils.identity import (
    Identity,
    own_account,
    session_uid,
)
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.shell.bytes import encode_text
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.types import ExecutionNode


async def handle_whoami(
    identity: Identity,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Print the name of the effective user, as whoami does: it never
    reads ``$USER``, and fails for a uid the user database lacks.

    Args:
        identity (Identity): who the session is.
    """
    account = own_account(identity)
    if account is None:
        err = encode_text(
            f"whoami: cannot find name for user ID {session_uid(identity)}\n"
        )
        return (
            None,
            IOResult(exit_code=1, stderr=err),
            ExecutionNode(command="whoami", exit_code=1, stderr=err),
        )
    out = encode_text(f"{account.name}\n")
    return out, IOResult(), ExecutionNode(command="whoami", exit_code=0)


async def whoami_builtin(call: BuiltinCall) -> Result:
    """The ``whoami`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_whoami(Identity(profile=call.context.session.profile))
