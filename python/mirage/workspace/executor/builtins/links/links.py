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

import dataclasses
import posixpath

from mirage.commands.spec import SPECS, parse_command, parse_to_kwargs
from mirage.commands.spec.types import FlagView
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, ReadOnlyError, fs_strerror
from mirage.utils.path import CycleError
from mirage.workspace.executor.builtins.links.probe import stat_or_none
from mirage.workspace.executor.builtins.shared import (fail, ok,
                                                       read_only_error,
                                                       split_flags)
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.mount.namespace import Namespace


def link_flags(args: list[str | PathSpec], known: str) -> set[str]:
    flags, _ = split_flags(args, known)
    return flags


def follow_parent(namespace: Namespace, virtual: str) -> str:
    """Resolve every component of a path but the last one.

    POSIX resolves a path one component at a time, and only the last one
    is exempt for an lstat-style command: ``stat dlink/f2`` reports
    ``f2`` because ``dlink`` was resolved on the way to it, while
    ``stat dlink`` reports the link. A no-follow command therefore still
    needs its operand's directory prefix resolved.

    Args:
        namespace (Namespace): addressing authority holding the links.
        virtual (str): absolute virtual path.

    Raises:
        CycleError: when a prefix loops past the hop limit (ELOOP).
    """
    parent, _, name = virtual.rstrip("/").rpartition("/")
    if not name:
        return virtual
    resolved = namespace.follow(parent or "/")
    return resolved.rstrip("/") + "/" + name


def follow_paths(
    namespace: Namespace,
    items: list[str | PathSpec],
    follow_last: bool = True,
    slash_follows: bool = True,
) -> list[str | PathSpec]:
    """Rewrite path operands through the symlink table (open(2) semantics).

    The directory prefix always resolves; ``follow_last`` decides the
    final component, which is the whole difference between open(2) and
    lstat(2). A trailing slash overrides it per operand, because POSIX
    reads ``dlink/`` as ``dlink/.`` and there is no ``.`` to reach
    without resolving the link first (GNU: ``stat dlink`` is a symbolic
    link, ``stat dlink/`` is a directory).

    Non-path items and paths that resolve to themselves pass through
    untouched. A rewritten spec keeps the user-typed form in ``raw_path``
    so error messages still name the operand as typed; the mount re-stamps
    ``resource_path`` at dispatch.

    Args:
        namespace (Namespace): addressing authority holding the link table.
        items (list[str | PathSpec]): classified command parts.
        follow_last (bool): whether the command resolves the final
            component of its own accord (open(2) rather than lstat(2)).
        slash_follows (bool): whether a trailing slash may override
            ``follow_last``; False only for ``tar``, which strips the
            slash before it stats.

    Raises:
        CycleError: when a path loops past the hop limit (ELOOP).
    """
    out: list[str | PathSpec] = []
    for item in items:
        if not isinstance(item, PathSpec):
            out.append(item)
            continue
        last = follow_last or (slash_follows and item.raw_path.endswith("/"))
        try:
            virtual = (namespace.follow(item.virtual)
                       if last else follow_parent(namespace, item.virtual))
        except CycleError:
            raise CycleError(item.raw_path) from None
        if virtual == item.virtual:
            out.append(item)
            continue
        out.append(
            dataclasses.replace(item,
                                virtual=virtual,
                                directory=virtual[:virtual.rfind("/") + 1]
                                or "/",
                                resource_path=""))
    return out


def accepts_line(name: str, args: tuple[str, ...], items: list[str | PathSpec],
                 cwd: str) -> bool:
    """Whether the command layer will act on this line as written.

    A link entry lives in the namespace, so ``strip_link_operands``
    removes it before the command runs, and the command layer can
    neither see that nor undo it. GNU validates the whole line first and
    removes nothing when it refuses: ``rm --bogus dlink`` reports the
    option and ``unlink dlink other`` reports the extra operand, both
    with every link still in place. So the strip runs only for a line
    that layer accepts, and a refused one falls through to it unchanged
    to be reported there. Option errors are the parser's, which reports
    rather than raises them; unlink's one-operand grammar is its
    builder's, and reporting it needs the operands to arrive intact.

    Args:
        name (str): command name.
        args (tuple[str, ...]): the line's words after the name.
        items (list[str | PathSpec]): classified command parts.
        cwd (str): session working directory, which the parser resolves
            path operands against.
    """
    spec = SPECS.get(name)
    if spec is None:
        return True
    parsed = parse_command(spec, list(args), cwd)
    if parsed.invalid_options or parsed.ambiguous_options:
        return False
    if name == "unlink":
        return sum(1 for i in items if isinstance(i, PathSpec)) <= 1
    return True


