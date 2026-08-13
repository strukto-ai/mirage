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
from collections.abc import AsyncIterator
from datetime import datetime, timezone

from mirage.io import IOResult
from mirage.policy import PolicyDenied
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, format_fs_error, fs_strerror
from mirage.utils.mode import DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, parse_chmod
from mirage.utils.path import CycleError, resolve_path
from mirage.workspace.executor.builtins.shared import (Result, expand_operands,
                                                       fail, finish,
                                                       operand_text,
                                                       split_value_flags)
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session

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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_only_error(cmd: str, namespace: Namespace, path: PathSpec) -> str:
    """Render the mirage read-only refusal for a metadata write.

    Args:
        cmd (str): command name.
        namespace (Namespace): addressing authority (mount lookup).
        path (PathSpec): the refused path.
    """
    prefix = namespace.mount_for(path.virtual).prefix
    return f"{cmd}: read-only mount at {prefix}\n"


def _permission_error(cmd: str, namespace: Namespace, path: PathSpec,
                      exc: PermissionError) -> str:
    """Render a metadata-write PermissionError.

    A mount-mode refusal keeps the mirage read-only wording; an
    admission-policy deny at the op door renders GNU's
    ``<cmd>: <path>: Permission denied`` instead of mislabeling the
    mount as read-only.

    Args:
        cmd (str): command name.
        namespace (Namespace): addressing authority (mount lookup).
        path (PathSpec): the refused path.
        exc (PermissionError): the raised refusal.
    """
    if not isinstance(exc, PolicyDenied):
        return _read_only_error(cmd, namespace, path)
    return format_fs_error(cmd, exc, [path]).decode()


