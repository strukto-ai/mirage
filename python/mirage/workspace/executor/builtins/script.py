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

import asyncio
import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from mirage.io import IOResult
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.shell.types import SET_FLAG_TO_OPTION
from mirage.types import FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, fs_strerror
from mirage.utils.path import resolve_path
from mirage.workspace.abort import cancellable_sleep
from mirage.workspace.executor.builtins.links import resolve_path_stat
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode


async def handle_source(
    dispatch: Callable[..., Any],
    execute_fn: Callable[..., Any],
    path: str | PathSpec,
    session: Session,
    args: list[str] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Read a script file and execute it.

    Args:
        dispatch (Callable): op dispatcher, used to read the file.
        execute_fn (Callable): runs the script text in this session.
        path (str | PathSpec): the script to source.
        session (Session): shell session state.
        args (list[str] | None): positional parameters to expose to the
            script. When given they replace ``$1..$#`` for the duration
            of the source and are restored afterwards, matching bash;
            when omitted the parent's positional parameters are kept.
    """
    raw = _scope_path(path)
    resolved = resolve_path(raw, session.cwd)
    scope = _to_scope(resolved)
    data, _ = await dispatch("read", scope)
    if isinstance(data, bytes):
        script = data.decode(errors="replace")
    else:
        script = ""
    saved_positional: list[str] | None = None
    if args:
        saved_positional = session.positional_args
        session.positional_args = args
    session.source_depth += 1
    try:
        io = await execute_fn(script, session_id=session.session_id)
    finally:
        session.source_depth -= 1
        if saved_positional is not None:
            session.positional_args = saved_positional
    return io.stdout, io, ExecutionNode(command=f"source {raw}",
                                        exit_code=io.exit_code)


async def handle_eval(
    execute_fn: Callable[..., Any],
    args: list[str],
    session: Session,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    script = " ".join(args)
    io = await execute_fn(script, session_id=session.session_id)
    return io.stdout, io, ExecutionNode(command="eval", exit_code=io.exit_code)


# Startup flags with nothing to configure in an embedded shell: there is
# no login profile, no rc file and no tty. Flags that name a `set` option
# (-e -u -x -f) are not here; they are applied through SET_FLAG_TO_OPTION.
_BASH_NOOP_SHORT_FLAGS = frozenset({"l", "i"})

_BASH_NOOP_LONG_FLAGS = frozenset(
    {"--login", "--norc", "--noprofile", "--posix", "--rcfile"})


def _bash_error(name: str, message: str,
                code: int) -> tuple[None, IOResult, ExecutionNode]:
    err = f"{name}: {message}\n".encode()
    return None, IOResult(exit_code=code,
                          stderr=err), ExecutionNode(command=name,
                                                     exit_code=code,
                                                     stderr=err)


@dataclass(frozen=True, slots=True)
class BashArgs:
    """One parsed ``bash``/``sh`` invocation.

    Args:
        script (str | None): inline program text from ``-c``.
        path (str | None): script file operand, as typed.
        argv (list[str]): words after the program, ``$0`` first for the
            ``-c`` form and all positional for the file form.
        options (list[str]): shell options the startup flags turn on.
        read_stdin (bool): ``-s`` was given.
        error (tuple | None): a ready usage failure, when parsing failed.
    """
    script: str | None = None
    path: str | None = None
    argv: list[str] = field(default_factory=list)
    options: list[str] = field(default_factory=list)
    read_stdin: bool = False
    error: tuple[None, IOResult, ExecutionNode] | None = None


def parse_bash_args(name: str, args: list[str]) -> BashArgs:
    """Split a ``bash``/``sh`` argument list into flags, program and argv.

    Option parsing stops at the first operand, so everything after a
    script file (or after ``-c``'s program text) is positional, even when
    it looks like a flag: ``bash run.sh -c foo`` passes ``-c foo`` to the
    script.

    Args:
        name (str): the head word, used as the diagnostic prefix.
        args (list[str]): words after the head word.
    """
    options: list[str] = []
    read_stdin = False
    i = 0
    while i < len(args):
        tok = args[i]
        if tok == "--":
            i += 1
            break
        if tok == "-s":
            read_stdin = True
            i += 1
            continue
        if tok in ("-o", "+o"):
            i += 2
            continue
        if tok in _BASH_NOOP_LONG_FLAGS:
            i += 1
            continue
        if not (tok.startswith("-") and len(tok) > 1
                and not tok.startswith("--")):
            break
        chars = tok[1:]
        if "c" in chars:
            if i + 1 >= len(args):
                return BashArgs(error=_bash_error(
                    name, "-c: option requires an argument", 2))
            options.extend(SET_FLAG_TO_OPTION[c] for c in chars
                           if c in SET_FLAG_TO_OPTION)
            return BashArgs(script=args[i + 1],
                            argv=args[i + 2:],
                            options=options,
                            read_stdin=read_stdin)
        if not all(ch in _BASH_NOOP_SHORT_FLAGS or ch == "s"
                   or ch in SET_FLAG_TO_OPTION for ch in chars):
            return BashArgs(
                error=_bash_error(name, f"{tok}: unsupported option", 2))
        options.extend(SET_FLAG_TO_OPTION[c] for c in chars
                       if c in SET_FLAG_TO_OPTION)
        read_stdin = read_stdin or "s" in chars
        i += 1
    if i < len(args):
        return BashArgs(path=args[i],
                        argv=args[i + 1:],
                        options=options,
                        read_stdin=read_stdin)
    return BashArgs(options=options, read_stdin=read_stdin)


async def read_script_file(
    dispatch: Callable[..., Any],
    name: str,
    path: str,
    session: Session,
) -> tuple[str, None] | tuple[None, tuple[None, IOResult, ExecutionNode]]:
    """Read a script file operand, or the failure bash reports for it.

    GNU splits the diagnostics by how far startup got. A file it cannot
    open is blamed on the shell (``bash: run.sh: No such file or
    directory``, exit 127; ``Permission denied``, exit 126), while a
    directory opens fine and only fails on the first read, by which point
    ``$0`` is already the operand, so bash prints it twice (``/tmp: /tmp:
    Is a directory``, exit 126). Reproduced rather than tidied up: it is
    what an agent copying a message into a search box will find.

    A backend that cannot tell a missing path from an unreadable one
    raises ENOENT for a directory too, so the stat probe runs on the
    failure path to recover the distinction.

    Args:
        dispatch (Callable): op dispatcher, used to read the file.
        name (str): the head word, used as the diagnostic prefix.
        path (str): the script operand, as typed.
        session (Session): shell session state, for the working directory.
    """
    scope = _to_scope(resolve_path(path, session.cwd))
    try:
        data, _ = await dispatch("read", scope)
    except FS_ERRORS as exc:
        stat = await resolve_path_stat(dispatch, scope)
        if stat is not None and stat.type == FileType.DIRECTORY:
            return None, _bash_error(path, f"{path}: Is a directory", 126)
        strerror = fs_strerror(exc) or "No such file or directory"
        code = 126 if isinstance(exc, PermissionError) else 127
        return None, _bash_error(name, f"{path}: {strerror}", code)
    return (data.decode(
        errors="replace") if isinstance(data, bytes) else ""), None


async def handle_bash(
    dispatch: Callable[..., Any],
    execute_fn: Callable[..., Any],
    args: list[str],
    session: Session,
    stdin: ByteSource | None = None,
    name: str = "bash",
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a nested shell: inline text from ``-c``, or a script file.

    Args:
        dispatch (Callable): op dispatcher, used to read a script file.
        execute_fn (Callable): runs the program text in this session.
        args (list[str]): words after the head word.
        session (Session): shell session state.
        stdin (ByteSource | None): input stream, also the program source
            under ``-s``.
        name (str): the head word (``bash`` or ``sh``). bash reports
            itself by ``argv[0]``, so the diagnostics follow the spelling
            the caller used.
    """
    parsed = parse_bash_args(name, args)
    if parsed.error is not None:
        return parsed.error
    script = parsed.script
    named = script is not None and bool(parsed.argv)
    script_name = parsed.argv[0] if named else name
    positional = parsed.argv[1:] if script is not None else parsed.argv
    if script is None and parsed.path is not None:
        script_name = parsed.path
        script, failure = await read_script_file(dispatch, name, parsed.path,
                                                 session)
        if failure is not None:
            return failure
    if script is None and parsed.read_stdin and stdin is not None:
        stdin_data = await materialize(stdin)
        if stdin_data:
            script = stdin_data.decode(errors="replace")
            stdin = None
    if script is None:
        return None, IOResult(), ExecutionNode(command=name, exit_code=0)
    saved_positional = session.positional_args
    saved_script_name = session.script_name
    saved_options = dict(session.shell_options)
    session.positional_args = positional
    session.script_name = script_name
    for option in parsed.options:
        session.shell_options[option] = True
    try:
        io = await execute_fn(script,
                              session_id=session.session_id,
                              stdin=stdin)
    finally:
        session.positional_args = saved_positional
        session.script_name = saved_script_name
        session.shell_options = saved_options
    label = f"{name} {parsed.path}" if parsed.path else f"{name} -c {script}"
    return io.stdout, io, ExecutionNode(command=label, exit_code=io.exit_code)


# Finite non-negative decimals only ("0", "0.2", ".5", "1.", "+1", "1e-3").
# GNU sleep additionally accepts "inf" and sleeps forever; an agent shell
# must never hang, so non-finite intervals are rejected (deliberate
# divergence). The regex also keeps Python/TypeScript parsing identical:
# float() alone would accept "inf", "nan", "1_0", and surrounding whitespace
# that Number() rejects, and Number() accepts hex that float() rejects.
SLEEP_INTERVAL = re.compile(r"\+?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?")


async def handle_sleep(
    args: list[str],
    cancel: asyncio.Event | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    if not args:
        err = b"sleep: missing operand\n"
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="sleep",
                                                         exit_code=1)
    raw = args[0]
    # "1e309" passes the regex but overflows to inf, so check both.
    seconds = float(raw) if SLEEP_INTERVAL.fullmatch(raw) else math.inf
    if not math.isfinite(seconds):
        err = f"sleep: invalid time interval '{raw}'\n".encode()
        return None, IOResult(exit_code=1,
                              stderr=err), ExecutionNode(command="sleep",
                                                         exit_code=1)
    await cancellable_sleep(seconds, cancel)
    return None, IOResult(), ExecutionNode(command="sleep", exit_code=0)
