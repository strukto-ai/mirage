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

import re
from datetime import datetime, timezone
from functools import partial

from mirage.commands.builtin.utils.identity import (
    Identity,
    group_name,
    owner_name,
)
from mirage.commands.builtin.utils.paths import dispatch_stat, dot_refusal
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.fs import fs_strerror, walk_refusal
from mirage.errors.render import format_fs_error
from mirage.policy import PolicyDenied
from mirage.runtime.types import DispatchFn
from mirage.shell.bytes import decode_text, encode_text
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.path import CycleError
from mirage.utils.quote import shell_quote_always
from mirage.workspace.executor.builtins.shared import expand_operands, result
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState

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
            raw = f"{datetime.now(timezone.utc).year:04d}{raw}"
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
    return datetime.now(timezone.utc).isoformat()


def permission_error(
    cmd: str, action: str, path: PathSpec, exc: PermissionError
) -> str:
    """Render a metadata-write PermissionError.

    A read-only region renders GNU's per-operand line, ``<cmd>: <action>
    '<path>': Read-only file system``, the voice every other write
    refusal uses; an admission-policy deny at the op door renders
    ``<cmd>: <path>: Permission denied``.

    Args:
        cmd (str): command name.
        action (str): GNU's phrase for the refused write (``cannot
            touch``, ``changing permissions of``).
        path (PathSpec): the refused path, as the line names it.
        exc (PermissionError): the raised refusal.
    """
    if isinstance(exc, PolicyDenied):
        return decode_text(format_fs_error(cmd, exc, [path]))
    return f"{cmd}: {action} '{path.raw_path}': {fs_strerror(exc)}\n"


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
    """Route one attribute write through the op door.

    The door applies what the backend can hold natively and stores the
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
    errors: list[str],
    *,
    uid: int | str | None = None,
    gid: int | str | None = None,
    mtime: str | None = None,
) -> None:
    """Setattr a link node itself (the ``-h`` family), collecting refusals.

    Dispatched with ``nofollow`` so the door writes the link entry's own
    attrs instead of the target's; a link has no backend inode, so the
    door stores them in the overlay.

    Args:
        dispatch (DispatchFn): op dispatcher.
        cmd (str): command name for the error message.
        path (PathSpec): the link's own path.
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
        errors.append(permission_error(cmd, ATTR_ACTIONS[cmd], path, exc))


def follow_operand(
    namespace: Namespace,
    cmd: str,
    action: str,
    target: PathSpec,
    errors: list[str],
) -> PathSpec | None:
    """Follow symlinks for one operand, collecting the ELOOP error.

    Args:
        namespace (Namespace): addressing authority.
        cmd (str): command name for the error message.
        action (str): GNU's words for the step that failed ("cannot
            access", "cannot touch", "setting times of").
        target (PathSpec): the operand as typed.
        errors (list[str]): per-operand error accumulator.
    """
    try:
        virtual = namespace.follow(target.virtual)
    except CycleError:
        errors.append(
            f"{cmd}: {action} '{target.raw_path}': "
            f"Too many levels of symbolic links\n"
        )
        return None
    return PathSpec.from_str_path(virtual)


async def resolve_operand(
    namespace: Namespace,
    dispatch: DispatchFn,
    cmd: str,
    target: PathSpec,
    errors: list[str],
) -> tuple[PathSpec, FileStat] | None:
    """Follow symlinks and stat one operand, collecting GNU errors.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (DispatchFn): op dispatcher.
        cmd (str): command name for the error messages.
        target (PathSpec): the operand as typed.
        errors (list[str]): per-operand error accumulator.
    """
    refusal = (
        walk_refusal(target)
        if target.walk_error is not None
        else await dot_refusal(
            partial(dispatch_stat, dispatch), target, namespace.follow
        )
    )
    if refusal is not None:
        errors.append(
            f"{cmd}: cannot access '{target.raw_path}': "
            f"{fs_strerror(refusal)}\n"
        )
        return None
    resolved = follow_operand(namespace, cmd, "cannot access", target, errors)
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
    errors: list[str],
    *,
    mode: int | None = None,
    uid: int | str | None = None,
    gid: int | str | None = None,
) -> None:
    """Setattr one operand, collecting the read-only refusal.

    Args:
        dispatch (DispatchFn): op dispatcher.
        cmd (str): command name for the error message.
        resolved (PathSpec): link-resolved target path.
        errors (list[str]): per-operand error accumulator.
        mode (int | None): permission bits (e.g. 0o644).
        uid (int | str | None): owner id or name.
        gid (int | str | None): group id or name.
    """
    try:
        await setattr_via(dispatch, resolved, mode=mode, uid=uid, gid=gid)
    except PermissionError as exc:
        errors.append(permission_error(cmd, ATTR_ACTIONS[cmd], resolved, exc))


