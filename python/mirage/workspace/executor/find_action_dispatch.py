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
import logging
from collections.abc import (
    AsyncGenerator,
    AsyncIterator,
)
from contextlib import aclosing
from dataclasses import replace

from mirage.commands.builtin.constants import EXEC_PLACEHOLDER
from mirage.commands.builtin.find_printf import compile_printf, render_printf
from mirage.commands.builtin.general.interpreter import line_output
from mirage.commands.builtin.types import (
    ExecAction,
    FindAction,
    PrintfAction,
    RowAction,
)
from mirage.commands.builtin.utils.files0 import listed_names
from mirage.commands.builtin.utils.formatting import format_find_ls
from mirage.commands.builtin.utils.identity import Identity
from mirage.commands.builtin.utils.links import link_view
from mirage.context import (
    current_caller,
    get_current_session,
    reset_caller,
    set_program_invocation,
)
from mirage.context.session_context import with_caller
from mirage.core.generic import find_eval
from mirage.core.generic import types as find_types
from mirage.core.generic.find import depth_first_order
from mirage.errors.classify import is_entry_error
from mirage.errors.fs import ebusy, enoent, enotempty, strerror_of
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.stream import (
    OutputStream,
    SharedStdin,
    close_quietly,
    ensure_stream,
    materialize,
)
from mirage.io.types import ByteSource, IOResult, OutputState
from mirage.rs.find import FindExpr
from mirage.rs.stream import OpenStream, close_stream
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.shell.console import JobConsole
from mirage.shell.console.types import Channel
from mirage.shell.join import shell_join
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import resolve_path
from mirage.utils.quote import quote_arg, shell_quote_always
from mirage.view.types import StatPath
from mirage.workspace.expand.types import ExecuteFn
from mirage.workspace.files import Files
from mirage.workspace.lookup.constants import SHELL_ONLY_BUILTINS
from mirage.workspace.lookup.lookup import lookup_all
from mirage.workspace.lookup.types import Consumer
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState

logger = logging.getLogger(__name__)


def exec_words(action: ExecAction, paths: list[str]) -> list[str]:
    """The argv one ``-exec`` run becomes, matches substituted.

    A per-match run substitutes every ``{}`` inside every word (``x{}y``
    is ``xd/a.txty``); a batched run replaces its one bare ``{}`` with
    the matches, one word each. The head is substituted like any other
    word, which is what lets ``-exec {} \\;`` run each match itself.
    ``-execdir`` hands its matches in already spelled ``./name``.

    Args:
        action (ExecAction): the action.
        paths (list[str]): the match, or every match for a batched run.
    """
    words: list[str] = []
    for word in action.argv:
        if action.batch and word == EXEC_PLACEHOLDER:
            words.extend(paths)
        elif not action.batch:
            words.append(word.replace(EXEC_PLACEHOLDER, paths[0]))
        else:
            words.append(word)
    return words


async def program_head(
    head: str,
    session: SessionState | None,
    registry: MountRegistry,
    cwd: str,
    stat_path: StatPath | None,
) -> tuple[bool, bool]:
    """Whether ``execvp`` would fail to find a head word (``find
    -exec``, ``exec``), and whether a shell function shadows the program
    it would find.

    A head carrying a slash is a file the loader runs, which no
    builtin, function or CLI can claim, so it is statted where the
    line would read it; any other head is looked up by name across
    the layers dispatch consults. A shell function is not found
    either, nor a builtin that is the shell's own: GNU execs the head
    through ``execvp``, which sees programs and nothing the shell
    defined, so ``f(){ :; }; find d -exec f {} \\;`` and
    ``find d -exec cd {} \\;`` report ``No such file or directory``
    per match while ``-exec echo`` or ``-exec sh -c`` runs
    (``SHELL_ONLY_BUILTINS`` names the shell's own). Every layer is
    asked, not the winner: ``execvp`` never sees the function
    ``cat(){ ...; }`` defines, so ``-exec cat`` still finds the
    program, and the run bypasses the function the way ``command``
    does.

    Args:
        head (str): the first word of the action.
        session (SessionState | None): the shell looking it up, None
            outside one.
        registry (MountRegistry): where a name is looked up.
        cwd (str): the session's working directory.
        stat_path (StatPath | None): dispatcher stat, None outside a
            workspace, where the loader answers for itself.
    """
    if "/" in head:
        return (
            stat_path is not None
            and await stat_path(resolve_path(head, cwd)) is None
        ), False
    sess = session
    if sess is None:
        return False, False
    layers = lookup_all(head, sess, registry)
    program = any(
        layer is not Consumer.FUNCTION
        and (layer is not Consumer.SESSION or head not in SHELL_ONLY_BUILTINS)
        for layer in layers
    )
    # A function is invisible to execvp, and `command` masks it for the
    # run; no alias rewrites a program line.
    shadowed = Consumer.FUNCTION in layers
    return not program, shadowed


