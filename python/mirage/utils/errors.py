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
from collections.abc import Awaitable, Callable

from mirage.types import PathSpec
from mirage.utils.path import drop_trailing_segments, respell_one
from mirage.utils.quote import quotes_operands, shell_quote


class OperationNotSupportedError(OSError):
    """A mount was asked for an op its backend does not register.

    Raised at the op-resolution boundary (``Mount.execute_op``) so a
    capability gap surfaces as a recoverable filesystem error
    (ENOTSUP, "Operation not supported") instead of an internal
    AttributeError: GNU-wise the backend behaves like a filesystem
    that does not allow the operation.
    """


class ReadOnlyError(PermissionError):
    """A write into a region whose mode stops below ``w``.

    Raised by the mode gate (``Mount.execute_op``) with ``errno.EROFS``
    stamped and the op's path as ``filename``, so a command chokepoint
    renders GNU's ``<cmd>: <path>: Read-only file system`` and a kernel
    adapter reports EROFS: the below-mode voice, distinct from both the
    hide voice (ENOENT) and the policy voice (EACCES). A
    ``PermissionError`` subclass because every catch site that tolerates
    a refused write already names that class; the strerror table lists
    this subclass first, and the classifiers read the errno, so the
    voice stays EROFS everywhere.
    """


class NoMountError(ValueError):
    """A path no mount owns: the registry's miss, and nothing else.

    A ValueError subclass so every existing catch keeps working, but
    typed so ``mirage.errors.classify`` can name the miss ENOENT
    without swallowing the bare ValueErrors backends raise for
    refusals that are not absence (an oversized read, a rename into
    the source's own subtree). Mirrors the TS ``noMount`` stamp.
    """


class BadDescriptorError(OSError):
    """EBADF: a read from a descriptor that is closed or open for
    writing only, which is what ``cat 0<&1`` and ``cat <&-`` attempt.
    """


_FS_STRERROR: list[tuple[type[OSError], str]] = [
    (BadDescriptorError, "Bad file descriptor"),
    (FileNotFoundError, "No such file or directory"),
    (NotADirectoryError, "Not a directory"),
    (IsADirectoryError, "Is a directory"),
    (FileExistsError, "File exists"),
    (ReadOnlyError, "Read-only file system"),
    (PermissionError, "Permission denied"),
    (OperationNotSupportedError, "Operation not supported"),
]

# The recoverable per-operand filesystem errors: every catch site that
# formats a GNU stderr line and keeps going uses this tuple, so the catch
# set and the strerror table can never drift apart (mirrors TS isFsError).
FS_ERRORS: tuple[type[OSError], ...] = tuple(t for t, _ in _FS_STRERROR)

# What a tree walk over a user operand tolerates: every recoverable
# filesystem error, plus the ValueError store backends raise for "not a
# directory". Catch sites that warn and keep walking (tree, grep -r, rg) use
# this so an errno split like ENOENT/ENOTDIR cannot make one of them abort
# while its siblings keep going.
WALK_ERRORS: tuple[type[Exception], ...] = (*FS_ERRORS, ValueError)

# What an existence probe reads as "nothing here": the path is absent, or
# a component of it is not traversable. Deliberately narrower than
# WALK_ERRORS, because a permission or missing-capability error is not
# absence, and mapping it to one would report a path that exists as
# missing. Mirrors TS isMissError.
MISS_ERRORS: tuple[type[Exception],
                   ...] = (FileNotFoundError, NotADirectoryError,
                           IsADirectoryError, ValueError)


def _virtual_of(path: str | PathSpec) -> str:
    original = getattr(path, "virtual", None)
    return original if original is not None else str(path)


def enoent(path: str | PathSpec) -> FileNotFoundError:
    return FileNotFoundError(_virtual_of(path))


def ebusy(path: str | PathSpec) -> OSError:
    return OSError(errno.EBUSY, "Device or resource busy", _virtual_of(path))


def enotdir(path: str | PathSpec) -> NotADirectoryError:
    return NotADirectoryError(_virtual_of(path))


def eexist(path: str | PathSpec) -> FileExistsError:
    return FileExistsError(_virtual_of(path))


def eisdir(path: str | PathSpec) -> IsADirectoryError:
    return IsADirectoryError(_virtual_of(path))


def eacces(path: str | PathSpec) -> PermissionError:
    return PermissionError(_virtual_of(path))


def no_mount(path: str | PathSpec) -> NoMountError:
    return NoMountError(f"no mount matches path: {str(path)!r}")


# The three conditions below have no typed builtin, so their errno is
# the stamp (mirage.errors.classify reads it); the strerror rides along
# for raw tracebacks and `filename` carries the operand, like enotsup.


def enotempty(path: str | PathSpec) -> OSError:
    return OSError(errno.ENOTEMPTY, "Directory not empty", _virtual_of(path))


def exdev(path: str | PathSpec) -> OSError:
    return OSError(errno.EXDEV, "Invalid cross-device link", _virtual_of(path))


def einval(path: str | PathSpec, message: str = "Invalid argument") -> OSError:
    return OSError(errno.EINVAL, message, _virtual_of(path))


def eloop(path: str | PathSpec) -> OSError:
    return OSError(errno.ELOOP, "Too many levels of symbolic links",
                   _virtual_of(path))


async def readdir_error(path: str | PathSpec, key: str,
                        is_file: Callable[[str], Awaitable[bool]],
                        is_dir: Callable[[str], Awaitable[bool]]) -> OSError:
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


