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
from mirage.runtime.types import DispatchFn
from mirage.shell.options import parse_option_word
from mirage.types import FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, eisdir, fs_strerror
from mirage.utils.path import resolve_path
from mirage.workspace.abort import cancellable_sleep
from mirage.workspace.executor.builtins.links import resolve_path_stat
from mirage.workspace.executor.builtins.scope import _scope_path, _to_scope
from mirage.workspace.session import Session
from mirage.workspace.types import ExecutionNode

# GNU prints the refusal and the usage line together, both under the
# builtin's own name, and exits 2 without ending the script.
SOURCE_USAGE = ("filename argument required\n"
                "source: usage: source filename [arguments]")


def script_error(
        prefix: str,
        message: str,
        code: int,
        command: str | None = None) -> tuple[None, IOResult, ExecutionNode]:
    """A diagnostic from a shell that never got as far as running.

    ``prefix`` and ``command`` come apart because bash reports itself by
    ``argv[0]``, which for a script operand is the operand: the recorded
    command still has to be the builtin that ran, not a file path.

    Args:
        prefix (str): what the line reports itself as, before the colon.
        message (str): the rest of the line, without the newline.
        code (int): the exit status.
        command (str | None): what to record the failure under, when
            that is not the prefix.
    """
    err = f"{prefix}: {message}\n".encode()
    return None, IOResult(exit_code=code,
                          stderr=err), ExecutionNode(command=command or prefix,
                                                     exit_code=code,
                                                     stderr=err)


async def read_script_text(dispatch: DispatchFn, path: str, cwd: str) -> str:
    """Read a script file through the op dispatcher.

    Every way of running a script off a mount comes through here, so a
    backend quirk is answered once rather than per caller. The one
    answered today is a directory: a keyed backend has no directory
    object to open, so it reports a read of one as ENOENT where a real
    filesystem reports EISDIR. The stat probe that tells the two apart
    runs only on the failure path, and asks both channels a backend can
    answer on, since on a prefix store a directory is the set of keys
    under it rather than an object.

    The caller owns the diagnostic: `source` and a nested shell word
    the same failure differently and exit differently on it.

    Args:
        dispatch (DispatchFn): op dispatcher, used to read the file.
        path (str): the script operand, as typed.
        cwd (str): working directory a relative operand resolves against.
    """
    scope = _to_scope(resolve_path(path, cwd))
    try:
        data, _ = await dispatch("read", scope)
    except FileNotFoundError:
        stat = await resolve_path_stat(dispatch, scope)
        if stat is not None and stat.type == FileType.DIRECTORY:
            raise eisdir(path) from None
        raise
    if isinstance(data, bytes):
        return data.decode(errors="replace")
    if data is None:
        return ""
    return (await materialize(data)).decode(errors="replace")


