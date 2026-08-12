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
    numbers, and nothing else. Adding a member means adding one row per
    table; ``tests/errors/test_types.py`` fails a half-added one.

    Two members are mirage's own conditions rather than POSIX spellings:
    ``CROSS_MOUNT`` is a rename whose ends live on different mounts
    (posix says EXDEV, the WASI wire deliberately says ENOENT), and
    ``NO_XATTR`` is "attribute not set", which POSIX names ENOATTR on
    macOS and ENODATA on Linux.
    """

    ENOENT = "enoent"
    ENOTDIR = "enotdir"
    EISDIR = "eisdir"
    EEXIST = "eexist"
    EACCES = "eacces"
    EPERM = "eperm"
    ENOTEMPTY = "enotempty"
    EXDEV = "exdev"
    CROSS_MOUNT = "cross_mount"
    ENOTSUP = "enotsup"
    ELOOP = "eloop"
    EINVAL = "einval"
    EIO = "eio"
    EBUSY = "ebusy"
    EROFS = "erofs"
    NO_XATTR = "no_xattr"


@dataclass(frozen=True, slots=True)
class PosixSeat:
    """One condition's POSIX rendering: host errno plus GNU strerror.

    Args:
        errno (int): the host's number for the condition (platform
            resolved, e.g. ENOTEMPTY is 66 on macOS and 39 on Linux).
        phrase (str): the GNU strerror text command boundaries render.
    """

    errno: int
    phrase: str


@dataclass(frozen=True, slots=True)
class GuestSeat:
    """One condition's guest-python rendering, for the monty encoders.

    Args:
        name (str): the builtin exception a guest should be able to
            ``except`` (e.g. ``FileNotFoundError``).
        errno (int): CPython-on-Linux errno; a guest interpreter is
            platform-neutral, so the numbering must not wobble with the
            host.
        phrase (str): CPython's message phrase for the errno.
    """

    name: str
    errno: int
    phrase: str
