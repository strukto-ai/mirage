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

import functools
import logging
import re
from datetime import datetime, timezone
from functools import partial
from typing import cast

from mirage.commands.builtin.generic_bind.files import (
    dispatched_call,
    dispatched_read_tree,
)
from mirage.commands.builtin.utils.identity import (
    Identity,
    group_name,
    owner_name,
)
from mirage.commands.builtin.utils.paths import dispatch_stat, dot_refusal
from mirage.commands.builtin.utils.tree import before_full_walk, tree_walk
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.fs import fs_strerror, walk_refusal
from mirage.errors.render import fs_error_line
from mirage.errors.types import DotWalkLoop
from mirage.policy import PolicyDenied
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import encode_text
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.clock import system_date
from mirage.utils.path import CycleError, ancestors
from mirage.utils.quote import shell_quote_always
from mirage.view.types import MountView, NamespaceLinks
from mirage.workspace.dispatcher.reader import NamespaceReader
from mirage.workspace.executor.builtins.shared import expand_operands, result
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState

logger = logging.getLogger(__name__)

# GNU's phrase for a refused attribute write, per command
# (`chmod: changing permissions of 'f': Read-only file system`); `touch`
# reaches it only for `-h`, which never creates.
ATTR_ACTIONS = {
    "chmod": "changing permissions of",
    "chown": "changing ownership of",
    "chgrp": "changing group of",
    "touch": "setting times of",
}

_TOUCH_STAMP_RE = re.compile(r"(\d{8}|\d{10}|\d{12})(\.\d{2})?")

_TOUCH_STAMP_FMT = {10: "%y%m%d%H%M", 12: "%Y%m%d%H%M"}


def parse_owner(text: str) -> tuple[int | str | None, int | str | None]:
    """Parse a chown OWNER[:GROUP] argument.

    Numeric ids become ints; names are kept as strings (mirage has no
    user database; ownership is stored, not enforced).

    Args:
        text (str): the OWNER[:GROUP] operand as typed.

    Returns:
        tuple: (uid, gid); each is None when its part is absent.

    Example::

        parse_owner("1000:staff")  -> (1000, "staff")
        parse_owner("alice")       -> ("alice", None)
        parse_owner(":dev")        -> (None, "dev")
    """
    owner, sep, group = text.partition(":")
    uid = (int(owner) if owner.isdigit() else owner) if owner else None
    gid = (int(group) if group.isdigit() else group) if sep and group else None
    return uid, gid


def parse_group(text: str) -> int | str | None:
    """Parse a chgrp GROUP argument.

    Numeric ids become ints; names are kept as strings (mirage has no
    group database; ownership is stored, not enforced). Empty is invalid.

    Args:
        text (str): the GROUP operand as typed.

    Returns:
        int | str | None: the gid, or None when the text is empty.

    Example::

        parse_group("staff")  -> "staff"
        parse_group("20")     -> 20
    """
    if not text:
        return None
    return int(text) if text.isdigit() else text


