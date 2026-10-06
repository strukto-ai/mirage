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

from dataclasses import dataclass
from enum import StrEnum


class FsCondition(StrEnum):
    """A filesystem condition mirage can report, named once.

    Every boundary that has to say a condition in a number (POSIX for
    the kernel adapters, preview1 for a WASI guest, CPython errnos for
    a monty guest) keeps only a table from these names to its own
    numbers, and nothing else. The POSIX table is the shared base and
    lives here; each runtime dialect lives beside its boundary
    (``runtime/wasm/errors.py``, ``runtime/python/monty/errors.py``).
    Every table stays total over this enum, and each table's own test
    fails a half-added member.

    One member is mirage's own condition rather than a POSIX spelling:
    ``NO_XATTR`` is "attribute not set", which POSIX names ENOATTR on
    macOS and ENODATA on Linux. ``EBADF`` is the shell's own: no mount
    raises it, only a standard input that is closed or write-only.
    """

    EBADF = "ebadf"
    ENOENT = "enoent"
    ENOTDIR = "enotdir"
    EISDIR = "eisdir"
    EEXIST = "eexist"
    EACCES = "eacces"
    EPERM = "eperm"
    ENOTEMPTY = "enotempty"
    EXDEV = "exdev"
    ENOTSUP = "enotsup"
    ELOOP = "eloop"
    EINVAL = "einval"
    EIO = "eio"
    EBUSY = "ebusy"
    EROFS = "erofs"
    EFBIG = "efbig"
    NO_XATTR = "no_xattr"


@dataclass(frozen=True, slots=True)
class PosixErrno:
    """One condition's POSIX rendering: host errno plus strerror text.

    Args:
        errno (int): the host's number for the condition (platform
            resolved, e.g. ENOTEMPTY is 66 on macOS and 39 on Linux).
        phrase (str): the strerror text command boundaries render.
    """

    errno: int
    phrase: str


class OperationNotSupportedError(OSError):
    """A mount was asked for an op its backend does not register.

    Raised at the op-resolution boundary (``Mount.execute_op``) so a
    capability gap surfaces as a recoverable filesystem error
    (ENOTSUP, "Operation not supported") instead of an internal
    AttributeError: the backend behaves like a filesystem that does not
    allow the operation.
    """


class ReadOnlyError(PermissionError):
    """A write into a region whose mode stops below ``w``.

    Raised by the mode gate (``Mount.execute_op``) with ``errno.EROFS``
    stamped and the op's path as ``filename``, so a command chokepoint
    renders ``<cmd>: <path>: Read-only file system`` and a kernel
    adapter reports EROFS: the below-mode voice, distinct from both the
    hide voice (ENOENT) and the policy voice (EACCES). A
    ``PermissionError`` subclass because every catch site that tolerates
    a refused write already names that class; the classifiers read the
    errno, so the voice stays EROFS everywhere.
    """


class NoMountError(ValueError):
    """A path no mount owns: the registry's miss, and nothing else.

    A ValueError subclass so every existing catch keeps working, but
    typed so ``mirage.errors.classify`` can name the miss ENOENT
    without swallowing the bare ValueErrors backends raise for
    refusals that are not absence (an oversized read, a rename into
    the source's own subtree). Mirrors the TS ``noMount`` stamp.
    """


class FileTooLargeError(OSError):
    """EFBIG: a read the backend refuses to render whole.

    A records file past its mount's record cap (Airtable's
    ``max_read_records``) raises this rather than paging a large table at
    a few requests a second. Stamped like the other per-operand errors, so
    a command chokepoint renders ``<cmd>: <path>: File too large`` and
    moves on to its next operand. Mirrors the TS ``efbig``.
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
