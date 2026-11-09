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

from mirage._rs import Shell, ShellTask
from mirage.shell.bytes import encode_text
from mirage.shell.call_stack import CallStack
from mirage.shell.join import shell_join
from mirage.shell.printer import stored_function_text
from mirage.shell.variable import VarAttr
from mirage.shell.voice import shell_voice
from mirage.workspace.evaluation import EvaluationContext
from mirage.workspace.executor.builtins.alias.alias import body_alias_values
from mirage.workspace.executor.builtins.declare.constants import (
    EXPORT_FLAGS,
    READONLY_FLAGS,
)
from mirage.workspace.executor.builtins.declare.types import (
    DeclarationOperand,
)
from mirage.workspace.executor.builtins.shared import (
    builtin_usage,
    fail,
    ok,
    result,
    written,
)
from mirage.workspace.executor.builtins.types import BuiltinCall, Result
from mirage.workspace.expand.node import run_on_shell
from mirage.workspace.expand.types import ExecuteFn
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import deciding, prefix_temporaries
from mirage.workspace.types import ExecutionNode


async def declared(
    cmd: str,
    start: Callable[[Shell], ShellTask],
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    call_stack: CallStack | None,
) -> Result:
    """Run a declaration on the session's shell and answer what it printed.

    Args:
        cmd (str): the builtin's name, for the node.
        start (Callable[[Shell], ShellTask]): starts it on the shell.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (ExecuteFn): evaluator for a subscript's substitutions.
        call_stack (CallStack | None): shell call stack.
    """
    pieces, status = await run_on_shell(start, context, execute_fn, call_stack)
    return written(cmd, pieces, status)


def split_decl_flags(
    args: list[DeclarationOperand],
    allowed: frozenset[str],
) -> tuple[set[str], list[DeclarationOperand], str | None]:
    """Split leading ``-xyz`` flag clusters from declaration operands.

    Returns:
        ``(flags, operands, bad)`` where ``bad`` is the first illegal
        option character, or ``None`` when every flag is allowed.
    """
    flags: set[str] = set()
    i = 0
    while i < len(args):
        tok = args[i]
        if not isinstance(tok, str):
            break
        if tok == "--":
            i += 1
            break
        if tok.startswith("-") and len(tok) > 1:
            body = tok[1:]
            illegal = next((c for c in body if c not in allowed), None)
            if illegal is not None:
                return flags, args[i:], illegal
            flags.update(body)
            i += 1
            continue
        break
    return flags, args[i:], None


def function_flags(session: SessionState, name: str) -> str:
    """The letters ``declare`` prints a function with: ``f``, then ``r``
    when ``readonly -f`` froze it and ``x`` when ``export -f`` marked it.

    Args:
        session (SessionState): shell session state.
        name (str): the function's name.
    """
    readonly = "r" if name in session.readonly_functions else ""
    exported = "x" if name in session.exported_functions else ""
    return f"f{readonly}{exported}"


def function_lines(
    session: SessionState, names: list[str], bodies: bool, marks: bool
) -> list[str]:
    """Print functions as ``declare`` lists them.

    A body prints as bash renders it (``stored_function_text``), followed
    with ``marks`` by a ``declare -fx NAME`` line when the function has
    an attribute; without bodies each function is its ``declare`` line,
    or its bare name.

    Args:
        session (SessionState): shell session state.
        names (list[str]): defined function names, in order.
        bodies (bool): print each body (``-f``) rather than a line.
        marks (bool): print the attribute line (``-p``, a listing).
    """
    lines: list[str] = []
    for name in names:
        flags = function_flags(session, name)
        if bodies:
            lines.append(
                stored_function_text(
                    name,
                    session.functions[name],
                    body_alias_values(session, name),
                )
            )
            if marks and flags != "f":
                lines.append(f"declare -{flags} {name}")
        else:
            lines.append(f"declare -{flags} {name}" if marks else name)
    return lines


def handle_declare_functions(
    cmd: str,
    session: SessionState,
    flags: set[str],
    names: list[str],
    plus: frozenset[str],
) -> Result:
    """Run the function half of ``declare``: ``-f`` / ``-F``.

    ``-p`` only prints, whatever attributes come with it: ``-F NAME``
    the attribute line, ``-f NAME`` the body and, for a function with an
    attribute, that line (``function_lines``); a missing name is
    ``not found``, exit 1. Without ``-p``, ``-r`` freezes the named
    functions as ``readonly -f`` does, ``-x`` marks them for export and
    ``+x`` takes the mark off, printing nothing; a ``+`` letter wins over
    its ``-`` twin, and ``+r`` refuses a frozen function, which then
    keeps every attribute (``readonly function``, exit 1); with no attribute
    ``-F NAME`` prints the name and ``-f NAME`` the body, and a missing
    name is exit 1 with no message. With no names every function lists
    as ``-p`` prints it; ``-r`` or ``-x`` narrows the list to the
    functions holding either attribute, and a ``+`` attribute does not.

    Args:
        cmd (str): the builtin's own name for a diagnostic.
        session (SessionState): shell session state.
        flags (set[str]): the declaration's collected flag letters.
        names (list[str]): the function names, empty to list all.
        plus (frozenset[str]): the attribute letters given with ``+``.
    """
    printing = "p" in flags
    wanted = flags & {"r", "x"}
    present = [name for name in names if name in session.functions]
    missing = [name for name in names if name not in session.functions]
    if names and not printing and (wanted or plus & {"r", "x"}):
        frozen = [
            name
            for name in present
            if "r" in plus and name in session.readonly_functions
        ]
        for name in present:
            if name in frozen:
                continue
            if "r" in flags - plus:
                session.readonly_functions.add(name)
            if "x" in plus:
                session.exported_functions.discard(name)
            elif "x" in flags:
                session.exported_functions.add(name)
        return result(
            cmd,
            exit_code=1 if missing or frozen else 0,
            stderr="".join(
                f"{shell_voice()}{cmd}: {name}: readonly function\n"
                for name in frozen
            ),
        )
    if not names:
        names = [
            name
            for name in sorted(session.functions)
            if not wanted or wanted & set(function_flags(session, name))
        ]
        printing = True
    pieces: list[tuple[bool, str]] = []
    for name in names:
        if name in session.functions:
            pieces.extend(
                (False, f"{line}\n")
                for line in function_lines(
                    session, [name], "F" not in flags, printing
                )
            )
        elif printing:
            pieces.append((True, f"{shell_voice()}{cmd}: {name}: not found\n"))
    return written(cmd, pieces, 1 if missing else 0)