async def listing_error(path: str | PathSpec, key: str,
                        is_file: Callable[[str], Awaitable[bool]],
                        is_dir: Callable[[str], Awaitable[bool]]) -> OSError:
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
    the answer is ENOENT. Those call ``readdir_error`` directly.
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
    if key.strip("/") and await is_file(key):
        return enotdir(path)
    return await readdir_error(path, key, is_file, is_dir)


def enotsup(resource: str, op_name: str,
            path: str | PathSpec) -> OperationNotSupportedError:
    """Missing-capability error for an op a backend does not register.

    ``filename`` carries the virtual path so ``format_fs_error`` reports
    the operand, while the strerror text keeps the resource and op name
    for raw tracebacks.

    Args:
        resource (str): Resource name of the mount that lacks the op.
        op_name (str): The unresolvable op (e.g. ``unlink``).
        path (object): The operand; ``virtual`` is the reported spelling.
    """
    return OperationNotSupportedError(errno.ENOTSUP,
                                      f"{resource}: no op {op_name!r}",
                                      _virtual_of(path))


def fs_strerror(exc: BaseException) -> str | None:
    for exc_type, strerror in _FS_STRERROR:
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

    Args:
        exc (BaseException): The filesystem error.
    """
    stamped = getattr(exc, "filename", None)
    if isinstance(stamped, str) and stamped:
        return stamped
    return str(exc)


def operand_spelling(path: str, operand: PathSpec) -> str:
    """Re-spell a reported path the way its operand was typed.

    Backends name paths in virtual space, but GNU quotes the operand as
    the user wrote it: ``cd /data && mkdir -p f.txt/sub`` reports
    ``'f.txt'``, not ``'/data/f.txt'``. The path an error names is the
    operand itself, an ancestor of it (``mkdir -p`` blames the component
    of the chain it tripped on), or something under it, so all three are
    rebased onto ``raw_path``. An absolute operand rebases to itself,
    which is why this is a no-op for most invocations.

    Args:
        path (str): The virtual path the error named.
        operand (PathSpec): The operand the command was given.
    """
    raw, virtual = operand.raw_path, operand.virtual
    if raw == virtual:
        return path
    if path == virtual:
        return raw
    base = virtual.rstrip("/")
    if path.startswith(base + "/"):
        return respell_one(path, virtual, raw)
    trimmed = path.rstrip("/")
    if base.startswith(trimmed + "/"):
        depth = len(_segments(base)) - len(_segments(trimmed))
        return drop_trailing_segments(raw, depth)
    return path


def _segments(path: str) -> list[str]:
    return [part for part in path.split("/") if part]


def fs_error_line(cmd_name: str, path: str | PathSpec,
                  exc: BaseException) -> str:
    """GNU coreutils stderr line for one failed path operand.

    Produces ``<cmd>: <path>: <strerror>``, byte-identical with the
    TypeScript formatter. ``path`` is the operand itself when the caller
    knows it (read-family commands that keep processing remaining operands
    after one fails, reported as typed via ``raw_path``), or an
    already-resolved label string. A command in ``SHELL_QUOTED_COMMANDS``
    reports the operand shell-quoted when it needs it (``'*.txt'``), the
    way GNU does; every other command reports it bare.

    Args:
        cmd_name (str): Command name for the ``<cmd>:`` prefix.
        path (object): The failed operand; ``raw_path`` (or ``virtual``) is
            the reported spelling, a plain string is used verbatim.
        exc (BaseException): The filesystem error.
    """
    label = getattr(path, "raw_path", None) or _virtual_of(path)
    if quotes_operands(cmd_name):
        label = shell_quote(label)
    strerror = fs_strerror(exc)
    if strerror is not None:
        return f"{cmd_name}: {label}: {strerror}\n"
    return f"{cmd_name}: {label}\n"


def format_fs_error(cmd_name: str,
                    exc: Exception,
                    paths: list[PathSpec] | None = None) -> bytes:
    """Format a thrown command error as a GNU coreutils stderr line.

    The chokepoint variant of ``fs_error_line`` for callers that only hold
    the exception, byte-identical with the TypeScript ``formatFsError``. A
    recognized filesystem error becomes ``<cmd>: <path>: <strerror>`` (the
    path is recovered from ``exc.filename`` when set, else ``str(exc)``;
    backends raise with the resolved absolute path, and ``paths`` rewrites it
    to the as-typed ``PathSpec.raw_path`` so a relative argument is reported
    as typed, like GNU). Any other exception becomes the generic
    ``<cmd>: <message>`` line, so a command that throws is reported with the
    ``prog: message`` prefix GNU and the TypeScript executor both use. A
    message that already carries the ``<cmd>: `` prefix (many generic
    commands raise a fully GNU-formatted string, e.g. ``uniq: invalid
    count``) is emitted verbatim so the prefix is not doubled.

    Args:
        cmd_name (str): Command name for the ``<cmd>:`` prefix.
        exc (Exception): The thrown error.
        paths (list[PathSpec] | None): Command operands, used to map the
            resolved path back to the as-typed form.
    """
    if fs_strerror(exc) is None:
        message = str(exc)
        if message.startswith(f"{cmd_name}: "):
            return f"{message}\n".encode()
        return f"{cmd_name}: {message}\n".encode()
    path = error_path(exc)
    if paths:
        for p in paths:
            if p.virtual == path:
                path = p.raw_path
                break
    return fs_error_line(cmd_name, path, exc).encode()
