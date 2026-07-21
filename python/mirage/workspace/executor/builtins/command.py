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

import shlex
from collections.abc import Callable
from typing import Any

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.workspace.mount import MountRegistry
from mirage.workspace.route import route
from mirage.workspace.route.types import Consumer
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

_USAGE = "command: usage: command [-pVv] command [arg ...]\n"

# bash reserved words: reported by `command -v/-V` as keywords even
# though the parser, not the executor, consumes them.
_KEYWORDS = frozenset({
    "if",
    "then",
    "else",
    "elif",
    "fi",
    "case",
    "esac",
    "for",
    "select",
    "while",
    "until",
    "do",
    "done",
    "in",
    "function",
    "time",
    "coproc",
    "{",
    "}",
    "!",
    "[[",
    "]]",
})


def _parse_flags(args: list[str]) -> tuple[str | None, list[str], str | None]:
    """Split ``command``'s own options from its operands.

    bash uses non-permuting getopt: option scanning stops at the first
    non-option word (or ``--``), so a flag after the target name belongs
    to the target, not to ``command``. Only ``-p -v -V`` are valid; ``-p``
    is accepted but has no identity effect (mirage has no PATH), and the
    last of ``-v``/``-V`` wins.

    Args:
        args (list[str]): words after the ``command`` name.

    Returns:
        ``(mode, rest, bad)`` where ``mode`` is ``"v"``/``"V"``/``None``,
        ``rest`` is the operand words, and ``bad`` is the first invalid
        option (as ``-x``) or ``None``.
    """
    mode: str | None = None
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if not (tok.startswith("-") and len(tok) > 1):
            break
        for ch in tok[1:]:
            if ch == "v":
                mode = "v"
            elif ch == "V":
                mode = "V"
            elif ch == "p":
                continue
            else:
                return None, [], f"-{ch}"
        i += 1
    return mode, args[i:], None


def _classify(name: str, session: Session, registry: MountRegistry) -> str:
    """Classify a name for ``command -v/-V`` reporting.

    Args:
        name (str): the operand word.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry.

    Returns:
        One of ``"keyword"``, ``"function"``, ``"builtin"``, ``"not_found"``.
        Every mirage-native runnable non-function name (shell builtin,
        namespace command, or mount command) reports as ``"builtin"``:
        mirage has no external binaries, so there is no honest path to
        print, and grouping them matches bash's runnable-and-in-process
        category (a deliberate divergence from bash's file paths).
    """
    if name in _KEYWORDS:
        return "keyword"
    consumer = route(name, session, registry)
    if consumer is Consumer.FUNCTION:
        return "function"
    if consumer is Consumer.UNKNOWN:
        return "not_found"
    return "builtin"


def _describe(name: str, kind: str) -> str:
    """Render the ``command -V`` verbose line for a classified name.

    Args:
        name (str): the operand word.
        kind (str): the classification from ``_classify``.
    """
    if kind == "keyword":
        return f"{name} is a shell keyword"
    if kind == "function":
        return f"{name} is a function"
    return f"{name} is a shell builtin"


def _type_word(kind: str) -> str:
    """The single classification word printed by ``type -t``.

    Args:
        kind (str): the classification from ``_classify``.
    """
    if kind == "keyword":
        return "keyword"
    if kind == "function":
        return "function"
    return "builtin"