def exec_dir(path: str) -> tuple[str, str]:
    """Where ``-execdir`` runs for one row and what ``{}`` becomes: the
    directory the row is printed under and ``./`` plus its last name, so
    ``d/a.txt`` runs in ``d`` as ``./a.txt`` and a start point ``.`` in
    ``.`` as ``./.``.

    Args:
        path (str): the row as find printed it.
    """
    trimmed = path.rstrip("/") or "/"
    head, slash, name = trimmed.rpartition("/")
    if not slash:
        return ".", "./" + name
    return head or "/", "./" + name


async def _run_exec(
    execute_fn: ExecuteFn,
    session: SessionState | None,
    session_id: str,
    registry: MountRegistry,
    cwd: str,
    stat_path: StatPath | None,
    action: ExecAction,
    paths: list[str],
    stdin: SharedStdin | None,
    where: str | None = None,
    utf8: bool = False,
) -> IOResult:
    """Start one ``-exec`` invocation, its output passed on as the child
    writes it (``line_output``).

    A command that cannot be found is GNU's ``find: 'cmd': No such file
    or directory`` rather than the shell's ``command not found``, and
    counts as a failed run. That is decided by looking the head word up
    before the line runs (GNU fails in ``execvp``), never from the exit
    status: a program that exists and exits 127 keeps its own stderr and
    is just a failed run. The run's status, read once its stdout has
    ended, is the action's truth value.

    Args:
        execute_fn (ExecuteFn): runs a line in the session.
        session (SessionState | None): the shell find runs in, where the
            head is looked up; None outside one.
        session_id (str): the session the line runs under.
        registry (MountRegistry): where the head word is looked up.
        cwd (str): the session's working directory.
        stat_path (StatPath | None): dispatcher stat for a slash head.
        action (ExecAction): the action.
        paths (list[str]): the match, or every match for a batched run.
        stdin (SharedStdin | None): find's own input, one cursor shared
            by every child; None keeps the ambient stdin.
        where (str | None): ``-execdir``'s directory as printed, which the
            run enters first; None runs where find does.
        utf8 (bool): the line runs under a UTF-8 locale.
    """
    # GNU substitutes the matches into the words and only then hands
    # them to execvp, so the head looked up is the substituted one:
    # `-exec {} \;` runs each match itself.
    words = exec_words(action, paths)
    head = words[0] if words else action.argv[0]
    here = cwd if where is None else resolve_path(where, cwd)
    missing, shadowed = await program_head(
        head, session, registry, here, stat_path
    )
    if missing:
        return IOResult(
            exit_code=1,
            stderr=encode_text(
                f"find: {quote_arg(head, utf8)}: No such file or directory\n"
            ),
        )
    # A function or alias of the head's name is invisible to execvp, so
    # the line runs the program past it, as `command` does. The run is
    # marked a program run for the session, so a builtin that doubles
    # as a program answers as the program (`printf -v` is a format).
    line = ("command " if shadowed else "") + shell_join(words)
    if where is not None:
        line = f"cd -- {shell_join([where])} && {line}"
    # find stays its process and forks each program as a child of it.
    process = current_caller().process
    if process is not None:
        process.one_command = False

    async def run(sink: JobConsole) -> IOResult:
        token = (
            set_program_invocation(session) if session is not None else None
        )
        try:
            return await execute_fn(
                f"( {line} )", session_id=session_id, stdin=stdin, sink=sink
            )
        finally:
            if token is not None:
                reset_caller(token)

    stdout, io = line_output(run)
    io.stdout = stdout
    return io


