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

from mirage.commands.builtin.utils.links import link_view
from mirage.context import program_invocation, reset_admission, set_admission
from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.shell.errors import ExitSignal
from mirage.shell.types import ShellBuiltin as SB
from mirage.types import PathSpec, word_text
from mirage.view.types import SessionView
from mirage.workspace.executor.builtins.condition.flat import eval_flat
from mirage.workspace.executor.builtins.condition.tree import eval_cond
from mirage.workspace.executor.builtins.condition.types import (
    AdmitTest,
    CondContext,
    CondError,
    CondNode,
    CondRefused,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.files import Files
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import session_view
from mirage.workspace.types import ExecutionNode


async def handle_test(
    dispatch: DispatchFn,
    namespace: Namespace,
    args: list[str | PathSpec] | CondNode,
    session: SessionState,
    name: str = "test",
    view: SessionView | None = None,
    admit: AdmitTest | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Evaluate test/[ (flat argv) or [[ (condition tree).

    ``[ ]`` and ``[[ ]]`` are the shell's own tests, which no command
    gate admitted, so each is admitted here by its own name on what it
    tests, read as every reader of the line reads it (``reads_of_test``):
    ``[``'s whole argv before it runs, each ``[[`` leaf as it is
    reached. A refusal is the test's answer, as it is ``test``'s.

    Args:
        dispatch (DispatchFn): op dispatcher for file probes.
        namespace (Namespace): addressing authority (symlink table).
        args (list[str | PathSpec] | CondNode): flat operands for
            test/[, a CondNode tree for [[.
        session (SessionState): session for cwd, env, and BASH_REMATCH.
        name (str): invocation name for diagnostics: "test", "[", "[[".
        view (SessionView | None): the gated session view, for
            an assignment inside a numeric operand.
        admit (AdmitTest | None): admits the words of a test by its
            own name; None where the command was admitted already.
    """
    ctx = CondContext(
        dispatch=dispatch,
        namespace=namespace,
        session=session,
        name=name,
        view=view,
        admit=admit,
        links=link_view(
            Files(
                dispatch,
                namespace.readers(lambda _session: session.visibility),
                clock=namespace.clock,
            )
        ),
    )
    try:
        if isinstance(args, list):
            code = await _flat_status(ctx, args, admit)
        else:
            code = await eval_cond(ctx, args)
    except CondRefused as refused:
        return (
            None,
            IOResult(
                exit_code=refused.exit_code,
                stderr=refused.stderr,
                refusal=refused.refusal,
            ),
            ExecutionNode(
                command=name,
                exit_code=refused.exit_code,
                stderr=refused.stderr,
                refused=True,
            ),
        )
    except CondError as err:
        # The builtin's own diagnostic is in bash's voice; the program
        # (`find -exec test`) keeps its bare one.
        message = err.message
        if message.startswith(f"{name}: ") and not program_invocation(session):
            message = f"bash: {message}"
        stderr = encode_text(message + "\n")
        if name == "[[" and err.fatal:
            # A bad [[ ]] operator is a bash PARSE error: the whole
            # input line dies, not just this command.
            raise ExitSignal(2, stderr=stderr, contained_code=2)
        return (
            None,
            IOResult(exit_code=err.exit_code, stderr=stderr),
            ExecutionNode(
                command="test", exit_code=err.exit_code, stderr=stderr
            ),
        )
    return (
        None,
        IOResult(exit_code=code),
        ExecutionNode(command="test", exit_code=code),
    )


async def _flat_status(
    ctx: CondContext, args: list[str | PathSpec], admit: AdmitTest | None
) -> int:
    """The status of a flat test, admitted whole first where it has
    to be: on its words and its closing ``]``, as the command ``[`` is.

    Args:
        ctx (CondContext): evaluation context.
        args (list[str | PathSpec]): the test's operands.
        admit (AdmitTest | None): admits them, None where the command
            was admitted already.
    """
    if admit is None:
        return 0 if await eval_flat(ctx, args) else 1
    words = [word_text(a) for a in args]
    token = set_admission(await admit([*words, "]"]))
    try:
        return 0 if await eval_flat(ctx, args) else 1
    finally:
        reset_admission(token)


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
            err = encode_text(
                "[: missing ']'\n"
                if program_invocation(call.context.session)
                else "bash: [: missing `]'\n"
            )
            return (
                None,
                IOResult(exit_code=2, stderr=err),
                ExecutionNode(command="[", exit_code=2, stderr=err),
            )
    return await handle_test(
        call.dispatch,
        call.namespace,
        test_args,
        call.context.session,
        name=test_name,
        view=session_view(
            call.context.session,
            call.namespace.registry.policies,
            diagnostics=call.context.frame.diagnostics,
        ),
    )
