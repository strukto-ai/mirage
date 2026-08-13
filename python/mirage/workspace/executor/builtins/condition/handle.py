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
from mirage.runtime.types import DispatchFn
from mirage.shell.errors import ExitSignal
from mirage.types import PathSpec
from mirage.workspace.executor.builtins.condition.flat import eval_flat
from mirage.workspace.executor.builtins.condition.tree import eval_cond
from mirage.workspace.executor.builtins.condition.types import (CondContext,
                                                                CondError,
                                                                CondNode)
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_test(
    dispatch: DispatchFn,
    namespace: Namespace,
    args: list[str | PathSpec] | CondNode,
    session: Session,
    name: str = "test",
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Evaluate test/[ (flat argv) or [[ (condition tree).

    Args:
        dispatch (DispatchFn): op dispatcher for file probes.
        namespace (Namespace): addressing authority (symlink table).
        args (list[str | PathSpec] | CondNode): flat operands for
            test/[, a CondNode tree for [[.
        session (Session): session for cwd, env, and BASH_REMATCH.
        name (str): invocation name for diagnostics: "test", "[", "[[".
    """
    ctx = CondContext(dispatch=dispatch,
                      namespace=namespace,
                      session=session,
                      name=name)
    try:
        if isinstance(args, list):
            result = await eval_flat(ctx, args)
        else:
            result = await eval_cond(ctx, args)
    except CondError as err:
        stderr = (err.message + "\n").encode()
        if name == "[[":
            # A bad [[ ]] operator is a bash PARSE error: the whole
            # input line dies, not just this command.
            raise ExitSignal(2, stderr=stderr, contained_code=2)
        return None, IOResult(exit_code=2,
                              stderr=stderr), ExecutionNode(command="test",
                                                            exit_code=2,
                                                            stderr=stderr)
    code = 0 if result else 1
    return None, IOResult(exit_code=code), ExecutionNode(command="test",
                                                         exit_code=code)