async def _delete_row(
    ps: PathSpec,
    vfs: Files | None,
    dispatch: DispatchFn | None,
    errors: list[bytes],
    stat_path: StatPath | None,
    registry: MountRegistry,
) -> bool:
    """Remove a matched entry through the dispatcher.

    The dispatcher owns admission, backend support, cache invalidation and
    namespace cleanup. A find action never resolves a shell command.

    Args:
        ps (PathSpec): the selected row, with its display spelling.
        vfs (Files | None): the namespace's link facts.
        dispatch (DispatchFn | None): the workspace dispatcher.
        errors (list[bytes]): receives a failure in find's voice.
        stat_path (StatPath | None): distinguishes files from directories.
        registry (MountRegistry): the mount table, which pins its roots.
    """
    links = link_view(vfs)
    path = ps.raw_path or ps.virtual
    if dispatch is None:
        errors.append(b"find: -delete requires an operation dispatcher\n")
        return False
    try:
        _check_unpinned(ps, registry)
        link = links is not None and links.stat_at(ps.virtual) is not None
        st = (
            await stat_path(ps) if not link and stat_path is not None else None
        )
        if not link and stat_path is not None and st is None:
            raise enoent(ps)
        op = (
            "rmdir"
            if st is not None and st.type == FileType.DIRECTORY
            else "unlink"
        )
        await dispatch(op, ps)
        return True
    except (OSError, ValueError) as exc:
        why = strerror_of(exc)
        errors.append(encode_text(f"find: cannot delete '{path}': {why}\n"))
        return False


async def _row_stat(
    ps: PathSpec,
    vfs: Files | None,
    stat_path: StatPath | None,
    errors: list[bytes],
    utf8: bool = False,
) -> FileStat | None:
    """The facts ``find -ls`` renders one accepted row from.

    They come from the two entry points the command boundary has: a symlink is
    namespace state no backend can see, so the link view answers for
    one (lstat, as GNU's ``-ls`` reports the link itself), and every
    other row is statted through the op dispatcher, which answers for a
    mount point and a namespace-only ancestor as well as a backend
    entry. A row that cannot be statted (the backend refuses it, or it
    is gone) is GNU's ``find: 'path': <reason>``; None with a line
    appended is the caller's signal to end the row's chain.

    Args:
        ps (PathSpec): the selected row, with its display spelling.
        vfs (Files | None): the name plane's facts, so a symlink
            row renders as the link.
        stat_path (StatPath | None): dispatcher stat; None outside a
            workspace, where no row can be rendered.
        errors (list[bytes]): where a failure's line is appended.
        utf8 (bool): the line runs under a UTF-8 locale.
    """
    links = link_view(vfs)
    shown = ps.raw_path or ps.virtual
    if stat_path is None:
        errors.append(
            encode_text(f"find: {quote_arg(shown, utf8)}: no stat function\n")
        )
        return None
    link = links.stat_at(ps.virtual) if links is not None else None
    try:
        st = link if link is not None else await stat_path(ps)
    except Exception as exc:
        if not is_entry_error(exc):
            raise
        # GNU words it with the errno text; a policy refusal carries its
        # reason there.
        why = (
            exc.strerror if isinstance(exc, OSError) else None
        ) or strerror_of(exc)
        errors.append(encode_text(f"find: {quote_arg(shown, utf8)}: {why}\n"))
        return None
    if st is None:
        missing = posix_phrase(FsCondition.ENOENT)
        errors.append(
            encode_text(f"find: {quote_arg(shown, utf8)}: {missing}\n")
        )
        return None
    return st


def _ls_row(ps: PathSpec, st: FileStat, identity: Identity | None) -> bytes:
    """Render one accepted row in ``find -ls``'s own layout.

    Args:
        ps (PathSpec): the selected row, with its display spelling.
        st (FileStat): the row's facts.
        identity (Identity | None): who the session is, for the owner
            and group columns.
    """
    path = ps.raw_path or ps.virtual
    row = format_find_ls(replace(st, name=path), identity)
    return encode_text(row + "\n")


async def _printf_row(
    engine: OpenStream,
    ps: PathSpec,
    start: PathSpec,
    st: FileStat | None,
    vfs: Files | None,
    identity: Identity | None,
) -> bytes:
    """Render one accepted row through a ``-printf`` format.

    A symlink row is the link itself, and ``%Y`` reads what it points at
    through the workspace, so a link into another mount classifies and a
    dangling one reads ``N``.

    Args:
        engine (OpenStream): the action's formatter.
        ps (PathSpec): the selected row, with its display spelling.
        start (PathSpec): the start point the row was found under, which
            ``%P`` and ``%d`` measure from.
        st (FileStat | None): the stat find holds for the row; None when
            the format names no stat directive.
        vfs (Files | None): the name plane's facts, for a symlink
            row's target.
        identity (Identity | None): who the session is, for the owner
            directives on an entry that reports no owner of its own.
    """
    links = link_view(vfs)
    target = (
        await links.target_stat(ps.virtual)
        if st is not None
        and links is not None
        and links.stat_at(ps.virtual) is not None
        else None
    )
    return await render_printf(
        engine, ps.raw_path or ps.virtual, start, st, target, identity
    )


