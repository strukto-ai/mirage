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
from functools import partial
from typing import Any

from mirage.context import clear_program_invocation, reset_program_invocation
from mirage.io import IOResult
from mirage.io.async_line_iterator import share
from mirage.io.types import ByteSource
from mirage.policy.decisions import Decisions
from mirage.policy.types import HandOff
from mirage.shell.call_stack import CallStack
from mirage.shell.console import JobConsole
from mirage.shell.errors import ExitSignal, ReturnSignal
from mirage.shell.helpers import parse_function
from mirage.shell.job_table import JobTable
from mirage.shell.parse.scope import ParseScope
from mirage.shell.variable import ShellVar
from mirage.types import PathSpec, word_text
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.command.types import ExecuteNodeFn
from mirage.workspace.executor.control import execute_body, returning
from mirage.workspace.executor.traps import (
    lift_function_traps,
    restore_function_traps,
)
from mirage.workspace.session.state import restore_locals
from mirage.workspace.types import ExecutionNode


async def run_shell_function(
    execute_node: ExecuteNodeFn,
    cmd_name: str,
    parts: list[str | PathSpec],
    context: EvaluationContext,
    stdin: ByteSource | None,
    call_stack: CallStack | None,
    job_table: JobTable | None = None,
    agent_id: str | None = None,
    handed: HandOff | None = None,
    decisions: Decisions | None = None,
    sink: JobConsole | None = None,
    execute_fn: Callable[..., Any] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a user-defined shell function's body statement by statement.

    Locals declared with ``local``/``declare`` shadow and restore on
    exit, ``return`` stops the body via :class:`ReturnSignal`, ``$?``
    tracks each inner statement, and ``set -e`` aborts the body on the
    first failing statement exactly as it does at top level. The body
    sees no inherited ERR or RETURN action unless ``set -E`` / ``set
    -T``; one it sets itself it sees, and the RETURN action runs as it
    returns.

    Args:
        execute_node (ExecuteNodeFn): the executor's statement runner.
        cmd_name (str): the function's name (already resolved).
        parts (list[str | PathSpec]): classified command words; the
            tail becomes the function's positional arguments as typed.
        context (EvaluationContext): session whose env/arrays host the locals.
        stdin (ByteSource | None): stdin forwarded to each statement.
        call_stack (CallStack | None): the caller's stack, or a fresh
            one for a top-level call.
        job_table (JobTable | None): the job plane for a body statement
            ending in ``&``.
        agent_id (str | None): agent identity for job bookkeeping.
        handed (HandOff | None): approval claims inherited by a job.
        decisions (Decisions | None): ledger that holds those claims.
        sink (JobConsole | None): where each statement writes as it
            finishes, None to return the body's output.
        execute_fn (Callable[..., Any] | None): runs a trap action as a
            line of the shell; None where nothing can run one.
    """
    session = context.session
    scope = ParseScope()
    try:
        func_body = parse_function(session.functions[cmd_name], scope.parse)
    except BaseException:
        scope.release()
        raise
    if sink is not None:
        execute_node = partial(execute_node, sink=sink)
    # The body's statements read the caller's stdin in turn.
    stdin = share(stdin)
    cs = call_stack if call_stack is not None else CallStack()
    # Positional args carry the word as typed ($1 stays sub/a.txt).
    text_args = [word_text(p) for p in parts[1:]]
    cs.push(text_args, function_name=cmd_name)
    lifted = lift_function_traps(session)
    outer_names = session.function_names
    if outer_names is not None:
        session.function_names = cs.function_names()
    # One stack: a local shadows the whole record, so the caller's
    # value and attributes are saved and put back together.
    saved_locals: dict[str, ShellVar | None] = {}
    # The caller's frame is kept and put back: a function that calls
    # another and then declares a `local` is still inside a function,
    # and its own shadows must keep being recorded on its own frame.
    outer_locals = session._local_vars
    session._local_vars = saved_locals
    session._local_frames.append(saved_locals)
    # The body is shell code: the builtins it runs are the shell's,
    # whatever `xargs` or `env` marked the line that called it.
    marked = clear_program_invocation()
    # The body is parsed again from its source, so its rows restart at
    # 0; it expands the aliases its definition saw, or reads them as a
    # parse of its own when it came from a stored session. It was read
    # apart from the alias that may have called it, whose guards do not
    # reach it (`alias a=f` still lets `f`'s body run its own `a`).
    outer_parse = (session._parse_current, session._parse_row)
    outer_view = session._alias_view
    outer_expansion = session._alias_expansion
    session._alias_expansion = None
    site = session._function_sites.get(cmd_name)
    if site is not None and site.source != session.functions[cmd_name]:
        site = None
    if site is None:
        session._parse_seq += 1
        mark = (session._parse_seq, 0)
    else:
        mark = site.mark
    session._parse_current, session._parse_row = mark
    session._alias_view = (
        dict(site.aliases)
        if site is not None and site.aliases is not None
        else None
    )
    # Its commands stand under the definition's place, on a hand-off of
    # their own as every re-parse does, so two definitions of one text
    # each need a nod and a second call runs on the first's.
    origin = site.origin if site is not None else None
    nested = (
        HandOff(parent=handed, origin=origin)
        if handed is not None and origin is not None
        else None
    )
    body_handed = nested if nested is not None else handed
    if nested is not None:
        execute_node = partial(execute_node, handed=nested)
    try:
        try:
            stdout, merged_io, last_exec = await execute_body(
                execute_node,
                func_body,
                context,
                stdin,
                cs,
                job_table,
                agent_id,
                body_handed,
                decisions,
                execute_fn,
                sink,
            )
        except ReturnSignal as sig:
            stdout = sig.stdout
            merged_io = IOResult(
                stderr=sig.stderr or None, exit_code=sig.exit_code
            )
            last_exec = ExecutionNode(command=cmd_name)
        stdout, merged_io = await returning(
            execute_fn, session, stdin, cs, stdout, merged_io, sink
        )
        last_exec.exit_code = merged_io.exit_code
        return stdout, merged_io, last_exec
    except ExitSignal as sig:
        # An `exec` replaced the shell: the actions went with it, so the
        # ones the body took from its caller do not come back.
        if sig.replaced is not None:
            lifted = (None, None)
        raise
    finally:
        session._parse_current, session._parse_row = outer_parse
        session._alias_view = outer_view
        session._alias_expansion = outer_expansion
        if nested is not None and decisions is not None:
            decisions.hand_up(session.session_id, nested)
        scope.release()
        reset_program_invocation(marked)
        cs.pop()
        if session.function_names is not None:
            session.function_names = outer_names
        restore_function_traps(session, lifted)
        restore_locals(session, saved_locals)
        session._local_frames.pop()
        session._local_vars = outer_locals
