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

from mirage.context import (
    clear_program_invocation,
    reset_current_session,
    reset_program_invocation,
    set_current_evaluation,
)
from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import decode_text
from mirage.shell.console import JobConsole, JobOutput
from mirage.shell.job_table import JobTable
from mirage.shell.options import parse_option_word
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.script.constants import (
    BASH_LONG_OPTIONS,
    BASH_START_FLAGS,
)
from mirage.workspace.executor.builtins.script.script import (
    read_script_file,
    script_error,
)
from mirage.workspace.executor.builtins.script.types import BashArgs
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.executor.traps import clear_exit_trap, finish_shell
from mirage.workspace.types import ExecutionNode


def parse_bash_args(args: list[str]) -> BashArgs:
    """Split a ``bash``/``sh`` argument list into flags, program and argv.

    Option parsing stops at the first operand, so everything after a
    script file (or after ``-c``'s program text) is positional, even when
    it looks like a flag: ``bash run.sh -c foo`` passes ``-c foo`` to the
    script. ``-`` and ``--`` both end it without being operands.

    ``-c`` takes the next *word*, never the rest of its cluster, which is
    where bash's own parser departs from getopt: ``bash -cx 'echo hi'``
    traces and runs ``echo hi`` rather than running ``x``.

    Args:
        args (list[str]): words after the head word.
    """
    settings: list[tuple[str, bool]] = []
    read_stdin = False
    i = 0
    while i < len(args):
        tok = args[i]
        if tok in ("--", "-"):
            i += 1
            break
        if tok.startswith("--"):
            takes_value = BASH_LONG_OPTIONS.get(tok)
            if takes_value is None:
                return BashArgs(invalid=tok)
            i += 2 if takes_value else 1
            continue
        nxt = args[i + 1] if i + 1 < len(args) else None
        word = parse_option_word(tok, nxt)
        if word is None:
            break
        if any(ch not in BASH_START_FLAGS for ch in word.other):
            return BashArgs(invalid=tok)
        settings.extend(word.settings)
        read_stdin = read_stdin or "s" in word.other
        if "c" in word.other:
            if i + word.consumed >= len(args):
                return BashArgs(needs_value="-c")
            return BashArgs(
                script=args[i + word.consumed],
                argv=args[i + word.consumed + 1 :],
                settings=tuple(settings),
            )
        i += word.consumed
    # The program comes from stdin whenever no operand names one, which
    # is the rule `-s` states explicitly for the case where operands do
    # follow: `bash -s A B` reads stdin and makes A and B positional.
    if i < len(args) and not read_stdin:
        return BashArgs(
            path=args[i], argv=args[i + 1 :], settings=tuple(settings)
        )
    return BashArgs(argv=args[i:], settings=tuple(settings))


async def handle_bash(
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    args: list[str],
    context: EvaluationContext,
    stdin: ByteSource | None = None,
    name: str = "bash",
    sink: JobConsole | None = None,
    job_table: JobTable | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a nested shell: inline text from ``-c``, or a script file.

    A nested shell is a program of its own, so it runs on a new shell
    started from the session's environment (``SessionState.new_shell``)
    and leaves the caller's state alone: ``bash -c 'cd /x'`` leaves the
    caller where it was, and ``x=1; bash -c 'echo $x'`` prints an empty
    line, as in bash, where the nested shell is a separate process.
    `source` is the opposite case and deliberately runs on the caller's
    session, because a sourced file is the caller.

    Args:
        dispatch (DispatchFn): op dispatcher, used to read a script file.
        execute_fn (Callable): runs the program text in this session.
        args (list[str]): words after the head word.
        context (EvaluationContext): the evaluation's session and frame.
        stdin (ByteSource | None): input stream, also the program source
            when no operand names one.
        name (str): the head word (``bash`` or ``sh``). bash reports
            itself by ``argv[0]``, so the diagnostics follow the spelling
            the caller used.
        sink (JobConsole | None): where the program's statements write
            as they finish, None to return them.
        job_table (JobTable | None): the caller's jobs, which the nested
            shell starts a table of its own beside.
    """
    session = context.session
    parsed = parse_bash_args(args)
    if parsed.invalid is not None:
        # GNU words this "invalid option" and follows it with a usage
        # block. One word covers both cases here on purpose: some of what
        # lands here is an option bash has and mirage does not implement
        # (`-r`, `-a`, `--version`), and calling those invalid would be a
        # lie. The exit status is GNU's 2 either way.
        return script_error(name, f"{parsed.invalid}: unsupported option", 2)
    if parsed.needs_value is not None:
        return script_error(
            name, f"{parsed.needs_value}: option requires an argument", 2
        )
    script = parsed.script
    named = script is not None and bool(parsed.argv)
    script_name = parsed.argv[0] if named else name
    positional = parsed.argv[1:] if script is not None else parsed.argv
    if script is None and parsed.path is not None:
        script_name = parsed.path
        script, failure = await read_script_file(
            dispatch, name, parsed.path, session
        )
        if failure is not None:
            return failure
    if script is None and stdin is not None:
        stdin_data = await materialize(stdin)
        if stdin_data:
            script = decode_text(stdin_data)
            stdin = None
    if script is None:
        return None, IOResult(), ExecutionNode(command=name, exit_code=0)
    context = EvaluationContext(
        context.session.new_shell(), context.frame.fork(), context
    )
    session = context.session
    child_token = set_current_evaluation(context)
    clear_exit_trap(session)
    session.job_output = JobOutput(session.job_output or session.tty.jobs)
    session.positional_args = positional
    session.script_name = script_name
    for option, enable in parsed.settings:
        session.shell_options[option] = enable
    # A nested shell is a program of its own: the builtins it runs are
    # its builtins again, whatever `find -exec` marked the outer line.
    token = clear_program_invocation()
    # A nested shell is its own process, with its own jobs: its `jobs` and
    # `wait` see only them, its EXIT action's included, and they are not
    # its caller's.
    if job_table is not None:
        execute_fn = partial(execute_fn, job_table=job_table.child())
    try:
        io = await execute_fn(
            script,
            session_id=session.session_id,
            stdin=stdin,
            sink=sink,
        )
        io = await finish_shell(execute_fn, session, io, stdin)
    finally:
        reset_program_invocation(token)
        reset_current_session(child_token)
    label = f"{name} {parsed.path}" if parsed.path else f"{name} -c {script}"
    return io.stdout, io, ExecutionNode(command=label, exit_code=io.exit_code)


async def bash_builtin(call: BuiltinCall) -> Result:
    """The ``bash`` / ``sh`` arm.

    Args:
        call (BuiltinCall): the invocation; the head word names the
            shell the nested program reports itself as.
    """
    return await handle_bash(
        call.dispatch,
        call.execute_fn,
        list(call.argv.args),
        call.context,
        call.stdin,
        str(call.argv.name),
        call.sink,
        call.job_table,
    )