async def strip_link_operands(
    name: str,
    dispatch: DispatchFn,
    namespace: Namespace,
    items: list[str | PathSpec],
    args: tuple[str, ...],
    cwd: str,
) -> tuple[list[str | PathSpec], int, list[str]]:
    """Unlink and drop ``rm``/``unlink`` operands that are symlinks.

    GNU ``rm`` removes the link itself and never follows it; a dangling
    link removes fine. Remaining operands stay for backend dispatch.

    The removal is a dispatch op, never a direct table write: the door
    is where session grants, the turf's mode, admission policies and
    the op ledger fire, and writing the table from here let a session
    delete a link its grant reads and a policy protecting one never
    fired (the same hole the FUSE unlink had). A refused operand does
    not stop the rest, which is also rm's rule for a backend operand;
    ``-f`` silences only the absent (a hidden link answers ENOENT, the
    no-name-leak rule).

    The refusal is voiced the way the same refusal on a backend file is
    voiced, so one grant does not describe itself two ways: a mount-mode
    refusal renders ``read_only_error`` (naming the mount, deduplicated
    because two operands on one mount are one fact), everything else
    renders GNU's per-operand line.

    An operand typed with a trailing slash is deliberately kept: the
    slash asked for a directory, and GNU refuses rather than removing
    the link (``rm dlink/`` is "Is a directory", ``unlink dlink/`` is
    "Not a directory"). Removing it here would delete exactly what the
    slash was protecting, so the command reports it instead.

    Args:
        name (str): the command, ``rm`` or ``unlink`` (picks the
            refusal verb, and only rm has ``-f``).
        dispatch (DispatchFn): op dispatcher (the door).
        namespace (Namespace): addressing authority holding the link table.
        items (list[str | PathSpec]): classified command parts.
        args (tuple[str, ...]): the line's words after the name, parsed
            for rm's ``-f``.
        cwd (str): session working directory the parse resolves against.

    Returns:
        tuple[list[str | PathSpec], int, list[str]]: surviving parts,
        the number of link operands consumed (removed, refused or
        force-silenced), and the refusal lines.
    """
    force = False
    if name == "rm":
        force = bool(
            parse_command(SPECS["rm"], list(args), cwd).flags.get("-f"))
    verb = "remove" if name == "rm" else "unlink"
    handled = 0
    errors: list[str] = []
    kept: list[str | PathSpec] = []
    for item in items:
        if (isinstance(item, PathSpec) and not item.raw_path.endswith("/")
                and namespace.is_link(item.virtual)):
            handled += 1
            try:
                await dispatch("unlink", item)
            except FileNotFoundError as exc:
                if not force:
                    errors.append(f"{name}: cannot {verb} '{item.raw_path}': "
                                  f"{fs_strerror(exc)}\n")
            except ReadOnlyError:
                # The mount voice, because the mount is what refused:
                # a backend file on this operand's turf is answered by
                # `Mount.execute_cmd` with this exact line, and one
                # grant must not describe itself two ways depending on
                # whether the name it stopped was a link.
                line = read_only_error(name, namespace, item)
                if line not in errors:
                    errors.append(line)
            except FS_ERRORS as exc:
                errors.append(f"{name}: cannot {verb} '{item.raw_path}': "
                              f"{fs_strerror(exc)}\n")
            continue
        kept.append(item)
    return kept, handled, errors


async def _slashed_link_refusal(
    namespace: Namespace,
    dispatch: DispatchFn,
    src: PathSpec,
    dst: PathSpec,
    dst_stat: FileStat | None,
) -> Result:
    """GNU's refusal for an ``mv`` source that is a link typed with a slash.

    rename(2) never follows, so the slash is not resolved away: POSIX
    reads ``dlink/`` as ``dlink/.``, which asks for a directory the call
    will not resolve, and GNU refuses with everything left in place --
    where a bare ``dlink`` renames the link entry. Which of the four
    wordings applies follows mv's own order, source stat before
    destination type before the rename itself, and all four are pinned
    against GNU coreutils 9.7.

    Args:
        namespace (Namespace): addressing authority holding the link table.
        dispatch (DispatchFn): op dispatcher used to stat the target.
        src (PathSpec): the slashed link source.
        dst (PathSpec): destination as typed.
        dst_stat (FileStat | None): the destination's stat, None when it
            does not exist.
    """
    followed = namespace.follow(src.virtual)
    target = await stat_or_none(dispatch, PathSpec.from_str_path(followed))
    if target is None:
        return fail(
            "mv", f"mv: cannot stat '{src.raw_path}': "
            "No such file or directory\n")
    if target.type != FileType.DIRECTORY:
        return fail("mv",
                    f"mv: cannot stat '{src.raw_path}': Not a directory\n")
    if dst_stat is not None and dst_stat.type != FileType.DIRECTORY:
        return fail(
            "mv", f"mv: cannot overwrite non-directory '{dst.raw_path}' "
            f"with directory '{src.raw_path}'\n")
    landing = dst.raw_path
    if dst_stat is not None:
        landing = landing.rstrip("/") + "/" + posixpath.basename(src.virtual)
    return fail(
        "mv", f"mv: cannot move '{src.raw_path}' to '{landing}': "
        "Not a directory\n")