def parse_touch_stamp(t: str | None, d: str | None) -> str | None:
    """Resolve touch -t/-d into an ISO timestamp.

    The -t stamp is the POSIX ``[[CC]YY]MMDDhhmm[.ss]`` form; strptime
    does the field validation, and its ``%y`` rule (00-68 is 2000s,
    69-99 is 1900s) is exactly the POSIX century inference.

    Args:
        t (str | None): POSIX ``[[CC]YY]MMDDhhmm[.ss]`` stamp.
        d (str | None): date string (ISO 8601 or ``YYYY-MM-DD hh:mm:ss``).

    Returns:
        str | None: ISO timestamp, or None when neither flag is given.

    Raises:
        ValueError: when the stamp does not parse.

    Example::

        parse_touch_stamp("202601021530", None) -> "2026-01-02T15:30:00+00:00"
        parse_touch_stamp(None, "2026-01-02")   -> "2026-01-02T00:00:00+00:00"
    """
    if t is not None:
        if _TOUCH_STAMP_RE.fullmatch(t) is None:
            raise ValueError(t)
        raw, _, seconds = t.partition(".")
        if len(raw) == 8:
            raw = f"{system_date().year:04d}{raw}"
        try:
            dt = datetime.strptime(raw, _TOUCH_STAMP_FMT[len(raw)])
            dt = dt.replace(
                second=int(seconds) if seconds else 0, tzinfo=timezone.utc
            )
        except ValueError:
            raise ValueError(t) from None
        return dt.isoformat()
    if d is not None:
        dt = datetime.fromisoformat(d.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat()
    return None


def now_iso() -> str:
    return system_date().isoformat()


def permission_error(
    cmd: str, action: str, name: str, exc: PermissionError
) -> str:
    """Render a metadata-write PermissionError.

    A read-only region renders GNU's per-operand line, ``<cmd>: <action>
    '<name>': Read-only file system``, the voice every other write
    refusal uses; an admission-policy deny at the dispatcher renders
    the line a refused operand gets, ``<cmd>: <name>: Permission
    denied`` (touch's ``cannot touch '<name>'``). Either names the file
    the way the line does, never the target a link resolved to: the
    dispatcher's error carries the resolved path.

    Args:
        cmd (str): command name.
        action (str): GNU's phrase for the refused write (``cannot
            touch``, ``changing permissions of``).
        name (str): the refused file, as the line names it.
        exc (PermissionError): the raised refusal.
    """
    if isinstance(exc, PolicyDenied):
        return fs_error_line(cmd, name, exc)
    return f"{cmd}: {action} '{name}': {fs_strerror(exc)}\n"


def unread_error(cmd: str, name: str, exc: PermissionError) -> str:
    """The line for a walked directory whose listing was refused: fts's
    unreadable directory, which chmod, chown and chgrp report after the
    directory's own change and do not descend.

    Args:
        cmd (str): command name.
        name (str): the directory, as the line names it.
        exc (PermissionError): the refused readdir.
    """
    return (
        f"{cmd}: cannot read directory {shell_quote_always(name)}: "
        f"{fs_strerror(exc)}\n"
    )


async def setattr_via(
    dispatch: DispatchFn,
    path: PathSpec,
    *,
    mode: int | None = None,
    uid: int | str | None = None,
    gid: int | str | None = None,
    atime: str | None = None,
    mtime: str | None = None,
) -> None:
    """Route one attribute write through the dispatcher.

    The dispatcher applies what the backend can hold natively and stores the
    residual in the namespace overlay (dropping overlay fields the
    backend applied, so a stale overlay never shadows the fresh backend
    value); a mount with no setattr op overlays everything. Kept as a
    seam so every metadata builtin shares one call shape.

    Args:
        dispatch (DispatchFn): op dispatcher.
        path (PathSpec): target path (already link-resolved).
        mode (int | None): permission bits (e.g. 0o644).
        uid (int | str | None): owner id or name.
        gid (int | str | None): group id or name.
        atime (str | None): ISO access time.
        mtime (str | None): ISO modification time.
    """
    await dispatch(
        "setattr", path, mode=mode, uid=uid, gid=gid, atime=atime, mtime=mtime
    )


async def apply_link_attrs(
    dispatch: DispatchFn,
    cmd: str,
    path: PathSpec,
    name: str,
    errors: list[str],
    *,
    uid: int | str | None = None,
    gid: int | str | None = None,
    mtime: str | None = None,
) -> None:
    """Setattr a link node itself (the ``-h`` family), collecting refusals.

    Dispatched with ``nofollow`` so the dispatcher writes the link entry's own
    attrs instead of the target's; a link has no backend inode, so the
    dispatcher stores them in the overlay.

    Args:
        dispatch (DispatchFn): op dispatcher.
        cmd (str): command name for the error message.
        path (PathSpec): the link's own path.
        name (str): the link, as the line names it.
        errors (list[str]): per-operand error accumulator.
        uid (int | str | None): owner id or name.
        gid (int | str | None): group id or name.
        mtime (str | None): ISO modification time.
    """
    try:
        await dispatch(
            "setattr", path, uid=uid, gid=gid, mtime=mtime, nofollow=True
        )
    except PermissionError as exc:
        errors.append(permission_error(cmd, ATTR_ACTIONS[cmd], name, exc))


def follow_operand(
    links: NamespaceLinks,
    cmd: str,
    action: str,
    target: PathSpec,
    errors: list[str],
) -> PathSpec | None:
    """Follow symlinks for one operand, collecting the ELOOP error.

    Args:
        links (NamespaceLinks): the session's link table
            (``Namespace.session_links``).
        cmd (str): command name for the error message.
        action (str): GNU's words for the step that failed ("cannot
            access", "cannot touch", "setting times of").
        target (PathSpec): the operand as typed.
        errors (list[str]): per-operand error accumulator.
    """
    try:
        virtual = links.follow(target.virtual)
    except CycleError:
        errors.append(
            f"{cmd}: {action} '{target.raw_path}': "
            f"Too many levels of symbolic links\n"
        )
        return None
    return PathSpec.from_str_path(virtual)


async def resolve_operand(
    links: NamespaceLinks,
    dispatch: DispatchFn,
    cmd: str,
    target: PathSpec,
    errors: list[str],
) -> tuple[PathSpec, FileStat] | None:
    """Follow symlinks and stat one operand, collecting GNU errors.

    Args:
        links (NamespaceLinks): the session's link table
            (``Namespace.session_links``).
        dispatch (DispatchFn): op dispatcher.
        cmd (str): command name for the error messages.
        target (PathSpec): the operand as typed.
        errors (list[str]): per-operand error accumulator.
    """
    refusal = (
        walk_refusal(target)
        if target.walk_error is not None
        else await dot_refusal(
            partial(dispatch_stat, dispatch), target, links.follow
        )
    )
    if refusal is not None:
        errors.append(
            f"{cmd}: cannot access '{target.raw_path}': "
            f"{fs_strerror(refusal)}\n"
        )
        return None
    resolved = follow_operand(links, cmd, "cannot access", target, errors)
    if resolved is None:
        return None
    try:
        stat, _ = await dispatch("stat", resolved)
    except (FileNotFoundError, NotADirectoryError) as exc:
        errors.append(
            f"{cmd}: cannot access '{target.raw_path}': {fs_strerror(exc)}\n"
        )
        return None
    return resolved, stat


async def apply_attrs(
    dispatch: DispatchFn,
    cmd: str,
    resolved: PathSpec,
    name: str,
    errors: list[str],
    *,
    mode: int | None = None,
    uid: int | str | None = None,
    gid: int | str | None = None,
) -> None:
    """Setattr one file, collecting its refusal: a read-only mount, or a
    rule's or policy's deny, is that file's error and the command goes
    on with the rest, as GNU does.

    Args:
        dispatch (DispatchFn): op dispatcher.
        cmd (str): command name for the error message.
        resolved (PathSpec): link-resolved target path.
        name (str): the file, as the line names it.
        errors (list[str]): per-operand error accumulator.
        mode (int | None): permission bits (e.g. 0o644).
        uid (int | str | None): owner id or name.
        gid (int | str | None): group id or name.
    """
    try:
        await setattr_via(dispatch, resolved, mode=mode, uid=uid, gid=gid)
    except PermissionError as exc:
        errors.append(permission_error(cmd, ATTR_ACTIONS[cmd], name, exc))


# One entry of a walked subtree: its path, its stat, and the refusal it
# met: a directory's listing's, or under -L a link's that could not be
# followed (None for an entry that read).
WalkEntry = tuple[PathSpec, FileStat, OSError | None]


async def before_recursive_change(
    mounts: MountView,
    dispatch: DispatchFn,
    root: PathSpec,
    cmd: str,
) -> None:
    """Ask the mount of ``root``, and every mount below it, before ``-R``
    changes anything, as for rm -r: a change cut short would leave a
    tree that looks done. The walk crosses into each mount below, so
    each one may refuse. A folder the session is refused is not asked:
    the walk does not enter it either, and reports it itself.

    Args:
        mounts (MountView): the mount boundaries (``mounts(False)`` of
            the session's link table).
        dispatch (DispatchFn): op dispatcher.
        root (PathSpec): subtree root (already link-resolved).
        cmd (str): command name for the refusal.

    Raises:
        UsageError: a mount refused the walk.
    """
    below = mounts.visible_descendants(root.virtual)
    for virtual in [root.virtual, *below]:
        try:
            await before_full_walk(
                dispatch, PathSpec.from_str_path(virtual), cmd
            )
        except PermissionError as exc:
            logger.debug("walk guard skipped at %s: %s", virtual, exc)


async def walk_stats(
    links: NamespaceReader,
    dispatch: DispatchFn,
    root: PathSpec,
    root_stat: FileStat,
    follow: bool = False,
    preserve_root: bool = False,
) -> list[WalkEntry]:
    """A subtree as ``(path, stat, unread)`` triples, in fts's pre-order.

    Each entry's stat is captured during the walk because chmod's
    symbolic clauses (``u+x``) build on the entry's own current mode,
    read off the mount's ``read_tree`` where one answers for the
    subtree (``tree_walk``).
    A traversed link is an entry of its own, with its own stat, and is
    neither changed nor descended: GNU chmod -R changes neither a
    traversed link nor its referent, and chown -R changes the link
    itself. Under ``-L`` (``follow``) the link is followed instead: its
    referent is the entry, named by the link, and a directory it names
    is walked unless the branch already holds it, as fts refuses a
    cycle. A link ``-L`` cannot follow (dangling, or a loop) is an
    entry of its own, with its own stat and the error as its
    ``unread``, and so is one that leads to ``/`` under
    ``--preserve-root``, with no error, for the caller to refuse.
    ``unread`` is the refusal a directory's listing met (a rule
    that denies the directory lets its stat through): fts's unreadable
    directory, which the caller reports after the directory's own
    change, and whose subtree is not walked.

    Args:
        links (NamespaceReader): the session's link table
            (``Namespace.session_links``).
        dispatch (DispatchFn): op dispatcher.
        root (PathSpec): subtree root (already link-resolved).
        root_stat (FileStat): the root's stat, already read.
        follow (bool): ``-L``, which follows every traversed link.
        preserve_root (bool): ``--preserve-root``, which follows no link
            to ``/``.
    """
    plain_readdir = functools.partial(dispatched_call, dispatch, "readdir")
    plain_stat = functools.partial(dispatched_call, dispatch, "stat")
    readdir, stat_of = (
        (plain_readdir, plain_stat)
        if follow
        else tree_walk(
            dispatched_read_tree(dispatch, links.mounts(False), None, True),
            plain_readdir,
            plain_stat,
        )
    )
    entries: list[WalkEntry] = []
    # An explicit stack, so a deep tree costs no recursion: a directory's
    # children go on in reverse and come off in listing order, after the
    # mark that leaves it. ``branch`` holds the directories entered and not
    # yet left, which ``-L`` will not enter again.
    branch: set[str] = set()
    stack: list[tuple[PathSpec, FileStat, str, bool, OSError | None]] = [
        (root, root_stat, root.virtual, False, None)
    ]
    while stack:
        path, stat, real, leaving, refused = stack.pop()
        if leaving:
            branch.discard(real)
            continue
        if refused is not None or stat.type != FileType.DIRECTORY:
            entries.append((path, stat, refused))
            continue
        try:
            children = await readdir(path)
        except PermissionError as exc:
            entries.append((path, stat, exc))
            continue
        entries.append((path, stat, None))
        branch.add(real)
        stack.append((path, stat, real, True, None))
        found: list[tuple[PathSpec, FileStat, str, bool, OSError | None]] = []
        for listed in children:
            # A folder-backed readdir spells a directory child with its
            # slash; a child is named below the path walked, which under
            # -L may be a link's name.
            name = listed.rstrip("/").rsplit("/", 1)[-1]
            child = PathSpec.from_str_path(
                f"{path.virtual.rstrip('/')}/{name}"
            )
            if not links.is_link(listed.rstrip("/")) and not (
                follow and links.is_link(child.virtual)
            ):
                real = links.follow(child.virtual) if follow else child.virtual
                found.append((child, await stat_of(child), real, False, None))
                continue
            if not follow:
                own, _ = await dispatch("stat", child, nofollow=True)
                found.append((child, own, child.virtual, False, None))
                continue
            try:
                real = links.follow(child.virtual)
                target = await stat_of(child)
            except (
                CycleError,
                DotWalkLoop,
                FileNotFoundError,
                NotADirectoryError,
            ) as exc:
                own, _ = await dispatch("stat", child, nofollow=True)
                found.append((child, own, child.virtual, False, exc))
                continue
            if preserve_root and not real.strip("/"):
                own, _ = await dispatch("stat", child, nofollow=True)
                found.append((child, own, child.virtual, False, None))
            elif real not in branch:
                found.append((child, target, real, False, None))
        stack.extend(reversed(found))
    return entries


async def walk_owned(
    links: NamespaceReader,
    dispatch: DispatchFn,
    root: PathSpec,
    root_stat: FileStat,
) -> tuple[list[WalkEntry], list[str]]:
    """A subtree split into backend entries and namespace link nodes.

    chown and chgrp change a traversed symlink itself rather than its
    referent (POSIX gives ``-R`` an implicit ``-P``), and a link is
    namespace state that no readdir can report, so the link nodes are
    folded back in from the node table, but for those under a directory
    whose listing was refused, which the walk does not descend.

    Args:
        links (NamespaceReader): the session's link table
            (``Namespace.session_links``).
        dispatch (DispatchFn): op dispatcher.
        root (PathSpec): subtree root.
        root_stat (FileStat): the root's stat, already read.
    """
    walked = [
        entry
        for entry in await walk_stats(links, dispatch, root, root_stat)
        if entry[1].type != FileType.SYMLINK
    ]
    unread = {path.virtual for path, _stat, exc in walked if exc is not None}
    # The root as well, which ``ancestors`` leaves out: a refused listing
    # of ``/`` keeps every link below it unwalked.
    owned = [
        path
        for path, _stat in links.link_stats_below(root.virtual)
        if unread.isdisjoint(["/", *ancestors(path)])
    ]
    return walked, owned


def unfollowed_error(cmd: str, name: str, exc: OSError) -> str:
    """The report for a link ``-L`` could not follow, worded as GNU
    words it: a loop cannot be accessed, and a dangling link is one chmod
    cannot operate on and chown and chgrp cannot dereference.

    Args:
        cmd (str): the command.
        name (str): the link, as the line names it.
        exc (OSError): what following it raised.
    """
    shown = shell_quote_always(name)
    if isinstance(exc, (CycleError, DotWalkLoop)):
        return f"{cmd}: cannot access {shown}: {fs_strerror(exc)}\n"
    if cmd == "chmod":
        return f"chmod: cannot operate on dangling symlink {shown}\n"
    return f"{cmd}: cannot dereference {shown}: {fs_strerror(exc)}\n"


def preserves_root(fl: FlagView) -> bool:
    """Whether ``--preserve-root`` is on: the last of it and
    ``--no-preserve-root`` wins, and neither is off.

    Args:
        fl (FlagView): the line's flags.
    """
    order = fl.typed_order("preserve_root", "no_preserve_root")
    return order[-1:] == ["preserve_root"]


def verbosity(fl: FlagView) -> str | None:
    """Which files chmod, chown and chgrp report: ``verbose`` (every
    one), ``changes`` (the changed ones) or None. The last of -c and -v
    wins.

    Args:
        fl (FlagView): the line's flags.
    """
    order = fl.typed_order("changes", "verbose")
    return order[-1] if order else None


def walked_name(typed: str, root: PathSpec, path: PathSpec) -> str:
    """An entry of a walked operand as GNU names it: the operand as
    typed, then the entry's path below it.

    Args:
        typed (str): the operand as typed.
        root (PathSpec): the operand, link-resolved.
        path (PathSpec): the entry.
    """
    below = path.virtual[len(root.virtual.rstrip("/")) :]
    if typed.endswith("/"):
        below = below.lstrip("/")
    return typed + below


def traversal(fl: FlagView, default: str) -> str:
    """How ``-R`` treats links, the last of ``-H`` (follow an operand),
    ``-L`` (follow every one) and ``-P`` (follow none).

    Args:
        fl (FlagView): the line's flags.
        default (str): the walk with none of them: ``H`` for chmod, ``P``
            for chown and chgrp.
    """
    order = fl.typed_order("H", "L", "P")
    return order[-1] if order else default


def follows_links(cmd: str, fl: FlagView) -> tuple[bool, Result | None]:
    """Whether chown or chgrp changes an operand link's referent, or
    GNU's refusal.

    The last of -h and --dereference wins. -R walks under -P unless -H
    or -L says otherwise: -P changes an operand link itself and refuses
    an explicit --dereference, and -H and -L follow it.

    Args:
        cmd (str): ``chown`` or ``chgrp``.
        fl (FlagView): the line's flags.
    """
    order = fl.typed_order("no_dereference", "dereference")
    last = order[-1] if order else None
    if not fl.as_bool("recursive"):
        return last != "no_dereference", None
    if traversal(fl, "P") != "P":
        return True, None
    if last == "dereference":
        message = f"{cmd}: -R --dereference requires either -H or -L\n"
        return False, result(cmd, exit_code=1, stderr=message)
    return False, None


def root_refusal(
    cmd: str, fl: FlagView, typed: str, resolved: PathSpec
) -> str | None:
    """``--preserve-root``'s refusal of a ``-R`` walk from ``/``, or None.

    The last of --preserve-root and --no-preserve-root wins, and none
    walks.

    Args:
        cmd (str): the command.
        fl (FlagView): the line's flags.
        typed (str): the operand as typed.
        resolved (PathSpec): the operand, link-resolved.
    """
    if not preserves_root(fl) or resolved.virtual.strip("/"):
        return None
    named = shell_quote_always(typed)
    same = "" if typed == "/" else " (same as '/')"
    return (
        f"{cmd}: it is dangerous to operate recursively on {named}{same}\n"
        f"{cmd}: use --no-preserve-root to override this failsafe\n"
    )


async def reference_stat(
    links: NamespaceLinks, dispatch: DispatchFn, cmd: str, reference: PathSpec
) -> FileStat | Result:
    """The stat ``--reference`` copies from, link-followed, or GNU's
    refusal, exit 1.

    Args:
        links (NamespaceLinks): the session's link table.
        dispatch (DispatchFn): op dispatcher.
        cmd (str): the command.
        reference (PathSpec): the file as typed.
    """
    try:
        stat, _ = await dispatch(
            "stat", PathSpec.from_str_path(links.follow(reference.virtual))
        )
    except (CycleError, OSError) as exc:
        named = shell_quote_always(reference.raw_path or reference.virtual)
        line = (
            f"{cmd}: failed to get attributes of {named}: {fs_strerror(exc)}\n"
        )
        return result(cmd, exit_code=1, stderr=line)
    return cast(FileStat, stat)


def reference_operands(
    parsed_texts: list[str], paths: list[PathSpec], cwd: str
) -> list[PathSpec]:
    """The files a ``--reference`` line changes: the word a mode or an
    owner would take is a file too.

    Args:
        parsed_texts (list[str]): the line's text operands.
        paths (list[PathSpec]): its path operands.
        cwd (str): the session working directory.
    """
    return [
        *(PathSpec.from_str_path(text, cwd=cwd) for text in parsed_texts),
        *paths,
    ]


def owner_spec(user: str | None, group: str | None) -> str | None:
    """``USER:GROUP``, or the one of them given, as GNU's -v names it.

    Args:
        user (str | None): the owner, None when absent.
        group (str | None): the group, None when absent.
    """
    if user is None:
        return group
    return user if group is None else f"{user}:{group}"


def owner_line(
    name: str,
    status: str,
    old: tuple[str, str] | None,
    user: str | None,
    group: str | None,
) -> str:
    """chown and chgrp's report for one file, as GNU 9.7 prints it.

    Args:
        name (str): the file as GNU names it.
        status (str): ``changed``, ``retained`` or ``failed``.
        old (tuple[str, str] | None): the owner and group before, None
            when the file could not be read.
        user (str | None): the owner asked for, None to keep it.
        group (str | None): the group asked for, None to keep it.
    """
    new = owner_spec(user, group)
    was = None
    if old is not None:
        was = owner_spec(
            old[0] if user is not None else None,
            old[1] if group is not None else None,
        )
    what = "ownership" if user is not None else "group"
    shown = shell_quote_always(name)
    if status == "changed":
        return f"changed {what} of {shown} from {was} to {new}\n"
    if status == "retained":
        return f"{what} of {shown} retained as {new}\n"
    if was is None:
        return f"failed to change {what} of {shown} to {new}\n"
    return f"failed to change {what} of {shown} from {was} to {new}\n"


async def change_owner(
    namespace: Namespace,
    dispatch: DispatchFn,
    session: SessionState,
    cmd: str,
    fl: FlagView,
    operands: list[PathSpec],
    uid: int | str | None,
    gid: int | str | None,
    current: tuple[int | str | None, int | str | None] | None = None,
) -> Result:
    """Set the owner and group of every operand, the way chown and chgrp
    do: -R walks under -P unless -H or -L follows links, -h changes a
    link itself, -v and -c report, -f drops the per-file errors, and a
    file whose owner or group is not ``current`` (``--from``) is kept.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): the session, for the identity that names
            an unowned file.
        cmd (str): ``chown`` or ``chgrp``.
        fl (FlagView): the line's flags.
        operands (list[PathSpec]): the file operands.
        uid (int | str | None): the owner asked for, None to keep it.
        gid (int | str | None): the group asked for, None to keep it.
        current (tuple[int | str | None, int | str | None] | None): the
            owner and group a file must have to change, each None for
            any; None for every file.
    """
    follow, refused = follows_links(cmd, fl)
    if refused is not None:
        return refused
    report = verbosity(fl)
    identity = Identity(profile=session.profile)
    user = None if uid is None else str(uid)
    group = None if gid is None else str(gid)
    errors: list[str] = []
    out: list[str] = []

    def matches(stat: FileStat | None) -> bool:
        if current is None or stat is None:
            return True
        return (current[0] is None or str(current[0]) == str(stat.uid)) and (
            current[1] is None or str(current[1]) == str(stat.gid)
        )

    def describe(name: str, stat: FileStat | None, failed: bool) -> None:
        old = None
        same = False
        if stat is not None and not matches(stat):
            if report == "verbose":
                out.append(owner_line(name, "retained", None, user, group))
            return
        if stat is not None:
            old = (
                owner_name(stat.uid, identity),
                group_name(stat.gid, identity),
            )
            same = (uid is None or uid == stat.uid) and (
                gid is None or gid == stat.gid
            )
        status = "failed" if failed else "retained" if same else "changed"
        if report == "verbose" or (
            report == "changes" and status == "changed"
        ):
            out.append(owner_line(name, status, old, user, group))

    async def own_link(link: PathSpec, name: str) -> None:
        try:
            stat, _ = await dispatch("stat", link, nofollow=True)
        except (FileNotFoundError, NotADirectoryError):
            stat = None
        before = len(errors)
        if matches(stat):
            await apply_link_attrs(
                dispatch, cmd, link, name, errors, uid=uid, gid=gid
            )
        describe(name, stat, len(errors) > before)

    async def own_referent(link: PathSpec, name: str) -> None:
        try:
            stat, _ = await dispatch("stat", link)
        except (DotWalkLoop, FileNotFoundError, NotADirectoryError) as exc:
            shown = shell_quote_always(name)
            errors.append(
                f"{cmd}: cannot dereference {shown}: {fs_strerror(exc)}\n"
            )
            return
        before = len(errors)
        if matches(stat):
            await apply_attrs(
                dispatch, cmd, link, name, errors, uid=uid, gid=gid
            )
        describe(name, stat, len(errors) > before)

    # Under -H or -L a link the walk meets is changed through, unless -h
    # asks for the link itself; the walk goes on through it either way.
    order = fl.typed_order("no_dereference", "dereference")
    itself = order[-1:] == ["no_dereference"]
    through = traversal(fl, "P") != "P" and not itself
    recursive = fl.as_bool("recursive")
    links = namespace.session_links(session)
    for target in await expand_operands(namespace, dispatch, operands):
        typed = target.raw_path or target.virtual
        operand_link = links.is_link(target.virtual)
        if not follow and operand_link:
            await own_link(target, typed)
            continue
        found = await resolve_operand(links, dispatch, cmd, target, errors)
        if found is None:
            describe(typed, None, True)
            continue
        resolved, stat = found
        if recursive:
            refusal = root_refusal(cmd, fl, typed, resolved)
            if refusal is not None:
                errors.append(refusal)
                continue
            try:
                await before_recursive_change(
                    links.mounts(False), dispatch, resolved, cmd
                )
            except UsageError as exc:
                errors.append(f"{exc}\n")
                continue
            if traversal(fl, "P") == "L":
                walked = await walk_stats(
                    links,
                    dispatch,
                    resolved,
                    stat,
                    follow=True,
                    preserve_root=preserves_root(fl),
                )
                owned: list[str] = []
            else:
                walked, owned = await walk_owned(
                    links, dispatch, resolved, stat
                )
        else:
            walked, owned = [(resolved, stat, None)], []
        # -h under -H or -L changes the operand link, not what it names.
        skip = resolved.virtual if itself and operand_link else None
        if skip is not None:
            await own_link(target, typed)
        for path, path_stat, unread in walked:
            name = walked_name(typed, resolved, path)
            if path_stat.type == FileType.SYMLINK:
                if unread is None:
                    top = PathSpec.from_str_path("/")
                    errors.append(root_refusal(cmd, fl, name, top) or "")
                elif itself:
                    await own_link(path, name)
                else:
                    errors.append(unfollowed_error(cmd, name, unread))
                continue
            if path.virtual == skip:
                pass
            elif itself and links.is_link(path.virtual):
                await own_link(path, name)
            else:
                before = len(errors)
                if matches(path_stat):
                    await apply_attrs(
                        dispatch, cmd, path, name, errors, uid=uid, gid=gid
                    )
                describe(name, path_stat, len(errors) > before)
            # A directory whose listing was refused is reported however
            # its own change went, link or not.
            if isinstance(unread, PermissionError):
                errors.append(unread_error(cmd, name, unread))
        for link in owned:
            link_spec = PathSpec.from_str_path(link)
            name = walked_name(typed, resolved, link_spec)
            if through:
                await own_referent(link_spec, name)
            else:
                await own_link(link_spec, name)
    quiet = fl.as_bool("silent") or fl.as_bool("quiet")
    return result(
        cmd,
        out=encode_text("".join(out)) or None,
        exit_code=1 if errors else 0,
        stderr=None if quiet else "".join(errors),
    )
