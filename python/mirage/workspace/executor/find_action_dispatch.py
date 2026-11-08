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

import logging
from collections.abc import AsyncIterator
from dataclasses import replace

from mirage.commands.builtin.constants import EXEC_PLACEHOLDER
from mirage.commands.builtin.find_printf import compile_printf, render_printf
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
    reset_program_invocation,
    set_program_invocation,
)
from mirage.core.generic import find_eval
from mirage.core.generic import types as find_types
from mirage.core.generic.find import depth_first_key
from mirage.errors.classify import is_entry_error
from mirage.errors.fs import enoent, strerror_of
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.stream import SharedStdin, ensure_stream, materialize
from mirage.io.types import ByteSource, IOResult, PathRecord
from mirage.rs.find import FindExpr
from mirage.rs.stream import OpenStream, close_stream
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.shell.join import shell_join
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import resolve_path
from mirage.utils.quote import shell_quote_always
from mirage.view.types import StatPath
from mirage.workspace.files import Files
from mirage.workspace.lookup.constants import SHELL_ONLY_BUILTINS
from mirage.workspace.lookup.lookup import lookup_all
from mirage.workspace.lookup.types import Consumer
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecuteLine

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
    execute_fn: ExecuteLine,
    session_id: str,
    registry: MountRegistry,
    cwd: str,
    stat_path: StatPath | None,
    action: ExecAction,
    paths: list[str],
    out: list[bytes],
    errors: list[bytes],
    stdin: SharedStdin | None,
    where: str | None = None,
) -> bool:
    """Run one ``-exec`` invocation, collecting its streams.

    A command that cannot be found is GNU's ``find: 'cmd': No such file
    or directory`` rather than the shell's ``command not found``, and
    counts as a failed run. That is decided by looking the head word up
    before the line runs (GNU fails in ``execvp``), never from the exit
    status: a program that exists and exits 127 keeps its own stderr and
    is just a failed run. Returns whether the run succeeded, which is
    the action's truth value.

    Args:
        execute_fn (ExecuteLine): runs a line in the session.
        session_id (str): the session the line runs under.
        registry (MountRegistry): where the head word is looked up.
        cwd (str): the session's working directory.
        stat_path (StatPath | None): dispatcher stat for a slash head.
        action (ExecAction): the action.
        paths (list[str]): the match, or every match for a batched run.
        out (list[bytes]): where the run's stdout is appended.
        errors (list[bytes]): where its stderr is appended.
        stdin (SharedStdin | None): find's own input, one cursor shared
            by every child; None keeps the ambient stdin.
        where (str | None): ``-execdir``'s directory as printed, which the
            run enters first; None runs where find does.
    """
    # GNU substitutes the matches into the words and only then hands
    # them to execvp, so the head looked up is the substituted one:
    # `-exec {} \;` runs each match itself.
    words = exec_words(action, paths)
    head = words[0] if words else action.argv[0]
    here = cwd if where is None else resolve_path(where, cwd)
    missing, shadowed = await program_head(
        head, get_current_session(), registry, here, stat_path
    )
    if missing:
        errors.append(
            encode_text(f"find: '{head}': No such file or directory\n")
        )
        return False
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
    sess = get_current_session()
    token = set_program_invocation(sess) if sess is not None else None
    try:
        io = await execute_fn(
            f"( {line} )", session_id=session_id, stdin=stdin
        )
    finally:
        if token is not None:
            reset_program_invocation(token)
    if io.stdout is not None:
        data = await materialize(io.stdout)
        if data:
            out.append(data)
    if io.stderr is not None:
        err = await materialize(io.stderr)
        if err:
            errors.append(err)
    return io.exit_code == 0


