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

from mirage.policy import PolicyDenied
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import format_fs_error, fs_strerror
from mirage.utils.path import CycleError
from mirage.workspace.mount.namespace import Namespace

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
            dt = dt.replace(second=int(seconds) if seconds else 0,
                            tzinfo=timezone.utc)
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


def permission_error(cmd: str, action: str, path: PathSpec,
                     exc: PermissionError) -> str:
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
        return format_fs_error(cmd, exc, [path]).decode()
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
    await dispatch("setattr",
                   path,
                   mode=mode,
                   uid=uid,
                   gid=gid,
                   atime=atime,
                   mtime=mtime)


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
        await dispatch("setattr",
                       path,
                       uid=uid,
                       gid=gid,
                       mtime=mtime,
                       nofollow=True)
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
        action (str): GNU verb in the message ("access", "touch").
        target (PathSpec): the operand as typed.
        errors (list[str]): per-operand error accumulator.
    """
    try:
        virtual = namespace.follow(target.virtual)
    except CycleError:
        errors.append(f"{cmd}: cannot {action} '{target.raw_path}': "
                      f"Too many levels of symbolic links\n")
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
    resolved = follow_operand(namespace, cmd, "access", target, errors)
    if resolved is None:
        return None
    try:
        stat, _ = await dispatch("stat", resolved)
    except (FileNotFoundError, NotADirectoryError) as exc:
        errors.append(f"{cmd}: cannot access '{target.raw_path}': "
                      f"{fs_strerror(exc)}\n")
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
    """A subtree as ``(path, stat)`` pairs, parents before children.

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
    entries = [(root, root_stat)]
    queue = [root] if root_stat.type == FileType.DIRECTORY else []
    while queue:
        directory = queue.pop(0)
        children, _ = await dispatch("readdir", directory)
        for child_virtual in children:
            if namespace.is_link(child_virtual):
                continue
            child = PathSpec.from_str_path(child_virtual)
            child_stat, _ = await dispatch("stat", child)
            entries.append((child, child_stat))
            if child_stat.type == FileType.DIRECTORY:
                queue.append(child)
    return entries


async def walk_owned(
    namespace: Namespace,
    dispatch: DispatchFn,
    root: PathSpec,
    root_stat: FileStat,
) -> tuple[list[PathSpec], list[str]]:
    """A subtree split into backend paths and namespace link nodes.

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
    return [path for path, _stat in walked], links
