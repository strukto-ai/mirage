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

from mirage.commands.builtin.constants import EXEC_PLACEHOLDER
from mirage.commands.builtin.find_parse import FindExpr, parse_find_expression
from mirage.commands.builtin.find_printf import (
    expand_printf,
    printf_needs_stat,
)
from mirage.commands.builtin.types import (
    ExecAction,
    FindAction,
    PrintfAction,
    RowAction,
)
from mirage.commands.builtin.utils.formatting import format_find_ls
from mirage.commands.builtin.utils.identity import Identity
from mirage.context import (
    get_current_session,
    reset_program_invocation,
    set_program_invocation,
)
from mirage.errors.classify import failure_text, is_entry_error
from mirage.errors.fs import enoent
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.stream import SharedStdin, materialize
from mirage.io.types import ByteSource
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.shell.join import shell_join
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import resolve_path
from mirage.view.types import NamespaceView, StatPath
from mirage.workspace.lookup.constants import SHELL_ONLY_BUILTINS
from mirage.workspace.lookup.lookup import lookup_all
from mirage.workspace.lookup.types import Consumer
from mirage.workspace.mount import MountRegistry
from mirage.workspace.session import SessionState
from mirage.workspace.types import ExecuteLine


def exec_words(action: ExecAction, paths: list[str]) -> list[str]:
    """The argv one ``-exec`` run becomes, matches substituted.

    A per-match run substitutes every ``{}`` inside every word (``x{}y``
    is ``xd/a.txty``); a batched run replaces its one bare ``{}`` with
    the matches, one word each. The head is substituted like any other
    word, which is what lets ``-exec {} \\;`` run each match itself.

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
    """
    # GNU substitutes the matches into the words and only then hands
    # them to execvp, so the head looked up is the substituted one:
    # `-exec {} \;` runs each match itself.
    words = exec_words(action, paths)
    head = words[0] if words else action.argv[0]
    missing, shadowed = await program_head(
        head, get_current_session(), registry, cwd, stat_path
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


async def _delete(
    ps: PathSpec,
    ns: NamespaceView | None,
    dispatch: DispatchFn | None,
    errors: list[bytes],
    stat_path: StatPath | None,
) -> bool:
    """Remove a matched entry through the shared operation door.

    The dispatcher owns admission, backend support, cache invalidation and
    namespace cleanup. A find action never resolves a shell command.

    Args:
        ps (PathSpec): the selected row, with its display spelling.
        ns (NamespaceView | None): the namespace's link facts.
        dispatch (DispatchFn | None): workspace operation door.
        errors (list[bytes]): receives a failure in find's voice.
        stat_path (StatPath | None): distinguishes files from directories.
    """
    path = ps.raw_path or ps.virtual
    if dispatch is None:
        errors.append(b"find: -delete requires an operation dispatcher\n")
        return False
    try:
        link = (
            ns is not None
            and ns.links is not None
            and ns.links.stat_at(ps.virtual) is not None
        )
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
        why = failure_text(exc)
        errors.append(encode_text(f"find: cannot delete '{path}': {why}\n"))
        return False


async def _row_stat(
    ps: PathSpec,
    ns: NamespaceView | None,
    stat_path: StatPath | None,
    errors: list[bytes],
) -> FileStat | None:
    """The facts ``find -ls`` renders one accepted row from.

    They come from the two doors the command boundary has: a symlink is
    namespace state no backend can see, so the link view answers for
    one (lstat, as GNU's ``-ls`` reports the link itself), and every
    other row is statted through the op dispatcher, which answers for a
    mount point and a namespace-only ancestor as well as a backend
    entry. A row that cannot be statted (the backend refuses it, or it
    is gone) is GNU's ``find: 'path': <reason>``; None with a line
    appended is the caller's signal to end the row's chain.

    Args:
        ps (PathSpec): the selected row, with its display spelling.
        ns (NamespaceView | None): the name plane's facts, so a symlink
            row renders as the link.
        stat_path (StatPath | None): dispatcher stat; None outside a
            workspace, where no row can be rendered.
        errors (list[bytes]): where a failure's line is appended.
    """
    path = ps.raw_path or ps.virtual
    if stat_path is None:
        errors.append(encode_text(f"find: '{path}': no stat door\n"))
        return None
    link = (
        ns.links.stat_at(ps.virtual)
        if ns is not None and ns.links is not None
        else None
    )
    try:
        st = link if link is not None else await stat_path(ps)
    except Exception as exc:
        if not is_entry_error(exc):
            raise
        # GNU words it with the errno text; a policy refusal carries its
        # reason there.
        why = (
            exc.strerror if isinstance(exc, OSError) else None
        ) or failure_text(exc)
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
    row = format_find_ls(st.model_copy(update={"name": path}), identity)
    return encode_text(row + "\n")


async def _printf_row(
    action: PrintfAction,
    ps: PathSpec,
    start: PathSpec,
    st: FileStat | None,
    ns: NamespaceView | None,
    warnings: list[str],
    identity: Identity | None,
) -> bytes:
    """Render one accepted row through a ``-printf`` format.

    A symlink row is the link itself, and ``%Y`` reads what it points at
    through the workspace, so a link into another mount classifies and a
    dangling one reads ``N``.

    Args:
        action (PrintfAction): the action.
        ps (PathSpec): the selected row, with its display spelling.
        start (PathSpec): the start point the row was found under, which
            ``%P`` and ``%d`` measure from.
        st (FileStat | None): the stat find holds for the row; None when
            the format names no stat directive.
        ns (NamespaceView | None): the name plane's facts, for a symlink
            row's target.
        warnings (list[str]): sink for GNU's warning lines.
        identity (Identity | None): who the session is, for the owner
            directives on an entry that reports no owner of its own.
    """
    links = ns.links if ns is not None else None
    target = (
        await links.target_stat(ps.virtual)
        if st is not None
        and links is not None
        and links.stat_at(ps.virtual) is not None
        else None
    )
    return encode_text(
        expand_printf(
            action.format,
            ps.raw_path or ps.virtual,
            start,
            st,
            warnings,
            target,
            identity,
        )
    )


def _reads_stat(action: FindAction) -> bool:
    """Whether an action reads the row's stat: ``-ls``, and a
    ``-printf`` whose format names a stat directive (%s %y %m %T ...).

    Args:
        action (FindAction): the action.
    """
    if isinstance(action, PrintfAction):
        return printf_needs_stat(action.format)
    return isinstance(action, RowAction) and action.kind == "ls"


def _tests_stat(expr: FindExpr) -> bool:
    """Whether the expression's tests made find stat every row it kept.

    GNU reads ``-name``, ``-path`` and ``-type`` off the directory
    entry and stats only for a test that needs the inode: a size or
    time window, ``-newer`` and ``-empty``.

    Args:
        expr (FindExpr): the parsed expression.
    """
    return (
        expr.min_size is not None
        or expr.max_size is not None
        or expr.mtime_min is not None
        or expr.mtime_max is not None
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
        not (isinstance(a, RowAction) and a.kind == "print")
        for a in expr.actions
    )


def depth_first_key(path: str) -> tuple[tuple[str, int], ...]:
    """The sort key for GNU's ``-depth`` order over sorted siblings.

    A directory's contents, each sorted, then the directory: the final
    component is flagged so a path sorts after its descendants, whose
    entry at that depth carries the same name unflagged. A start point
    spelled with a trailing slash prints as ``d/`` while its descendants
    print as ``d/a``, so the slash is dropped before splitting: kept, it
    would leave an empty final component that sorts the directory ahead
    of everything under it, which is the one order ``-delete`` cannot
    remove a tree in.

    Args:
        path (str): a row as find printed it.
    """
    parts = path.rstrip("/").split("/")
    return (*((part, 0) for part in parts[:-1]), (parts[-1], 1))


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
    matched_runs: list[list[PathSpec]] | None,
    texts: list[str],
    registry: MountRegistry,
    cwd: str,
    *,
    execute_fn: ExecuteLine | None = None,
    session_id: str = "",
    ns: NamespaceView | None = None,
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
    it begins ``d/sub`` again, which is why the rows arrive as one run
    per start point rather than one list; ``-printf``'s ``%P`` and
    ``%d`` measure a row from its run's start point.

    Args:
        stdout (ByteSource | None): display output from find.
        matched_runs (list[list[PathSpec]] | None): matches before
            rendering, one run per start point in operand order.
        texts (list[str]): the expression tokens, already validated.
        registry (MountRegistry): used to route per-match dispatch.
        cwd (str): cwd forwarded to per-match sub-dispatch.
        execute_fn (ExecuteLine | None): runs an ``-exec`` line in the
            session; None outside a workspace, where ``-exec`` is
            refused.
        session_id (str): the session the ``-exec`` lines run under.
        ns (NamespaceView | None): the name plane's facts, threaded into
            the -ls sub-dispatch so a namespace-only row (a mount point,
            a symlink) renders the way ``ls -l`` renders it.
        stat_path (StatPath | None): dispatcher stat, threaded with it
            and used to find a slash-carrying ``-exec`` head.
        dispatch (DispatchFn | None): removes matched rows through the
            operation door, which owns admission and cleanup.
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
    expr = parse_find_expression(list(texts))
    reorders = expr.depth_first
    if stdout is None or not (_has_actions(expr) or reorders):
        return stdout, b"", 0
    await materialize(stdout)
    if expr.execs and execute_fn is None:
        return None, b"find: -exec: no shell to run the command\n", 1
    if matched_runs is None:
        return None, b"find: actions require structured matches\n", 1
    # The runs arrive one per start point, in operand order, so each row
    # carries the start point it was found under; with no operand that is
    # the working directory, which prints as `.`.
    cwd_start = PathSpec(virtual=cwd, directory=cwd, vfs_path="", raw_path=".")
    matches = [
        (match, starts[i] if starts and i < len(starts) else cwd_start)
        for i, run in enumerate(matched_runs)
        for match in (
            sorted(run, key=lambda p: depth_first_key(p.raw_path or p.virtual))
            if reorders
            else run
        )
    ]
    # An expression with no action of its own prints, which is the one
    # implicit action -depth reorders.
    actions = expr.actions or [RowAction("print")]
    errors: list[bytes] = []
    warnings: list[str] = []
    out: list[bytes] = []
    batches: dict[int, list[str]] = {}
    exit_code = 0
    stats = any(_reads_stat(a) for a in actions)
    statted = _tests_stat(expr)
    start_virtuals = {s.virtual for s in starts} if starts else {cwd}
    for match, start in matches:
        path = match.raw_path or match.virtual
        # The stat -ls and -printf render is the one find already holds,
        # taken before any action of the chain can remove the row; a row
        # it never statted is looked up by the first action that reads
        # it, and held from there, as GNU stats a row once.
        held = (
            await _row_stat(match, ns, stat_path, [])
            if stats and (statted or match.virtual in start_virtuals)
            else None
        )
        for position, action in enumerate(actions):
            if isinstance(action, ExecAction):
                if action.batch:
                    batches.setdefault(position, []).append(path)
                    continue
                assert execute_fn is not None
                if not await _run_exec(
                    execute_fn,
                    session_id,
                    registry,
                    cwd,
                    stat_path,
                    action,
                    [path],
                    out,
                    errors,
                    once,
                ):
                    break
            elif _reads_stat(action):
                if held is None:
                    held = await _row_stat(match, ns, stat_path, errors)
                if held is None:
                    # A row -ls or -printf cannot stat is false, so the
                    # chain ends for it, as GNU's does.
                    exit_code = 1
                    break
                out.append(
                    await _printf_row(
                        action, match, start, held, ns, warnings, identity
                    )
                    if isinstance(action, PrintfAction)
                    else _ls_row(match, held, identity)
                )
            elif isinstance(action, PrintfAction):
                out.append(
                    await _printf_row(
                        action, match, start, None, ns, warnings, identity
                    )
                )
            elif action.kind == "delete":
                # A structural row is skipped, not refused, the way Unix
                # leaves a mount point in place.
                if _structural(match, registry):
                    continue
                if not await _delete(match, ns, dispatch, errors, stat_path):
                    exit_code = 1
                    break
            else:
                out.append(
                    encode_text(path)
                    + (b"\x00" if action.kind == "print0" else b"\n")
                )
    for position, action in enumerate(actions):
        paths = batches.get(position)
        if not isinstance(action, ExecAction) or not paths:
            continue
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
        ):
            exit_code = 1
    body = b"".join(out)
    # GNU warns about a directive it cannot render once, ahead of anything
    # the actions report.
    warned = [encode_text(f"{line}\n") for line in warnings]
    return (body if body else None), b"".join(warned + errors), exit_code