async def walk_stats(
    namespace: Namespace,
    dispatch: DispatchFn,
    root: PathSpec,
    root_stat: FileStat,
) -> list[tuple[PathSpec, FileStat]]:
    """A subtree as ``(path, stat)`` pairs, in fts's pre-order.

    Each entry's stat is captured during the walk because chmod's
    symbolic clauses (``u+x``) build on the entry's own current mode.
    Symlinks are skipped by name: the door's readdir reports them (they
    are namespace structure), GNU chmod -R changes neither a traversed
    link nor its referent, and the skip must come before the stat
    because stat follows a link and would descend through a directory
    link.

    Args:
        namespace (Namespace): addressing authority (link table).
        dispatch (DispatchFn): op dispatcher.
        root (PathSpec): subtree root (already link-resolved).
        root_stat (FileStat): the root's stat, already read.
    """
    entries: list[tuple[PathSpec, FileStat]] = []
    # An explicit stack, so a deep tree costs no recursion: a directory's
    # children go on in reverse and come off in listing order.
    stack = [(root, root_stat)]
    while stack:
        path, stat = stack.pop()
        entries.append((path, stat))
        if stat.type != FileType.DIRECTORY:
            continue
        children, _ = await dispatch("readdir", path)
        found: list[tuple[PathSpec, FileStat]] = []
        for listed in children:
            # A folder-backed readdir spells a directory child with its
            # slash.
            child_virtual = listed.rstrip("/")
            if namespace.is_link(child_virtual):
                continue
            child = PathSpec.from_str_path(child_virtual)
            child_stat, _ = await dispatch("stat", child)
            found.append((child, child_stat))
        stack.extend(reversed(found))
    return entries


async def walk_owned(
    namespace: Namespace,
    dispatch: DispatchFn,
    root: PathSpec,
    root_stat: FileStat,
) -> tuple[list[tuple[PathSpec, FileStat]], list[str]]:
    """A subtree split into backend entries and namespace link nodes.

    chown and chgrp change a traversed symlink itself rather than its
    referent (POSIX gives ``-R`` an implicit ``-P``), and a link is
    namespace state that no readdir can report, so the link nodes are
    folded back in from the node table.

    Args:
        namespace (Namespace): addressing authority (link table).
        dispatch (DispatchFn): op dispatcher.
        root (PathSpec): subtree root.
        root_stat (FileStat): the root's stat, already read.
    """
    walked = await walk_stats(namespace, dispatch, root, root_stat)
    links = [path for path, _stat in namespace.link_stats_below(root.virtual)]
    return walked, links


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


def follows_links(cmd: str, fl: FlagView) -> tuple[bool, Result | None]:
    """Whether chown or chgrp changes a link's referent, or GNU's refusal.

    The last of -h and --dereference wins; -R implies -h, and refuses an
    explicit --dereference, which needs the -H or -L walk mirage does not
    offer.

    Args:
        cmd (str): ``chown`` or ``chgrp``.
        fl (FlagView): the line's flags.
    """
    order = fl.typed_order("no_dereference", "dereference")
    last = order[-1] if order else None
    if not fl.as_bool("recursive"):
        return last != "no_dereference", None
    if last == "dereference":
        message = f"{cmd}: -R --dereference requires either -H or -L\n"
        return False, result(cmd, exit_code=1, stderr=message)
    return False, None


def owner_spec(user: str | None, group: str | None) -> str | None:
    """``USER:GROUP``, or the one of them given (GNU's user_group_str).

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
    """chown and chgrp's report for one file (GNU 9.7's describe_change).

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
) -> Result:
    """Set the owner and group of every operand, the way chown and chgrp
    do: -R walks under an implicit -P, -h changes a link itself, -v and
    -c report, -f drops the per-file errors.

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
    """
    follow, refused = follows_links(cmd, fl)
    if refused is not None:
        return refused
    report = verbosity(fl)
    identity = Identity(user=namespace.user, profile=session.profile)
    user = None if uid is None else str(uid)
    group = None if gid is None else str(gid)
    errors: list[str] = []
    out: list[str] = []

    def describe(name: str, stat: FileStat | None, failed: bool) -> None:
        old = None
        same = False
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
        await apply_link_attrs(dispatch, cmd, link, errors, uid=uid, gid=gid)
        describe(name, stat, len(errors) > before)

    for target in await expand_operands(namespace, operands):
        typed = target.raw_path or target.virtual
        if not follow and namespace.is_link(target.virtual):
            await own_link(target, typed)
            continue
        found = await resolve_operand(namespace, dispatch, cmd, target, errors)
        if found is None:
            describe(typed, None, True)
            continue
        resolved, stat = found
        if fl.as_bool("recursive"):
            walked, links = await walk_owned(
                namespace, dispatch, resolved, stat
            )
        else:
            walked, links = [(resolved, stat)], []
        for path, path_stat in walked:
            before = len(errors)
            await apply_attrs(dispatch, cmd, path, errors, uid=uid, gid=gid)
            name = walked_name(typed, resolved, path)
            describe(name, path_stat, len(errors) > before)
        for link in links:
            link_spec = PathSpec.from_str_path(link)
            await own_link(link_spec, walked_name(typed, resolved, link_spec))
    quiet = fl.as_bool("silent") or fl.as_bool("quiet")
    return result(
        cmd,
        out=encode_text("".join(out)) or None,
        exit_code=1 if errors else 0,
        stderr=None if quiet else "".join(errors),
    )