def _reads_stat(action: FindAction) -> bool:
    """Whether an action reads the row's stat: ``-ls``, and a
    ``-printf`` whose format names a stat directive (%s %y %m %T ...).

    Args:
        action (FindAction): the action.
    """
    if isinstance(action, PrintfAction):
        return action.needs_stat
    return isinstance(action, RowAction) and action.kind == "ls"


def _tests_stat(expr: FindExpr) -> bool:
    """Whether the expression's tests made find stat every row it kept.

    The reference reads ``-name``, ``-path``, ``-regex``, ``-type`` and
    the access tests off the directory entry and access(2), and stats
    only for a test that needs the inode: a size or time window,
    ``-newer``, ``-empty``, ``-perm``, ``-links``, the owner tests,
    ``-lname`` and ``-xtype``.

    Args:
        expr (FindExpr): the parsed expression.
    """
    return (
        expr.min_size is not None
        or expr.max_size is not None
        or expr.mtime_min is not None
        or expr.mtime_max is not None
        or find_eval.tree_has_time(expr.tree)
        or find_eval.tree_has(
            expr.tree,
            (
                find_types.Size,
                find_types.Perm,
                find_types.Count,
                find_types.Owner,
                find_types.NoOwner,
                find_types.Lname,
                find_types.XType,
            ),
        )
        or expr.uses_empty
        or bool(expr.newer)
    )


def _has_actions(expr: FindExpr) -> bool:
    """Whether the actions differ from the implicit print.

    One explicit ``-print`` is exactly what the backend already
    rendered; two of them print every row twice, as GNU does.

    Args:
        expr (FindExpr): the parsed expression.
    """
    return len(expr.actions) > 1 or any(
        not (isinstance(a, RowAction) and a.kind == "print" and a.file is None)
        for a in expr.actions
    )


# The files -fprint names that are find's own streams, not files.
_STDOUT = "/dev/stdout"
_STDERR = "/dev/stderr"
_NULL = "/dev/null"
_STREAMS = (_STDOUT, _STDERR, _NULL)


def _file_spec(file: str, cwd: str) -> PathSpec:
    return replace(
        PathSpec.from_str_path(resolve_path(file, cwd)), raw_path=file
    )


async def open_find_files(
    expr: FindExpr, cwd: str, dispatch: DispatchFn | None
) -> bytes | None:
    """Create every file ``-fprint``, ``-fprint0`` and ``-fprintf`` name,
    empty, before the walk, as the reference opens them while it parses: a file
    no row reaches still exists, and one that cannot be created ends
    find before it walks.

    Args:
        expr (FindExpr): the parsed expression.
        cwd (str): where a relative file is resolved.
        dispatch (DispatchFn | None): the workspace dispatcher.

    Returns:
        The reference's line for the first file that cannot be created, None when
        every one was.
    """
    if dispatch is None:
        return None
    for file in expr.files:
        if resolve_path(file, cwd) in _STREAMS:
            continue
        try:
            await dispatch("write", _file_spec(file, cwd), data=b"")
        except (OSError, ValueError) as exc:
            return encode_text(
                f"find: {quote_arg(file, expr.utf8)}: {strerror_of(exc)}\n"
            )
    return None


# The words before find's start points that are not start points.
_LINK_OPTIONS = ("-P", "-H", "-L")
# Start point names find's grammar would read as the expression.
_GRAMMAR = ("!", "(", ")")


