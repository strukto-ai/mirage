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

from mirage.shell.call_stack import CallStack
from mirage.shell.constants import FUNCNAME
from mirage.shell.voice import shell_voice
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.help import flag_help
from mirage.workspace.executor.builtins.shared import (
    builtin_usage,
    fail,
    written,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.expand.node import run_on_shell
from mirage.workspace.expand.types import ExecuteFn
from mirage.workspace.session.state import deciding


async def _unset_word(
    letters: str,
    word: str,
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    call_stack: CallStack | None,
) -> tuple[list[tuple[bool, bytes]], int]:
    """Unset one operand on the shell, then what it named on the host,
    before the next operand runs.

    Args:
        letters (str): the option letters.
        word (str): the operand.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (ExecuteFn): evaluator for a subscript's substitutions.
        call_stack (CallStack | None): shell call stack.

    Returns:
        tuple[list[tuple[bool, bytes]], int]: what it said, and its status.
    """
    session = context.session
    pieces, status, function, tracked = await run_on_shell(
        lambda shell: shell.unset_word(
            letters,
            word,
            word in session.functions,
            word in session.readonly_functions,
            deciding(),
        ),
        context,
        execute_fn,
        call_stack,
    )
    if function:
        session.remove_function(word)
    if tracked == "OPTIND":
        session._getopts_optind = None
    if tracked == FUNCNAME:
        session.function_names = None
    return pieces, status


async def handle_unset(
    args: list[str],
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    call_stack: CallStack | None = None,
) -> Result:
    """Read ``unset``'s options and unset its operands in order.

    Args:
        args (list[str]): option words followed by names to unset.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (ExecuteFn): evaluator for a subscript's substitutions.
        call_stack (CallStack | None): shell call stack.
    """
    if args[:1] == ["--help"]:
        answered = flag_help("unset")
        if answered is not None:
            return answered
    letters: set[str] = set()
    i = 0
    while i < len(args) and args[i].startswith("-") and args[i] != "-":
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if all(ch in "vfn" for ch in tok[1:]):
            letters.update(tok[1:])
            i += 1
            continue
        return fail(
            "unset",
            f"{shell_voice()}unset: {tok}: invalid option\n"
            + builtin_usage("unset"),
            2,
        )
    if {"f", "v"} <= letters:
        return fail(
            "unset",
            f"{shell_voice()}unset: cannot simultaneously unset a function"
            " and a variable\n",
        )
    said: list[tuple[bool, bytes]] = []
    failed = 0
    for word in args[i:]:
        pieces, status = await _unset_word(
            "".join(sorted(letters)), word, context, execute_fn, call_stack
        )
        said.extend(pieces)
        failed |= status
    return written("unset", said, failed)


async def unset_builtin(call: BuiltinCall) -> Result:
    """The ``unset`` arm.

    Args:
        call (BuiltinCall): the invocation.
    """
    return await handle_unset(
        list(call.argv.args), call.context, call.execute_fn, call.call_stack
    )
