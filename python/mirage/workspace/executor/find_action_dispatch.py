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
from collections.abc import AsyncIterator

from mirage.commands.builtin.constants import EXEC_PLACEHOLDER
from mirage.commands.builtin.find_parse import FindExpr, parse_find_expression
from mirage.commands.builtin.types import ExecAction, RowAction
from mirage.commands.builtin.utils.formatting import format_find_ls
from mirage.commands.builtin.utils.identity import Identity
from mirage.commands.config import ExecContext
from mirage.context import (get_current_session, reset_op_policies,
                            reset_program_invocation, set_program_invocation,
                            suspend_op_policies)
from mirage.io.stream import materialize
from mirage.io.types import ByteSource
from mirage.ops.types import NamespaceView, StatPath
from mirage.policy import pre_ops_gate
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import fs_strerror
from mirage.utils.path import resolve_path
from mirage.utils.stream import ensure_stream
from mirage.workspace.lookup.constants import SHELL_ONLY_BUILTINS
from mirage.workspace.lookup.lookup import lookup_all
from mirage.workspace.lookup.types import Consumer
from mirage.workspace.mount import MountRegistry
from mirage.workspace.mount.namespace import Namespace
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


def exec_line(action: ExecAction, paths: list[str]) -> str:
    """The shell line one ``-exec`` run becomes.

    GNU execs the words directly, so every match must reach the command
    as exactly one argv word: the line is built with ``shlex.join``, and
    a plain join would be re-parsed by the shell.

    Args:
        action (ExecAction): the action.
        paths (list[str]): the match, or every match for a batched run.
    """
    return shlex.join(exec_words(action, paths))


async def _head_state(head: str, registry: MountRegistry, cwd: str,
                      stat_path: StatPath | None) -> tuple[bool, bool]:
    """Whether ``execvp`` would fail to find an ``-exec`` head word, and
    whether a shell function shadows the program it would find.

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
        registry (MountRegistry): where a name is looked up.
        cwd (str): the session's working directory.
        stat_path (StatPath | None): dispatcher stat, None outside a
            workspace, where the loader answers for itself.
    """
    if "/" in head:
        return (stat_path is not None
                and await stat_path(resolve_path(head, cwd)) is None), False
    sess = get_current_session()
    if sess is None:
        return False, False
    layers = lookup_all(head, sess, registry)
    program = any(layer is not Consumer.FUNCTION and (
        layer is not Consumer.SESSION or head not in SHELL_ONLY_BUILTINS)
                  for layer in layers)
    # An alias is as invisible to execvp as a function, and `command`
    # masks both for the run.
    shadowed = Consumer.FUNCTION in layers or head in sess.aliases
    return not program, shadowed


class _SharedStdin:
    """find's own input, shared by its ``-exec`` children as one cursor.

    GNU's children inherit find's stdin descriptor, so its offset moves
    only when a child reads: ``-exec true \\; -exec cat \\;`` leaves the
    bytes for cat, while two cats see them once. The same object rides
    into every child as its stdin, and the source is pulled only as a
    child reads: find itself never reads its stdin, so a walk with no
    reading child (``yes | find d -maxdepth 0``) must not wait on it,
    and a child that reads a little of an unbounded input
    (``-exec head -c 1``) must get its byte without waiting for EOF.

    Args:
        source (ByteSource): find's own input, unread.
    """

    __slots__ = ("_chunks", "_buffer", "_pos")

    def __init__(self, source: ByteSource) -> None:
        self._chunks: AsyncIterator[bytes] | None = ensure_stream(source)
        self._buffer = b""
        self._pos = 0

    def __aiter__(self) -> AsyncIterator[bytes]:
        return self._drain()

    async def _drain(self) -> AsyncIterator[bytes]:
        # One byte per pull, so a child that stops reading early (`head
        # -c 1`) leaves the rest at the cursor for the next child, the
        # way a shared descriptor's offset does; the next source chunk
        # is pulled only once the buffered one is spent.
        while True:
            if self._pos >= len(self._buffer):
                if self._chunks is None:
                    return
                try:
                    self._buffer = await anext(self._chunks)
                except StopAsyncIteration:
                    self._chunks = None
                    return
                self._pos = 0
                continue
            chunk = self._buffer[self._pos:self._pos + 1]
            self._pos += 1
            yield chunk


