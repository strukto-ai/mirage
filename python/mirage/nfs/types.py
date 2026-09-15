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


@dataclass(frozen=True, slots=True)
class NFSAttrs:
    """One entry's attributes, as the server layer needs them.

    Enough to build an ``fattr3`` and nothing more. ``size`` already
    counts writes the adapter has buffered but not yet stored, because
    the client was told those writes succeeded.

    Args:
        fileid (int): the id this entry is addressed by.
        size (int): byte length a client should see; 0 for a directory.
        is_dir (bool): whether the entry is a directory.
        is_symlink (bool): whether the entry is a symbolic link.
        mode (int | None): permission bits when the namespace holds an
            overlay for them, else None for the server's default.
        mtime_epoch (float): modification time in seconds since the
            epoch, which is the shape ``nfstime3`` needs. Zero means
            unknown, and a client reads that as 1970 -- so a backend
            that knows the time must put it here, not in a prettier
            field the wire layer cannot read.
    """

    fileid: int
    size: int
    is_dir: bool
    is_symlink: bool
    mode: int | None = None
    mtime_epoch: float = 0.0


@dataclass(frozen=True, slots=True)
class DirEntry:
    """One listing entry, with the cookie a client resumes from.

    Args:
        name (str): the entry's name within its directory.
        fileid (int): the entry's file id.
        cookie (int): one-based position in the sorted listing; a client
            passes it back to continue after this entry.
        attrs (NFSAttrs): the entry's attributes, so a listing does not
            cost a stat round trip per name.
    """

    name: str
    fileid: int
    cookie: int
    attrs: NFSAttrs
