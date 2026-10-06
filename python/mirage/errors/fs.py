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

import errno
import os
from collections.abc import Awaitable, Callable

from mirage.errors.constants import ELOOP_STRERROR, FS_STRERROR
from mirage.errors.types import (
    DotWalkError,
    DotWalkLoop,
    DotWalkMissing,
    FileTooLargeError,
    NoMountError,
    OperationNotSupportedError,
)
from mirage.types import PathSpec


def virtual_of(path: str | PathSpec) -> str:
    original = getattr(path, "virtual", None)
    return original if original is not None else str(path)


def enoent(path: str | PathSpec) -> FileNotFoundError:
    return FileNotFoundError(virtual_of(path))


def walk_refusal(path: PathSpec) -> DotWalkError:
    """What an op raises for an operand the kernel walk did not resolve.

    Named as typed, the empty name included, since it is what the
    command reports and ``virtual`` names the working directory for it.

    Args:
        path (PathSpec): an operand whose ``walk_error`` is set.
    """
    if path.walk_error == "ELOOP":
        return DotWalkLoop(errno.ELOOP, ELOOP_STRERROR, path.raw_path)
    return DotWalkMissing(
        errno.ENOENT, "No such file or directory", path.raw_path
    )


def efbig(path: str | PathSpec) -> FileTooLargeError:
    return FileTooLargeError(errno.EFBIG, "File too large", virtual_of(path))


def ebusy(path: str | PathSpec) -> OSError:
    return OSError(errno.EBUSY, "Device or resource busy", virtual_of(path))


def enotdir(path: str | PathSpec) -> NotADirectoryError:
    """ENOTDIR: a component of the path is a plain file.

    What ``open(2)`` and ``stat(2)`` answer for ``a.txt/x``, and what a
    lookup there answers on ram, redis, disk and OPFS too: the keyed stores
    walk the parents on a miss (their ``lookup_error``), the filesystems
    hear it from the kernel. Deliberate divergence: object stores and SFTP
    answer ENOENT, because telling the two apart costs a request per
    ancestor on every miss, a stat miss is the ordinary case of a copy's
    destination probe, and an object store may hold ``a.txt`` and
    ``a.txt/x`` at once. Mirrors TS ``enotdir``.

    Args:
        path (str | PathSpec): the operand; ``virtual`` is the reported
            spelling.
    """
    return NotADirectoryError(virtual_of(path))


def eexist(path: str | PathSpec) -> FileExistsError:
    return FileExistsError(virtual_of(path))


def eisdir(path: str | PathSpec) -> IsADirectoryError:
    return IsADirectoryError(virtual_of(path))


def eacces(path: str | PathSpec) -> PermissionError:
    return PermissionError(virtual_of(path))


def no_mount(path: str | PathSpec) -> NoMountError:
    return NoMountError(f"no mount matches path: {str(path)!r}")


# The three conditions below have no typed builtin, so their errno is
# the stamp (mirage.errors.classify reads it); the strerror rides along
# for raw tracebacks and `filename` carries the operand, like enotsup.


def enotempty(path: str | PathSpec) -> OSError:
    return OSError(errno.ENOTEMPTY, "Directory not empty", virtual_of(path))


def no_xattr(path: str | PathSpec) -> OSError:
    code = getattr(errno, "ENOATTR", errno.ENODATA)
    return OSError(code, os.strerror(code), virtual_of(path))


def exdev(path: str | PathSpec) -> OSError:
    return OSError(errno.EXDEV, "Invalid cross-device link", virtual_of(path))


def einval(path: str | PathSpec, message: str = "Invalid argument") -> OSError:
    return OSError(errno.EINVAL, message, virtual_of(path))


def eloop(path: str | PathSpec) -> DotWalkLoop:
    """ELOOP: a link loop stands in the path's walk.

    Typed, unlike the three above, because it is a walk refusal: final
    for every layer that re-reads a miss, and an OSError, so a per-operand
    catch words it where the namespace's own ``CycleError`` escaped every
    one. The door raises it for a loop above any name it is handed.

    Args:
        path (str | PathSpec): the path whose walk looped.
    """
    return DotWalkLoop(errno.ELOOP, ELOOP_STRERROR, virtual_of(path))