async def prepare_mv(
    namespace: Namespace,
    dispatch: DispatchFn,
    items: list[str | PathSpec],
    args: tuple[str, ...],
    cwd: str,
) -> tuple[list[str | PathSpec], str | None, tuple[str, str] | None, Result
           | None]:
    """Adjust a two-operand ``mv`` for node-meta operands.

    A link source renames the link entry itself. A destination that is
    (a link to) a directory receives the move inside it (rename(2)
    preceded by mv's dst stat); any other destination is replaced, so its
    node entry, link or overlay attrs alike, drops once the backend move
    succeeds. A plain source hands back the pair to re-anchor once the
    backend move succeeds, so whatever the node table holds at it and
    below it travels with the bytes.

    The pair is where this can be done at all: a single-mount ``mv``
    renames through the backend op bound to the accessor rather than
    through the dispatcher, so the re-anchoring the dispatcher does for
    every other caller has to be repeated here. Only a two-operand line
    qualifies, because a path-shaped word is classified into a PathSpec
    whether it filled an operand slot or a flag's value, and nothing
    here can tell ``mv a b dst`` from ``mv -t dst a b``.

    Args:
        namespace (Namespace): addressing authority holding the node table.
        dispatch (DispatchFn): op dispatcher used to stat the destination.
        items (list[str | PathSpec]): classified command parts.
        args (tuple[str, ...]): the line's words after the name, read
            for the two options that move the destination.
        cwd (str): session working directory, which the parser resolves
            path operands against.

    Returns:
        tuple: (possibly rewritten parts, node entry to drop after a
        successful backend move (the replaced destination), (src, dst)
        meta rename to apply after a successful backend move, early
        result when the mv completed as a pure namespace rename).
    """
    paths = [p for p in items if isinstance(p, PathSpec)]
    if len(paths) != 2:
        return items, None, None, None
    # ``-t`` makes every positional a source and the flag's value the
    # destination, which is the many-source shape above; ``-T`` names
    # the destination outright, so no basename is appended to it. Both
    # are read off the parsed line rather than guessed from the parts,
    # since a path-shaped flag value is classified into a PathSpec there
    # exactly as an operand is.
    fl = FlagView(parse_to_kwargs(parse_command(SPECS["mv"], list(args), cwd)),
                  spec=SPECS["mv"])
    if fl.raw("target_directory") is not None:
        return items, None, None, None
    src, dst = paths

    # Where the move lands: inside a directory destination (followed, so
    # node-meta keys line up with the followed paths stat merges on), else
    # the destination itself, replaced like rename(2).
    followed = namespace.follow(dst.virtual)
    stat = await stat_or_none(dispatch, PathSpec.from_str_path(followed))
    into_dir = (not fl.as_bool("no_target_directory") and stat is not None
                and stat.type == FileType.DIRECTORY)
    if into_dir:
        target_dst = (followed.rstrip("/") + "/" +
                      posixpath.basename(src.virtual))
    else:
        target_dst = dst.virtual

    if namespace.is_link(src.virtual):
        if src.raw_path.endswith("/"):
            return items, None, None, await _slashed_link_refusal(
                namespace, dispatch, src, dst, stat)
        # The move is a node-table rename, which the door answers: a
        # link has no backend entry for the generic mv to move. Reaching
        # the table directly from here would skip the admission gates
        # every other mv passes, so the dispatch is the point.
        try:
            await dispatch("rename",
                           src,
                           dst=PathSpec.from_str_path(target_dst))
        except ReadOnlyError as exc:
            # Voiced as the same refusal on a backend file is: the mount
            # voice when the source's own turf is what refused (the case
            # `Mount.execute_cmd` answers, since the command runs on the
            # source mount), GNU's per-operand line when it was the
            # destination -- which is what a cross-mount `mv f /ro/f`
            # already answers for a regular file.
            blame = exc.filename or src.virtual
            if blame == src.virtual:
                return items, None, None, fail(
                    "mv", read_only_error("mv", namespace, src))
            return items, None, None, fail(
                "mv", f"mv: cannot move '{src.raw_path}' to "
                f"'{dst.raw_path}': {fs_strerror(exc)}\n")
        except PermissionError as exc:
            # A policy deny, which GNU voices per operand and which the
            # backend mv path voices the same way.
            return items, None, None, fail(
                "mv", f"mv: cannot move '{src.raw_path}' to "
                f"'{dst.raw_path}': {fs_strerror(exc)}\n")
        return items, None, None, ok("mv")

    # Unconditional: a directory source carries a whole subtree of node
    # entries that no exact-path lookup at the source can see, and a
    # symlink below it is destroyed rather than merely forgotten when
    # they are left behind. Both halves are no-ops when the table holds
    # nothing there.
    post_rename = (src.virtual, target_dst)

    rewritten = items
    if into_dir and namespace.is_link(dst.virtual):
        rewritten = follow_paths(namespace, items)
    return rewritten, target_dst, post_rename, None