async def _run_exec(execute_fn: ExecuteLine, session_id: str,
                    registry: MountRegistry, cwd: str,
                    stat_path: StatPath | None, action: ExecAction,
                    paths: list[str], out: list[bytes], errors: list[bytes],
                    stdin: _SharedStdin | None) -> bool:
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
        stdin (_SharedStdin | None): find's own input, one cursor shared
            by every child; None keeps the ambient stdin.
    """
    # GNU substitutes the matches into the words and only then hands
    # them to execvp, so the head looked up is the substituted one:
    # `-exec {} \;` runs each match itself.
    words = exec_words(action, paths)
    head = words[0] if words else action.argv[0]
    missing, shadowed = await _head_state(head, registry, cwd, stat_path)
    if missing:
        errors.append(f"find: '{head}': No such file or directory\n".encode())
        return False
    # A function or alias of the head's name is invisible to execvp, so
    # the line runs the program past it, as `command` does. The run is
    # marked a program run for the session, so a builtin that doubles
    # as a program answers as the program (`printf -v` is a format).
    line = ("command " if shadowed else "") + shlex.join(words)
    sess = get_current_session()
    token = set_program_invocation(sess) if sess is not None else None
    try:
        io = await execute_fn(f"( {line} )",
                              session_id=session_id,
                              stdin=stdin)
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


async def _delete(ps: PathSpec, registry: MountRegistry, cwd: str,
                  ns: NamespaceView | None, dispatch: DispatchFn | None,
                  errors: list[bytes], namespace: Namespace | None,
                  stat_path: StatPath | None) -> bool:
    """Delete one accepted row; returns whether it succeeded.

    A symlink row came from the namespace, which no backend can see, so
    it is unlinked through the op dispatcher the way ``rm link`` is
    (``strip_link_operands``): that door is where the path gate, the
    turf's mode and the op ledger fire, and it removes the node the
    mount's ``rm`` would only report as absent. Every other row is a
    backend entry, removed by the mount's own ``rm``.

    Args:
        ps (PathSpec): the selected row, with its display spelling.
        registry (MountRegistry): used to route the removal.
        cwd (str): the session's working directory.
        ns (NamespaceView | None): the name plane's facts, whose link
            view tells a namespace row from a backend one.
        dispatch (DispatchFn | None): the op dispatcher a link is
            unlinked through; None outside a workspace, where there is
            no namespace to hold one.
        errors (list[bytes]): where a failure's line is appended.
        namespace (Namespace | None): the node table a removed row's
            meta is dropped from; None outside a workspace.
        stat_path (StatPath | None): dispatcher stat, which tells a
            directory row (admitted as ``rmdir``) from a file (``unlink``).
    """
    path = ps.raw_path or ps.virtual
    link = (dispatch is not None and ns is not None and ns.links is not None
            and ns.links.stat_at(ps.virtual) is not None)
    mount = registry.try_mount_for(ps.virtual)
    if mount is None and not link:
        errors.append(f"find: cannot delete '{path}': no mount\n".encode())
        return False
    try:
        if link:
            assert dispatch is not None
            await dispatch("unlink", ps)
            return True
        assert mount is not None
        # -delete is find's own action, not an `rm` line, so no command
        # rule sees it; it is a removal all the same, so it clears the op
        # door a path rule guards (the same gate `ws.fs`, FUSE and a
        # redirect clear), by the session the line runs under, and a
        # refusal reports in find's voice. The delegated rm's own slots
        # are suspended for the call, so the deletion admits exactly
        # once. -d so a directory emptied by the rows before it in -depth
        # order is removable, matching GNU -delete's rmdir behavior.
        # Admitted as the op the row's removal is: a directory row is an
        # rmdir, so a rule that refuses rmdir and allows unlink judges
        # `find emptydir -delete` as it judges `rmdir emptydir`.
        st = await stat_path(ps.virtual) if stat_path is not None else None
        op = ("rmdir" if st is not None and st.type == FileType.DIRECTORY else
              "unlink")
        sess = get_current_session()
        await pre_ops_gate(registry.policies, op, ps, True, mount.prefix,
                           sess.session_id if sess is not None else "")
        token = suspend_op_policies()
        try:
            _, rm_io = await mount.execute_cmd("rm", [ps], [], {"d": True},
                                               ExecContext(cwd=cwd))
        finally:
            reset_op_policies(token)
    except (FileNotFoundError, NotADirectoryError, PermissionError,
            ValueError) as exc:
        # GNU words it with the errno text; a policy refusal carries its
        # reason there.
        why = (exc.strerror or str(exc)) if isinstance(exc,
                                                       OSError) else str(exc)
        errors.append(f"find: cannot delete '{path}': {why}\n".encode())
        return False
    if rm_io.exit_code != 0:
        err = await materialize(rm_io.stderr) if rm_io.stderr else b""
        # rm names the reason last (`rm: cannot remove '/w/d': Directory
        # not empty`), and find says the same thing about the row as it
        # was typed.
        why = err.decode("utf-8", errors="replace").strip().rsplit(": ", 1)[-1]
        errors.append(f"find: cannot delete '{path}'"
                      f"{': ' + why if why else ''}\n".encode())
        return False
    if namespace is not None:
        # The row's node meta (a chmod/chown overlay) goes with it and a
        # directory's subtree purges, as the `rm` command path does in
        # command_dispatch: a file later created at the same name must
        # not inherit the removed one's mode.
        await namespace.unlink(ps.virtual)
        await namespace.purge_under(ps.virtual)
    return True


async def _row_stat(ps: PathSpec, ns: NamespaceView | None,
                    stat_path: StatPath | None,
                    errors: list[bytes]) -> FileStat | None:
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
        errors.append(f"find: '{path}': no stat door\n".encode())
        return None
    link = (ns.links.stat_at(ps.virtual)
            if ns is not None and ns.links is not None else None)
    try:
        st = link if link is not None else await stat_path(ps.virtual)
    except (NotADirectoryError, PermissionError, ValueError) as exc:
        # GNU words it with the errno text; a policy refusal carries its
        # reason there.
        why = (exc.strerror or str(exc)) if isinstance(exc,
                                                       OSError) else str(exc)
        errors.append(f"find: '{path}': {why}\n".encode())
        return None
    if st is None:
        errors.append(
            f"find: '{path}': {fs_strerror(FileNotFoundError())}\n".encode())
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
    return (row + "\n").encode()


def _tests_stat(expr: FindExpr) -> bool:
    """Whether the expression's tests made find stat every row it kept.

    GNU reads ``-name``, ``-path`` and ``-type`` off the directory
    entry and stats only for a test that needs the inode: a size or
    time window, ``-newer`` and ``-empty``.

    Args:
        expr (FindExpr): the parsed expression.
    """
    return (expr.min_size is not None or expr.max_size is not None
            or expr.mtime_min is not None or expr.mtime_max is not None
            or expr.uses_empty or bool(expr.newer))


def _has_actions(expr: FindExpr) -> bool:
    """Whether the actions differ from the implicit print.

    One explicit ``-print`` is exactly what the backend already
    rendered; two of them print every row twice, as GNU does.

    Args:
        expr (FindExpr): the parsed expression.
    """
    return len(expr.actions) > 1 or any(
        not (isinstance(a, RowAction) and a.kind == "print")
        for a in expr.actions)


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
    return (registry.is_mount_root(virtual)
            or bool(registry.descendant_mounts(virtual)))


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
    namespace: Namespace | None = None,
    stdin: ByteSource | None = None,
    starts: list[PathSpec] | None = None,
) -> tuple[ByteSource | None, bytes, int]:
    """Apply find's actions (-exec / -delete / -print0 / -ls) to its rows.

    Per-resource find handlers only emit matched paths. This dispatcher
    layer re-reads the actions off the expression and applies them per
    match, in the order they were written, the way GNU's implicit ``-a``
    chain runs: each per-match ``-exec`` runs in turn and the first that
    fails ends the chain for that match, so a later ``-print`` (or
    ``-ls``, ``-print0``, ``-delete``) sees only the matches every
    earlier ``-exec`` accepted (``-exec grep -q x {} ";" -print``), and
    ``-exec echo {} ";" -print -exec echo again {} ";"`` alternates the
    three per match. A batched ``-exec ... {} +`` collects the match at
    its position and runs once after the walk; a failing batch is
    find's exit 1, as is a row it could not delete or list, and
    either ends that row's chain; a failing per-match run is not, and
    neither is a command that cannot be found, which GNU reports per
    match and carries on from with exit 0.
    An action other than ``-print`` suppresses the implicit print.
    ``-delete`` runs at its position, so a later ``-exec`` sees the row
    gone, and a row it cannot delete ends the chain with GNU's line and
    find's exit 1. ``-ls`` renders the stat find already holds, as GNU's
    does: GNU stats a start point when it opens the walk and any other
    row only when a test needs it (``-size``, ``-mtime``, ``-newer``,
    ``-empty``; ``-name`` and ``-type`` read the directory entry), so
    ``find d/f -delete -ls`` and ``find d -size -1k -delete -ls`` list
    the row they removed and exit 0, while ``find d -type f -delete
    -ls`` reports it gone and exits 1. ``starts`` names the operands
    that rule reads. It also turns on ``-depth``, which orders every
    directory after its contents, the only order a tree can be removed
    in; ``-depth`` alone reorders the implicit print the same way, and
    both order one start point's walk at a time: GNU walks each start
    point to completion before the next, so ``find b a -depth`` prints
    ``b/x b a/y a`` and ``find d d/sub -depth`` finishes ``d`` before
    it begins ``d/sub`` again, which is why the rows arrive as one run
    per start point rather than one list.

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
        dispatch (DispatchFn | None): the op dispatcher a ``-delete``
            unlinks a symlink row through, since the row is namespace
            state no mount's ``rm`` can reach.
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
    once = _SharedStdin(stdin) if stdin is not None else None
    expr = parse_find_expression(list(texts))
    reorders = expr.depth_first and expr.printf is None
    if stdout is None or not (_has_actions(expr) or reorders):
        return stdout, b"", 0
    if expr.execs and execute_fn is None:
        return None, b"find: -exec: no shell to run the command\n", 1
    if matched_runs is None:
        return None, b"find: actions require structured matches\n", 1
    matches = [
        match for run in matched_runs for match in (
            sorted(run, key=lambda p: depth_first_key(p.raw_path or p.virtual)
                   ) if reorders else run)
    ]
    # An expression with no action of its own prints, which is the one
    # implicit action -depth reorders.
    actions = expr.actions or [RowAction("print")]
    errors: list[bytes] = []
    out: list[bytes] = []
    batches: dict[int, list[str]] = {}
    exit_code = 0
    lists = any(isinstance(a, RowAction) and a.kind == "ls" for a in actions)
    statted = _tests_stat(expr)
    start_virtuals = {s.virtual for s in starts} if starts else {cwd}
    for match in matches:
        path = match.raw_path or match.virtual
        # The stat -ls renders is the one find already holds, taken
        # before any action of the chain can remove the row; a row it
        # never statted is looked up by the -ls that reaches it.
        held = (await _row_stat(match, ns, stat_path, []) if lists and
                (statted or match.virtual in start_virtuals) else None)
        for position, action in enumerate(actions):
            if isinstance(action, ExecAction):
                if action.batch:
                    batches.setdefault(position, []).append(path)
                    continue
                assert execute_fn is not None
                if not await _run_exec(execute_fn, session_id, registry, cwd,
                                       stat_path, action, [path], out, errors,
                                       once):
                    break
            elif action.kind == "ls":
                st = held if held is not None else await _row_stat(
                    match, ns, stat_path, errors)
                if st is None:
                    # A row -ls cannot list is false, so the chain ends
                    # for it, as GNU's does.
                    exit_code = 1
                    break
                out.append(_ls_row(match, st, identity))
            elif action.kind == "delete":
                # A structural row is skipped, not refused, the way Unix
                # leaves a mount point in place.
                if _structural(match, registry):
                    continue
                if not await _delete(match, registry, cwd, ns, dispatch,
                                     errors, namespace, stat_path):
                    exit_code = 1
                    break
            else:
                out.append(
                    path.encode("utf-8") +
                    (b"\x00" if action.kind == "print0" else b"\n"))
    for position, action in enumerate(actions):
        paths = batches.get(position)
        if not isinstance(action, ExecAction) or not paths:
            continue
        assert execute_fn is not None
        if not await _run_exec(execute_fn, session_id, registry, cwd,
                               stat_path, action, paths, out, errors, once):
            exit_code = 1
    body = b"".join(out)
    return (body if body else None), b"".join(errors), exit_code