async def mark_names(
    assignments: list[DeclarationOperand],
    context: EvaluationContext,
    execute_fn: ExecuteFn,
    call_stack: CallStack | None,
    attr: VarAttr,
) -> Result:
    """Run ``export`` or ``readonly``: mark names, or print them.

    An invalid option letter fails with status 2 and the GNU usage line.
    ``-f`` marks functions instead (``mark_functions``); the variables'
    half runs on the shell.

    Args:
        assignments (list[DeclarationOperand]): the option words, then
            the operands in order.
        context (EvaluationContext): the evaluation's session and frame.
        execute_fn (ExecuteFn): evaluator for nested lines.
        call_stack (CallStack | None): shell call stack.
        attr (VarAttr): EXPORT or READONLY.
    """
    session = context.session
    exporting = attr is VarAttr.EXPORT
    cmd = "export" if exporting else "readonly"
    flags, names, bad = split_decl_flags(
        assignments, EXPORT_FLAGS if exporting else READONLY_FLAGS
    )
    if bad is not None:
        usage = builtin_usage("export" if exporting else "readonly")
        return fail(
            cmd, f"{shell_voice()}{cmd}: -{bad}: invalid option\n{usage}", 2
        )
    on = "n" not in flags

    def marking(functions: bool) -> Callable[[Shell], ShellTask]:
        return lambda shell: shell.mark_names(
            cmd,
            attr.value,
            on,
            "".join(sorted(flags)),
            names,
            prefix_temporaries(session),
            functions,
            deciding(),
        )

    if "f" not in flags:
        return await declared(
            cmd, marking(False), context, execute_fn, call_stack
        )
    marked = (
        session.exported_functions if exporting else session.readonly_functions
    )
    return await mark_functions(
        cmd,
        session,
        marked,
        names,
        on,
        await run_on_shell(marking(True), context, execute_fn, call_stack)
        if not all(isinstance(name, str) for name in names)
        else ([], 0),
    )


async def mark_functions(
    cmd: str,
    session: SessionState,
    marked: set[str],
    operands: list[DeclarationOperand],
    on: bool,
    staged: tuple[list[tuple[bool, bytes]], int],
) -> Result:
    """Run ``readonly -f`` or ``export -f``: mark functions, or list them.

    A name that is not a function is ``not a function``, exit 1, and the
    other operands are still marked (or, with ``on`` False, unmarked),
    in the order typed. An array literal (``export -f ARR=(a b)``) still
    stores first, and its name is then checked at its place, as bash
    assigns every literal before it looks for the functions. With no
    names the marked functions print as bodies, each followed by its
    ``declare`` line.

    Args:
        cmd (str): the builtin's own name for a diagnostic.
        session (SessionState): shell session state.
        marked (set[str]): the session's set of marked functions.
        operands (list[DeclarationOperand]): the function names and
            staged literals in order, empty to list.
        on (bool): set the mark rather than clear it.
        staged (tuple[list[tuple[bool, bytes]], int]): what storing the
            array literals said, and its status.
    """
    said, status = staged
    if status:
        return written(cmd, said, status)
    names = [o if isinstance(o, str) else o[0] for o in operands]
    if not names:
        listed = sorted(name for name in marked if name in session.functions)
        lines = function_lines(session, listed, True, True)
        return ok(cmd, encode_text("".join(f"{line}\n" for line in lines)))
    errors: list[str] = []
    for name in names:
        if name not in session.functions:
            errors.append(f"{shell_voice()}{cmd}: {name}: not a function\n")
        elif on:
            marked.add(name)
        else:
            marked.discard(name)
    return written(
        cmd,
        [*said, *((True, line) for line in errors)],
        1 if errors else 0,
    )


async def declaration_builtin(call: BuiltinCall) -> Result:
    """The ``declare``, ``typeset`` and ``readonly`` arm, for a name the
    parser did not read as a declaration: after an assignment
    (``n=1 declare -p n``) or from an expansion (``$d -p n``). The words
    run again as the declaration they spell, as ``command`` runs them,
    the name's alias masked: bash expands none in a word that came from
    an expansion.

    Args:
        call (BuiltinCall): the invocation.
    """
    session = call.context.session
    saved_alias = session.aliases.pop(call.argv.name, None)
    try:
        io = await call.execute_fn(
            shell_join([call.argv.name, *call.argv.args]),
            session_id=session.session_id,
            stdin=call.stdin,
            call_stack=call.call_stack,
        )
    finally:
        if saved_alias is not None:
            session.aliases[call.argv.name] = saved_alias
    return (
        io.stdout,
        io,
        ExecutionNode(command=call.argv.name, exit_code=io.exit_code),
    )
