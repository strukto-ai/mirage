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

from collections.abc import Awaitable, Callable
from typing import TypeVar

from mirage.errors.classify import classify
from mirage.errors.constants import CONDITION_CLASS, OPERAND_CONDITIONS
from mirage.errors.posix import posix_errno, posix_phrase
from mirage.errors.types import (
    BadDescriptorError,
    DotWalkError,
    DotWalkLoop,
    DotWalkMissing,
    DotWalkNotDir,
    FileTooLargeError,
    FsCondition,
    NoMountError,
    OperationNotSupportedError,
    ReadOnlyError,
    StaleWriteError,
    WalkDeclinedError,
)
from mirage.types import PathSpec

E = TypeVar("E", bound=OSError)


def virtual_of(path: str | PathSpec) -> str:
    original = getattr(path, "virtual", None)
    return original if original is not None else str(path)


def _stamped(
    kind: type[E],
    condition: FsCondition,
    path: str | PathSpec,
    message: str | None = None,
) -> E:
    return kind(
        posix_errno(condition),
        posix_phrase(condition) if message is None else message,
        virtual_of(path),
    )


def fs_error(path: str | PathSpec, condition: FsCondition) -> OSError:
    """The error a mount raises for one condition at one path.

    Stamped the way the kernel stamps it: the host errno, the condition's
    phrase, and the operand as ``filename``. Raised as mirage's own class
    for a condition that has one (``ReadOnlyError`` for EROFS), else as the
    builtin CPython picks for the errno. Every constructor below is this
    one with its class spelled out. Mirrors TS ``fsError``.

    Args:
        path (str | PathSpec): the operand; ``virtual`` is the reported
            spelling.
        condition (FsCondition): the condition to raise.
    """
    return _stamped(CONDITION_CLASS.get(condition, OSError), condition, path)


def numbered(exc: OSError) -> OSError:
    """`exc` as a real syscall raises it: errno, strerror and path set.

    Every mirage constructor stamps the errno already, but a third-party
    mount may raise ``FileNotFoundError(path)`` with none, and pathlib
    reads the errno to tell a missing path from a broken one:
    ``Path.exists``, ``is_file`` and ``is_dir`` re-raise any OSError
    whose errno they do not recognize, so a plain ``if p.exists()`` would
    crash on a missing mounted path. An error the vocabulary cannot name
    is returned as it came.

    Args:
        exc (OSError): what the entry point raised, errno set or not.
    """
    condition = classify(exc)
    if exc.errno is not None or condition is None:
        return exc
    path = exc.filename if exc.filename is not None else exc.args[0]
    return fs_error(path, condition)


def enoent(path: str | PathSpec) -> FileNotFoundError:
    return _stamped(FileNotFoundError, FsCondition.ENOENT, path)


def ebadf(path: str | PathSpec) -> BadDescriptorError:
    """EBADF: a read from a descriptor that is closed or write-only.

    Args:
        path (str | PathSpec): the operand the reader names, ``-`` for
            standard input.
    """
    return _stamped(BadDescriptorError, FsCondition.EBADF, path)


def dot_walk_error(
    path: str | PathSpec, condition: FsCondition
) -> DotWalkError:
    """A walk refusal: ENOENT, ENOTDIR or ELOOP at a name the walk met.

    Args:
        path (str | PathSpec): the operand as the command reports it.
        condition (FsCondition): ENOENT, ENOTDIR or ELOOP.
    """
    if condition is FsCondition.ENOTDIR:
        return _stamped(DotWalkNotDir, condition, path)
    if condition is FsCondition.ELOOP:
        return _stamped(DotWalkLoop, condition, path)
    return _stamped(DotWalkMissing, FsCondition.ENOENT, path)


def walk_refusal(path: PathSpec) -> DotWalkError:
    """What an op raises for an operand the kernel walk did not resolve.

    Named as typed, the empty name included, since it is what the
    command reports and ``virtual`` names the working directory for it.

    Args:
        path (PathSpec): an operand whose ``walk_error`` is set.
    """
    if path.walk_error == "ELOOP":
        return dot_walk_error(path.raw_path, FsCondition.ELOOP)
    return dot_walk_error(path.raw_path, FsCondition.ENOENT)


def efbig(path: str | PathSpec) -> FileTooLargeError:
    return _stamped(FileTooLargeError, FsCondition.EFBIG, path)


def stale_write(path: str | PathSpec, landed: bool = False) -> StaleWriteError:
    """A conditional write the backend refused. Mirrors TS ``staleWrite``.

    Args:
        path (str | PathSpec): the operand; ``virtual`` is the reported
            spelling.
        landed (bool): a move's copy landed before its source's delete
            lost.
    """
    err = _stamped(StaleWriteError, FsCondition.STALE_WRITE, path)
    err.landed = landed
    return err


def ebusy(path: str | PathSpec) -> OSError:
    return fs_error(path, FsCondition.EBUSY)


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
    return _stamped(NotADirectoryError, FsCondition.ENOTDIR, path)


def eexist(path: str | PathSpec) -> FileExistsError:
    return _stamped(FileExistsError, FsCondition.EEXIST, path)


def eisdir(path: str | PathSpec) -> IsADirectoryError:
    return _stamped(IsADirectoryError, FsCondition.EISDIR, path)