def _probe(
    mode: str, rest: list[str], session: Session, registry: MountRegistry
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the ``-v``/``-V`` introspection modes.

    The exit status is 0 when no names are given, otherwise 0 if any name
    resolved and 1 if none did (bash's ``command`` uses this any-found
    rule, unlike ``type``'s all-found rule). ``-v`` prints the name for a
    resolvable command (no fake path); ``-V`` prints a verbose line.
    Not-found names are silent under ``-v`` and warn on stderr under ``-V``.

    Args:
        mode (str): ``"v"`` or ``"V"``.
        rest (list[str]): operand words to classify.
        session (Session): shell session state.
        registry (MountRegistry): mount registry.
    """
    out_lines: list[str] = []
    err_lines: list[str] = []
    any_found = False
    for name in rest:
        kind = _classify(name, session, registry)
        if kind == "not_found":
            if mode == "V":
                err_lines.append(f"command: {name}: not found")
            continue
        any_found = True
        out_lines.append(name if mode == "v" else _describe(name, kind))
    out = ("\n".join(out_lines) + "\n").encode() if out_lines else None
    err = ("\n".join(err_lines) + "\n").encode() if err_lines else b""
    code = 0 if (not rest or any_found) else 1
    return out, IOResult(exit_code=code,
                         stderr=err), ExecutionNode(command="command",
                                                    exit_code=code,
                                                    stderr=err)


def _parse_type_flags(
        args: list[str]) -> tuple[str | None, bool, list[str], str | None]:
    """Split ``type``'s options from its name operands.

    Recognizes ``-t`` (type word only), ``-p``/``-P`` (path; empty for
    mirage's pathless builtins), ``-a`` (all locations; one in mirage),
    and ``-f`` (skip the function table). Non-permuting like bash: option
    scanning stops at the first non-option word or ``--``.

    Args:
        args (list[str]): words after the ``type`` name.

    Returns:
        ``(mode, nofunc, rest, bad)`` where ``mode`` is ``"t"``/``"p"``/
        ``None``, ``nofunc`` skips functions, ``rest`` is the operands,
        and ``bad`` is the first invalid option (as ``-x``) or ``None``.
    """
    mode: str | None = None
    nofunc = False
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if not (tok.startswith("-") and len(tok) > 1):
            break
        for ch in tok[1:]:
            if ch == "t":
                mode = "t"
            elif ch in ("p", "P"):
                mode = "p"
            elif ch == "a":
                continue
            elif ch == "f":
                nofunc = True
            else:
                return None, False, [], f"-{ch}"
        i += 1
    return mode, nofunc, args[i:], None


def handle_type(
    args: list[str],
    session: Session,
    registry: MountRegistry,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the ``type`` builtin (``type [-afptP] name [name ...]``).

    Mirrors ``command -V`` resolution (every mirage-native runnable name
    is reported as a shell builtin; there are no external paths), but uses
    ``type``'s all-found exit rule: 0 only when every name resolves. ``-t``
    prints the classification word, ``-p``/``-P`` print a path (always
    empty here), and a missing name warns on stderr unless a word-only
    mode (``-t``/``-p``) is active.

    Args:
        args (list[str]): words after the ``type`` name.
        session (Session): shell session (function table).
        registry (MountRegistry): mount registry for name resolution.
    """
    mode, nofunc, rest, bad = _parse_type_flags(args)
    if bad is not None:
        err = (f"type: {bad}: invalid option\n"
               "type: usage: type [-afptP] name [name ...]\n").encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="type",
                                                         exit_code=2,
                                                         stderr=err)
    out_lines: list[str] = []
    err_lines: list[str] = []
    all_found = True
    for name in rest:
        if nofunc and name in session.functions:
            saved = session.functions.pop(name)
            try:
                kind = _classify(name, session, registry)
            finally:
                session.functions[name] = saved
        else:
            kind = _classify(name, session, registry)
        if kind == "not_found":
            all_found = False
            if mode is None:
                err_lines.append(f"type: {name}: not found")
            continue
        if mode == "t":
            out_lines.append(_type_word(kind))
        elif mode == "p":
            continue
        else:
            out_lines.append(_describe(name, kind))
    out = ("\n".join(out_lines) + "\n").encode() if out_lines else None
    err = ("\n".join(err_lines) + "\n").encode() if err_lines else b""
    code = 0 if (not rest or all_found) else 1
    return out, IOResult(exit_code=code,
                         stderr=err), ExecutionNode(command="type",
                                                    exit_code=code,
                                                    stderr=err)


async def handle_command_builtin(
    execute_fn: Callable[..., Any],
    args: list[str],
    session: Session,
    registry: MountRegistry,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run the ``command`` builtin (``command [-pVv] name [arg ...]``).

    Without ``-v``/``-V`` it runs the target ignoring any shell function
    of the same name (bash's function bypass): the name is masked in the
    session function table for the inner run so a shadowing function is
    skipped while builtins and mount commands still resolve. Already
    expanded operands are re-joined with ``shlex`` so they survive
    re-parsing as one token each.

    Args:
        execute_fn (Callable): shell evaluator for the inner line.
        args (list[str]): words after the ``command`` name.
        session (Session): shell session state.
        registry (MountRegistry): mount registry for name resolution.
        stdin (ByteSource | None): piped input for the inner run.
    """
    mode, rest, bad = _parse_flags(args)
    if bad is not None:
        err = f"command: {bad}: invalid option\n{_USAGE}".encode()
        return None, IOResult(exit_code=2,
                              stderr=err), ExecutionNode(command="command",
                                                         exit_code=2,
                                                         stderr=err)
    if mode is not None:
        return _probe(mode, rest, session, registry)
    if not rest:
        return None, IOResult(), ExecutionNode(command="command", exit_code=0)

    inner_name = rest[0]
    inner = shlex.join(rest)
    # Function bodies are never None, so popping with a None default lets
    # `is not None` mean "a shadowing function was masked" for restore.
    saved_fn = session.functions.pop(inner_name, None)
    try:
        io = await execute_fn(inner,
                              session_id=session.session_id,
                              stdin=stdin)
    finally:
        if saved_fn is not None:
            session.functions[inner_name] = saved_fn
    return io.stdout, io, ExecutionNode(command="command",
                                        exit_code=io.exit_code)