async def run_listed_find(
    expr: FindExpr,
    words: list[str],
    cwd: str,
    dispatch: DispatchFn | None,
    execute_fn: ExecuteFn | None,
    session_id: str,
    stdin: ByteSource | None,
) -> IOResult:
    """``find -files0-from LIST``: find over the start points a list of
    NUL-terminated names holds, ``-`` reading the list from stdin.

    The names become the line's start points, run as the line again, so
    each one routes to its mount as a typed operand does. A start point
    typed beside the list is refused, an empty name is refused by its
    place in the list while the others run, and an empty list walks
    nothing. A name the grammar would read as a test (``-x``, ``!``)
    is handed on as ``./-x``, which is the same file.

    Args:
        expr (FindExpr): the parsed expression.
        words (list[str]): the words after ``find``.
        cwd (str): where the list and the names are resolved.
        dispatch (DispatchFn | None): reads the list.
        execute_fn (ExecuteFn | None): runs the find over the names.
        session_id (str): the session the find runs under.
        stdin (ByteSource | None): find's input, the list under ``-``.
    """
    source = "-" if expr.files0_from is None else expr.files0_from
    typed = [w for w in words[: expr.start] if w not in _LINK_OPTIONS]
    if typed:
        return IOResult(
            exit_code=1,
            stderr=encode_text(
                f"find: extra operand {quote_arg(typed[0], expr.utf8)}\n"
                "find: file operands cannot be combined with -files0-from\n"
            ),
        )

    async def stream(_: PathSpec) -> AsyncIterator[bytes]:
        if source == "":
            raise enoent(_file_spec(source, cwd))
        if source == "-":
            data: ByteSource = stdin if stdin is not None else b""
        elif dispatch is None:
            raise enoent(_file_spec(source, cwd))
        else:
            data, _io = await dispatch(
                "read", _file_spec(source, cwd), stream=True
            )
        async for chunk in ensure_stream(data):
            yield chunk

    try:
        names = await listed_names(_file_spec(source, cwd), stream)
    except (OSError, ValueError) as exc:
        return IOResult(
            exit_code=1,
            stderr=encode_text(
                f"find: cannot open {quote_arg(source, expr.utf8)} for "
                f"reading: {strerror_of(exc)}\n"
            ),
        )
    refused = "".join(
        f"find: {shell_quote_always(source)}:{at + 1}: "
        "invalid zero-length file name\n"
        for at, name in enumerate(names)
        if not name
    )
    starts = [
        "./" + name if name.startswith("-") or name in _GRAMMAR else name
        for name in names
        if name
    ]
    if not starts or execute_fn is None:
        opened = await open_find_files(expr, cwd, dispatch)
        return IOResult(
            exit_code=1 if refused or opened else 0,
            stderr=encode_text(refused) + (opened or b""),
        )
    dropped = {at + step for at in expr.files0_at for step in (0, 1)}
    rest = [
        word
        for at, word in enumerate(words[expr.start :])
        if at not in dropped
    ]
    line = shell_join(["find", *words[: expr.start], *starts, *rest])
    given = None if source == "-" else stdin

    async def run(sink: JobConsole) -> IOResult:
        assert execute_fn is not None
        return await execute_fn(
            line, session_id=session_id, stdin=given, sink=sink
        )

    stdout, io = line_output(run, 1 if refused else 0)
    io.stdout = stdout
    io.stderr = encode_text(refused) or None
    return io


def _check_unpinned(path: PathSpec, registry: MountRegistry) -> None:
    """Refuse a row the mount table pins, as the kernel refuses its rmdir.

    A mount point is busy, and a directory holding one is never empty,
    even once ``-delete`` has removed everything else under it
    (coreutils' find over a tmpfs). Ancestors use the raw mount table
    like ``is_mount_root``: an ungranted mount still pins its ancestors
    in the namespace.

    Args:
        path (PathSpec): the selected row.
        registry (MountRegistry): the mount table.
    """
    virtual = path.virtual
    if registry.is_mount_root(virtual):
        raise ebusy(path)
    if registry.descendant_mounts(virtual):
        raise enotempty(path)


async def _write_files(
    sinks: dict[str, list[bytes]],
    cwd: str,
    dispatch: DispatchFn | None,
    moved: bool,
    utf8: bool = False,
) -> bytes:
    """Write what ``-fprint``, ``-fprint0``, ``-fprintf`` and ``-fls``
    collected, each file once.

    Args:
        sinks (dict[str, list[bytes]]): each file's rows, in order.
        cwd (str): where a relative file is resolved.
        dispatch (DispatchFn | None): the workspace dispatcher.
        moved (bool): an ``-exec`` child ran, which may have moved or
            removed a file.
        utf8 (bool): the line runs under a UTF-8 locale.

    Returns:
        find's line for each file it could not write, empty when every
        one was written.
    """
    failed: list[bytes] = []
    for file, rows in sinks.items():
        if resolve_path(file, cwd) in _STREAMS or dispatch is None:
            continue
        spec = _file_spec(file, cwd)
        if moved:
            # The reference writes to the file it opened, wherever a
            # child moves it; a workspace has no open file to follow,
            # so a file a child moved or removed is not made again.
            try:
                await dispatch("stat", spec)
            except (OSError, ValueError) as exc:
                logger.debug("find: %s is gone, rows dropped: %s", file, exc)
                continue
        try:
            await dispatch("write", spec, data=b"".join(rows))
        except (OSError, ValueError) as exc:
            failed.append(
                encode_text(
                    f"find: {quote_arg(file, utf8)}: {strerror_of(exc)}\n"
                )
            )
    return b"".join(failed)