async def readdir_error(
    path: str | PathSpec,
    key: str,
    is_file: Callable[[str], Awaitable[bool]],
    is_dir: Callable[[str], Awaitable[bool]],
) -> OSError:
    """The errno a failed directory listing should report.

    ``opendir`` reports ENOTDIR only when a component of the path exists and
    is not a directory (GNU ``ls /f.txt/x`` -> "Not a directory"); a component
    that does not exist at all is ENOENT (``ls /nope`` -> "No such file or
    directory"), however deep it is. Store-backed backends have no kernel to
    draw that line for them, so they walk the ancestors and ask here instead
    of collapsing both cases into one errno.

    The walk stops at the first component that resolves to neither a
    directory nor a file, the way the kernel stops resolving there: a store
    can hold a key whose parent is not a directory, and looking past that
    gap would report ENOTDIR for a path the kernel never reaches.

    A component is tested as a directory *first*, because a keyed store can
    hold both an object ``a`` and a prefix ``a/`` and traversal only ever
    reaches an intermediate component through the directory: with an object
    ``a`` and a key ``a/x``, ``ls /a/never`` must report ENOENT, not ENOTDIR.
    On a store where the two are mutually exclusive the order is immaterial,
    so ram, redis and disk are unaffected.

    Every component is walked, the listed path included, because the walk
    is the only thing that can see a gap above it. A backend whose store
    cannot hold such a gap should call ``listing_error`` instead, which
    settles the common case in one probe.
    Mirrors TS ``readdirError``.

    Args:
        path (str | PathSpec): The operand; ``virtual`` is the reported
            spelling.
        key (str): The mount-local normalized path that was looked up.
        is_file (Callable[[str], Awaitable[bool]]): Probe reporting whether a
            mount-local path exists as a non-directory.
        is_dir (Callable[[str], Awaitable[bool]]): Probe reporting whether a
            mount-local path exists as a directory.
    """
    segments = [s for s in key.split("/") if s]
    for i in range(1, len(segments) + 1):
        component = "/" + "/".join(segments[:i])
        if await is_dir(component):
            continue
        if await is_file(component):
            return enotdir(path)
        return enoent(path)
    return enoent(path)


async def listing_error(
    path: str | PathSpec,
    key: str,
    is_file: Callable[[str], Awaitable[bool]],
    is_dir: Callable[[str], Awaitable[bool]],
) -> OSError:
    """``readdir_error`` for a store that cannot hold an orphan.

    An object store's key implies every prefix of it, and a hierarchy the
    backend addresses by path implies every folder above it, so on those
    backends a path that exists proves its ancestors are directories and
    the answer for one that is not a directory is ENOTDIR outright. Probing
    it first is what keeps a ``readdir`` on a plain file to one round trip
    where each probe is an API request rather than a dict lookup.

    That premise is exactly what a flat store breaks: ram and redis rename
    without creating the destination's ancestors, so they can hold
    ``/missing/a.txt`` with ``/missing`` absent, where resolution stops and
    the answer is ENOENT. Those call ``readdir_error`` directly. The walk
    ends at the listed path itself, which the first probe has already
    found is not a file, so it is not asked again.
    Mirrors TS ``listingError``.

    Args:
        path (str | PathSpec): The operand; ``virtual`` is the reported
            spelling.
        key (str): The mount-local normalized path that was looked up.
        is_file (Callable[[str], Awaitable[bool]]): Probe reporting whether a
            mount-local path exists as a non-directory.
        is_dir (Callable[[str], Awaitable[bool]]): Probe reporting whether a
            mount-local path exists as a directory.
    """
    leaf = key.strip("/")
    if not leaf:
        return await readdir_error(path, key, is_file, is_dir)
    if await is_file(key):
        return enotdir(path)

    async def is_file_above(component: str) -> bool:
        return component.strip("/") != leaf and await is_file(component)

    return await readdir_error(path, key, is_file_above, is_dir)


def enotsup(
    vfs: str, op_name: str, path: str | PathSpec
) -> OperationNotSupportedError:
    """Missing-capability error for an op a backend does not register.

    ``filename`` carries the virtual path so ``format_fs_error`` reports
    the operand, while the strerror text keeps the VFS and op name
    for raw tracebacks.

    Args:
        vfs (str): VFS name of the mount that lacks the op.
        op_name (str): The unresolvable op (e.g. ``unlink``).
        path (object): The operand; ``virtual`` is the reported spelling.
    """
    return OperationNotSupportedError(
        errno.ENOTSUP, f"{vfs}: no op {op_name!r}", virtual_of(path)
    )


def fs_strerror(exc: BaseException) -> str | None:
    for exc_type, strerror in FS_STRERROR:
        if isinstance(exc, exc_type):
            return strerror
    return None


def error_path(exc: BaseException) -> str:
    """The path an fs error is about.

    Two conventions meet here and both mean the same thing. The store
    backends raise with the bare operand as the message
    (``enoent(spec)``), while the real-filesystem backends stamp
    ``filename`` (``disk_errors``, and the kernel before it). An error may
    also name something other than the operand it was raised for:
    ``mkdir -p`` reports the component of the chain it tripped on, so the
    stamped path wins over what the caller was holding.

    An empty stamp is the empty operand, which is a name like any other.

    Args:
        exc (BaseException): The filesystem error.
    """
    stamped = getattr(exc, "filename", None)
    if isinstance(stamped, str):
        return stamped
    return str(exc)
