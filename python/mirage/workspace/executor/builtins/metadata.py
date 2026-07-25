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
from collections.abc import AsyncIterator, Callable
from datetime import datetime, timezone
from typing import Any

from mirage.io import IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.mode import DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, parse_mode
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


async def _setattr_via(
    namespace: Namespace,
    dispatch: Callable[..., Any],
    path: PathSpec,
    *,
    mode: int | None = None,
    uid: int | str | None = None,
    gid: int | str | None = None,
    atime: str | None = None,
    mtime: str | None = None,
) -> None:
    """Apply attributes natively where the backend can hold them; store
    the rest in the namespace overlay. None fields are left untouched.

    A mount with a setattr op applies what it can and returns the
    residual (e.g. disk: clamped mode bits, ownership). Residual fields
    go to the overlay; fields the backend applied natively are dropped
    from it, so a stale overlay never shadows the fresh backend value.
    A mount without setattr (API backend) overlays everything.

    Args:
        namespace (Namespace): addressing authority (overlay home).
        dispatch (Callable): op dispatcher.
        path (PathSpec): target path (already link-resolved).
        mode (int | None): permission bits (e.g. 0o644).
        uid (int | str | None): owner id or name.
        gid (int | str | None): group id or name.
        atime (str | None): ISO access time.
        mtime (str | None): ISO modification time.
    """
    mount = namespace.mount_for(path.virtual)
    requested = {
        "mode": mode,
        "uid": uid,
        "gid": gid,
        "atime": atime,
        "mtime": mtime,
    }
    if mount.supports_op("setattr", path.virtual):
        residual, _ = await dispatch("setattr",
                                     path,
                                     mode=mode,
                                     uid=uid,
                                     gid=gid,
                                     atime=atime,
                                     mtime=mtime)
        applied = [
            key for key, value in requested.items()
            if value is not None and key not in residual
        ]
        if applied:
            await namespace.drop_attrs(path.virtual, applied)
        if not residual:
            return
        mode = residual.get("mode")
        uid = residual.get("uid")
        gid = residual.get("gid")
        atime = residual.get("atime")
        mtime = residual.get("mtime")
    epoch: float | None = None
    if mtime is not None:
        epoch = datetime.fromisoformat(mtime).timestamp()
    await namespace.set_attrs(path.virtual,
                              mode=mode,
                              uid=uid,
                              gid=gid,
                              atime=atime,
                              mtime=epoch)


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
    dispatch: Callable[..., Any],
    cmd: str,
    target: PathSpec,
    errors: list[str],
) -> tuple[PathSpec, FileStat] | None:
    """Follow symlinks and stat one operand, collecting GNU errors.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (Callable): op dispatcher.
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
    dispatch: Callable[..., Any],
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
        dispatch (Callable): op dispatcher.
        cmd (str): command name for the error message.
        resolved (PathSpec): link-resolved target path.
        errors (list[str]): per-operand error accumulator.
        mode (int | None): permission bits (e.g. 0o644).
        uid (int | str | None): owner id or name.
        gid (int | str | None): group id or name.
    """
    try:
        await _setattr_via(namespace,
                           dispatch,
                           resolved,
                           mode=mode,
                           uid=uid,
                           gid=gid)
    except PermissionError:
        errors.append(_read_only_error(cmd, namespace, resolved))


async def handle_chmod(
    namespace: Namespace,
    dispatch: Callable[..., Any],
    args: list[str | PathSpec],
) -> Result:
    """chmod MODE FILE...: set permission bits via setattr.

    Follows symlinks (GNU chmod always dereferences). Stored, not
    enforced: mount mode does real access control.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (Callable): op dispatcher.
        args (list[str | PathSpec]): args after the command name.
    """
    flags, _values, operands, bad = split_value_flags(args, "Rvf", "")
    if bad is not None:
        return fail("chmod", f"chmod: invalid option -- '{bad}'\n", 2)
    if len(operands) < 2:
        return fail("chmod", "chmod: missing operand\n", 2)
    if "R" in flags:
        return fail("chmod", "chmod: -R is not supported\n", 2)
    mode_text = operand_text(operands[0])
    if parse_mode(mode_text, 0) is None:
        return fail("chmod", f"chmod: invalid mode: '{mode_text}'\n", 1)

    errors: list[str] = []
    for target in await expand_operands(namespace, operands[1:]):
        found = await _resolve_operand(namespace, dispatch, "chmod", target,
                                       errors)
        if found is None:
            continue
        resolved, stat = found
        # Backends without a mode default to what ls renders: 755 for
        # directories, 644 for files (symbolic clauses build on this).
        if stat.mode is not None:
            current = stat.mode
        else:
            current = (DEFAULT_DIR_MODE if stat.type == FileType.DIRECTORY else
                       DEFAULT_FILE_MODE)
        new_mode = parse_mode(mode_text, current)
        if new_mode is None:
            return fail("chmod", f"chmod: invalid mode: '{mode_text}'\n", 1)
        await _apply_attrs(namespace,
                           dispatch,
                           "chmod",
                           resolved,
                           errors,
                           mode=new_mode)
    return finish("chmod", errors)


