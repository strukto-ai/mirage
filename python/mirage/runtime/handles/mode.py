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

import os
from dataclasses import dataclass

from mirage.runtime.handles.constants import MODE_BASES, MODE_CHARS


@dataclass(frozen=True, slots=True)
class OpenMode:
    """What an fopen-style mode string says about a handle.

    One vocabulary for every dialect that opens by mode: monty's
    ``path_open`` passes a CPython mode string, the host ``open`` takes one
    from embedding code, and preview1's oflags/rights/fdflags (which a
    QuickJS guest's ``std.open`` reaches as) translate onto the same
    facts in ``WasiFs.path_open``.

    Args:
        readable (bool): the handle may read (r, +).
        writable (bool): the handle may mutate its buffer (w, a, x, +).
        truncate (bool): opening discards existing content (w).
        append (bool): every write lands at the end (a).
        create (bool): a missing file is created (w, a, x).
        exclusive (bool): an existing file refuses the open (x).
        binary (bool): the handle carries bytes, not text (b).
        directory (bool): a directory may open, for a read: ``os.open``
            and preview1 open one, ``open`` and SFTP refuse it.
    """

    readable: bool
    writable: bool
    truncate: bool
    append: bool
    create: bool
    exclusive: bool
    binary: bool
    directory: bool = False


READ = OpenMode(
    readable=True,
    writable=False,
    truncate=False,
    append=False,
    create=False,
    exclusive=False,
    binary=True,
)


def open_mode(flags: int) -> OpenMode:
    """What open(2) flags say about a handle, in the mode vocabulary.

    Args:
        flags (int): the ``os.O_*`` flags.
    """
    # Windows' os has no O_ACCMODE; the access bits are these three there
    # too.
    access = flags & (os.O_RDONLY | os.O_WRONLY | os.O_RDWR)
    writable = access in (os.O_WRONLY, os.O_RDWR)
    create = bool(flags & os.O_CREAT)
    return OpenMode(
        readable=access in (os.O_RDONLY, os.O_RDWR),
        writable=writable,
        truncate=writable and bool(flags & os.O_TRUNC),
        append=bool(flags & os.O_APPEND),
        create=create,
        exclusive=create and bool(flags & os.O_EXCL),
        binary=True,
    )


def parse_mode(mode: str) -> OpenMode:
    """Read an fopen-style mode string into its facts, validating it.

    The rule is CPython's: one base, at most one each of ``+``, ``b``,
    ``t``, and never ``b`` together with ``t``. A guest that opens in
    C's dialect (fopen reads ``rr`` as ``r`` and spells exclusive
    creation ``wx``) arrives as open flags and never reaches this
    parser.

    Args:
        mode (str): the mode as the caller spelled it (``r``, ``w+b``,
            ``a``, ``x``, ...).

    Raises:
        ValueError: the mode does not parse, in CPython's own wording.
    """
    if any(char not in MODE_CHARS for char in mode) or any(
        mode.count(char) > 1 for char in MODE_CHARS
    ):
        raise ValueError(f"invalid mode: {mode!r}")
    if "b" in mode and "t" in mode:
        raise ValueError("can't have text and binary mode at once")
    if not set(mode) & set("rwax"):
        raise ValueError(
            "Must have exactly one of create/read/write/append mode "
            "and at most one plus"
        )
    if set(mode) & set("rwax") not in MODE_BASES:
        raise ValueError(
            "must have exactly one of create/read/write/append mode"
        )
    plus = "+" in mode
    return OpenMode(
        readable="r" in mode or plus,
        writable="r" not in mode or plus,
        truncate="w" in mode,
        append="a" in mode,
        create=any(char in mode for char in "wax"),
        exclusive="x" in mode,
        binary="b" in mode,
    )