async def _delete_row(
    ps: PathSpec,
    vfs: Files | None,
    dispatch: DispatchFn | None,
    errors: list[bytes],
    stat_path: StatPath | None,
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
    """
    links = link_view(vfs)
    path = ps.raw_path or ps.virtual
    if dispatch is None:
        errors.append(b"find: -delete requires an operation dispatcher\n")
        return False
    try:
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
    """
    links = link_view(vfs)
    path = ps.raw_path or ps.virtual
    if stat_path is None:
        errors.append(encode_text(f"find: '{path}': no stat function\n"))
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
        errors.append(encode_text(f"find: '{path}': {why}\n"))
        return None
    if st is None:
        errors.append(
            encode_text(
                f"find: '{path}': {posix_phrase(FsCondition.ENOENT)}\n"
            )
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
            return encode_text(f"find: '{file}': {strerror_of(exc)}\n")
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
    execute_fn: ExecuteLine | None,
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
        execute_fn (ExecuteLine | None): runs the find over the names.
        session_id (str): the session the find runs under.
        stdin (ByteSource | None): find's input, the list under ``-``.
    """
    source = "-" if expr.files0_from is None else expr.files0_from
    typed = [w for w in words[: expr.start] if w not in _LINK_OPTIONS]
    if typed:
        return IOResult(
            exit_code=1,
            stderr=encode_text(
                f"find: extra operand {shell_quote_always(typed[0])}\n"
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
                f"find: cannot open {shell_quote_always(source)} for "
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
    io = await execute_fn(
        line,
        session_id=session_id,
        stdin=None if source == "-" else stdin,
    )
    if refused:
        existing = await materialize(io.stderr) if io.stderr else b""
        io.stderr = encode_text(refused) + existing
        io.exit_code = max(io.exit_code, 1)
    return io


def _structural(path: PathSpec, registry: MountRegistry) -> bool:
    """Whether a row is a mount point or a namespace-only ancestor of
    one, which are not unlinkable entries. Ancestors use the raw mount
    table like ``is_mount_root``: an ungranted mount still pins its
    ancestors in the namespace.

    Args:
        path (PathSpec): the selected row.
        registry (MountRegistry): the mount table.
    """
    virtual = path.virtual
    return registry.is_mount_root(virtual) or bool(
        registry.descendant_mounts(virtual)
    )


async def _apply_find_actions(
    stdout: ByteSource | None,
    records: list[PathRecord] | None,
    expr: FindExpr,
    registry: MountRegistry,
    cwd: str,
    *,
    execute_fn: ExecuteLine | None = None,
    session_id: str = "",
    vfs: Files | None = None,
    stat_path: StatPath | None = None,
    dispatch: DispatchFn | None = None,
    identity: Identity | None = None,
    stdin: ByteSource | None = None,
    starts: list[PathSpec] | None = None,
) -> tuple[ByteSource | None, bytes, int]:
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

    Args:
        stdout (ByteSource | None): display output from find.
        records (list[PathRecord] | None): matches before rendering,
            each with the start point it was found under, in operand
            order.
        expr (FindExpr): the expression, parsed once for the line.
        registry (MountRegistry): used to route per-match dispatch.
        cwd (str): cwd forwarded to per-match sub-dispatch.
        execute_fn (ExecuteLine | None): runs an ``-exec`` line in the
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

    Returns:
        The rows to print, the stderr to append, and the exit status the
        actions impose (0 when they impose none, even with stderr).
        stdin (ByteSource | None): find's own input, which its ``-exec``
            children share as one cursor, as GNU's do (a pipe feeds one
            reader, and a child that never reads leaves it for the next);
            None keeps the ambient stdin for every child.
        starts (list[PathSpec] | None): the start operands, whose rows
            GNU statted when it opened the walk; None or empty means the
            working directory.
    """
    once = SharedStdin(stdin) if stdin is not None else None
    reorders = expr.depth_first
    if stdout is None or not (_has_actions(expr) or reorders):
        return stdout, b"", 0
    await materialize(stdout)
    if expr.execs and execute_fn is None:
        return (
            None,
            b"find: -exec: no shell to run the command\n",
            1,
        )
    if records is None:
        return (
            None,
            b"find: actions require structured matches\n",
            1,
        )
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
                    depth_first_key(r.path.raw_path or r.path.virtual),
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
    errors: list[bytes] = []
    out: list[bytes] = []
    batches: dict[int, list[tuple[str | None, list[str]]]] = {}
    sinks: dict[str, list[bytes]] = {file: [] for file in expr.files}

    def sink(file: str | None) -> list[bytes]:
        if file is None:
            return out
        where = resolve_path(file, cwd)
        if where == _STDOUT:
            return out
        if where == _STDERR:
            return errors
        return sinks[file]

    exit_code = 0
    stats = any(_reads_stat(a) for a in actions)
    statted = _tests_stat(expr)
    start_virtuals = {s.virtual for s in starts} if starts else {cwd}
    formatters = {
        position: compile_printf(action.parts)
        for position, action in enumerate(actions)
        if isinstance(action, PrintfAction)
    }
    try:
        for match, start in matches:
            path = match.raw_path or match.virtual
            # The stat -ls and -printf render is the one find already holds,
            # taken before any action of the chain can remove the row; a row
            # it never statted is looked up by the first action that reads
            # it, and held from there, as GNU stats a row once.
            held = (
                await _row_stat(match, vfs, stat_path, [])
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
                        # arrive together, as the reference's runs end where its walk
                        # leaves a directory.
                        groups = batches.setdefault(position, [])
                        if groups and groups[-1][0] == where:
                            groups[-1][1].append(arg)
                        else:
                            groups.append((where, [arg]))
                        continue
                    assert execute_fn is not None
                    if not await _run_exec(
                        execute_fn,
                        session_id,
                        registry,
                        cwd,
                        stat_path,
                        action,
                        [arg],
                        out,
                        errors,
                        once,
                        where,
                    ):
                        break
                elif _reads_stat(action):
                    if held is None:
                        held = await _row_stat(match, vfs, stat_path, errors)
                    if held is None:
                        # A row -ls or -printf cannot stat is false, so the
                        # chain ends for it, as GNU's does.
                        exit_code = 1
                        break
                    rendered = (
                        await _printf_row(
                            formatters[position],
                            match,
                            start,
                            held,
                            vfs,
                            identity,
                        )
                        if isinstance(action, PrintfAction)
                        else _ls_row(match, held, identity)
                    )
                    sink(
                        action.file
                        if isinstance(action, PrintfAction)
                        else None
                    ).append(rendered)
                elif isinstance(action, PrintfAction):
                    sink(action.file).append(
                        await _printf_row(
                            formatters[position],
                            match,
                            start,
                            None,
                            vfs,
                            identity,
                        )
                    )
                elif action.kind == "delete":
                    # A structural row is skipped, not refused, the way Unix
                    # leaves a mount point in place.
                    if _structural(match, registry):
                        continue
                    if not await _delete_row(
                        match, vfs, dispatch, errors, stat_path
                    ):
                        exit_code = 1
                        break
                else:
                    sink(action.file).append(
                        encode_text(path)
                        + (b"\x00" if action.kind == "print0" else b"\n")
                    )
        for position, action in enumerate(actions):
            if not isinstance(action, ExecAction):
                continue
            for where, paths in batches.get(position, []):
                assert execute_fn is not None
                if not await _run_exec(
                    execute_fn,
                    session_id,
                    registry,
                    cwd,
                    stat_path,
                    action,
                    paths,
                    out,
                    errors,
                    once,
                    where,
                ):
                    exit_code = 1
        for file, chunks in sinks.items():
            if resolve_path(file, cwd) in _STREAMS or dispatch is None:
                continue
            spec = _file_spec(file, cwd)
            if expr.execs:
                # The reference writes to the file it opened, wherever a
                # child moves it; a workspace has no open file to follow,
                # so a file a child moved or removed is not made again.
                try:
                    await dispatch("stat", spec)
                except (OSError, ValueError) as exc:
                    logger.debug(
                        "find: %s is gone, rows dropped: %s", file, exc
                    )
                    continue
            try:
                await dispatch("write", spec, data=b"".join(chunks))
            except (OSError, ValueError) as exc:
                errors.append(
                    encode_text(f"find: '{file}': {strerror_of(exc)}\n")
                )
                exit_code = 1
        body = b"".join(out)
        return (body if body else None), b"".join(errors), exit_code
    finally:
        for engine in formatters.values():
            await close_stream(engine)
