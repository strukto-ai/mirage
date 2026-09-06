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
from mirage.ops.types import SessionView
from mirage.runtime.types import DispatchFn
from mirage.shell.errors import ExitSignal
from mirage.shell.types import ShellBuiltin as SB
from mirage.types import PathSpec, word_text
from mirage.workspace.executor.builtins.condition.flat import eval_flat
from mirage.workspace.executor.builtins.condition.tree import eval_cond
from mirage.workspace.executor.builtins.condition.types import (CondContext,
                                                                CondError,
                                                                CondNode)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session
from mirage.workspace.session.state import session_view
from mirage.workspace.types import ExecutionNode


async def handle_test(
    dispatch: DispatchFn,
    namespace: Namespace,
    args: list[str | PathSpec] | CondNode,
    session: Session,
    name: str = "test",
    view: SessionView | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Evaluate test/[ (flat argv) or [[ (condition tree).

    Args:
        dispatch (DispatchFn): op dispatcher for file probes.
        namespace (Namespace): addressing authority (symlink table).
        args (list[str | PathSpec] | CondNode): flat operands for
            test/[, a CondNode tree for [[.
        session (Session): session for cwd, env, and BASH_REMATCH.
        name (str): invocation name for diagnostics: "test", "[", "[[".
        view (SessionView | None): the session plane's gated door, for
            an assignment inside a numeric operand.
    """
    ctx = CondContext(dispatch=dispatch,
                      namespace=namespace,
                      session=session,
                      name=name,
                      view=view)
    try:
        if isinstance(args, list):
            result = await eval_flat(ctx, args)
        else:
            result = await eval_cond(ctx, args)
    except CondError as err:
        stderr = (err.message + "\n").encode()
        if name == "[[" and err.fatal:
            # A bad [[ ]] operator is a bash PARSE error: the whole
            # input line dies, not just this command.
            raise ExitSignal(2, stderr=stderr, contained_code=2)
        return None, IOResult(exit_code=err.exit_code,
                              stderr=stderr), ExecutionNode(
                                  command="test",
                                  exit_code=err.exit_code,
                                  stderr=stderr)
    code = 0 if result else 1
    return None, IOResult(exit_code=code), ExecutionNode(command="test",
                                                         exit_code=code)


async def test_builtin(call: BuiltinCall) -> Result:
    """The ``test`` / ``[`` / ``[[`` arm.

    Args:
        call (BuiltinCall): the invocation; ``[`` must close with ``]``.
    """
    name = call.argv.name
    test_args = list(call.argv.operands)
    test_name = "[" if name == SB.BRACKET else "test"
    if name == SB.BRACKET:
        if test_args and word_text(test_args[-1]) == "]":
            test_args = test_args[:-1]
        else:
            err = b"[: missing `]'\n"
            return None, IOResult(exit_code=2,
                                  stderr=err), ExecutionNode(command="[",
                                                             exit_code=2,
                                                             stderr=err)
    return await handle_test(call.dispatch,
                             call.namespace,
                             test_args,
                             call.session,
                             name=test_name,
                             view=session_view(
                                 call.session,
                                 call.namespace.registry.policies))
