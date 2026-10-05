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

from mirage.types import PathSpec
from mirage.utils.path import drop_trailing_segments, respell_one
from mirage.utils.quote import quotes_operands, shell_quote, shell_quote_always


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


class GzipDataError(ValueError):
    """Why ``gzip -d`` cannot decompress one input, in gzip's words.

    ``fatal`` is gzip 1.13's split: an input with no gzip header, or
    with a header naming a method or flag gzip does not support, is
    reported and the run moves on to the next operand, while a truncated
    or corrupt one ends the run, as does a CRC or length mismatch unless
    ``-t`` is only testing. A mismatch in both carries both reasons, in
    gzip's order. ``keeps_output`` says the bytes decoded before the
    failure are whole members: after a refusal of a later member, of
    trailing garbage, or of a trailer. An in-place run still writes them
    when the refusal is not fatal, and tar reads them whatever gzip
    does. ``first_header`` says gzip stopped inside its first member's
    header, before it would create an output file or read a body; on
    stdin that ends the run, as gzip exits there. The reasons are gzip's
    own lines, the program name and any leading newline included, since
    gunzip, zcat, zgrep and tar's child all run gzip.

    Args:
        reasons (tuple[str, ...]): gzip's diagnostic lines, each with
            ``{}`` where the input's name goes.
        fatal (bool): whether gzip stops at this input.
        exit_code (int): One for an error, two for a trailing-data warning.
        keeps_output (bool): whether the bytes decoded before the
            failure are whole members.
        first_header (bool): whether the failure lies in the first
            member's header.
    """

    def __init__(
        self,
        reasons: tuple[str, ...],
        fatal: bool,
        exit_code: int = 1,
        keeps_output: bool = False,
        first_header: bool = False,
    ) -> None:
        super().__init__("\n".join(reasons))
        self.reasons = reasons
        self.fatal = fatal
        self.exit_code = exit_code
        self.keeps_output = keeps_output
        self.first_header = first_header

    def render(self, label: str) -> str:
        """gzip's lines for the failure, the input named ``label``.

        Args:
            label (str): the input as the diagnostic names it.
        """
        return "".join(
            f"{reason.replace('{}', label)}\n" for reason in self.reasons
        )


class FileTooLargeError(OSError):
    """EFBIG: a read the backend refuses to render whole.

    A records file past its mount's record cap (Airtable's
    ``max_read_records``) raises this rather than paging a large table at
    a few requests a second. Stamped like the other per-operand errors, so
    a command chokepoint renders GNU's ``<cmd>: <path>: File too large``
    and moves on to its next operand. Mirrors the TS ``efbig``.
    """


class BadDescriptorError(OSError):
    """EBADF: a read from a descriptor that is closed or open for
    writing only, which is what ``cat 0<&1`` and ``cat <&-`` attempt.
    """


class DotWalkError(OSError):
    """A path the kernel walk does not resolve: its own ``.`` and ``..``
    (``dot_refusal``), or an operand whose ``walk_error`` the walk
    answered before the command ran (``walk_refusal``).

    Final, which is why it is a type of its own: a keyed store's plain
    miss can still be an implicit directory, and the layers that ask
    (the read commands' directory probes) re-read ENOENT that way, but
    a name in front of a dot that is missing or a plain file is not a
    directory under any reading, and neither is the empty name or a
    link loop. Raised as one of the subclasses, so every catch site
    keyed on ENOENT or ENOTDIR still sees its own.
    """


class DotWalkMissing(DotWalkError, FileNotFoundError):
    """ENOENT: a name in front of a dot is not there, or the name is
    empty."""


class DotWalkNotDir(DotWalkError, NotADirectoryError):
    """ENOTDIR: a name in front of a dot is a plain file."""


class DotWalkLoop(DotWalkError):
    """ELOOP: a symbolic link loop stands in the path's walk."""


ELOOP_STRERROR = "Too many levels of symbolic links"