async def _setattr_via(
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


async def _apply_link_attrs(
    namespace: Namespace,
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
        namespace (Namespace): addressing authority (error rendering).
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
        errors.append(_permission_error(cmd, namespace, path, exc))


def _follow_operand(
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


async def _resolve_operand(
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
    resolved = _follow_operand(namespace, cmd, "access", target, errors)
    if resolved is None:
        return None
    try:
        stat, _ = await dispatch("stat", resolved)
    except FileNotFoundError:
        errors.append(f"{cmd}: cannot access '{target.raw_path}': "
                      f"No such file or directory\n")
        return None
    return resolved, stat


async def _apply_attrs(
    namespace: Namespace,
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
        namespace (Namespace): addressing authority.
        dispatch (DispatchFn): op dispatcher.
        cmd (str): command name for the error message.
        resolved (PathSpec): link-resolved target path.
        errors (list[str]): per-operand error accumulator.
        mode (int | None): permission bits (e.g. 0o644).
        uid (int | str | None): owner id or name.
        gid (int | str | None): group id or name.
    """
    try:
        await _setattr_via(dispatch, resolved, mode=mode, uid=uid, gid=gid)
    except PermissionError as exc:
        errors.append(_permission_error(cmd, namespace, resolved, exc))


async def _walk_stats(
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


async def _walk_owned(
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
    walked = await _walk_stats(namespace, dispatch, root, root_stat)
    links = [path for path, _stat in namespace.link_stats_below(root.virtual)]
    return [path for path, _stat in walked], links


async def handle_chmod(
    namespace: Namespace,
    dispatch: DispatchFn,
    args: list[str | PathSpec],
) -> Result:
    """chmod MODE FILE...: set permission bits via setattr.

    Follows symlinks (GNU chmod always dereferences). Stored, not
    enforced: mount mode does real access control. ``-R`` walks the
    operand's subtree and applies the mode to every entry, skipping
    symlinks the way GNU does (a traversed link changes neither itself
    nor its referent); a command-line link to a directory is still
    followed and its target walked.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (DispatchFn): op dispatcher.
        args (list[str | PathSpec]): args after the command name.
    """
    flags, _values, operands, bad = split_value_flags(args, "Rvf", "")
    if bad is not None:
        return fail("chmod", f"chmod: invalid option -- '{bad}'\n", 2)
    if len(operands) < 2:
        return fail("chmod", "chmod: missing operand\n", 2)
    mode_text = operand_text(operands[0])
    if parse_chmod(mode_text, 0) is None:
        return fail("chmod", f"chmod: invalid mode: '{mode_text}'\n", 1)

    recursive = "R" in flags
    errors: list[str] = []
    for target in await expand_operands(namespace, operands[1:]):
        found = await _resolve_operand(namespace, dispatch, "chmod", target,
                                       errors)
        if found is None:
            continue
        resolved, stat = found
        if recursive:
            entries = await _walk_stats(namespace, dispatch, resolved, stat)
        else:
            entries = [(resolved, stat)]
        for path, path_stat in entries:
            # Backends without a mode default to what ls renders: 755 for
            # directories, 644 for files (symbolic clauses build on this).
            if path_stat.mode is not None:
                current = path_stat.mode
            else:
                current = (DEFAULT_DIR_MODE if path_stat.type
                           == FileType.DIRECTORY else DEFAULT_FILE_MODE)
            new_mode = parse_chmod(mode_text, current)
            if new_mode is None:
                return fail("chmod", f"chmod: invalid mode: '{mode_text}'\n",
                            1)
            await _apply_attrs(namespace,
                               dispatch,
                               "chmod",
                               path,
                               errors,
                               mode=new_mode)
    return finish("chmod", errors)


async def handle_chown(
    namespace: Namespace,
    dispatch: DispatchFn,
    args: list[str | PathSpec],
) -> Result:
    """chown OWNER[:GROUP] FILE...: set ownership via setattr.

    Ownership is stored, not enforced (mirage has no user model); names
    are kept verbatim, numeric ids become ints. ``-R`` walks the
    operand's subtree; POSIX gives it an implicit ``-P``, so a symlink
    is changed itself rather than followed, whether it is the operand
    or reached during the walk.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (DispatchFn): op dispatcher.
        args (list[str | PathSpec]): args after the command name.
    """
    flags, _values, operands, bad = split_value_flags(args, "Rvfh", "")
    if bad is not None:
        return fail("chown", f"chown: invalid option -- '{bad}'\n", 2)
    if len(operands) < 2:
        return fail("chown", "chown: missing operand\n", 2)
    owner_text = operand_text(operands[0])
    uid, gid = parse_owner(owner_text)
    if uid is None and gid is None:
        return fail("chown", f"chown: invalid spec: '{owner_text}'\n", 1)

    recursive = "R" in flags
    no_deref = recursive or "h" in flags
    errors: list[str] = []
    for target in await expand_operands(namespace, operands[1:]):
        if no_deref and namespace.is_link(target.virtual):
            await _apply_link_attrs(namespace,
                                    dispatch,
                                    "chown",
                                    target,
                                    errors,
                                    uid=uid,
                                    gid=gid)
            continue
        found = await _resolve_operand(namespace, dispatch, "chown", target,
                                       errors)
        if found is None:
            continue
        resolved, stat = found
        if recursive:
            paths, links = await _walk_owned(namespace, dispatch, resolved,
                                             stat)
        else:
            paths, links = [resolved], []
        for path in paths:
            await _apply_attrs(namespace,
                               dispatch,
                               "chown",
                               path,
                               errors,
                               uid=uid,
                               gid=gid)
        for link in links:
            await _apply_link_attrs(namespace,
                                    dispatch,
                                    "chown",
                                    PathSpec.from_str_path(link),
                                    errors,
                                    uid=uid,
                                    gid=gid)
    return finish("chown", errors)


async def handle_chgrp(
    namespace: Namespace,
    dispatch: DispatchFn,
    args: list[str | PathSpec],
) -> Result:
    """chgrp GROUP FILE...: set group ownership via setattr.

    The group half of chown: writes gid and leaves uid untouched. Group is
    stored, not enforced (mirage has no group model); a name is kept
    verbatim, a numeric id becomes an int. ``-h`` writes the link node's
    own group, and ``-R`` walks the subtree under the same implicit
    ``-P`` as chown.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (DispatchFn): op dispatcher.
        args (list[str | PathSpec]): args after the command name.
    """
    flags, _values, operands, bad = split_value_flags(args, "Rvfh", "")
    if bad is not None:
        return fail("chgrp", f"chgrp: invalid option -- '{bad}'\n", 2)
    if len(operands) < 2:
        return fail("chgrp", "chgrp: missing operand\n", 2)
    group_text = operand_text(operands[0])
    gid = parse_group(group_text)
    if gid is None:
        return fail("chgrp", f"chgrp: invalid group: '{group_text}'\n", 1)

    recursive = "R" in flags
    no_deref = recursive or "h" in flags
    errors: list[str] = []
    for target in await expand_operands(namespace, operands[1:]):
        if no_deref and namespace.is_link(target.virtual):
            await _apply_link_attrs(namespace,
                                    dispatch,
                                    "chgrp",
                                    target,
                                    errors,
                                    gid=gid)
            continue
        found = await _resolve_operand(namespace, dispatch, "chgrp", target,
                                       errors)
        if found is None:
            continue
        resolved, stat = found
        if recursive:
            paths, links = await _walk_owned(namespace, dispatch, resolved,
                                             stat)
        else:
            paths, links = [resolved], []
        for path in paths:
            await _apply_attrs(namespace,
                               dispatch,
                               "chgrp",
                               path,
                               errors,
                               gid=gid)
        for link in links:
            await _apply_link_attrs(namespace,
                                    dispatch,
                                    "chgrp",
                                    PathSpec.from_str_path(link),
                                    errors,
                                    gid=gid)
    return finish("chgrp", errors)


async def handle_touch(
    namespace: Namespace,
    dispatch: DispatchFn,
    session: Session,
    args: list[str | PathSpec],
) -> Result:
    """touch: set access/modification times, creating missing files.

    GNU flags: -a/-m select which times, -c no-create, -h no-dereference
    (writes the link node's own mtime), -t STAMP / -d STRING supply the
    time, -r FILE copies times from a reference file.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (DispatchFn): op dispatcher.
        session (Session): session whose cwd resolves relative -r paths.
        args (list[str | PathSpec]): args after the command name.
    """
    flags, values, operands, bad = split_value_flags(args, "acmh", "tdr")
    if bad is not None:
        return fail("touch", f"touch: invalid option -- '{bad}'\n", 2)
    if not operands:
        return fail("touch", "touch: missing file operand\n", 1)

    try:
        stamp = parse_touch_stamp(values.get("t"), values.get("d"))
    except ValueError as exc:
        return fail("touch", f"touch: invalid date format '{exc}'\n", 1)
    if stamp is None and "r" in values:
        ref = PathSpec.from_str_path(resolve_path(values["r"], session.cwd))
        try:
            ref_stat, _ = await dispatch("stat", ref)
        except FileNotFoundError:
            return fail(
                "touch", f"touch: failed to get attributes of "
                f"'{values['r']}': No such file or directory\n")
        stamp = ref_stat.modified
    if stamp is None:
        stamp = _now_iso()

    atime = stamp if "a" in flags or "m" not in flags else None
    mtime = stamp if "m" in flags or "a" not in flags else None

    errors: list[str] = []
    writes: dict[str, bytes | AsyncIterator[bytes]] = {}
    for target in await expand_operands(namespace, operands):
        if namespace.is_mount_root(target.virtual):
            errors.append(f"touch: cannot touch '{target.raw_path}': "
                          f"Is a directory\n")
            continue
        if "h" in flags and namespace.is_link(target.virtual):
            await _apply_link_attrs(namespace,
                                    dispatch,
                                    "touch",
                                    target,
                                    errors,
                                    mtime=stamp)
            continue
        resolved = _follow_operand(namespace, "touch", "touch", target, errors)
        if resolved is None:
            continue
        try:
            try:
                await dispatch("stat", resolved)
            except FileNotFoundError:
                if "c" in flags:
                    continue
                mount = namespace.mount_for(resolved.virtual)
                if not mount.supports_op("write", resolved.virtual):
                    # Stat-only backend (e.g. an API surface): creation is
                    # impossible, which GNU reports as EROFS.
                    errors.append(f"touch: cannot touch '{target.raw_path}': "
                                  f"Read-only file system\n")
                    continue
                await dispatch("write", resolved, data=b"")
                writes[resolved.virtual] = b""
            await _setattr_via(dispatch, resolved, atime=atime, mtime=mtime)
        except PermissionError as exc:
            errors.append(_permission_error("touch", namespace, resolved, exc))
        except FS_ERRORS as exc:
            # A destination whose parent chain is not all directories is one
            # failed operand, not an aborted command: GNU reports it and
            # touches the rest. Caught here rather than around the write
            # because backends disagree about which call refuses first (ram
            # answers stat with ENOENT and fails the write; a real
            # filesystem answers stat itself with ENOTDIR).
            errors.append(f"touch: cannot touch '{target.raw_path}': "
                          f"{fs_strerror(exc)}\n")
    return finish("touch", errors, io=IOResult(writes=writes))


__all__ = [
    "handle_chgrp",
    "handle_chmod",
    "handle_chown",
    "handle_touch",
    "parse_group",
    "parse_owner",
    "parse_touch_stamp",
]