async def handle_source(
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    path: str | PathSpec,
    session: Session,
    args: list[str] | None = None,
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Read a script file and execute it in the calling shell.

    Unlike a nested shell, a sourced file *is* the caller, so whatever
    it sets stays set: `source f` where f runs `set -x` leaves the
    caller tracing. Only the positional parameters come back, because
    bash restores those and nothing else.

    Args:
        dispatch (DispatchFn): op dispatcher, used to read the file.
        execute_fn (Callable): runs the script text in this session.
        path (str | PathSpec): the script to source.
        session (Session): shell session state.
        args (list[str] | None): positional parameters to expose to the
            script. When given they replace ``$1..$#`` for the duration
            of the source and are restored afterwards, matching bash;
            when omitted the parent's positional parameters are kept.
    """
    raw = _scope_path(path)
    if not raw:
        return script_error("source", SOURCE_USAGE, 2)
    try:
        script = await read_script_text(dispatch, raw, session.cwd)
    except FS_ERRORS as exc:
        return script_error("source",
                            f"{raw}: {fs_strerror(exc)}",
                            1,
                            command=f"source {raw}")
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


# Startup letters bash has that `set` does not. `c` takes the program
# text from the next word and `s` reads it from stdin; the rest have
# nothing to configure in an embedded shell, which has no login profile,
# no rc file and no tty. Letters that name a `set` option (-e -u -x -f)
# are not here: parse_option_word already knows them, so the two
# spellings cannot drift.
_BASH_START_FLAGS = frozenset({"c", "s", "l", "i"})

# bash's long options, mapped to whether the option takes the next word.
# A flat set of names to ignore cannot say that `--rcfile FILE` swallows
# FILE, and read `bash --rcfile run.sh` as "run run.sh". Anything absent
# is refused rather than mistaken for a script operand, which is what
# made `bash --version` report a missing file.
_BASH_LONG_OPTIONS: dict[str, bool] = {
    "--login": False,
    "--noediting": False,
    "--noprofile": False,
    "--norc": False,
    "--posix": False,
    "--init-file": True,
    "--rcfile": True,
}


@dataclass(frozen=True, slots=True)
class BashArgs:
    """One parsed ``bash``/``sh`` invocation.

    The two failure fields report what went wrong rather than a rendered
    message, the way ``ShellParse`` does: the wording and the exit code
    belong to the caller, which is the only thing that knows the head
    word the shell was spelled as.

    Args:
        script (str | None): inline program text from ``-c``.
        path (str | None): script file operand, as typed.
        argv (list[str]): words after the program, ``$0`` first for the
            ``-c`` form and all positional for the other two.
        settings (tuple[tuple[str, bool], ...]): shell options the
            startup flags turn on or off, in the order written.
        invalid (str | None): the option word the shell does not have.
        needs_value (str | None): the option given no argument.
    """
    script: str | None = None
    path: str | None = None
    argv: list[str] = field(default_factory=list)
    settings: tuple[tuple[str, bool], ...] = ()
    invalid: str | None = None
    needs_value: str | None = None


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
            takes_value = _BASH_LONG_OPTIONS.get(tok)
            if takes_value is None:
                return BashArgs(invalid=tok)
            i += 2 if takes_value else 1
            continue
        nxt = args[i + 1] if i + 1 < len(args) else None
        word = parse_option_word(tok, nxt)
        if word is None:
            break
        if any(ch not in _BASH_START_FLAGS for ch in word.other):
            return BashArgs(invalid=tok)
        settings.extend(word.settings)
        read_stdin = read_stdin or "s" in word.other
        if "c" in word.other:
            if i + word.consumed >= len(args):
                return BashArgs(needs_value="-c")
            return BashArgs(script=args[i + word.consumed],
                            argv=args[i + word.consumed + 1:],
                            settings=tuple(settings))
        i += word.consumed
    # The program comes from stdin whenever no operand names one, which
    # is the rule `-s` states explicitly for the case where operands do
    # follow: `bash -s A B` reads stdin and makes A and B positional.
    if i < len(args) and not read_stdin:
        return BashArgs(path=args[i],
                        argv=args[i + 1:],
                        settings=tuple(settings))
    return BashArgs(argv=args[i:], settings=tuple(settings))


async def read_script_file(
    dispatch: DispatchFn,
    name: str,
    path: str,
    session: Session,
) -> tuple[str, None] | tuple[None, tuple[None, IOResult, ExecutionNode]]:
    """Read a script file operand, or the failure bash reports for it.

    GNU splits the diagnostics by how far startup got, and both halves
    fall out of the errno rather than being listed case by case. A file
    the shell cannot open at all is blamed on the shell, and only a
    missing one is exit 127 (``bash: run.sh: No such file or directory``);
    anything it found but could not run is 126 (``Permission denied``,
    ``Not a directory``). A directory is the exception, because it opens
    fine and fails on the first read, by which point ``$0`` is already the
    operand, so bash prints it twice (``/tmp: /tmp: Is a directory``, exit
    126). Reproduced rather than tidied up: it is what an agent copying a
    message into a search box will find.

    Args:
        dispatch (DispatchFn): op dispatcher, used to read the file.
        name (str): the head word, used as the diagnostic prefix.
        path (str): the script operand, as typed.
        session (Session): shell session state, for the working directory.
    """
    try:
        return await read_script_text(dispatch, path, session.cwd), None
    except FS_ERRORS as exc:
        strerror = fs_strerror(exc)
        if isinstance(exc, IsADirectoryError):
            return None, script_error(path,
                                      f"{path}: {strerror}",
                                      126,
                                      command=name)
        code = 127 if isinstance(exc, FileNotFoundError) else 126
        return None, script_error(name, f"{path}: {strerror}", code)


async def handle_bash(
    dispatch: DispatchFn,
    execute_fn: Callable[..., Any],
    args: list[str],
    session: Session,
    stdin: ByteSource | None = None,
    name: str = "bash",
) -> tuple[ByteSource | None, IOResult, ExecutionNode]:
    """Run a nested shell: inline text from ``-c``, or a script file.

    A nested shell is a child shell, so it runs on a snapshot of the
    session and the caller gets its state back afterwards:
    ``bash -c 'cd /x'`` leaves the caller where it was, as it does in
    bash, where the nested shell is a separate process. `source` is the
    opposite case and deliberately does not snapshot, because a sourced
    file is the caller.

    Args:
        dispatch (DispatchFn): op dispatcher, used to read a script file.
        execute_fn (Callable): runs the program text in this session.
        args (list[str]): words after the head word.
        session (Session): shell session state.
        stdin (ByteSource | None): input stream, also the program source
            when no operand names one.
        name (str): the head word (``bash`` or ``sh``). bash reports
            itself by ``argv[0]``, so the diagnostics follow the spelling
            the caller used.
    """
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
            name, f"{parsed.needs_value}: option requires an argument", 2)
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
    if script is None and stdin is not None:
        stdin_data = await materialize(stdin)
        if stdin_data:
            script = stdin_data.decode(errors="replace")
            stdin = None
    if script is None:
        return None, IOResult(), ExecutionNode(command=name, exit_code=0)
    saved = session.snapshot()
    session.positional_args = positional
    session.script_name = script_name
    # A child shell is outside every `source` its caller is inside, so a
    # top-level `return` in the script it runs is the error bash reports
    # rather than an early exit the program loop absorbs.
    session.source_depth = 0
    for option, enable in parsed.settings:
        session.shell_options[option] = enable
    try:
        io = await execute_fn(script,
                              session_id=session.session_id,
                              stdin=stdin)
    finally:
        session.restore(saved)
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