_FS_STRERROR: list[tuple[type[OSError], str]] = [
    (BadDescriptorError, "Bad file descriptor"),
    (FileNotFoundError, "No such file or directory"),
    (NotADirectoryError, "Not a directory"),
    (IsADirectoryError, "Is a directory"),
    (DotWalkLoop, ELOOP_STRERROR),
    (FileExistsError, "File exists"),
    (ReadOnlyError, "Read-only file system"),
    (PermissionError, "Permission denied"),
    (OperationNotSupportedError, "Operation not supported"),
    (FileTooLargeError, "File too large"),
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
MISS_ERRORS: tuple[type[Exception], ...] = (
    FileNotFoundError,
    NotADirectoryError,
    IsADirectoryError,
    ValueError,
)


def _virtual_of(path: str | PathSpec) -> str:
    original = getattr(path, "virtual", None)
    return original if original is not None else str(path)


def enoent(path: str | PathSpec) -> FileNotFoundError:
    return FileNotFoundError(_virtual_of(path))


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
    return FileTooLargeError(errno.EFBIG, "File too large", _virtual_of(path))


def ebusy(path: str | PathSpec) -> OSError:
    return OSError(errno.EBUSY, "Device or resource busy", _virtual_of(path))


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


def no_xattr(path: str | PathSpec) -> OSError:
    code = getattr(errno, "ENOATTR", errno.ENODATA)
    return OSError(code, os.strerror(code), _virtual_of(path))


def exdev(path: str | PathSpec) -> OSError:
    return OSError(errno.EXDEV, "Invalid cross-device link", _virtual_of(path))


def einval(path: str | PathSpec, message: str = "Invalid argument") -> OSError:
    return OSError(errno.EINVAL, message, _virtual_of(path))


def eloop(path: str | PathSpec) -> DotWalkLoop:
    """ELOOP: a link loop stands in the path's walk.

    Typed, unlike the three above, because it is a walk refusal: final
    for every layer that re-reads a miss, and an OSError, so a per-operand
    catch words it where the namespace's own ``CycleError`` escaped every
    one. The door raises it for a loop above any name it is handed.

    Args:
        path (str | PathSpec): the path whose walk looped.
    """
    return DotWalkLoop(errno.ELOOP, ELOOP_STRERROR, _virtual_of(path))


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
        errno.ENOTSUP, f"{vfs}: no op {op_name!r}", _virtual_of(path)
    )


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

    An empty stamp is the empty operand, which is a name like any other.

    Args:
        exc (BaseException): The filesystem error.
    """
    stamped = getattr(exc, "filename", None)
    if isinstance(stamped, str):
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


# The failures that happen after the open, which GNU words as the read
# step: a directory opens and then refuses the read, and the backend
# contract raises the other two for a read it will not serve.
READ_FAILURES: tuple[type[OSError], ...] = (
    IsADirectoryError,
    FileTooLargeError,
    BadDescriptorError,
)

_CANNOT_OPEN = "cannot open {quoted} for reading: {strerror}"

# How GNU words a failed operand for the commands that name the step that
# failed instead of printing ``<cmd>: <name>: <strerror>``. An entry is
# (opening, reading): the line for a name the command could not open, and
# for one it opened that then refused the read (READ_FAILURES). None keeps
# the plain line for that step, which is also the choice wherever GNU's
# own line drops the name (``base64: read error``, ``fmt: read error``):
# mirage words a step GNU's way only while that still says which operand
# failed. ``{quoted}`` is the name always quoted (gnulib's quoteaf),
# ``{shown}`` quoted only when it needs it (quotef), ``{bare}`` as typed.
# Measured on coreutils 9.7 and GNU sed 4.9 (debian:stable-slim), a
# directory read on tmpfs: overlayfs answers a directory's read with
# EINVAL, so a tac there says ``read error: Invalid argument``.
FAILURE_WORDING: dict[str, tuple[str | None, str | None]] = {
    "csplit": (_CANNOT_OPEN, None),
    "du": ("cannot access {quoted}: {strerror}", None),
    "find": ("{quoted}: {strerror}", "{quoted}: {strerror}"),
    "fmt": (_CANNOT_OPEN, None),
    "head": (_CANNOT_OPEN, "error reading {quoted}: {strerror}"),
    "ls": ("cannot access {quoted}: {strerror}", None),
    "mkdir": (
        "cannot create directory {quoted}: {strerror}",
        "cannot create directory {quoted}: {strerror}",
    ),
    "rev": ("cannot open {bare}: {strerror}", None),
    "rm": (
        "cannot remove {quoted}: {strerror}",
        "cannot remove {quoted}: {strerror}",
    ),
    "rmdir": (
        "failed to remove {quoted}: {strerror}",
        "failed to remove {quoted}: {strerror}",
    ),
    "sed": (
        "can't read {bare}: {strerror}",
        "read error on {bare}: {strerror}",
    ),
    "split": (_CANNOT_OPEN, None),
    "stat": (
        "cannot statx {quoted}: {strerror}",
        "cannot statx {quoted}: {strerror}",
    ),
    "tac": (
        "failed to open {quoted} for reading: {strerror}",
        "{shown}: read error: {strerror}",
    ),
    "tail": (_CANNOT_OPEN, "error reading {quoted}: {strerror}"),
    "touch": (
        "cannot touch {quoted}: {strerror}",
        "cannot touch {quoted}: {strerror}",
    ),
    "truncate": (
        "cannot open {quoted} for writing: {strerror}",
        "cannot open {quoted} for writing: {strerror}",
    ),
    "tsort": (None, "{shown}: read error: {strerror}"),
    "uniq": (None, "error reading {quoted}: {strerror}"),
}

# GNU wc and du vet every name the way their --files0-from reader does,
# and refuse an empty one in these words before any open could answer
# ENOENT for it (coreutils 9.7).
ZERO_LENGTH_NAME = "invalid zero-length file name"
_VETS_EMPTY_NAMES = frozenset({"du", "wc"})


def _step_wording(cmd_name: str, label: str, exc: BaseException) -> str | None:
    """The command's own template for this failure, None for the plain
    line: no entry, no template for the step, or standard input, whose
    ``-`` line is the one GNU prints when it closes a stdin it could not
    read.

    Args:
        cmd_name (str): Command name.
        label (str): The operand as reported.
        exc (BaseException): The filesystem error.
    """
    wording = FAILURE_WORDING.get(cmd_name)
    if wording is None or label == "-":
        return None
    return wording[1] if isinstance(exc, READ_FAILURES) else wording[0]


def fs_error_line(
    cmd_name: str, path: str | PathSpec, exc: BaseException
) -> str:
    """GNU coreutils stderr line for one failed path operand.

    Produces ``<cmd>: <path>: <strerror>``, byte-identical with the
    TypeScript formatter. ``path`` is the operand itself when the caller
    knows it (read-family commands that keep processing remaining operands
    after one fails, reported as typed via ``raw_path``), or an
    already-resolved label string. A command in ``SHELL_QUOTED_COMMANDS``
    reports the operand shell-quoted when it needs it (``'*.txt'``), the
    way GNU does; every other command reports it bare. A command in
    ``FAILURE_WORDING`` says which step failed instead.

    Args:
        cmd_name (str): Command name for the ``<cmd>:`` prefix.
        path (object): The failed operand; ``raw_path`` (or ``virtual``) is
            the reported spelling, a plain string is used verbatim.
        exc (BaseException): The filesystem error.
    """
    raw = getattr(path, "raw_path", None)
    label = raw if raw is not None else _virtual_of(path)
    if label == "" and cmd_name in _VETS_EMPTY_NAMES:
        return f"{cmd_name}: {ZERO_LENGTH_NAME}\n"
    strerror = fs_strerror(exc)
    template = _step_wording(cmd_name, label, exc)
    if template is not None and strerror is not None:
        line = template.format(
            quoted=shell_quote_always(label),
            shown=shell_quote(label),
            bare=label,
            strerror=strerror,
        )
        return f"{cmd_name}: {line}\n"
    if quotes_operands(cmd_name):
        label = shell_quote(label)
    if strerror is not None:
        return f"{cmd_name}: {label}: {strerror}\n"
    return f"{cmd_name}: {label}\n"


def revoice_fs_error_line(
    line: str, from_cmd: str, cmd_name: str, operand: str | PathSpec
) -> str:
    """Re-say another command's failed-operand line in `cmd_name`'s voice.

    A command that reads its operands through another one (the
    cross-mount stream strategy fetches each with ``cat``) holds that
    command's rendered line, not the error. When the line is the fetch
    command's own ``fs_error_line`` for ``operand``, it is rendered again
    from the strerror it names, so the prefix, the quoting and the step
    wording are all the real command's; any other line only has its
    prefix swapped. Mirrors TS ``revoiceFsErrorLine``.

    Args:
        line (str): one stderr line, without its newline.
        from_cmd (str): the command that printed it.
        cmd_name (str): the command to say it as.
        operand (str | PathSpec): the operand the fetch was for.
    """
    prefix = f"{from_cmd}: "
    if not line.startswith(prefix):
        return line
    strerror = line.rsplit(": ", 1)[-1]
    for exc_type, text in _FS_STRERROR:
        if text != strerror:
            continue
        exc = exc_type(_virtual_of(operand))
        if fs_error_line(from_cmd, operand, exc) == f"{line}\n":
            return fs_error_line(cmd_name, operand, exc).removesuffix("\n")
        break
    return f"{cmd_name}: {line[len(prefix) :]}"


def format_fs_error(
    cmd_name: str, exc: Exception, paths: list[PathSpec] | None = None
) -> bytes:
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
        if not message.startswith(f"{cmd_name}: "):
            message = f"{cmd_name}: {message}"
        return f"{message}\n".encode("utf-8", "surrogateescape")
    path = error_path(exc)
    if paths:
        for p in paths:
            if p.virtual == path:
                path = p.raw_path
                break
    return fs_error_line(cmd_name, path, exc).encode(
        "utf-8", "surrogateescape"
    )