def _refuse(io: IOResult, line: bytes) -> None:
    """End find on a line its actions cannot run under, with exit 1 over
    a selection's 0 and no rows.

    Args:
        io (IOResult): the selection's result, amended in place.
        line (bytes): find's line.
    """
    io.add_stderr(line)
    if io.exit_code == 0:
        io.exit_code = 1


async def _apply_find_actions(
    stdout: ByteSource | None,
    io: IOResult,
    expr: FindExpr,
    registry: MountRegistry,
    cwd: str,
    *,
    execute_fn: ExecuteFn | None = None,
    session_id: str = "",
    vfs: Files | None = None,
    stat_path: StatPath | None = None,
    dispatch: DispatchFn | None = None,
    identity: Identity | None = None,
    stdin: ByteSource | None = None,
    starts: list[PathSpec] | None = None,
) -> ByteSource | None:
    """Apply find's actions (-exec / -delete / -print0 / -ls / -printf)
    to its rows.

    Per-VFS find handlers only emit matched paths. This dispatcher
    layer re-reads the actions off the expression and applies them per
    match, in the order they were written, the way GNU's implicit ``-a``
    chain runs: each per-match ``-exec`` runs in turn and the first that
    fails ends the chain for that match, so a later ``-print`` (or
    ``-ls``, ``-print0``, ``-printf``, ``-delete``) sees only the
    matches every earlier ``-exec`` accepted (``-exec grep -q x {} ";"
    -print``), and ``-exec echo {} ";" -print -exec echo again {} ";"``
    alternates the three per match. A batched ``-exec ... {} +``
    collects the match at its position and runs once after the walk; a
    failing batch is find's exit 1, as is a row it could not delete,
    list or stat for a ``-printf``, and either ends that row's chain; a
    failing per-match run is not, and neither is a command that cannot
    be found, which GNU reports per match and carries on from with exit
    0.
    An action other than ``-print`` suppresses the implicit print.
    ``-delete`` runs at its position, so a later ``-exec`` sees the row
    gone, and a row it cannot delete ends the chain with GNU's line and
    find's exit 1. ``-ls`` renders the stat find already holds, as GNU's
    does: GNU stats a start point when it opens the walk and any other
    row only when a test needs it (``-size``, ``-mtime``, ``-newer``,
    ``-empty``; ``-name`` and ``-type`` read the directory entry), so
    ``find d/f -delete -ls`` and ``find d -size -1k -delete -ls`` list
    the row they removed and exit 0, while ``find d -type f -delete
    -ls`` reports it gone and exits 1; ``-printf`` reads the same stat
    when its format names a stat directive. ``starts`` names the
    operands that rule reads. ``-delete`` also turns on ``-depth``,
    which orders every directory after its contents, the only order a
    tree can be removed in; ``-depth`` alone reorders the implicit print
    the same way, and
    both order one start point's walk at a time: GNU walks each start
    point to completion before the next, so ``find b a -depth`` prints
    ``b/x b a/y a`` and ``find d d/sub -depth`` finishes ``d`` before
    it begins ``d/sub`` again, which is why each row names the start
    point it was found under; ``-printf``'s ``%P`` and ``%d`` measure a
    row from that start point.

    The actions run as the rows are read. A child's output passes on as
    the child writes it, and a reader that stops early stops find there,
    so no later action or child runs, as ``cat a b | head -n1`` never
    opens ``b``; GNU's find runs on and reports each later child that
    writes as killed by SIGPIPE. What the actions say goes on stderr as
    they say it, before the output that follows it, a child's after its
    own output; what ``-fprint`` and its kind collected is written once,
    when the stream ends.

    Args:
        stdout (ByteSource | None): display output from find.
        io (IOResult): the selection's result, whose ``records`` are the
            matches before rendering, each with the start point it was
            found under, in operand order; a selection that streams
            settles them as its rows drain, so they are read after.
        expr (FindExpr): the expression, parsed once for the line.
        registry (MountRegistry): used to route per-match dispatch.
        cwd (str): cwd forwarded to per-match sub-dispatch.
        execute_fn (ExecuteFn | None): runs an ``-exec`` line in the
            session; None outside a workspace, where ``-exec`` is
            refused.
        session_id (str): the session the ``-exec`` lines run under.
        vfs (Files | None): the name plane's facts, threaded into
            the -ls sub-dispatch so a namespace-only row (a mount point,
            a symlink) renders the way ``ls -l`` renders it.
        stat_path (StatPath | None): dispatcher stat, threaded with it
            and used to find a slash-carrying ``-exec`` head.
        dispatch (DispatchFn | None): removes matched rows through the
            dispatcher, which owns admission and cleanup.
        identity (Identity | None): who the session is, for the owner
            and group columns of ``-ls``.
        stdin (ByteSource | None): find's own input, which its ``-exec``
            children share as one cursor, as GNU's do (a pipe feeds one
            reader, and a child that never reads leaves it for the next);
            None keeps the ambient stdin for every child.
        starts (list[PathSpec] | None): the start operands, whose rows
            GNU statted when it opened the walk; None or empty means the
            working directory.

    Returns:
        The rows to print: the selection's own when no action rewrites
        them, else a stream the actions run in as it is read. ``io``
        takes the expression's warnings first, then what the actions say,
        and the status they impose (1 over a selection's 0) as the stream
        ends (``IOResult.output``).
    """
    warned = b"".join(encode_text(f"{line}\n") for line in expr.warnings)
    reorders = expr.depth_first
    if stdout is None or not (_has_actions(expr) or reorders):
        if warned:
            io.stderr = warned + await materialize(io.stderr)
        return stdout
    await materialize(stdout)
    io.stderr = warned + await materialize(io.stderr) or None
    records = io.records
    if expr.execs and execute_fn is None:
        _refuse(io, b"find: -exec: no shell to run the command\n")
        return None
    if records is None:
        _refuse(io, b"find: actions require structured matches\n")
        return None
    # The rows arrive in operand order, each naming the start point it was
    # found under; with no operand that is the working directory, which
    # prints as `.`.
    cwd_start = PathSpec(virtual=cwd, directory=cwd, vfs_path="", raw_path=".")
    matches = [
        (
            record.path,
            starts[record.run]
            if starts and record.run < len(starts)
            else cwd_start,
        )
        for record in (
            sorted(
                records,
                key=lambda r: (
                    r.run,
                    depth_first_order(r.path.raw_path or r.path.virtual),
                ),
            )
            if reorders
            else records
        )
    ]
    # An expression with no action of its own prints, which is the one
    # implicit action -depth reorders.
    actions = (
        expr.actions[: expr.reached] if expr.actions else [RowAction("print")]
    )
    caller = current_caller()
    session = get_current_session()
    once = SharedStdin(stdin) if stdin is not None else None
    batches: dict[int, list[tuple[str | None, list[str]]]] = {}
    sinks: dict[str, list[bytes]] = {file: [] for file in expr.files}
    held: list[tuple[Channel, list[bytes]]] = []
    errors: list[bytes] = []
    stats = any(_reads_stat(a) for a in actions)
    statted = _tests_stat(expr)
    start_virtuals = {s.virtual for s in starts} if starts else {cwd}
    formatters = {
        position: compile_printf(action.parts)
        for position, action in enumerate(actions)
        if isinstance(action, PrintfAction)
    }
    io.output = state = OutputState()
    size = 0
    failed = False
    walked = False
    closing: asyncio.Task[None] | None = None

    def route(file: str | None) -> Channel | list[bytes]:
        if file is None:
            return Channel.STDOUT
        where = resolve_path(file, cwd)
        if where == _STDOUT:
            return Channel.STDOUT
        if where == _STDERR:
            return Channel.STDERR
        return sinks[file]

    def put(target: Channel | list[bytes], data: bytes) -> None:
        nonlocal size
        if isinstance(target, list):
            target.append(data)
            return
        if not data:
            return
        if target is Channel.STDOUT:
            size += len(data)
        if held and held[-1][0] is target:
            held[-1][1].append(data)
        else:
            held.append((target, [data]))

    def heard() -> None:
        for line in errors:
            put(Channel.STDERR, line)
        errors.clear()

    async def flushed() -> AsyncGenerator[bytes, None]:
        nonlocal size
        taken = held[:]
        held.clear()
        size = 0
        for channel, parts in taken:
            if channel is Channel.STDERR:
                io.add_stderr(b"".join(parts))
            else:
                yield b"".join(parts)

    async def ran(run: IOResult) -> AsyncGenerator[bytes, None]:
        try:
            if held:
                async with aclosing(flushed()) as rows:
                    async for chunk in rows:
                        yield chunk
            if run.stdout is not None:
                async for chunk in ensure_stream(run.stdout):
                    yield chunk
        finally:
            await close_quietly(run.stdout)
            put(Channel.STDERR, await materialize(run.stderr))

    async def walk() -> AsyncGenerator[bytes, None]:
        nonlocal failed, walked
        walked = True
        for match, start in matches:
            path = match.raw_path or match.virtual
            # The stat -ls and -printf render is the one find already holds,
            # taken before any action of the chain can remove the row; a row
            # it never statted is looked up by the first action that reads
            # it, and held from there, as GNU stats a row once.
            known = (
                await _row_stat(match, vfs, stat_path, [], expr.utf8)
                if stats and (statted or match.virtual in start_virtuals)
                else None
            )
            for position, action in enumerate(actions):
                if isinstance(action, ExecAction):
                    where, arg = (
                        exec_dir(path) if action.in_dir else (None, path)
                    )
                    if action.batch:
                        # -execdir batches the rows of one directory that
                        # arrive together, as the reference's runs end where
                        # its walk leaves a directory.
                        groups = batches.setdefault(position, [])
                        if groups and groups[-1][0] == where:
                            groups[-1][1].append(arg)
                        else:
                            groups.append((where, [arg]))
                        continue
                    assert execute_fn is not None
                    run = await _run_exec(
                        execute_fn,
                        session,
                        session_id,
                        registry,
                        cwd,
                        stat_path,
                        action,
                        [arg],
                        once,
                        where,
                        expr.utf8,
                    )
                    async with aclosing(ran(run)) as output:
                        async for chunk in output:
                            yield chunk
                    if run.exit_code != 0:
                        break
                elif _reads_stat(action):
                    if known is None:
                        known = await _row_stat(
                            match, vfs, stat_path, errors, expr.utf8
                        )
                        heard()
                    if known is None:
                        # A row -ls or -printf cannot stat is false, so the
                        # chain ends for it, as GNU's does.
                        failed = True
                        break
                    put(
                        route(action.file),
                        await _printf_row(
                            formatters[position],
                            match,
                            start,
                            known,
                            vfs,
                            identity,
                        )
                        if isinstance(action, PrintfAction)
                        else _ls_row(match, known, identity),
                    )
                elif isinstance(action, PrintfAction):
                    put(
                        route(action.file),
                        await _printf_row(
                            formatters[position],
                            match,
                            start,
                            None,
                            vfs,
                            identity,
                        ),
                    )
                elif action.kind == "delete":
                    deleted = await _delete_row(
                        match, vfs, dispatch, errors, stat_path, registry
                    )
                    heard()
                    if not deleted:
                        failed = True
                        break
                else:
                    put(
                        route(action.file),
                        encode_text(path)
                        + (b"\x00" if action.kind == "print0" else b"\n"),
                    )
            if size >= CHUNK_SIZE:
                async with aclosing(flushed()) as rows:
                    async for chunk in rows:
                        yield chunk
        for position, action in enumerate(actions):
            if not isinstance(action, ExecAction):
                continue
            for where, paths in batches.get(position, []):
                assert execute_fn is not None
                run = await _run_exec(
                    execute_fn,
                    session,
                    session_id,
                    registry,
                    cwd,
                    stat_path,
                    action,
                    paths,
                    once,
                    where,
                    expr.utf8,
                )
                try:
                    async with aclosing(ran(run)) as output:
                        async for chunk in output:
                            yield chunk
                finally:
                    # A batch the reader cut short died of SIGPIPE, which
                    # fails find as any failing batch does.
                    failed = failed or run.exit_code != 0
        async with aclosing(flushed()) as rows:
            async for chunk in rows:
                yield chunk

    async def finalize() -> None:
        nonlocal failed
        try:
            for engine in formatters.values():
                await close_stream(engine)
            if walked:
                unwritten = await _write_files(
                    sinks, cwd, dispatch, bool(expr.execs), expr.utf8
                )
                put(Channel.STDERR, unwritten)
                failed = failed or bool(unwritten)
            for channel, parts in held:
                if channel is Channel.STDERR:
                    io.add_stderr(b"".join(parts))
            held.clear()
        finally:
            if failed and io.exit_code == 0:
                io.exit_code = 1
            state.finish()

    async def close() -> None:
        nonlocal closing
        if closing is None:
            closing = asyncio.create_task(finalize())
        await closing

    async def output() -> AsyncIterator[bytes]:
        try:
            async with aclosing(walk()) as rows:
                async for chunk in rows:
                    yield chunk
        finally:
            await close()

    return OutputStream(with_caller(output(), caller), close)
