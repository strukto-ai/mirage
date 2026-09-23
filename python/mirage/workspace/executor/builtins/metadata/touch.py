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

from collections.abc import AsyncIterator

from mirage.context import DEFAULT_UMASK
from mirage.io import IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import FileType, PathSpec
from mirage.utils.errors import FS_ERRORS, fs_strerror
from mirage.utils.path import resolve_path
from mirage.workspace.executor.builtins.metadata.metadata import (
    apply_link_attrs, follow_operand, now_iso, parse_touch_stamp,
    permission_error, setattr_via)
from mirage.workspace.executor.builtins.shared import (expand_operands, fail,
                                                       finish,
                                                       split_value_flags)
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import SessionState


async def handle_touch(
    namespace: Namespace,
    dispatch: DispatchFn,
    session: SessionState,
    args: list[str | PathSpec],
) -> Result:
    """touch: set access/modification times, creating missing files.

    GNU flags: -a/-m select which times, -c no-create, -h no-dereference
    (writes the link node's own mtime), -t STAMP / -d STRING supply the
    time, -r FILE copies times from a reference file.

    Args:
        namespace (Namespace): addressing authority.
        dispatch (DispatchFn): op dispatcher.
        session (SessionState): session whose cwd resolves relative -r paths.
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
        stamp = now_iso()

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
            await apply_link_attrs(namespace,
                                   dispatch,
                                   "touch",
                                   target,
                                   errors,
                                   mtime=stamp)
            continue
        resolved = follow_operand(namespace, "touch", "touch", target, errors)
        if resolved is None:
            continue
        # `x/` is `x/.`, so touch never creates through a trailing slash:
        # it sets times on a directory that has to be there already, and
        # GNU words that refusal ("setting times of") differently from
        # its create-path one ("cannot touch").
        if target.raw_path.endswith("/"):
            try:
                slashed, _ = await dispatch("stat", resolved)
            except FS_ERRORS as exc:
                errors.append(f"touch: setting times of "
                              f"'{target.raw_path}': {fs_strerror(exc)}\n")
                continue
            if slashed.type != FileType.DIRECTORY:
                errors.append(f"touch: setting times of "
                              f"'{target.raw_path}': Not a directory\n")
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
                # A file touch creates is 0666 under the session's
                # umask; only a mask away from bash's default is worth
                # a mode write, since 644 is what a fresh file renders as.
                if session.umask != DEFAULT_UMASK:
                    await setattr_via(dispatch,
                                      resolved,
                                      mode=0o666 & ~session.umask,
                                      atime=atime,
                                      mtime=mtime)
                    continue
            await setattr_via(dispatch, resolved, atime=atime, mtime=mtime)
        except PermissionError as exc:
            errors.append(permission_error("touch", namespace, resolved, exc))
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