async def handle_chown(
    namespace: Namespace,
    dispatch: Callable[..., Any],
    args: list[str | PathSpec],
) -> Result:
    """chown OWNER[:GROUP] FILE...: set ownership via setattr.

    Ownership is stored, not enforced (mirage has no user model); names
    are kept verbatim, numeric ids become ints.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (Callable): op dispatcher.
        args (list[str | PathSpec]): args after the command name.
    """
    flags, _values, operands, bad = split_value_flags(args, "Rvfh", "")
    if bad is not None:
        return fail("chown", f"chown: invalid option -- '{bad}'\n", 2)
    if len(operands) < 2:
        return fail("chown", "chown: missing operand\n", 2)
    if "R" in flags:
        return fail("chown", "chown: -R is not supported\n", 2)
    owner_text = operand_text(operands[0])
    uid, gid = parse_owner(owner_text)
    if uid is None and gid is None:
        return fail("chown", f"chown: invalid spec: '{owner_text}'\n", 1)

    no_deref = "h" in flags
    errors: list[str] = []
    for target in await expand_operands(namespace, operands[1:]):
        if no_deref and namespace.is_link(target.virtual):
            await namespace.set_attrs(target.virtual, uid=uid, gid=gid)
            continue
        found = await _resolve_operand(namespace, dispatch, "chown", target,
                                       errors)
        if found is None:
            continue
        resolved, _stat = found
        await _apply_attrs(namespace,
                           dispatch,
                           "chown",
                           resolved,
                           errors,
                           uid=uid,
                           gid=gid)
    return finish("chown", errors)


async def handle_chgrp(
    namespace: Namespace,
    dispatch: Callable[..., Any],
    args: list[str | PathSpec],
) -> Result:
    """chgrp GROUP FILE...: set group ownership via setattr.

    The group half of chown: writes gid and leaves uid untouched. Group is
    stored, not enforced (mirage has no group model); a name is kept
    verbatim, a numeric id becomes an int. ``-h`` writes the link node's
    own group.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (Callable): op dispatcher.
        args (list[str | PathSpec]): args after the command name.
    """
    flags, _values, operands, bad = split_value_flags(args, "Rvfh", "")
    if bad is not None:
        return fail("chgrp", f"chgrp: invalid option -- '{bad}'\n", 2)
    if len(operands) < 2:
        return fail("chgrp", "chgrp: missing operand\n", 2)
    if "R" in flags:
        return fail("chgrp", "chgrp: -R is not supported\n", 2)
    group_text = operand_text(operands[0])
    gid = parse_group(group_text)
    if gid is None:
        return fail("chgrp", f"chgrp: invalid group: '{group_text}'\n", 1)

    no_deref = "h" in flags
    errors: list[str] = []
    for target in await expand_operands(namespace, operands[1:]):
        if no_deref and namespace.is_link(target.virtual):
            await namespace.set_attrs(target.virtual, gid=gid)
            continue
        found = await _resolve_operand(namespace, dispatch, "chgrp", target,
                                       errors)
        if found is None:
            continue
        resolved, _stat = found
        await _apply_attrs(namespace,
                           dispatch,
                           "chgrp",
                           resolved,
                           errors,
                           gid=gid)
    return finish("chgrp", errors)


async def handle_touch(
    namespace: Namespace,
    dispatch: Callable[..., Any],
    session: Session,
    args: list[str | PathSpec],
) -> Result:
    """touch: set access/modification times, creating missing files.

    GNU flags: -a/-m select which times, -c no-create, -h no-dereference
    (writes the link node's own mtime), -t STAMP / -d STRING supply the
    time, -r FILE copies times from a reference file.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (Callable): op dispatcher.
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
            epoch = datetime.fromisoformat(stamp).timestamp()
            await namespace.set_attrs(target.virtual, mtime=epoch)
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
            await _setattr_via(namespace,
                               dispatch,
                               resolved,
                               atime=atime,
                               mtime=mtime)
        except PermissionError:
            errors.append(_read_only_error("touch", namespace, resolved))
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
