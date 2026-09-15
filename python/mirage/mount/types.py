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
from typing import Any


@dataclass(slots=True)
class MountAttrs:
    """One entry's POSIX attributes, as any kernel adapter needs them.

    Neutral on purpose. The core used to answer in libfuse's own
    ``st_*`` dict, which made every other adapter read that binding's
    vocabulary: the nfs delegate was pulling ``entry["st_mode"]`` out of
    a shape named for a library it does not use. Answering in a struct
    and letting the libfuse adapter spell it as a dict puts the
    convention where the convention belongs.

    Mutable rather than frozen because ``apply_stat_attrs`` folds the
    namespace overlay onto a freshly built row before anyone sees it,
    which is one construction in two steps rather than a mutation of
    shared state. The TypeScript twin is an interface for the same
    reason.

    Args:
        mode (int): type bits plus permissions.
        size (int): byte length the client should see.
        nlink (int): link count; 2 for a directory, 1 otherwise.
        uid (int): owning user id.
        gid (int): owning group id.
        atime (float): access time, seconds since the epoch.
        mtime (float): modification time, seconds since the epoch.
        ctime (float): change time, seconds since the epoch.

    Seconds is load-bearing, not a preference. Both consumers want
    seconds and neither can say so: libfuse's ``st_mtime`` is seconds,
    and NFSv3's ``nfstime3.seconds`` is a **u32**, so a nanosecond value
    handed to it saturates and every file over the mount reads
    2106-02-07 -- which is the 1970 bug with a different date on it.
    The TypeScript twin holds a ``Date`` for the same reason.
    """

    mode: int
    size: int
    nlink: int
    uid: int
    gid: int
    atime: float
    mtime: float
    ctime: float

    def as_stat_dict(self) -> dict[str, Any]:
        """The same row in libfuse's ``st_*`` spelling.

        Lives here rather than in the fuse adapter only because mfusepy
        and the FSKit shim both want it and neither should re-derive it.
        Nothing else calls this: an adapter that does not speak libfuse
        reads the fields.

        Returns:
            dict: the attributes keyed as libfuse names them.
        """
        return {
            "st_mode": self.mode,
            "st_nlink": self.nlink,
            "st_uid": self.uid,
            "st_gid": self.gid,
            "st_size": self.size,
            "st_atime": self.atime,
            "st_mtime": self.mtime,
            "st_ctime": self.ctime,
        }


@dataclass(frozen=True, slots=True)
class MountEntry:
    """One listing entry, described as it is listed.

    A protocol that lists with attributes (NFSv3's READDIRPLUS, and
    libfuse's readdir-plus) would otherwise stat every name a second
    time, once per entry per listing. Carrying the path as well as the
    name is what lets an adapter address the entry -- mint a file
    handle for it, cache it -- without rejoining the parent itself and
    disagreeing with the core about how a name becomes a path.

    Args:
        name (str): the entry's name within its directory.
        path (str): the entry's mount path, joined by the core.
        attrs (MountAttrs): the entry's attributes.
    """

    name: str
    path: str
    attrs: MountAttrs


@dataclass(frozen=True, slots=True)
class SetAttrs:
    """The attribute change a set-attributes request carries.

    Only ``size`` acts. Mode, owner and timestamps are accepted and
    discarded: a mirage backend has nowhere to persist them, and
    refusing would fail ordinary tools. Neutral rather than nfs's,
    because every kernel protocol asks the same narrow question here.

    Args:
        size (int | None): new length in bytes, or None to leave it.
    """

    size: int | None = None