def eacces(path: str | PathSpec) -> PermissionError:
    return _stamped(PermissionError, FsCondition.EACCES, path)


def erofs(path: str | PathSpec) -> ReadOnlyError:
    """EROFS: a write into a region whose mode stops below ``w``.

    The mode voice, distinct from the hide voice (ENOENT) and the policy
    voice (EACCES). Mirrors TS ``erofs``.

    Args:
        path (str | PathSpec): the operand the write named.
    """
    return _stamped(ReadOnlyError, FsCondition.EROFS, path)


def no_mount(path: str | PathSpec) -> NoMountError:
    return NoMountError(f"no mount matches path: {str(path)!r}")


def enotempty(path: str | PathSpec) -> OSError:
    return fs_error(path, FsCondition.ENOTEMPTY)


def no_xattr(path: str | PathSpec) -> OSError:
    return fs_error(path, FsCondition.NO_XATTR)


def exdev(path: str | PathSpec) -> OSError:
    return fs_error(path, FsCondition.EXDEV)


def einval(path: str | PathSpec, message: str | None = None) -> OSError:
    return _stamped(OSError, FsCondition.EINVAL, path, message)


def eloop(path: str | PathSpec) -> DotWalkLoop:
    """ELOOP: a link loop stands in the path's walk.

    A walk refusal: final for every layer that re-reads a miss, and an
    OSError, so a per-operand catch words it where the namespace's own
    ``CycleError`` escaped every one. The dispatcher raises it for a loop
    above any name it is handed.

    Args:
        path (str | PathSpec): the path whose walk looped.
    """
    return _stamped(DotWalkLoop, FsCondition.ELOOP, path)


async def readdir_error(
    path: str | PathSpec,
    key: str,
    is_file: Callable[[str], Awaitable[bool]],
    is_dir: Callable[[str], Awaitable[bool]],
) -> OSError:
    """The errno a failed directory listing should report.

    ``opendir`` reports ENOTDIR only when a component of the path exists and
    is not a directory (``ls /f.txt/x`` -> "Not a directory"); a component
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
    vfs: str, name: str, path: str | PathSpec
) -> OperationNotSupportedError:
    """Missing-capability error for an op a backend does not register.

    ``filename`` carries the virtual path so ``format_fs_error`` reports
    the operand, while the strerror text keeps the VFS and op name
    for raw tracebacks.

    Args:
        vfs (str): VFS name of the mount that lacks the op.
        name (str): The unresolvable op (e.g. ``unlink``).
        path (object): The operand; ``virtual`` is the reported spelling.
    """
    return _stamped(
        OperationNotSupportedError,
        FsCondition.ENOTSUP,
        path,
        f"{vfs}: no op {name!r}",
    )


def walk_declined(
    vfs: str, name: str, path: str | PathSpec
) -> WalkDeclinedError:
    """The dispatcher's refusal of a one-call walk the caller makes itself.

    Mirrors TS ``walkDeclined``.

    Args:
        vfs (str): VFS name of the mount the walk was sent to.
        name (str): The declined op (e.g. ``rm_r``).
        path (str | PathSpec): The operand; ``virtual`` is the reported
            spelling.
    """
    return _stamped(
        WalkDeclinedError,
        FsCondition.ENOTSUP,
        path,
        f"{vfs}: {name!r} declined",
    )


def inner_suffix(operand: PathSpec, exc: BaseException) -> str:
    """The part of a failure's path below ``operand``, '' when it is the operand.

    A recursive command that fails on a file inside its operand names that
    file, as GNU does (``rm: cannot remove 'd/s/b'``): the operand as typed
    plus this suffix. Mirrors TS ``innerSuffix``.

    Args:
        operand (PathSpec): the operand the command was given.
        exc (BaseException): the failure; its ``filename`` names the file.
    """
    name = getattr(exc, "filename", None)
    base = operand.virtual.rstrip("/")
    if not isinstance(name, str) or not name.startswith(base + "/"):
        return ""
    return name[len(base) :]


def with_inner(raw: str, inner: str) -> str:
    """An operand as typed, or naming the file inside it that failed.

    Mirrors TS ``withInner``.

    Args:
        raw (str): the operand as the user typed it.
        inner (str): its ``inner_suffix``; '' keeps the operand as typed.
    """
    return raw.rstrip("/") + inner if inner else raw


def fs_strerror(exc: BaseException) -> str | None:
    """The phrase a command line ends with for a failed operand.

    None for anything but an OSError naming a condition in
    ``OPERAND_CONDITIONS``: the line then carries the exception's own
    words. Mirrors TS ``fsStrerror``.

    Args:
        exc (BaseException): the failure.
    """
    if not isinstance(exc, OSError):
        return None
    condition = classify(exc)
    if condition is None or condition not in OPERAND_CONDITIONS:
        return None
    return posix_phrase(condition)


def error_path(exc: BaseException) -> str:
    """The path an fs error is about.

    The stamped ``filename``, which every constructor here sets and the
    kernel sets for the disk backend. An error raised bare, with the
    operand as its only argument (``FileNotFoundError(path)`` from a
    third-party mount), names it in the message instead. An error may
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
